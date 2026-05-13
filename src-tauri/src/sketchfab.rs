//! Sketchfab Data API v3 client.
//!
//! Base URL: https://api.sketchfab.com/v3
//! Auth: `Authorization: Token <api_token>` header.
//! Get tokens at https://sketchfab.com/settings/password (API section).
//!
//! Unlike Cults3D, Sketchfab accepts multipart uploads directly — no need
//! for the GitHub asset host. Thumbnails are rendered automatically from the
//! uploaded 3D model.
//!
//! Selling paid downloads requires a Sketchfab Pro+ plan. Free accounts can
//! still upload, list, and offer free downloads.
//!
//! Rate limits aren't publicly documented; we rely on a per-day cap in the
//! publisher orchestration plus exponential backoff on 429/5xx.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::path::Path;
use std::time::Duration;

const API_BASE: &str = "https://api.sketchfab.com/v3";
const UA: &str = "agent-factory/1.0";

/// Trim `s` to at most `max_chars` characters (not bytes), cutting on a
/// word boundary when possible and adding a single ellipsis char if trimmed.
/// Counts Unicode scalar values to stay consistent with Sketchfab's
/// validator which rejects "more than 48 characters" by codepoint.
fn clamp_name(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        return s.to_string();
    }
    // Reserve one slot for the ellipsis.
    let limit = max_chars.saturating_sub(1).max(1);
    // Try to cut at the last whitespace within the limit so we don't slice
    // a word in half. If the prefix has no space, fall back to a hard cut.
    let prefix: String = chars.iter().take(limit).collect();
    let cut_at = prefix
        .rfind(|c: char| c.is_whitespace())
        .filter(|i| *i >= max_chars / 2)
        .map(|i| prefix[..i].trim_end().to_string())
        .unwrap_or(prefix);
    format!("{cut_at}…")
}

