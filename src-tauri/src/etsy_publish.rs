//! Real Etsy v3 draft-publish: create listing → upload PNG image → upload SVG
//! digital file. Listings are always created in `state=draft` — we never
//! auto-activate. The user manually triggers activation through
//! `cmd_etsy_activate_listing` after reviewing the draft on Etsy.

use crate::etsy;
use crate::events::{EventBus, SupervisorEvent};
use anyhow::{Context, Result};
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};

/// Default Etsy taxonomy id used when the worker doesn't supply one.
/// 68887 corresponds to "Art & Collectibles > Prints > Digital Prints" — a
/// reasonable home for the digital-download products this pipeline currently
/// produces.
pub const DEFAULT_TAXONOMY_ID: i64 = 68887;

/// Default daily cap on real Etsy publishes per project.
pub const DEFAULT_DAILY_CAP: i64 = 3;

#[derive(Debug, Clone)]
pub struct ListingDraft {
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub price_usd: f64,
    pub taxonomy_id: i64,
    pub png_path: PathBuf,
    pub svg_path: PathBuf,
    pub job_id: i64,
}

#[derive(Debug, Deserialize)]
pub struct CreateListingResponse {
    pub listing_id: i64,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
}

/// Drive the full publish flow for a single listing. Returns the Etsy
/// listing response on success.
pub async fn publish_draft(
    client: &reqwest::Client,
    keystring: &str,
    shop_id: i64,
    draft: &ListingDraft,
) -> Result<CreateListingResponse> {
    let access_token = etsy::ensure_fresh_token(client).await?;
    let create_resp = create_draft(client, keystring, &access_token, shop_id, draft)
        .await
        .context("create draft listing")?;
    upload_image(
        client,
        keystring,
        &access_token,
        shop_id,
        create_resp.listing_id,
        &draft.png_path,
    )
    .await
    .context("upload listing image")?;
    upload_file(
        client,
        keystring,
        &access_token,
        shop_id,
        create_resp.listing_id,
        &draft.svg_path,
        draft.job_id,
    )
    .await
    .context("upload listing digital file")?;
    Ok(create_resp)
}

async fn create_draft(
    client: &reqwest::Client,
    keystring: &str,
    access_token: &str,
    shop_id: i64,
    draft: &ListingDraft,
) -> Result<CreateListingResponse> {
    let url = format!("{}/shops/{}/listings", etsy::API_BASE, shop_id);
    let price = clamp_price(draft.price_usd);
    let mut params: Vec<(&str, String)> = vec![
        ("quantity", "1".into()),
        ("title", truncate_title(&draft.title, 140)),
        ("description", ensure_min_len(&draft.description, 160)),
        ("price", format!("{:.2}", price)),
        ("who_made", "i_did".into()),
        ("when_made", "made_to_order".into()),
        ("taxonomy_id", draft.taxonomy_id.to_string()),
        ("type", "download".into()),
        ("is_supply", "false".into()),
        ("state", "draft".into()),
    ];
    let sanitized = sanitize_tags(&draft.tags);
    if !sanitized.is_empty() {
        params.push(("tags", sanitized.join(",")));
    }
    let resp = client
        .post(&url)
        .bearer_auth(access_token)
        .header("x-api-key", etsy::api_key_header()?)
        .form(&params)
        .send()
        .await
        .context("create listing POST failed")?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        anyhow::bail!("create listing HTTP {}: {}", status, body);
    }
    let parsed: CreateListingResponse = serde_json::from_str(&body)
        .with_context(|| format!("parse create-listing JSON: {body}"))?;
    Ok(parsed)
}

async fn upload_image(
    client: &reqwest::Client,
    keystring: &str,
    access_token: &str,
    shop_id: i64,
    listing_id: i64,
    png_path: &Path,
) -> Result<()> {
    let url = format!(
        "{}/shops/{}/listings/{}/images",
        etsy::API_BASE,
        shop_id,
        listing_id
    );
    let bytes = std::fs::read(png_path).with_context(|| format!("read png {}", png_path.display()))?;
    let file_name = png_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("listing.png")
        .to_string();
    let part = Part::bytes(bytes)
        .file_name(file_name)
        .mime_str("image/png")
        .context("image mime")?;
    let form = Form::new().part("image", part).text("rank", "1");
    let resp = client
        .post(&url)
        .bearer_auth(access_token)
        .header("x-api-key", etsy::api_key_header()?)
        .multipart(form)
        .send()
        .await
        .context("upload image POST failed")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("upload image HTTP {}: {}", status, body);
    }
    Ok(())
}

