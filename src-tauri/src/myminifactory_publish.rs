//! MyMiniFactory publish orchestration.
//!
//! Same shape as the Cults3D / Sketchfab / Gumroad orchestrations. MMF's
//! upload endpoint may reject calls if the API key lacks write scope; the
//! error message gets surfaced in the publishes list.

use crate::events::{EventBus, SupervisorEvent};
use crate::myminifactory;
use crate::secrets;
use serde_json::Value;
use sqlx::SqlitePool;
use std::path::PathBuf;

pub const DEFAULT_DAILY_CAP: i64 = 5;

// Personal API key fallback is read-only and not accepted by MMF for
// writes — the publish path always uses an OAuth access token via
// `crate::mmf_oauth::ensure_fresh_token` instead.

pub async fn handle_publisher_complete_mmf(
    pool: &SqlitePool,
    project_id: i64,
    bus: &EventBus,
    publisher_result: &Value,
) {
    let local_listing_id = publisher_result
        .get("listing_id")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);
    let title = publisher_result
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let description_raw = publisher_result
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let description = if description_raw.to_lowercase().contains("generated with ai")
        || description_raw.to_lowercase().contains("ai-generated")
    {
        description_raw
    } else {
        format!("{description_raw}\n\n— Generated with AI.")
    };
    let mut tags: Vec<String> = publisher_result
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if !tags.iter().any(|t| t.to_lowercase() == "ai-generated") {
        tags.push("ai-generated".into());
    }
    let niche = publisher_result
        .get("niche")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let price_usd = publisher_result
        .get("price_usd")
        .and_then(|v| v.as_f64())
        .unwrap_or(4.99);
    let asset_path_str = publisher_result
        .get("asset_path")
        .and_then(|v| v.as_str())
        .map(String::from);

    let fail = |reason: String| {
        bus.send(SupervisorEvent::MmfPublishFailed {
            local_listing_id,
            reason,
        });
    };

    let Some(asset_path_str) = asset_path_str else {
        fail("publisher result has no asset_path".into());
        return;
    };
    let file_path = PathBuf::from(&asset_path_str);
    if !file_path.exists() {
        fail(format!("asset missing at {}", file_path.display()));
        return;
    }

    // Fresh OAuth token — refreshed automatically if the cached one is
    // about to expire. Errors here mean the operator hasn't run the
    // OAuth flow yet.
    let client = reqwest::Client::new();
    let access_token = match crate::mmf_oauth::ensure_fresh_token(&client).await {
        Ok(t) => t,
        Err(e) => {
            fail(format!("mmf oauth not ready: {e:#}"));
            return;
        }
    };

    // Charge for paid by default — toggleable.
    let sell_paid = secrets::get("mmf_sell_paid")
        .ok()
        .flatten()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let price = if sell_paid { price_usd } else { 0.0 };

    let cap: i64 = secrets::get("mmf_daily_cap")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_DAILY_CAP);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM mmf_publishes WHERE project_id = ? AND day = ? AND state = 'published'",
    )
    .bind(project_id)
    .bind(&today)
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    if count >= cap {
        bus.send(SupervisorEvent::MmfCapped { count, cap });
        return;
    }

    let category = myminifactory::pick_category(&niche, &tags);
    let input = myminifactory::CreateObjectInput {
        name: title.clone(),
        description,
        tags,
        category,
        price_usd: price,
    };

    let now = chrono::Utc::now().timestamp();
    match myminifactory::create_object_with_file(&client, &access_token, &input, &file_path).await {
        Ok(res) => {
            if let Err(e) = sqlx::query(
                "INSERT INTO mmf_publishes \
                 (project_id, local_listing_id, mmf_object_id, title, url, \
                  price_usd, state, warning, published_at, day) \
                 VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)",
            )
            .bind(project_id)
            .bind(local_listing_id)
            .bind(&res.object_id)
            .bind(&title)
            .bind(res.url.as_deref())
            .bind(price)
            .bind(res.warning.as_deref())
            .bind(now)
            .bind(&today)
            .execute(pool)
            .await
            {
                tracing::warn!("mmf_publishes insert failed: {e}");
            }
            let _ = crate::etsy_ingest::append_marketplace_publish_outcome(
                "mmf_publish",
                local_listing_id,
                &niche,
                &title,
                &res.object_id,
                res.url.as_deref(),
                price,
            );
            bus.send(SupervisorEvent::MmfPublished {
                local_listing_id,
                object_id: res.object_id,
                url: res.url,
            });
        }
        Err(e) => {
            let raw = format!("{e:#}");
            // A 401 here after we've already passed `ensure_fresh_token`
            // means the refresh succeeded but the token MMF gave us is
            // somehow invalid for writes, OR the user revoked our app
            // from their MMF account. Clear the tokens so we stop
            // retrying every cycle; the operator can reconnect from
            // Settings to recover.
            let is_auth_failure = raw.contains("HTTP 401") || raw.contains("Unauthorized");
            let reason = if is_auth_failure {
                let _ = crate::mmf_oauth::disconnect();
                format!(
                    "mmf create failed: MMF returned 401 after a fresh OAuth token. \
                     Tokens dropped to stop retry loops — reconnect via \
                     Settings → MyMiniFactory. Raw error: {raw}"
                )
            } else {
                format!("mmf create failed: {raw}")
            };
            if let Err(db_err) = sqlx::query(
                "INSERT INTO mmf_publishes \
                 (project_id, local_listing_id, title, state, error, published_at, day) \
                 VALUES (?, ?, ?, 'errored', ?, ?, ?)",
            )
            .bind(project_id)
            .bind(local_listing_id)
            .bind(&title)
            .bind(&reason)
            .bind(now)
            .bind(&today)
            .execute(pool)
            .await
            {
                tracing::warn!("mmf_publishes errored insert failed: {db_err}");
            }
            fail(reason);
        }
    }
}
