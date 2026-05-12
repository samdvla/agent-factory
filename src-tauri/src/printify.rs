//! Printify HTTP client.
//!
//! Auth: Bearer PAT in the `Authorization` header. A non-blank `User-Agent`
//! is required — Printify rejects unbranded requests. Rate limits: 600
//! req/min global; we don't approach that at our volume.
//!
//! Public API:
//!   - `list_shops` — discover connected shops (used by Verify)
//!   - `find_sticker_blueprint` / `first_print_provider` / `pick_small_variants`
//!     — catalog walkers used when we first need to publish
//!   - `upload_image_base64` — push the print PNG to Printify, return file id
//!   - `create_product` — build the product against blueprint/provider/variants
//!   - `publish_product` — push the product to Etsy as a draft

use anyhow::{Context, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const API_BASE: &str = "https://api.printify.com/v1";
const USER_AGENT: &str = "agent-factory/0.1 (+https://github.com/biker222)";

fn client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .context("build reqwest client")
}

async fn handle_json(resp: reqwest::Response, ctx: &str) -> Result<Value> {
    let status = resp.status();
    let body = resp.text().await.with_context(|| format!("read {ctx} body"))?;
    if !status.is_success() {
        anyhow::bail!("printify {ctx} HTTP {status}: {body}");
    }
    serde_json::from_str::<Value>(&body)
        .with_context(|| format!("parse {ctx} JSON: {body}"))
}

/* ---------------------------------------------------------------- */
/*  Shops                                                            */
/* ---------------------------------------------------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shop {
    pub id: i64,
    pub title: String,
    pub sales_channel: String,
}

pub async fn list_shops(api_key: &str) -> Result<Vec<Shop>> {
    let url = format!("{API_BASE}/shops.json");
    let resp = client()?.get(&url).bearer_auth(api_key).send().await
        .context("shops GET failed")?;
    let v = handle_json(resp, "shops").await?;
    Ok(serde_json::from_value(v).context("parse shops")?)
}

pub fn pick_etsy_shop(shops: &[Shop]) -> Option<&Shop> {
    shops.iter().find(|s| s.sales_channel.eq_ignore_ascii_case("etsy"))
}

/* ---------------------------------------------------------------- */
/*  Catalog discovery                                                */
/* ---------------------------------------------------------------- */