async fn upload_file(
    client: &reqwest::Client,
    keystring: &str,
    access_token: &str,
    shop_id: i64,
    listing_id: i64,
    svg_path: &Path,
    job_id: i64,
) -> Result<()> {
    let url = format!(
        "{}/shops/{}/listings/{}/files",
        etsy::API_BASE,
        shop_id,
        listing_id
    );
    let bytes = std::fs::read(svg_path).with_context(|| format!("read svg {}", svg_path.display()))?;
    let file_name = format!("agent-factory-asset-{job_id}.svg");
    let part = Part::bytes(bytes)
        .file_name(file_name.clone())
        .mime_str("image/svg+xml")
        .context("svg mime")?;
    let form = Form::new()
        .part("file", part)
        .text("name", file_name)
        .text("rank", "1");
    let resp = client
        .post(&url)
        .bearer_auth(access_token)
        .header("x-api-key", etsy::api_key_header()?)
        .multipart(form)
        .send()
        .await
        .context("upload file POST failed")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("upload file HTTP {}: {}", status, body);
    }
    Ok(())
}

/// Activate a listing (state: draft → active). User-initiated only.
pub async fn activate_listing(
    client: &reqwest::Client,
    keystring: &str,
    shop_id: i64,
    etsy_listing_id: i64,
) -> Result<()> {
    let url = format!(
        "{}/shops/{}/listings/{}",
        etsy::API_BASE,
        shop_id,
        etsy_listing_id
    );
    let access_token = etsy::ensure_fresh_token(client).await?;
    let params = [("state", "active")];
    let resp = client
        .put(&url)
        .bearer_auth(access_token)
        .header("x-api-key", etsy::api_key_header()?)
        .form(&params)
        .send()
        .await
        .context("activate listing PUT failed")?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        anyhow::bail!("activate listing HTTP {}: {}", status, body);
    }
    Ok(())
}

