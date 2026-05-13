//! Real Etsy v3 receipts ingest.
//!
//! Poll new paid receipts → append outcomes.jsonl rows the SI / orchestrator
//! loops already consume. Listing-stats and conversations/messages ingest
//! used to live here too — they were removed (2026-05-13) because Etsy v3
//! never shipped those endpoints, so every call returned a permanent 404.
//!
//! All network helpers in this module are pure: they accept a `reqwest::Client`
//! plus an explicit `api_base` URL so tests can point them at mockito servers.
//! The polling task in `etsy_polling.rs` uses `etsy::API_BASE` and
//! `etsy::ensure_fresh_token` directly.

use crate::etsy;
use anyhow::{Context, Result};
use serde::Deserialize;
use std::collections::HashMap;

/// Default limit when listing receipts.
pub const DEFAULT_LIMIT: i64 = 25;

#[derive(Debug, Deserialize, Clone)]
pub struct Receipt {
    pub receipt_id: i64,
    #[serde(default)]
    pub creation_timestamp: i64,
    #[serde(default)]
    pub transactions: Vec<Transaction>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct Transaction {
    pub listing_id: i64,
    #[serde(default = "default_quantity")]
    pub quantity: i32,
    pub price: Price,
}

fn default_quantity() -> i32 {
    1
}

#[derive(Debug, Deserialize, Clone)]
pub struct Price {
    pub amount: i64,
    pub divisor: i64,
    #[serde(default)]
    pub currency_code: Option<String>,
}

impl Price {
    pub fn usd(&self) -> f64 {
        if self.divisor == 0 {
            return 0.0;
        }
        self.amount as f64 / self.divisor as f64
    }
}

#[derive(Debug, Deserialize)]
pub struct ReceiptsPage {
    #[serde(default)]
    pub count: i64,
    #[serde(default)]
    pub results: Vec<Receipt>,
}

/// Fetch the most recent paid + non-canceled receipts from a shop, returning
/// only those whose `receipt_id` is strictly greater than `last_seen_id`.
pub async fn fetch_new_receipts(
    client: &reqwest::Client,
    api_base: &str,
    access_token: &str,
    shop_id: i64,
    last_seen_id: i64,
) -> Result<Vec<Receipt>> {
    let url = format!(
        "{}/shops/{}/receipts?was_paid=true&was_canceled=false&limit={}",
        api_base, shop_id, DEFAULT_LIMIT
    );
    let resp = client
        .get(&url)
        .bearer_auth(access_token)
        .header("x-api-key", crate::etsy::api_key_header()?)
        .send()
        .await
        .context("fetch receipts GET failed")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("fetch receipts HTTP {}: {}", status, body);
    }
    let body = resp.text().await.context("read receipts body")?;
    let page: ReceiptsPage =
        serde_json::from_str(&body).with_context(|| format!("parse receipts JSON: {body}"))?;
    Ok(page
        .results
        .into_iter()
        .filter(|r| r.receipt_id > last_seen_id)
        .collect())
}

/// POST a reply into an Etsy conversation. Body is
/// `message=<text>` URL-encoded.
pub async fn post_reply(
    client: &reqwest::Client,
    api_base: &str,
    access_token: &str,
    shop_id: i64,
    conversation_id: i64,
    text: &str,
) -> Result<()> {
    let url = format!(
        "{}/shops/{}/conversations/{}/messages",
        api_base, shop_id, conversation_id
    );
    let resp = client
        .post(&url)
        .bearer_auth(access_token)
        .header("x-api-key", crate::etsy::api_key_header()?)
        .form(&[("message", text)])
        .send()
        .await
        .context("post reply POST failed")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("post reply HTTP {}: {}", status, body);
    }
    Ok(())
}

/// Convenience wrapper around `post_reply` that pulls a fresh access token
/// from the keychain (rotating if needed) and reads the keystring + shop id.
pub async fn post_reply_with_status(
    client: &reqwest::Client,
    shop_id: i64,
    conversation_id: i64,
    text: &str,
) -> Result<()> {
    // api_key_header() reads the keystring from the keychain on each request,
    // but we still surface a missing key early for a clearer error.
    if crate::secrets::get("etsy_api_keystring")?
        .map(|k| k.is_empty())
        .unwrap_or(true)
    {
        return Err(anyhow::anyhow!("etsy_api_keystring not in keychain"));
    }
    let access = etsy::ensure_fresh_token(client).await?;
    post_reply(
        client,
        etsy::API_BASE,
        &access,
        shop_id,
        conversation_id,
        text,
    )
    .await
}