/// Trim `s` to at most `max_chars` characters with an ellipsis. Sketchfab
/// caps the description field at 1024 characters; longer strings 400.
fn clamp_description(s: &str, max_chars: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= max_chars {
        return s.to_string();
    }
    let limit = max_chars.saturating_sub(1).max(1);
    let prefix: String = chars.iter().take(limit).collect();
    format!("{prefix}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_name_short_unchanged() {
        assert_eq!(clamp_name("Norse Wolf STL", 48), "Norse Wolf STL");
    }

    #[test]
    fn clamp_name_word_boundary() {
        let long = "Lovecraftian Deep One Altar Figurine STL Cthulhu Cosmic Horror 3D Print";
        let out = clamp_name(long, 48);
        assert!(out.chars().count() <= 48, "length was {}", out.chars().count());
        assert!(out.ends_with('…'));
        // Should not end mid-word — last char before ellipsis is whitespace-
        // trimmed (no trailing space).
        assert!(!out[..out.len() - "…".len()].ends_with(' '));
    }

    #[test]
    fn clamp_name_no_space_hard_cut() {
        let s = "x".repeat(80);
        let out = clamp_name(&s, 48);
        assert_eq!(out.chars().count(), 48);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn clamp_description_long_trimmed() {
        let s = "a".repeat(2000);
        let out = clamp_description(&s, 1024);
        assert_eq!(out.chars().count(), 1024);
        assert!(out.ends_with('…'));
    }
}

#[derive(Debug, Clone)]
pub struct Creds {
    pub api_token: String,
}

impl Creds {
    pub fn auth_header(&self) -> String {
        format!("Token {}", self.api_token)
    }
}

#[derive(Debug, Clone)]
pub struct UploadInput {
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    /// Sketchfab category slug, e.g. "characters-creatures", "places-travel".
    /// None lets Sketchfab autoplace.
    pub category: Option<String>,
    /// CC license slug for FREE listings — one of cc0/by/by-sa/by-nd/by-nc/
    /// by-nc-sa/by-nc-nd. Ignored when `price_usd` is Some (Store handles licensing).
    pub free_license: Option<String>,
    /// If Some, after upload we POST to /me/store/products to put the model on
    /// the Sketchfab Store. Requires Pro+ on the account.
    pub price_usd: Option<f64>,
    pub is_published: bool,
    /// Whether downloadable in the viewer (free model). For Store models this
    /// is ignored; Store gates downloads behind purchase.
    pub is_downloadable: bool,
}

#[derive(Debug, Clone)]
pub struct UploadResult {
    pub uid: String,
    pub url: String,
    /// Store product id if we successfully put the model on sale. Best-effort.
    pub store_product_id: Option<String>,
    /// Any non-fatal warning (e.g. Store creation failed but upload succeeded).
    pub warning: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MeResp {
    username: String,
}

#[derive(Debug, Deserialize)]
struct UploadResp {
    uid: String,
}

/// Lightweight auth ping: fetch /me. Returns the authenticated username.
pub async fn verify(client: &reqwest::Client, creds: &Creds) -> Result<String> {
    let resp = client
        .get(format!("{API_BASE}/me"))
        .header("Authorization", creds.auth_header())
        .header("User-Agent", UA)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .context("sketchfab GET /me failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("sketchfab /me HTTP {status}: {text}"));
    }
    let parsed: MeResp =
        serde_json::from_str(&text).with_context(|| format!("parse /me JSON: {text}"))?;
    Ok(parsed.username)
}

/// Upload a 3D model file (STL/GLB/FBX/OBJ/DAE) via multipart. Returns the
/// model uid + public URL. If `input.price_usd` is set, also attempts to add
/// the model to the Sketchfab Store (best-effort).
pub async fn upload_model(
    client: &reqwest::Client,
    creds: &Creds,
    model_path: &Path,
    input: &UploadInput,
) -> Result<UploadResult> {
    let bytes = tokio::fs::read(model_path)
        .await
        .with_context(|| format!("read model file {}", model_path.display()))?;
    let filename = model_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("model.glb")
        .to_string();

    // Sketchfab API caps `name` at 48 chars and `description` at 1024.
    // Etsy titles run up to 140 chars — without truncation here every
    // upload fails with HTTP 400 "Ensure this value has at most 48
    // characters". Trim on a word boundary to avoid awkward mid-word cuts,
    // and only suffix the ellipsis when we actually had to trim.
    let name = clamp_name(&input.name, 48);
    let description = clamp_description(&input.description, 1024);
    let tags_joined = input.tags.join(" ");
    let mut form = reqwest::multipart::Form::new()
        .text("name", name)
        .text("description", description)
        .text("tags", tags_joined)
        .text("isPublished", input.is_published.to_string())
        .text("isInspectable", "true".to_string())
        .text("private", "false".to_string());

    if input.price_usd.is_none() {
        // Free listing — set CC license + downloadable flag.
        form = form
            .text(
                "license",
                input.free_license.clone().unwrap_or_else(|| "by".into()),
            )
            .text("isDownloadable", input.is_downloadable.to_string());
    }
    if let Some(cat) = &input.category {
        form = form.text("categories", cat.clone());
    }
    let model_part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str("application/octet-stream")?;
    form = form.part("modelFile", model_part);

    let resp = client
        .post(format!("{API_BASE}/models"))
        .header("Authorization", creds.auth_header())
        .header("User-Agent", UA)
        .multipart(form)
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .context("sketchfab POST /models failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("sketchfab upload HTTP {status}: {text}"));
    }
    let parsed: UploadResp =
        serde_json::from_str(&text).with_context(|| format!("parse upload JSON: {text}"))?;
    let uid = parsed.uid;
    let url = format!("https://sketchfab.com/3d-models/{uid}");

    let mut store_product_id = None;
    let mut warning = None;

    if let Some(price) = input.price_usd {
        match create_store_product(client, creds, &uid, price).await {
            Ok(pid) => store_product_id = Some(pid),
            Err(e) => warning = Some(format!("store product creation failed: {e:#}")),
        }
    }

    Ok(UploadResult {
        uid,
        url,
        store_product_id,
        warning,
    })
}

#[derive(Debug, Deserialize)]
struct StoreProductResp {
    uid: String,
}

/// Put a model on the Sketchfab Store. Requires the account to have an
/// active Pro+ subscription with Store enabled. Failures are non-fatal at
/// the caller (warning returned, model still uploaded).
async fn create_store_product(
    client: &reqwest::Client,
    creds: &Creds,
    model_uid: &str,
    price_usd: f64,
) -> Result<String> {
    // Sketchfab Store expects price in cents (integer).
    let price_cents = (price_usd * 100.0).round() as i64;
    let body = serde_json::json!({
        "model": model_uid,
        "price": price_cents,
        "currency": "USD",
    });
    let resp = client
        .post(format!("{API_BASE}/me/store/products"))
        .header("Authorization", creds.auth_header())
        .header("User-Agent", UA)
        .header("Content-Type", "application/json")
        .json(&body)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .context("sketchfab POST /me/store/products failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("store HTTP {status}: {text}"));
    }
    let parsed: StoreProductResp =
        serde_json::from_str(&text).with_context(|| format!("parse store JSON: {text}"))?;
    Ok(parsed.uid)
}

/// Heuristic category picker — Sketchfab's category slugs are stable and
/// the list is small (~15). Tries to match niche/tag keywords to a slug;
/// returns None if no signal (Sketchfab will infer).
pub fn pick_category(niche: &str, tags: &[String]) -> Option<String> {
    let hay = format!("{} {}", niche, tags.join(" ")).to_lowercase();
    // Pairs of (slug, keyword_set). Order matters — first match wins on ties.
    let table: &[(&str, &[&str])] = &[
        ("characters-creatures", &["character", "creature", "monster", "figure", "miniature", "mini"]),
        ("animals-pets", &["animal", "pet", "dog", "cat", "horse", "bird", "wildlife"]),
        ("places-travel", &["building", "architecture", "city", "landmark", "house", "castle"]),
        ("furniture-home", &["furniture", "chair", "table", "lamp", "decor", "decoration", "vase"]),
        ("weapons-military", &["weapon", "gun", "sword", "armor", "tank", "military"]),
        ("cultural-heritage", &["statue", "sculpture", "artifact", "historic", "museum"]),
        ("electronics-gadgets", &["electronic", "gadget", "phone", "computer", "device"]),
        ("food-drink", &["food", "drink", "fruit", "vegetable", "meal", "kitchen"]),
        ("nature-plants", &["plant", "tree", "flower", "leaf", "garden"]),
        ("art-abstract", &["abstract", "art", "design", "pattern"]),
        ("cars-vehicles", &["car", "vehicle", "truck", "motorcycle", "bike"]),
    ];
    for (slug, kws) in table {
        if kws.iter().any(|kw| hay.contains(kw)) {
            return Some((*slug).to_string());
        }
    }
    None
}
