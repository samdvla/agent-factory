//! Gumroad API v2 client.
//!
//! Base URL: https://api.gumroad.com/v2/
//! Auth: `Authorization: Bearer <access_token>`. Tokens come from
//! https://gumroad.com/settings/advanced -> "Create access token".
//!
//! Gumroad's modern API v2 supports programmatic product creation, file
//! upload and cover images. The flow this client implements mirrors what
//! the Gumroad web UI does:
//!
//!   1. Upload each product file with the S3 multipart presign flow —
//!      `POST /v2/files/presign` for presigned part URLs, `PUT` the bytes
//!      to each, then `POST /v2/files/complete` for the seller-owned URL.
//!   2. POST /v2/products with `files[]` referencing those URLs (or
//!      PUT /v2/products/:id when attaching files to an existing product).
//!   3. POST /v2/products/:id/covers with a public image URL to attach a
//!      preview image.
//!
//! Products are created as drafts — Gumroad's API always does this. The
//! operator publishes from the dashboard after review (same review gate
//! we use for Etsy).
//!
//! Rate limits: ~600 req/15min. We rely on the per-day cap upstream.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::json;
use std::path::Path;
use std::time::Duration;

const API_BASE: &str = "https://api.gumroad.com/v2";
const UA: &str = "agent-factory/1.0";

/// S3 multipart part size Gumroad's presign endpoint chunks by (100 MB).
/// Our 3D assets are well under one part, but we slice generically so a
/// large textured GLB still uploads correctly.
const PART_SIZE: usize = 100 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct Creds {
    pub access_token: String,
}

#[derive(Debug, Clone)]
pub struct CreateProductInput {
    pub name: String,
    pub description: String,
    pub price_usd: f64,
    pub tags: Vec<String>,
}

/// A file that has been uploaded via the presign flow and is ready to be
/// referenced from a product's `files[]` array.
#[derive(Debug, Clone)]
pub struct UploadedFile {
    /// Canonical seller-owned URL returned by POST /v2/files/complete.
    pub url: String,
    /// Buyer-facing label for the download.
    pub display_name: String,
}

#[derive(Debug, Clone)]
pub struct CreateProductResult {
    pub product_id: String,
    pub edit_url: Option<String>,
    pub short_url: Option<String>,
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

#[derive(Debug, Deserialize)]
struct PresignResp {
    success: bool,
    upload_id: Option<String>,
    key: Option<String>,
    file_url: Option<String>,
    parts: Option<Vec<PresignPart>>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PresignPart {
    part_number: i64,
    presigned_url: String,
}

#[derive(Debug, Deserialize)]
struct CompleteResp {
    success: bool,
    file_url: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PlainResp {
    success: bool,
    message: Option<String>,
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

/// Upload one file to the seller's Gumroad storage via the S3 presign
/// flow, returning the canonical file URL to reference from `files[]`.
///
/// This is the most network-heavy call in the integration: presign, then
/// one PUT per 100 MB part, then complete. For our STL/GLB assets that's
/// presign + one PUT + complete.
pub async fn upload_product_file(
    client: &reqwest::Client,
    creds: &Creds,
    file_path: &Path,
) -> Result<String> {
    let bytes = tokio::fs::read(file_path)
        .await
        .with_context(|| format!("read file {}", file_path.display()))?;
    if bytes.is_empty() {
        return Err(anyhow!("file {} is empty", file_path.display()));
    }
    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("download.bin")
        .to_string();

    // Step 1: presign.
    let presign_resp = client
        .post(format!("{API_BASE}/files/presign"))
        .header("Authorization", format!("Bearer {}", creds.access_token))
        .header("User-Agent", UA)
        .json(&json!({ "filename": filename, "file_size": bytes.len() }))
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .context("gumroad POST /files/presign failed")?;
    let status = presign_resp.status();
    let text = presign_resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("gumroad /files/presign HTTP {status}: {text}"));
    }
    let presign: PresignResp =
        serde_json::from_str(&text).with_context(|| format!("parse presign JSON: {text}"))?;
    if !presign.success {
        return Err(anyhow!(
            "gumroad /files/presign success=false: {}",
            presign.message.unwrap_or_else(|| text.clone())
        ));
    }
    let upload_id = presign
        .upload_id
        .ok_or_else(|| anyhow!("gumroad presign: missing upload_id"))?;
    let key = presign
        .key
        .ok_or_else(|| anyhow!("gumroad presign: missing key"))?;
    let parts = presign.parts.unwrap_or_default();
    if parts.is_empty() {
        return Err(anyhow!("gumroad presign: no parts returned"));
    }

    // Step 2: PUT each part to its presigned S3 URL. The presigned URL
    // carries its own auth — we must NOT add the Gumroad bearer header here.
    let mut completed_parts: Vec<serde_json::Value> = Vec::with_capacity(parts.len());
    for part in &parts {
        let idx = (part.part_number - 1).max(0) as usize;
        let start = idx.saturating_mul(PART_SIZE);
        if start >= bytes.len() {
            return Err(anyhow!(
                "gumroad presign part {} starts past end of file",
                part.part_number
            ));
        }
        let end = start.saturating_add(PART_SIZE).min(bytes.len());
        let chunk = bytes[start..end].to_vec();
        let put_resp = client
            .put(&part.presigned_url)
            .body(chunk)
            .timeout(Duration::from_secs(300))
            .send()
            .await
            .with_context(|| format!("gumroad S3 PUT part {} failed", part.part_number))?;
        let put_status = put_resp.status();
        if !put_status.is_success() {
            let body = put_resp.text().await.unwrap_or_default();
            return Err(anyhow!(
                "gumroad S3 PUT part {} HTTP {put_status}: {body}",
                part.part_number
            ));
        }
        let etag = put_resp
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| anyhow!("gumroad S3 PUT part {}: missing ETag", part.part_number))?;
        completed_parts.push(json!({ "part_number": part.part_number, "etag": etag }));
    }

