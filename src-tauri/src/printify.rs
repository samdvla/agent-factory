//! Printify HTTP client.
//!
//! We start with the credential-verification surface only:
//!   - `verify_credentials` calls `GET /v1/shops.json` with the user's
//!     Personal Access Token and returns the first connected shop.
//!
//! Future commits add:
//!   - image upload (`POST /v1/uploads/images.json`)
//!   - product create + publish (`POST /v1/shops/{id}/products(.json|/{pid}/publish.json)`)
//!   - order webhooks
//!
//! Auth: Bearer PAT in `Authorization` header.
//! Required: a `User-Agent` header per Printify docs — they reject blank UAs.
//! Rate limits: 600 req/min global; we don't hit those at our volume yet.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

const API_BASE: &str = "https://api.printify.com/v1";
const USER_AGENT: &str = "agent-factory/0.1 (+https://github.com/biker222)";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shop {
    pub id: i64,
    pub title: String,
    /// Sales channel: "etsy", "shopify", "woocommerce", etc. We only care about "etsy".
    pub sales_channel: String,
}

/// Verify the Printify PAT and discover connected shops. Returns the full list
/// — caller picks the Etsy one. Errors when the token is invalid, the network
/// is down, or no shop is connected on the account.
pub async fn list_shops(api_key: &str) -> Result<Vec<Shop>> {
    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .context("build reqwest client")?;
    let url = format!("{API_BASE}/shops.json");
    let resp = client
        .get(&url)
        .bearer_auth(api_key)
        .send()
        .await
        .context("printify shops GET failed")?;
    let status = resp.status();
    let body = resp.text().await.context("read shops body")?;
    if !status.is_success() {
        anyhow::bail!("printify shops HTTP {status}: {body}");
    }
    let shops: Vec<Shop> =
        serde_json::from_str(&body).with_context(|| format!("parse shops JSON: {body}"))?;
    Ok(shops)
}

/// Pick the Etsy shop out of the connected-shops list. We refuse to operate
/// against a non-Etsy channel (Shopify/WC are out of scope for this build).
pub fn pick_etsy_shop(shops: &[Shop]) -> Option<&Shop> {
    shops.iter().find(|s| s.sales_channel.eq_ignore_ascii_case("etsy"))
}
