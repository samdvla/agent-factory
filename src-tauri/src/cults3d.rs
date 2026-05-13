//! Cults3D GraphQL API client.
//!
//! Endpoint: POST https://cults3d.com/graphql
//! Auth: HTTP Basic — `username:api_key` base64'd.
//! Generate keys at https://cults3d.com/en/api/keys.
//!
//! Cults3D pulls hosted assets from public HTTPS URLs we pass; it does not
//! accept multipart uploads. Asset hosting is `asset_host_github`.
//!
//! Rate limits (publicly stated): ~60 req/30s, ~500 req/day. We don't enforce
//! this client-side beyond exponential backoff on 429/5xx; the daily cap is
//! also gated by `cults3d_daily_cap` so the supervisor stops queueing once
//! we've hit our self-imposed limit.

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const GRAPHQL_URL: &str = "https://cults3d.com/graphql";

#[derive(Debug, Clone)]
pub struct Creds {
    pub username: String,
    pub api_key: String,
}

impl Creds {
    pub fn basic_header(&self) -> String {
        format!(
            "Basic {}",
            B64.encode(format!("{}:{}", self.username, self.api_key))
        )
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateCreationInput {
    pub name: String,
    pub description: String,
    pub image_urls: Vec<String>,
    pub file_urls: Vec<String>,
    /// Defaults to USD; pass EUR or GBP if the user picked another currency.
    pub currency: String,
    pub download_price: f64,
    /// Cults3D license code, e.g. "cults_cu" (Cults Common Use).
    pub license_code: String,
    /// Opaque base64-encoded category id from `categories` query.
    pub category_id: Option<String>,
    pub sub_category_ids: Vec<String>,
    pub tag_names: Vec<String>,
    pub locale: String,
    /// MUST be true for AI-generated content — Cults3D's schema requirement,
    /// not just a hint. Don't lie about this; it's account-suspendable.
    pub made_with_ai: bool,
}

#[derive(Debug, Clone)]
pub struct CreationResult {
    pub creation_id: String,
    pub url: String,
}

/// Run a GraphQL query/mutation with Basic auth. Returns parsed JSON `data`.
async fn graphql(
    client: &reqwest::Client,
    creds: &Creds,
    query: &str,
    variables: serde_json::Value,
) -> Result<serde_json::Value> {
    let body = serde_json::json!({"query": query, "variables": variables});
    let resp = client
        .post(GRAPHQL_URL)
        .header("Authorization", creds.basic_header())
        .header("Content-Type", "application/json")
        .header("User-Agent", "agent-factory/1.0")
        .json(&body)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .context("cults3d POST failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("cults3d HTTP {status}: {text}"));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("parse cults3d JSON: {text}"))?;
    if let Some(errs) = parsed.get("errors") {
        return Err(anyhow!("cults3d graphql errors: {errs}"));
    }
    Ok(parsed
        .get("data")
        .cloned()
        .ok_or_else(|| anyhow!("cults3d response missing data: {text}"))?)
}

/// Lightweight auth ping: fetch the authenticated user's username via
/// `myself`. We don't care about the value beyond confirming auth works.
pub async fn verify(client: &reqwest::Client, creds: &Creds) -> Result<String> {
    let query = "query { myself { username } }";
    let data = graphql(client, creds, query, serde_json::json!({})).await?;
    let username = data
        .get("myself")
        .and_then(|m| m.get("username"))
        .and_then(|u| u.as_str())
        .ok_or_else(|| anyhow!("verify: no myself.username in response"))?
        .to_string();
    Ok(username)
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Category {
    pub id: String,
    pub name: String,
}

/// Fetch the top-level Cults3D categories — used to map our internal
/// product_type → Cults3D categoryId. Result is small (~30 items) and rarely
/// changes; cache in secrets after first fetch.
pub async fn list_categories(client: &reqwest::Client, creds: &Creds) -> Result<Vec<Category>> {
    let query =
        "query { categories { id name(locale: EN) } }";
    let data = graphql(client, creds, query, serde_json::json!({})).await?;
    let arr = data
        .get("categories")
        .and_then(|c| c.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::with_capacity(arr.len());
    for c in arr {
        let id = c
            .get("id")
            .and_then(|s| s.as_str())
            .unwrap_or_default()
            .to_string();
        let name = c
            .get("name")
            .and_then(|s| s.as_str())
            .unwrap_or_default()
            .to_string();
        if !id.is_empty() && !name.is_empty() {
            out.push(Category { id, name });
        }
    }
    Ok(out)
}

/// Heuristic: pick a category id by keyword match. Cults3D category names
/// are fairly stable ("Miniatures", "Decoration", "Tools", etc.). We score
/// each by how many input keywords appear in the category name, pick the
/// best match, fall back to "Various" or the first category.
pub fn pick_category(categories: &[Category], niche: &str, tags: &[String]) -> Option<String> {
    if categories.is_empty() {
        return None;
    }
    let hay = format!("{} {}", niche, tags.join(" ")).to_lowercase();
    let mut best: Option<(usize, &Category)> = None;
    for c in categories {
        let name = c.name.to_lowercase();
        // Count of category words that appear anywhere in our text.
        let score = name
            .split_whitespace()
            .filter(|w| w.len() >= 4 && hay.contains(w))
            .count();
        if score > 0 {
            match best {
                Some((bs, _)) if bs >= score => {}
                _ => best = Some((score, c)),
            }
        }
    }
    if let Some((_, c)) = best {
        return Some(c.id.clone());
    }
    // Fallback preference: "Various", "Other", else the first category.
    for needle in ["various", "other"] {
        if let Some(c) = categories
            .iter()
            .find(|c| c.name.to_lowercase().contains(needle))
        {
            return Some(c.id.clone());
        }
    }
    Some(categories[0].id.clone())
}

/// Create a Cults3D creation. Uses inline-variable mutation form (matches
/// the public reference schema). Returns the new creation's id + URL.
pub async fn create_creation(
    client: &reqwest::Client,
    creds: &Creds,
    input: &CreateCreationInput,
) -> Result<CreationResult> {
    let query = r#"
mutation CreateDesign(
  $name: String!,
  $description: String!,
  $imageUrls: [String!]!,
  $fileUrls: [String!]!,
  $locale: LocaleEnum!,
  $categoryId: ID,
  $subCategoryIds: [ID!],
  $downloadPrice: Float!,
  $currency: CurrencyEnum!,
  $licenseCode: String!,
  $tagNames: [String!],
  $madeWithAi: Boolean!
) {
  createCreation(
    name: $name,
    description: $description,
    imageUrls: $imageUrls,
    fileUrls: $fileUrls,
    locale: $locale,
    categoryId: $categoryId,
    subCategoryIds: $subCategoryIds,
    downloadPrice: $downloadPrice,
    currency: $currency,
    licenseCode: $licenseCode,
    tagNames: $tagNames,
    madeWithAi: $madeWithAi
  ) {
    creation { id url(locale: $locale) }
    errors
  }
}
"#;
    let vars = serde_json::json!({
        "name": input.name,
        "description": input.description,
        "imageUrls": input.image_urls,
        "fileUrls": input.file_urls,
        "locale": input.locale,
        "categoryId": input.category_id,
        "subCategoryIds": input.sub_category_ids,
        "downloadPrice": input.download_price,
        "currency": input.currency,
        "licenseCode": input.license_code,
        "tagNames": input.tag_names,
        "madeWithAi": input.made_with_ai,
    });
    let data = graphql(client, creds, query, vars).await?;
    let payload = data
        .get("createCreation")
        .ok_or_else(|| anyhow!("createCreation: empty payload"))?;
    if let Some(errs) = payload.get("errors").and_then(|e| e.as_array()) {
        if !errs.is_empty() {
            return Err(anyhow!("createCreation errors: {errs:?}"));
        }
    }
    let creation = payload
        .get("creation")
        .ok_or_else(|| anyhow!("createCreation: no creation in payload"))?;
    let id = creation
        .get("id")
        .and_then(|s| s.as_str())
        .ok_or_else(|| anyhow!("createCreation: missing id"))?
        .to_string();
    let url = creation
        .get("url")
        .and_then(|s| s.as_str())
        .unwrap_or("")
        .to_string();
    Ok(CreationResult { creation_id: id, url })
}