    // Step 3: complete the multipart upload.
    let complete_resp = client
        .post(format!("{API_BASE}/files/complete"))
        .header("Authorization", format!("Bearer {}", creds.access_token))
        .header("User-Agent", UA)
        .json(&json!({ "upload_id": upload_id, "key": key, "parts": completed_parts }))
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .context("gumroad POST /files/complete failed")?;
    let status = complete_resp.status();
    let text = complete_resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("gumroad /files/complete HTTP {status}: {text}"));
    }
    let complete: CompleteResp =
        serde_json::from_str(&text).with_context(|| format!("parse complete JSON: {text}"))?;
    if !complete.success {
        return Err(anyhow!(
            "gumroad /files/complete success=false: {}",
            complete.message.unwrap_or_else(|| text.clone())
        ));
    }
    complete
        .file_url
        .or(presign.file_url)
        .ok_or_else(|| anyhow!("gumroad /files/complete: missing file_url"))
}

/// Build the JSON `files[]` array from already-uploaded files.
fn files_json(files: &[UploadedFile]) -> Vec<serde_json::Value> {
    files
        .iter()
        .enumerate()
        .map(|(i, f)| {
            json!({
                "url": f.url,
                "display_name": f.display_name,
                "position": i,
            })
        })
        .collect()
}

/// Create a Gumroad product with its files attached in one call.
///
/// `files` must already be uploaded via [`upload_product_file`]. The
/// product is created as a draft (Gumroad API behaviour).
pub async fn create_product(
    client: &reqwest::Client,
    creds: &Creds,
    input: &CreateProductInput,
    files: &[UploadedFile],
) -> Result<CreateProductResult> {
    if files.is_empty() {
        return Err(anyhow!("gumroad create-product: at least one file required"));
    }
    let price_cents = (input.price_usd * 100.0).round() as i64;
    let body = json!({
        "name": input.name,
        "description": input.description,
        "price": price_cents,
        "native_type": "digital",
        "tags": input.tags,
        "files": files_json(files),
    });
    let resp = client
        .post(format!("{API_BASE}/products"))
        .header("Authorization", format!("Bearer {}", creds.access_token))
        .header("User-Agent", UA)
        .json(&body)
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .context("gumroad POST /products failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
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
    Ok(CreateProductResult {
        product_id: product.id,
        edit_url: product.edit_url,
        short_url: product.short_url,
    })
}

/// Replace an existing product's files. Gumroad's PUT /v2/products/:id
/// treats `files[]` as a full replacement — used by the backfill path to
/// attach files to products that were created empty by the old, broken
/// integration.
pub async fn set_product_files(
    client: &reqwest::Client,
    creds: &Creds,
    product_id: &str,
    files: &[UploadedFile],
) -> Result<()> {
    if files.is_empty() {
        return Err(anyhow!("gumroad set-product-files: at least one file required"));
    }
    let resp = client
        .put(format!("{API_BASE}/products/{product_id}"))
        .header("Authorization", format!("Bearer {}", creds.access_token))
        .header("User-Agent", UA)
        .json(&json!({ "files": files_json(files) }))
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .context("gumroad PUT /products/:id failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("gumroad update-product HTTP {status}: {text}"));
    }
    let parsed: PlainResp =
        serde_json::from_str(&text).with_context(|| format!("parse update JSON: {text}"))?;
    if !parsed.success {
        return Err(anyhow!(
            "gumroad update-product success=false: {}",
            parsed.message.unwrap_or_else(|| text.clone())
        ));
    }
    Ok(())
}

/// Attach a cover (preview) image to a product from a public image URL.
/// Gumroad downloads the URL server-side and stores its own copy, so the
/// source URL only needs to be reachable for the duration of this call.
pub async fn add_cover(
    client: &reqwest::Client,
    creds: &Creds,
    product_id: &str,
    image_url: &str,
) -> Result<()> {
    let resp = client
        .post(format!("{API_BASE}/products/{product_id}/covers"))
        .header("Authorization", format!("Bearer {}", creds.access_token))
        .header("User-Agent", UA)
        .json(&json!({ "url": image_url }))
        .timeout(Duration::from_secs(120))
        .send()
        .await
        .context("gumroad POST /products/:id/covers failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("gumroad add-cover HTTP {status}: {text}"));
    }
    let parsed: PlainResp =
        serde_json::from_str(&text).with_context(|| format!("parse cover JSON: {text}"))?;
    if !parsed.success {
        return Err(anyhow!(
            "gumroad add-cover success=false: {}",
            parsed.message.unwrap_or_else(|| text.clone())
        ));
    }
    Ok(())
}
