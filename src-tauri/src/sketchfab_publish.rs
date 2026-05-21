//! Sketchfab publish orchestration.
//!
//! Fires from supervisor.rs when a publisher job completes with a 3D
//! `product_type` AND `sketchfab_enabled=true`.
//!
//! Flow:
//!   1. Read the STL/GLB path from the publisher result.
//!   2. Call `sketchfab::upload_model` with metadata + optional Store price.
//!   3. Insert a row into `sketchfab_publishes`.
//!   4. Emit `SketchfabPublished` (success) or `SketchfabPublishFailed`.
//!
//! Unlike Cults3D, Sketchfab handles its own thumbnail generation from the
//! uploaded 3D scene — no asset host required. Failures are non-fatal; the
//! Etsy / Cults3D paths run independently.

use crate::events::{EventBus, SupervisorEvent};
use crate::secrets;
use crate::sketchfab;
use serde_json::Value;
use sqlx::SqlitePool;
use std::path::PathBuf;

fn creds_from_secrets() -> Option<sketchfab::Creds> {
    let api_token = secrets::get("sketchfab_api_token").ok().flatten().unwrap_or_default();
    if api_token.is_empty() {
        return None;
    }
    Some(sketchfab::Creds { api_token })
}

/// Entry point called from supervisor.rs on a successful publisher job that
/// produced a 3D asset and has Sketchfab enabled.
pub async fn handle_publisher_complete_sketchfab(
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
    // Sketchfab AI disclosure — append a clear marker so it's visible in the
    // description even though we also tag with "ai-generated".
    let description = if description_raw.to_lowercase().contains("ai-generated")
        || description_raw.to_lowercase().contains("generated with ai")
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
    // Prefer the textured GLB (image-to-3D renders bake PBR materials —
    // baseColorTexture + normal + roughness) so the Sketchfab viewer shows
    // a colored, lit turntable instead of a flat-shaded STL silhouette.
    // Falls back to the STL when no GLB sibling was produced (text-to-3D
    // cycles, or older listings before the GLB-on-disk pivot).
    let glb_path_str = publisher_result
        .get("glb_path")
        .and_then(|v| v.as_str())
        .map(String::from);
    let stl_path_str = publisher_result
        .get("asset_path")
        .and_then(|v| v.as_str())
        .map(String::from);
    let asset_path_str = glb_path_str.clone().or(stl_path_str);
    let publisher_price = publisher_result
        .get("price_usd")
        .and_then(|v| v.as_f64());
    // Mature listings stay on Sketchfab but MUST NOT be made
    // Fab-migration-eligible — Fab's TOS forbids NSFW and migrating one
    // would risk a SabiWabiGifts seller account ban that blows up the
    // whole Etsy + Fab funnel. We still upload the model (Sketchfab
    // permits age-restricted content) but skip the post-upload heal.
    let mature_content = publisher_result
        .get("mature_content")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let fail = |reason: String| {
        bus.send(SupervisorEvent::SketchfabPublishFailed {
            local_listing_id,
            reason,
        });
    };

    let Some(asset_path_str) = asset_path_str else {
        fail("publisher result has no asset_path".into());
        return;
    };
    let model_path = PathBuf::from(&asset_path_str);
    if !model_path.exists() {
        fail(format!("model missing at {}", model_path.display()));
        return;
    }

    let Some(creds) = creds_from_secrets() else {
        fail("sketchfab credentials missing (set sketchfab_api_token)".into());
        return;
    };

    // No artificial daily cap — publish as fast as the pipeline produces.
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

    // Selling mode is gated on a separate secret because the account needs
    // Pro+ for the Store. Default: free listing with downloads enabled (CC BY).
    let sell_on_store = secrets::get("sketchfab_sell_on_store")
        .ok()
        .flatten()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let price_usd = if sell_on_store { publisher_price } else { None };

    let category = sketchfab::pick_category(&niche, &tags);

    let input = sketchfab::UploadInput {
        name: title.clone(),
        description,
        tags,
        category,
        free_license: Some("by".into()),
        price_usd,
        is_published: true,
        is_downloadable: !sell_on_store,
        is_age_restricted: mature_content,
    };

    let client = reqwest::Client::new();
    let now = chrono::Utc::now().timestamp();
    match sketchfab::upload_model(&client, &creds, &model_path, &input).await {
        Ok(res) => {
            // Fab's community-models migration tool only picks up free,
            // public, published, CC-BY, downloadable models. Re-assert those
            // four flags via GET+PATCH right after upload — Sketchfab can
            // silently normalize fields during multipart ingestion, and the
            // migration crawler reads the *live* state, not what we POSTed.
            // Store-route uploads skip this: Store products are ineligible
            // for the community migration, and we warn instead.
            if sell_on_store {
                tracing::warn!(
                    "sketchfab {} uploaded via Store route — NOT Fab-migration-eligible. \
                     Disable `sketchfab_sell_on_store` to make new uploads migration-ready.",
                    res.uid,
                );
            } else if mature_content {
                tracing::warn!(
                    "sketchfab {} flagged mature_content — skipping Fab-migration heal. \
                     Fab prohibits NSFW; keeping this listing off the Fab on-ramp.",
                    res.uid,
                );
            } else {
                match sketchfab::ensure_migration_eligible(&client, &creds, &res.uid).await {
                    Ok(report) if report.already_ok => {}
                    Ok(report) => tracing::warn!(
                        "sketchfab {} drifted off Fab-migration state — healed {:?}",
                        res.uid,
                        report.healed_fields,
                    ),
                    Err(e) => tracing::warn!(
                        "sketchfab {} Fab-migration verify failed (non-fatal): {e:#}",
                        res.uid,
                    ),
                }
            }
            if let Err(e) = sqlx::query(
                "INSERT INTO sketchfab_publishes \
                 (project_id, local_listing_id, sketchfab_uid, store_product_id, title, url, \
                  price_usd, state, warning, published_at, day) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)",
            )
            .bind(project_id)
            .bind(local_listing_id)
            .bind(&res.uid)
            .bind(res.store_product_id.as_deref())
            .bind(&title)
            .bind(&res.url)
            .bind(price_usd)
            .bind(res.warning.as_deref())
            .bind(now)
            .bind(&today)
            .execute(pool)
            .await
            {
                tracing::warn!("sketchfab_publishes insert failed: {e}");
            }
            let _ = crate::etsy_ingest::append_marketplace_publish_outcome(
                "sketchfab_publish",
                local_listing_id,
                &niche,
                &title,
                &res.uid,
                Some(&res.url),
                price_usd.unwrap_or(0.0),
            );
            bus.send(SupervisorEvent::SketchfabPublished {
                local_listing_id,
                uid: res.uid,
                url: res.url,
            });
        }
        Err(e) => {
            let reason = format!("sketchfab upload failed: {e:#}");
            if let Err(db_err) = sqlx::query(
                "INSERT INTO sketchfab_publishes \
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
                tracing::warn!("sketchfab_publishes errored insert failed: {db_err}");
            }
            fail(reason);
        }
    }
}