#[derive(Debug, Clone, Deserialize)]
pub struct Blueprint {
    pub id: i64,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PrintProvider {
    pub id: i64,
    pub title: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Variant {
    pub id: i64,
    pub title: String,
    #[serde(default)]
    pub price: Option<i64>,
}

/// Find the kiss-cut sticker blueprint. Printify's catalog uses titles like
/// "Kiss-Cut Stickers"; we match case-insensitively on "kiss-cut" + "sticker"
/// so it survives small wording changes.
pub async fn find_sticker_blueprint(api_key: &str) -> Result<Blueprint> {
    let url = format!("{API_BASE}/catalog/blueprints.json");
    let resp = client()?.get(&url).bearer_auth(api_key).send().await
        .context("blueprints GET failed")?;
    let v = handle_json(resp, "blueprints").await?;
    let arr = v.as_array().ok_or_else(|| anyhow::anyhow!("blueprints not an array"))?;
    let mut blueprints: Vec<Blueprint> = arr.iter()
        .filter_map(|b| serde_json::from_value::<Blueprint>(b.clone()).ok())
        .collect();
    // Prefer "kiss-cut sticker", then fall back to anything with "sticker" in title.
    blueprints.sort_by_key(|b| {
        let t = b.title.to_lowercase();
        let kiss = t.contains("kiss-cut") || t.contains("kiss cut");
        let sticker = t.contains("sticker");
        match (kiss, sticker) {
            (true, true) => 0,
            (false, true) => 1,
            _ => 2,
        }
    });
    blueprints.into_iter().next()
        .filter(|b| b.title.to_lowercase().contains("sticker"))
        .ok_or_else(|| anyhow::anyhow!("no sticker blueprint found in Printify catalog"))
}

pub async fn list_print_providers(api_key: &str, blueprint_id: i64) -> Result<Vec<PrintProvider>> {
    let url = format!("{API_BASE}/catalog/blueprints/{blueprint_id}/print_providers.json");
    let resp = client()?.get(&url).bearer_auth(api_key).send().await
        .context("providers GET failed")?;
    let v = handle_json(resp, "providers").await?;
    Ok(serde_json::from_value(v).context("parse providers")?)
}

pub async fn list_variants(api_key: &str, blueprint_id: i64, provider_id: i64) -> Result<Vec<Variant>> {
    let url = format!(
        "{API_BASE}/catalog/blueprints/{blueprint_id}/print_providers/{provider_id}/variants.json"
    );
    let resp = client()?.get(&url).bearer_auth(api_key).send().await
        .context("variants GET failed")?;
    let v = handle_json(resp, "variants").await?;
    // Variants endpoint wraps in { id, title, variants: [...] }
    let arr = v.get("variants").and_then(|a| a.as_array())
        .ok_or_else(|| anyhow::anyhow!("variants response missing `variants` array: {v}"))?;
    Ok(arr.iter()
        .filter_map(|x| serde_json::from_value::<Variant>(x.clone()).ok())
        .collect())
}

/// Pick up to N variants that look like the smaller sticker sizes (3"–4") —
/// those have the best margin at our $12 retail cap.
pub fn pick_small_variants(variants: &[Variant], max: usize) -> Vec<i64> {
    let mut scored: Vec<(i32, i64)> = variants.iter()
        .map(|v| {
            let t = v.title.to_lowercase();
            // Prefer titles containing 3"/4", deprioritize 5.5"/6".
            let score = if t.contains("3\"") || t.contains("3 inch") { 0 }
                else if t.contains("4\"") || t.contains("4 inch") { 1 }
                else if t.contains("5\"") || t.contains("5.5\"") { 2 }
                else if t.contains("6\"") || t.contains("6 inch") { 3 }
                else { 4 };
            (score, v.id)
        })
        .collect();
    scored.sort_by_key(|(s, _)| *s);
    scored.into_iter().take(max).map(|(_, id)| id).collect()
}

/* ---------------------------------------------------------------- */
/*  Uploads                                                          */
/* ---------------------------------------------------------------- */

#[derive(Debug, Clone, Deserialize)]
pub struct UploadedImage {
    pub id: String,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub preview_url: Option<String>,
}

pub async fn upload_image_base64(api_key: &str, file_name: &str, png_bytes: &[u8]) -> Result<UploadedImage> {
    let url = format!("{API_BASE}/uploads/images.json");
    let body = json!({
        "file_name": file_name,
        "contents": base64::engine::general_purpose::STANDARD.encode(png_bytes),
    });
    let resp = client()?.post(&url).bearer_auth(api_key).json(&body).send().await
        .context("upload POST failed")?;
    let v = handle_json(resp, "upload").await?;
    Ok(serde_json::from_value(v).context("parse upload response")?)
}

/* ---------------------------------------------------------------- */
/*  Product create + publish                                         */
/* ---------------------------------------------------------------- */

#[derive(Debug, Clone, Deserialize)]
pub struct CreatedProduct {
    pub id: String,
    #[serde(default)]
    pub title: Option<String>,
}

/// Build a Printify product against `blueprint_id` / `provider_id` / `variant_ids`
/// using the freshly uploaded `image_id` as the single print-area placement.
/// Pricing is per-variant in cents and applied to every variant.
pub async fn create_product(
    api_key: &str,
    shop_id: i64,
    title: &str,
    description: &str,
    tags: &[String],
    price_cents: i64,
    blueprint_id: i64,
    provider_id: i64,
    variant_ids: &[i64],
    image_id: &str,
) -> Result<CreatedProduct> {
    let url = format!("{API_BASE}/shops/{shop_id}/products.json");
    let variants_json: Vec<Value> = variant_ids.iter().map(|vid| json!({
        "id": vid,
        "price": price_cents,
        "is_enabled": true,
    })).collect();
    // Single placeholder for the front print area, centered, full size.
    let print_areas = vec![json!({
        "variant_ids": variant_ids,
        "placeholders": [{
            "position": "front",
            "images": [{
                "id": image_id,
                "x": 0.5, "y": 0.5,
                "scale": 1.0,
                "angle": 0,
            }],
        }],
    })];
    let body = json!({
        "title": title,
        "description": description,
        "tags": tags,
        "blueprint_id": blueprint_id,
        "print_provider_id": provider_id,
        "variants": variants_json,
        "print_areas": print_areas,
    });
    let resp = client()?.post(&url).bearer_auth(api_key).json(&body).send().await
        .context("create product POST failed")?;
    let v = handle_json(resp, "create product").await?;
    Ok(serde_json::from_value(v).context("parse create product")?)
}

/// Push a created product to the connected Etsy shop. Printify creates the
/// Etsy draft on our behalf — the user reviews & activates in Etsy seller
/// dashboard (or via our existing `cmd_etsy_activate_listing` once we wire
/// the etsy_listing_id back through their webhook).
pub async fn publish_product(api_key: &str, shop_id: i64, product_id: &str) -> Result<()> {
    let url = format!("{API_BASE}/shops/{shop_id}/products/{product_id}/publish.json");
    // Publish flags: ship every editable field so Etsy mirrors what we built.
    let body = json!({
        "title": true, "description": true, "images": true,
        "variants": true, "tags": true, "key_features": true, "shipping_template": true,
    });
    let resp = client()?.post(&url).bearer_auth(api_key).json(&body).send().await
        .context("publish POST failed")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("printify publish HTTP {status}: {body}");
    }
    Ok(())
}

/* ---------------------------------------------------------------- */
/*  Unit tests for the pure helpers                                  */
/* ---------------------------------------------------------------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_etsy_shop_finds_etsy_case_insensitively() {
        let shops = vec![
            Shop { id: 1, title: "shopify-store".into(), sales_channel: "shopify".into() },
            Shop { id: 2, title: "etsy-store".into(), sales_channel: "Etsy".into() },
        ];
        assert_eq!(pick_etsy_shop(&shops).unwrap().id, 2);
    }

    #[test]
    fn pick_etsy_shop_returns_none_when_only_non_etsy() {
        let shops = vec![
            Shop { id: 1, title: "shopify-store".into(), sales_channel: "shopify".into() },
        ];
        assert!(pick_etsy_shop(&shops).is_none());
    }

    #[test]
    fn pick_small_variants_prefers_3_then_4_inch_titles() {
        let variants = vec![
            Variant { id: 1, title: "6\" x 6\"".into(), price: None },
            Variant { id: 2, title: "3\" x 3\"".into(), price: None },
            Variant { id: 3, title: "4\" x 4\"".into(), price: None },
            Variant { id: 4, title: "5.5\" x 5.5\"".into(), price: None },
        ];
        let picked = pick_small_variants(&variants, 2);
        assert_eq!(picked, vec![2, 3]);
    }
}