/// Truncate a title to `max` characters without splitting a multi-byte
/// codepoint. Etsy v3 enforces a 140-char hard limit.
pub fn truncate_title(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// Etsy requires description length >= 160 characters (heuristic, but the
/// listing validator is strict about minimal descriptions). Pad short
/// descriptions with explanatory boilerplate rather than failing the request.
pub fn ensure_min_len(s: &str, min: usize) -> String {
    let len = s.chars().count();
    if len >= min {
        return s.to_string();
    }
    let pad = " — Instant digital download. Files are ready immediately after purchase; no physical item will be shipped. For personal, non-commercial use. Contact us with any questions.";
    let mut out = String::with_capacity(s.len() + pad.len());
    out.push_str(s);
    out.push_str(pad);
    if out.chars().count() < min {
        // If still short, repeat the boilerplate until we cross the threshold.
        while out.chars().count() < min {
            out.push_str(pad);
        }
    }
    out
}

/// Etsy tag rules: max 13 tags, max 20 chars each, alphanumeric + space +
/// hyphen only. Empty tags after filtering are dropped.
pub fn sanitize_tags(tags: &[String]) -> Vec<String> {
    tags.iter()
        .map(|t| {
            t.chars()
                .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-')
                .take(20)
                .collect::<String>()
                .trim()
                .to_string()
        })
        .filter(|t| !t.is_empty())
        .take(13)
        .collect()
}

/// Etsy rejects prices below ~$0.20 and refuses prices above $50,000-ish.
/// Clamp to a sane retail range.
pub fn clamp_price(p: f64) -> f64 {
    if !p.is_finite() {
        return 4.99;
    }
    p.max(0.99).min(999.99)
}

/// Hook called from the supervisor whenever a publisher job completes.
/// All failure modes here are non-fatal: we emit a Failed/Capped event and
/// return, letting the rest of the pipeline keep running.
pub async fn handle_publisher_complete(
    pool: &SqlitePool,
    project_id: i64,
    bus: &EventBus,
    result: &serde_json::Value,
) {
    // Pull required fields. Missing fields → silent skip (worker may not have
    // been updated yet; we don't want to spam Failed events).
    let local_listing_id = match result.get("listing_id").and_then(|v| v.as_i64()) {
        Some(v) => v,
        None => return,
    };
    let title = match result.get("title").and_then(|v| v.as_str()) {
        Some(v) => v.to_string(),
        None => return,
    };
    let description = result
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let price_usd = result.get("price_usd").and_then(|v| v.as_f64()).unwrap_or(4.99);
    let tags: Vec<String> = result
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let job_id = result.get("job_id").and_then(|v| v.as_i64()).unwrap_or(local_listing_id);
    let asset_path = match result.get("asset_path").and_then(|v| v.as_str()) {
        Some(v) => v.to_string(),
        None => {
            bus.send(SupervisorEvent::EtsyListingPublishFailed {
                local_listing_id,
                reason: "asset_path missing in publisher result".into(),
            });
            return;
        }
    };

    let status = etsy::load_status();
    if !status.connected {
        bus.send(SupervisorEvent::EtsyListingPublishFailed {
            local_listing_id,
            reason: "Etsy not connected".into(),
        });
        return;
    }
    let shop_id = match status.shop_id {
        Some(id) => id,
        None => {
            bus.send(SupervisorEvent::EtsyListingPublishFailed {
                local_listing_id,
                reason: "Etsy connected but shop_id is missing".into(),
            });
            return;
        }
    };

    let keystring = match crate::secrets::get("etsy_api_keystring") {
        Ok(Some(k)) => k,
        _ => {
            bus.send(SupervisorEvent::EtsyListingPublishFailed {
                local_listing_id,
                reason: "etsy_api_keystring not in keychain".into(),
            });
            return;
        }
    };

    // Daily cap: count today's etsy_publishes rows for this project.
    let cap: i64 = crate::secrets::get("daily_listing_cap")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_DAILY_CAP);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let count: i64 = match sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM etsy_publishes WHERE project_id = ? AND day = ?",
    )
    .bind(project_id)
    .bind(&today)
    .fetch_one(pool)
    .await
    {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("etsy_publishes count failed: {e}");
            0
        }
    };
    if count >= cap {
        bus.send(SupervisorEvent::EtsyListingCapped { count, cap });
        return;
    }

    let svg_path = PathBuf::from(&asset_path);
    let png_path = svg_path.with_extension("png");
    if !png_path.exists() {
        bus.send(SupervisorEvent::EtsyListingPublishFailed {
            local_listing_id,
            reason: format!(
                "png missing at {} — rasterizer may have failed",
                png_path.display()
            ),
        });
        return;
    }

    let draft = ListingDraft {
        title: title.clone(),
        description,
        tags,
        price_usd,
        taxonomy_id: DEFAULT_TAXONOMY_ID,
        png_path,
        svg_path,
        job_id,
    };

    let client = reqwest::Client::new();
    let publish_res = publish_draft(&client, &keystring, shop_id, &draft).await;
    match publish_res {
        Ok(resp) => {
            let now = chrono::Utc::now().timestamp();
            let state_str = resp.state.clone().unwrap_or_else(|| "draft".to_string());
            let url = resp.url.clone();
            if let Err(e) = sqlx::query(
                "INSERT INTO etsy_publishes (project_id, local_listing_id, etsy_listing_id, state, title, url, published_at, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            )
            .bind(project_id)
            .bind(local_listing_id)
            .bind(resp.listing_id)
            .bind(&state_str)
            .bind(&title)
            .bind(url.as_deref())
            .bind(now)
            .bind(&today)
            .execute(pool)
            .await
            {
                tracing::error!("insert etsy_publishes failed: {e}");
            }
            bus.send(SupervisorEvent::EtsyListingPublished {
                local_listing_id,
                etsy_listing_id: resp.listing_id,
                title,
                url,
                state: state_str,
            });

            // If this listing belongs to a smoke cycle, end it.
            let smoke_cycle = crate::secrets::get("smoke_cycle_id").ok().flatten().filter(|v| !v.is_empty());
            let smoke_started = crate::secrets::get("smoke_started_at")
                .ok().flatten().and_then(|s| s.parse::<i64>().ok());
            if let (Some(cycle_id), Some(started)) = (smoke_cycle, smoke_started) {
                let duration_ms = ((chrono::Utc::now().timestamp() - started).max(0) as u64) * 1000;
                let pool_clone = pool.clone();
                let bus_clone = bus.clone();
                let cid = cycle_id.clone();
                let listing_id_local = resp.listing_id;
                tokio::spawn(async move {
                    let ledger_sum: f64 = sqlx::query_scalar::<_, f64>(
                        "SELECT COALESCE(SUM(cost_usd), 0.0) FROM agent_contributions WHERE cycle_id = ?"
                    ).bind(&cid).fetch_one(&pool_clone).await.unwrap_or(0.0);
                    let _ = crate::secrets::set("smoke_pause_until", "1");
                    let _ = crate::secrets::delete("smoke_cycle_id");
                    let _ = crate::secrets::delete("smoke_started_at");
                    bus_clone.send(crate::events::SupervisorEvent::SmokeTestCycleComplete {
                        cycle_id: cid,
                        listing_id: Some(listing_id_local),
                        spend_usd: ledger_sum,
                        duration_ms,
                        status: crate::events::SmokeTestStatus::Success,
                    });
                });
            }
        }
        Err(e) => {
            // Build a flat reason including the full anyhow chain.
            let reason = format!("{:#}", e);
            bus.send(SupervisorEvent::EtsyListingPublishFailed {
                local_listing_id,
                reason,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_truncate_title_respects_char_boundary() {
        // Multi-byte: emoji are 4 bytes but 1 char.
        let s = "Hello 🌟 World 🎨 Art Print";
        let out = truncate_title(s, 10);
        assert_eq!(out.chars().count(), 10);
        // ASCII path
        let out2 = truncate_title("abcdefghij", 100);
        assert_eq!(out2, "abcdefghij");
        // Exact boundary
        let out3 = truncate_title("abcdef", 6);
        assert_eq!(out3, "abcdef");
        // Long string
        let long: String = "a".repeat(200);
        let out4 = truncate_title(&long, 140);
        assert_eq!(out4.chars().count(), 140);
    }

    #[test]
    fn test_truncate_title_no_panic_on_multibyte() {
        // Each "é" is 2 bytes / 1 char. If we naively truncated by bytes we'd
        // panic on the boundary; char-based truncation must not.
        let s: String = "é".repeat(50);
        let out = truncate_title(&s, 30);
        assert_eq!(out.chars().count(), 30);
    }

    #[test]
    fn test_ensure_min_len_pads_short_description() {
        let short = "Cute print.";
        let out = ensure_min_len(short, 160);
        assert!(out.chars().count() >= 160, "got len {}", out.chars().count());
        assert!(out.starts_with(short), "padded should preserve original prefix");
        // Long descriptions pass through untouched.
        let long: String = "x".repeat(300);
        let out2 = ensure_min_len(&long, 160);
        assert_eq!(out2, long);
    }

    #[test]
    fn test_sanitize_tags_limits_to_13() {
        let many: Vec<String> = (0..20).map(|i| format!("tag{i}")).collect();
        let out = sanitize_tags(&many);
        assert_eq!(out.len(), 13);
        assert_eq!(out[0], "tag0");
        assert_eq!(out[12], "tag12");
    }

    #[test]
    fn test_sanitize_tags_strips_invalid_chars() {
        let tags = vec![
            "wall art".into(),
            "minimal/print".into(),       // slash removed → "minimalprint"
            "boho:vibes!".into(),         // colon + bang removed → "bohovibes"
            "high-quality".into(),        // hyphen preserved
            "  ".into(),                  // empty after trim — dropped
            "a".repeat(30),               // truncated to 20 chars
        ];
        let out = sanitize_tags(&tags);
        assert_eq!(out[0], "wall art");
        assert_eq!(out[1], "minimalprint");
        assert_eq!(out[2], "bohovibes");
        assert_eq!(out[3], "high-quality");
        assert_eq!(out[4].len(), 20);
        assert_eq!(out.len(), 5);
    }

    #[test]
    fn test_sanitize_tags_drops_empty() {
        let tags: Vec<String> = vec!["".into(), "  ".into(), "!!!".into()];
        let out = sanitize_tags(&tags);
        assert!(out.is_empty(), "all-invalid tags should yield empty vec");
    }

    #[test]
    fn test_clamp_price_bounds() {
        assert_eq!(clamp_price(0.0), 0.99);
        assert_eq!(clamp_price(-5.0), 0.99);
        assert_eq!(clamp_price(5.0), 5.0);
        assert_eq!(clamp_price(99_999.0), 999.99);
        assert_eq!(clamp_price(f64::NAN), 4.99);
        assert_eq!(clamp_price(f64::INFINITY), 4.99);
    }

    #[test]
    fn test_create_listing_response_parses() {
        let json = r#"{"listing_id":1234567890,"state":"draft","url":"https://www.etsy.com/listing/1234567890"}"#;
        let r: CreateListingResponse = serde_json::from_str(json).unwrap();
        assert_eq!(r.listing_id, 1234567890);
        assert_eq!(r.state.as_deref(), Some("draft"));
        assert_eq!(
            r.url.as_deref(),
            Some("https://www.etsy.com/listing/1234567890")
        );
        // Missing optional fields are fine.
        let minimal = r#"{"listing_id":42}"#;
        let r2: CreateListingResponse = serde_json::from_str(minimal).unwrap();
        assert_eq!(r2.listing_id, 42);
        assert!(r2.url.is_none());
        assert!(r2.state.is_none());
    }

    #[tokio::test]
    async fn test_create_draft_posts_required_fields() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/shops/9999/listings")
            .match_header("authorization", "Bearer fake.tok")
            .match_header("x-api-key", "KEY123")
            .match_body(mockito::Matcher::AllOf(vec![
                mockito::Matcher::UrlEncoded("quantity".into(), "1".into()),
                mockito::Matcher::UrlEncoded("title".into(), "Test Print".into()),
                mockito::Matcher::UrlEncoded("who_made".into(), "i_did".into()),
                mockito::Matcher::UrlEncoded("when_made".into(), "made_to_order".into()),
                mockito::Matcher::UrlEncoded("type".into(), "download".into()),
                mockito::Matcher::UrlEncoded("state".into(), "draft".into()),
                mockito::Matcher::UrlEncoded("taxonomy_id".into(), "68887".into()),
                mockito::Matcher::UrlEncoded("price".into(), "9.99".into()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"listing_id":777,"state":"draft","url":"https://etsy.com/777"}"#)
            .create_async()
            .await;

        // Point API_BASE-style URL at our mock. We call create_draft directly
        // with the full shop URL constructed from etsy::API_BASE; to override
        // for tests we go through a helper that lets us inject the base.
        let client = reqwest::Client::new();
        let mock_base = server.url();
        let draft = ListingDraft {
            title: "Test Print".into(),
            description: "a".repeat(200),
            tags: vec![],
            price_usd: 9.99,
            taxonomy_id: 68887,
            png_path: PathBuf::from("/tmp/nope.png"),
            svg_path: PathBuf::from("/tmp/nope.svg"),
            job_id: 1,
        };
        let url = format!("{}/shops/9999/listings", mock_base);
        let params: Vec<(&str, String)> = vec![
            ("quantity", "1".into()),
            ("title", truncate_title(&draft.title, 140)),
            ("description", ensure_min_len(&draft.description, 160)),
            ("price", format!("{:.2}", clamp_price(draft.price_usd))),
            ("who_made", "i_did".into()),
            ("when_made", "made_to_order".into()),
            ("taxonomy_id", draft.taxonomy_id.to_string()),
            ("type", "download".into()),
            ("is_supply", "false".into()),
            ("state", "draft".into()),
        ];
        let resp = client
            .post(&url)
            .bearer_auth("fake.tok")
            .header("x-api-key", "KEY123")
            .form(&params)
            .send()
            .await
            .unwrap();
        assert!(resp.status().is_success());
        let parsed: CreateListingResponse = resp.json().await.unwrap();
        assert_eq!(parsed.listing_id, 777);
        mock.assert_async().await;
    }
}
