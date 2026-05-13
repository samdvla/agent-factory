//! Gumroad API v2 client.
//!
//! Base URL: https://api.gumroad.com/v2/
//! Auth: `access_token` either as a query param or `Authorization: Bearer`.
//! Get tokens at https://gumroad.com/settings/advanced → "Create access token"
//! (or via OAuth app).
//!
//! Gumroad's public API around product creation has been historically
//! conservative — `POST /v2/products` is supported but file upload usually
//! requires a separate multi-step flow:
//!
//!   1. POST /v2/products (name, price_cents, description)
//!   2. Upload file via the older internal `links/{id}/upload` flow, which
//!      isn't officially documented.
//!
//! To stay robust, this integration:
//!   - Always creates the product via the documented endpoint
//!   - Attempts the file-attach call; on failure, marks the publish as
//!     `published_without_file` (the product is live but empty — operator
//!     needs to attach the file manually). UI surfaces this clearly.
//!
//! Rate limits: ~600 req/15min. We rely on the per-day cap.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::path::Path;
use std::time::Duration;

const API_BASE: &str = "https://api.gumroad.com/v2";
const UA: &str = "agent-factory/1.0";

#[derive(Debug, Clone)]
pub struct Creds {
    pub access_token: String,
}

#[derive(Debug, Clone)]
pub struct CreateProductInput {
    pub name: String,
    pub description: String,
    pub price_usd: f64,
    /// Gumroad needs a URL — for digital downloads we use a placeholder; the
    /// actual file is attached via a separate call.
    pub product_type: String, // "digital"
}

#[derive(Debug, Clone)]
pub struct CreateProductResult {
    pub product_id: String,
    pub edit_url: Option<String>,
    pub short_url: Option<String>,
    pub file_attached: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UserResp {
    success: bool,
    user: Option<UserUser>,
}

#[derive(Debug, Deserialize)]
struct UserUser {
    name: Option<String>,
    email: Option<String>,
    user_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProductWrap {
    success: bool,
    product: Option<ProductInner>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProductInner {
    id: String,
    short_url: Option<String>,
    edit_url: Option<String>,
}

/// Lightweight auth ping: GET /v2/user. Returns the account email (or name
/// fallback) for the settings UI to display.
pub async fn verify(client: &reqwest::Client, creds: &Creds) -> Result<String> {
    let resp = client
        .get(format!("{API_BASE}/user"))
        .header("Authorization", format!("Bearer {}", creds.access_token))
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .context("gumroad GET /user failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("gumroad /user HTTP {status}: {text}"));
    }
    let parsed: UserResp =
        serde_json::from_str(&text).with_context(|| format!("parse /user JSON: {text}"))?;
    if !parsed.success {
        return Err(anyhow!("gumroad /user returned success=false: {text}"));
    }
    let u = parsed
        .user
        .ok_or_else(|| anyhow!("gumroad /user: missing user object"))?;
    Ok(u.email.or(u.name).or(u.user_id).unwrap_or_else(|| "gumroad".into()))
}

/// Create a Gumroad product + attempt to attach the file in one call. The
/// file-attach step is best-effort — if it fails the product is still
/// created (just empty) and we mark `file_attached: false` so the UI can
/// nudge the operator to upload manually.
pub async fn create_product_with_file(
    client: &reqwest::Client,
    creds: &Creds,
    input: &CreateProductInput,
    file_path: &Path,
) -> Result<CreateProductResult> {
    // Step 1: create the product.
    let price_cents = (input.price_usd * 100.0).round() as i64;
    let create_resp = client
        .post(format!("{API_BASE}/products"))
        .header("Authorization", format!("Bearer {}", creds.access_token))
        .header("User-Agent", UA)
        .form(&[
            ("name", input.name.as_str()),
            ("price", &price_cents.to_string()),
            ("description", input.description.as_str()),
            ("product_type", input.product_type.as_str()),
        ])
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .context("gumroad POST /products failed")?;
    let status = create_resp.status();
    let text = create_resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("gumroad create-product HTTP {status}: {text}"));
    }
    let parsed: ProductWrap =
        serde_json::from_str(&text).with_context(|| format!("parse product JSON: {text}"))?;
    if !parsed.success {
        return Err(anyhow!(
            "gumroad create-product success=false: {}",
            parsed.message.unwrap_or_else(|| text.clone())
        ));
    }
    let product = parsed
        .product
        .ok_or_else(|| anyhow!("gumroad create-product: missing product"))?;

    // Step 2: attempt file attach. Use the (semi-documented) variant_categories
    // / files endpoint. If Gumroad rejects this (their API around file
    // attachment is restricted), we surface a warning and call the product
    // "published_without_file" — the operator can upload via dashboard.
    let mut file_attached = false;
    let mut warning = None;
    match attach_file(client, creds, &product.id, file_path).await {
        Ok(()) => file_attached = true,
        Err(e) => {
            warning = Some(format!(
                "file attach failed (product created but empty): {e:#}"
            ));
        }
    }

    Ok(CreateProductResult {
        product_id: product.id,
        edit_url: product.edit_url,
        short_url: product.short_url,
        file_attached,
        warning,
    })
}

/// Best-effort file attachment via Gumroad's product files endpoint. This is
/// the most-likely-to-break call in the integration — Gumroad has tightened
/// public-API write access over the years.
async fn attach_file(
    client: &reqwest::Client,
    creds: &Creds,
    product_id: &str,
    file_path: &Path,
) -> Result<()> {
    let bytes = tokio::fs::read(file_path)
        .await
        .with_context(|| format!("read file {}", file_path.display()))?;
    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download.bin")
        .to_string();
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str("application/octet-stream")?;
    let form = reqwest::multipart::Form::new().part("file", part);
    let resp = client
        .post(format!("{API_BASE}/products/{product_id}/files"))
        .header("Authorization", format!("Bearer {}", creds.access_token))
        .header("User-Agent", UA)
        .multipart(form)
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .context("gumroad POST /products/:id/files failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("gumroad file attach HTTP {status}: {text}"));
    }
    Ok(())
}