/// Resolve the outcomes data directory used by cfo / SI / orchestrator.
/// Honors `AGENT_FACTORY_DATA` for test isolation, falling back to
/// `~/.agent-factory`.
fn data_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("AGENT_FACTORY_DATA") {
        return std::path::PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    std::path::PathBuf::from(home).join(".agent-factory")
}

fn outcomes_path() -> std::path::PathBuf {
    data_dir().join("outcomes.jsonl")
}

/// Append a cross-marketplace publish row to outcomes.jsonl. Used by the
/// non-Etsy publishers (Cults3D, Sketchfab, Gumroad, MyMiniFactory) so the
/// strategist can see how listings are spread across all stores even before
/// any sale lands. `source` should be "sketchfab_publish", etc.
pub fn append_marketplace_publish_outcome(
    source: &str,
    local_listing_id: i64,
    niche: &str,
    title: &str,
    marketplace_id: &str,
    url: Option<&str>,
    price_usd: f64,
) -> Result<()> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("mkdir {}", dir.display()))?;
    let path = outcomes_path();
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("open {}", path.display()))?;
    use std::io::Write;
    let row = serde_json::json!({
        "ts": chrono::Utc::now().timestamp(),
        "listing_id": local_listing_id,
        "niche": niche,
        "title": title,
        "sales": 0,
        "revenue_usd": 0.0,
        "price_usd": price_usd,
        "marketplace_id": marketplace_id,
        "url": url,
        "source": source,
    });
    writeln!(f, "{row}").context("write outcomes.jsonl marketplace publish row")?;
    Ok(())
}

