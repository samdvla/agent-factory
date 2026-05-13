//! Gumroad publish orchestration.
//!
//! Fires from supervisor.rs when a publisher job completes with a 3D
//! `product_type` AND `gumroad_enabled=true`.
//!
//! Gumroad's product-creation API works; the file-attach step is
//! best-effort. When file attach fails we mark `state=published_no_file`
//! so the UI can show a clear "needs manual file upload" badge.

use crate::events::{EventBus, SupervisorEvent};
use crate::gumroad;
use crate::secrets;
use serde_json::Value;
use sqlx::SqlitePool;
use std::path::PathBuf;

pub const DEFAULT_DAILY_CAP: i64 = 5;

fn creds_from_secrets() -> Option<gumroad::Creds> {
    let access_token = secrets::get("gumroad_access_token").ok().flatten().unwrap_or_default();
    if access_token.is_empty() {
        return None;
    }
    Some(gumroad::Creds { access_token })
}

pub async fn handle_publisher_complete_gumroad(
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
    // Gumroad: AI disclosure goes in the product description (Gumroad
    // doesn't have a structured "AI" tag).
    let description = if description_raw.to_lowercase().contains("generated with ai")
        || description_raw.to_lowercase().contains("ai-generated")
    {
        description_raw
    } else {
        format!("{description_raw}\n\n— Generated with AI.")
    };
    let price_usd = publisher_result
        .get("price_usd")
        .and_then(|v| v.as_f64())
        .unwrap_or(4.99);
    let niche = publisher_result
        .get("niche")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let asset_path_str = publisher_result
        .get("asset_path")
        .and_then(|v| v.as_str())
        .map(String::from);

    let fail = |reason: String| {
        bus.send(SupervisorEvent::GumroadPublishFailed {
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

    let Some(creds) = creds_from_secrets() else {
        fail("gumroad credentials missing (set gumroad_access_token)".into());
        return;
    };

    let cap: i64 = secrets::get("gumroad_daily_cap")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_DAILY_CAP);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM gumroad_publishes WHERE project_id = ? AND day = ? AND state IN ('published','published_no_file')",
    )
    .bind(project_id)
    .bind(&today)
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    if count >= cap {
        bus.send(SupervisorEvent::GumroadCapped { count, cap });
        return;
    }

    let input = gumroad::CreateProductInput {
        name: title.clone(),
        description,
        price_usd,
        product_type: "digital".into(),
    };

    let client = reqwest::Client::new();
    let now = chrono::Utc::now().timestamp();
    match gumroad::create_product_with_file(&client, &creds, &input, &file_path).await {
        Ok(res) => {
            let state = if res.file_attached {
                "published"
            } else {
                "published_no_file"
            };
            if let Err(e) = sqlx::query(
                "INSERT INTO gumroad_publishes \
                 (project_id, local_listing_id, gumroad_product_id, title, short_url, edit_url, \
                  price_usd, state, warning, published_at, day) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(project_id)
            .bind(local_listing_id)
            .bind(&res.product_id)
            .bind(&title)
            .bind(res.short_url.as_deref())
            .bind(res.edit_url.as_deref())
            .bind(price_usd)
            .bind(state)
            .bind(res.warning.as_deref())
            .bind(now)
            .bind(&today)
            .execute(pool)
            .await
            {
                tracing::warn!("gumroad_publishes insert failed: {e}");
            }
            let _ = crate::etsy_ingest::append_marketplace_publish_outcome(
                "gumroad_publish",
                local_listing_id,
                &niche,
                &title,
                &res.product_id,
                res.short_url.as_deref(),
                price_usd,
            );
            bus.send(SupervisorEvent::GumroadPublished {
                local_listing_id,
                product_id: res.product_id,
                short_url: res.short_url,
                file_attached: res.file_attached,
            });
        }
        Err(e) => {
            let reason = format!("gumroad create failed: {e:#}");
            if let Err(db_err) = sqlx::query(
                "INSERT INTO gumroad_publishes \
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
                tracing::warn!("gumroad_publishes errored insert failed: {db_err}");
            }
            fail(reason);
        }
    }
}