/// Append one outcomes.jsonl row per transaction in the receipt. The shape
/// matches what cfo writes today so SI / orchestrator pick it up unchanged.
pub fn append_outcome_for_receipt(
    receipt: &Receipt,
    listing_id_to_niche: &HashMap<i64, String>,
) -> Result<f64> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("mkdir {}", dir.display()))?;
    let path = outcomes_path();
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("open {}", path.display()))?;
    use std::io::Write;
    let mut total_usd = 0.0;
    for txn in &receipt.transactions {
        let rev = txn.price.usd() * (txn.quantity.max(1) as f64);
        total_usd += rev;
        let niche = listing_id_to_niche
            .get(&txn.listing_id)
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        let row = serde_json::json!({
            "ts": receipt.creation_timestamp,
            "listing_id": txn.listing_id,
            "niche": niche,
            "sales": txn.quantity.max(1),
            "revenue_usd": (rev * 100.0).round() / 100.0,
            "source": "etsy_receipt",
            "receipt_id": receipt.receipt_id,
        });
        writeln!(f, "{}", row.to_string())
            .with_context(|| format!("write outcomes.jsonl"))?;
    }
    Ok((total_usd * 100.0).round() / 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_price_usd() {
        let p = Price {
            amount: 350,
            divisor: 100,
            currency_code: Some("USD".into()),
        };
        assert!((p.usd() - 3.50).abs() < 1e-9);
        // Divisor=0 must not panic and must yield 0.0.
        let z = Price {
            amount: 999,
            divisor: 0,
            currency_code: None,
        };
        assert_eq!(z.usd(), 0.0);
        // Larger numbers.
        let big = Price {
            amount: 1_999_99,
            divisor: 100,
            currency_code: None,
        };
        assert!((big.usd() - 1999.99).abs() < 1e-6);
    }

    #[test]
    fn test_receipts_page_parses() {
        let json = r#"
        {
          "count": 1,
          "results": [
            {
              "receipt_id": 12345,
              "creation_timestamp": 1730000000,
              "transactions": [
                {
                  "listing_id": 999,
                  "quantity": 2,
                  "price": {"amount": 350, "divisor": 100, "currency_code": "USD"}
                }
              ]
            }
          ]
        }"#;
        let page: ReceiptsPage = serde_json::from_str(json).unwrap();
        assert_eq!(page.count, 1);
        assert_eq!(page.results.len(), 1);
        let r = &page.results[0];
        assert_eq!(r.receipt_id, 12345);
        assert_eq!(r.creation_timestamp, 1730000000);
        assert_eq!(r.transactions.len(), 1);
        let t = &r.transactions[0];
        assert_eq!(t.listing_id, 999);
        assert_eq!(t.quantity, 2);
        assert!((t.price.usd() - 3.50).abs() < 1e-9);
    }

    #[tokio::test]
    async fn test_fetch_new_receipts_filters_by_last_seen() {
        crate::secrets::set_cache_for_test("etsy_api_keystring", Some("KEY123"));
        crate::secrets::set_cache_for_test("etsy_shared_secret", None);
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("GET", "/shops/9999/receipts")
            .match_query(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("was_paid".into(), "true".into()),
                mockito::Matcher::UrlEncoded("was_canceled".into(), "false".into()),
                mockito::Matcher::UrlEncoded("limit".into(), "25".into()),
            ]))
            .match_header("authorization", "Bearer fake.tok")
            .match_header("x-api-key", "KEY123")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{
                  "count": 3,
                  "results": [
                    {"receipt_id": 10, "creation_timestamp": 1, "transactions": []},
                    {"receipt_id": 11, "creation_timestamp": 2, "transactions": [
                      {"listing_id": 1, "quantity": 1, "price": {"amount": 500, "divisor": 100}}
                    ]},
                    {"receipt_id": 12, "creation_timestamp": 3, "transactions": []}
                  ]
                }"#,
            )
            .create_async()
            .await;

        let client = reqwest::Client::new();
        let new_receipts =
            fetch_new_receipts(&client, &server.url(), "fake.tok", 9999, 10)
                .await
                .unwrap();
        mock.assert_async().await;
        // Only receipts with id > 10 → 11 and 12.
        let ids: Vec<i64> = new_receipts.iter().map(|r| r.receipt_id).collect();
        assert_eq!(ids, vec![11, 12]);
    }

    #[tokio::test]
    async fn test_post_reply_form_body() {
        crate::secrets::set_cache_for_test("etsy_api_keystring", Some("KEY123"));
        crate::secrets::set_cache_for_test("etsy_shared_secret", None);
        let mut server = mockito::Server::new_async().await;
        // "hello world!" URL-encoded as "hello+world%21" — accept either +
        // or %20 for the space (reqwest uses application/x-www-form-urlencoded).
        let mock = server
            .mock("POST", "/shops/42/conversations/77/messages")
            .match_header("authorization", "Bearer tok123")
            .match_header("x-api-key", "KEY123")
            .match_header(
                "content-type",
                "application/x-www-form-urlencoded",
            )
            .match_body(mockito::Matcher::Any)
            .with_status(200)
            .with_body("{}")
            .create_async()
            .await;
        let client = reqwest::Client::new();
        post_reply(
            &client,
            &server.url(),
            "tok123",
            42,
            77,
            "hello world!",
        )
        .await
        .unwrap();
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn test_post_reply_form_body_contents() {
        // Separately verify the form body actually contains `message=...`.
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/shops/42/conversations/77/messages")
            .match_body(mockito::Matcher::UrlEncoded(
                "message".into(),
                "hi there".into(),
            ))
            .with_status(200)
            .with_body("{}")
            .create_async()
            .await;
        let client = reqwest::Client::new();
        post_reply(&client, &server.url(), "tok", 42, 77, "hi there")
            .await
            .unwrap();
        mock.assert_async().await;
    }

    #[test]
    fn test_append_outcome_for_receipt_writes_jsonl() {
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("AGENT_FACTORY_DATA", tmp.path());
        let receipt = Receipt {
            receipt_id: 999,
            creation_timestamp: 1730000123,
            transactions: vec![
                Transaction {
                    listing_id: 1,
                    quantity: 2,
                    price: Price {
                        amount: 500,
                        divisor: 100,
                        currency_code: Some("USD".into()),
                    },
                },
                Transaction {
                    listing_id: 99,
                    quantity: 1,
                    price: Price {
                        amount: 1200,
                        divisor: 100,
                        currency_code: None,
                    },
                },
            ],
        };
        let mut niches = HashMap::new();
        niches.insert(1i64, "boho-prints".to_string());
        // listing 99 deliberately absent → must fall back to "unknown".

        let total = append_outcome_for_receipt(&receipt, &niches).unwrap();
        // 2 * $5.00 + 1 * $12.00 = $22.00
        assert!((total - 22.0).abs() < 1e-9);
        let path = tmp.path().join("outcomes.jsonl");
        let body = std::fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = body.lines().collect();
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["listing_id"], 1);
        assert_eq!(first["niche"], "boho-prints");
        assert_eq!(first["sales"], 2);
        assert_eq!(first["revenue_usd"].as_f64().unwrap(), 10.0);
        assert_eq!(first["source"], "etsy_receipt");
        assert_eq!(first["receipt_id"], 999);
        let second: serde_json::Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(second["listing_id"], 99);
        assert_eq!(second["niche"], "unknown");
        assert_eq!(second["sales"], 1);
        assert_eq!(second["revenue_usd"].as_f64().unwrap(), 12.0);

        std::env::remove_var("AGENT_FACTORY_DATA");
    }
}
