//! Print-on-demand publish orchestrator.
//!
//! Triggered from the supervisor when a publisher job completes AND
//! `pod_enabled=true` AND the brief's `product_type == "sticker"`. Drives the
//! Printify pipeline end-to-end:
//!
//!   1. Rasterize the designer's SVG to a 1800px print PNG sibling.
//!   2. Discover sticker blueprint + print provider + small-size variants
//!      (cached in secrets after first run so we don't burn a catalog walk
//!      on every job).
//!   3. Upload the PNG to Printify, get a file id.
//!   4. Create a Printify product wired to the listing copy + price.
//!   5. Publish the product → Printify pushes it to Etsy as a draft.
//!
//! Each step emits a SupervisorEvent so the Printify Operator avatar on the
//! floor reacts in real time. Every error path emits a `JobFailed` so the
//! alert tray surfaces it.

use crate::events::{EventBus, SupervisorEvent};
use crate::{printify, raster, secrets};
use anyhow::{Context, Result};
use serde_json::Value;
use sqlx::SqlitePool;
use std::path::PathBuf;

/// New-shop velocity cap. Research recommends 1–2 sticker publishes per day
/// for the first 14 days to dodge Etsy's auto-suspension on volume spikes.
/// User can override via the `pod_daily_cap` secret.
const DEFAULT_POD_DAILY_CAP: i64 = 2;

/// Top-level entry. Reads everything it needs from the publisher result blob
/// and the secrets store. Never panics; emits events on every outcome.
pub async fn handle_publisher_complete_pod(
    pool: &SqlitePool,
    project_id: i64,
    bus: &EventBus,
    result: &Value,
) {
    let job_id = result.get("job_id").and_then(|v| v.as_i64()).unwrap_or(0);

    let _ = bus.send(SupervisorEvent::JobStarted {
        role: "pod".into(),
        job_id,
    });

    // Velocity cap: count today's pod_publishes rows and bail before any
    // Printify calls if we're already at the cap.
    let cap: i64 = secrets::get("pod_daily_cap")
        .ok().flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_POD_DAILY_CAP);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let count: i64 = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM pod_publishes WHERE project_id = ? AND day = ?",
    )
    .bind(project_id)
    .bind(&today)
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    if count >= cap {
        tracing::info!("pod_publish skipped: daily cap reached ({count}/{cap})");
        let _ = bus.send(SupervisorEvent::JobFailed {
            role: "pod".into(),
            job_id,
            error: format!("daily POD cap reached ({count}/{cap}). Raise pod_daily_cap to allow more sticker publishes today."),
        });
        return;
    }

    let pipeline_outcome = run_pipeline(result).await;
    // Always write a row to `jobs` so the Activity feed lists POD attempts
    // alongside the other workers — without this, POD work was invisible
    // except for the supervisor-event ticker.
    let payload_json = serde_json::json!({
        "source_publisher_job_id": job_id,
        "title": result.get("title").and_then(|v| v.as_str()).unwrap_or(""),
        "price_usd": result.get("price_usd").and_then(|v| v.as_f64()).unwrap_or(0.0),
        "asset_path": result.get("asset_path").and_then(|v| v.as_str()).unwrap_or(""),
    });

    match pipeline_outcome {
        Ok(out) => {
            // Record the publish so tomorrow's cap math is right. Best-effort —
            // log on failure but don't block the success path.
            let now = chrono::Utc::now().timestamp();
            if let Err(e) = sqlx::query(
                "INSERT INTO pod_publishes (project_id, printify_product_id, title, price_cents, published_at, day) VALUES (?, ?, ?, ?, ?, ?)"
            )
            .bind(project_id)
            .bind(&out.product_id)
            .bind(&out.title)
            .bind(out.price_cents)
            .bind(now)
            .bind(&today)
            .execute(pool).await {
                tracing::warn!("pod_publishes insert failed: {e}");
            }
            let result_json = serde_json::json!({
                "ok": true,
                "printify_product_id": out.product_id,
                "title": out.title,
                "price_cents": out.price_cents,
                "ticker_text": format!(
                    "printify → etsy: \"{}\" product_id={}",
                    out.title.chars().take(60).collect::<String>(),
                    out.product_id,
                ),
            });
            let _ = insert_job_row(pool, project_id, "pod", &payload_json, Some(&result_json), None).await;
            let _ = bus.send(SupervisorEvent::JobCompleted {
                role: "pod".into(),
                job_id,
                result: result_json,
            });
        }
        Err(e) => {
            tracing::warn!("pod_publish failed: {e:#}");
            let err_msg = format!("{e}");
            let _ = insert_job_row(pool, project_id, "pod", &payload_json, None, Some(&err_msg)).await;
            let _ = bus.send(SupervisorEvent::JobFailed {
                role: "pod".into(),
                job_id,
                error: err_msg,
            });
        }
    }
}

/// Write a finished POD job to the `jobs` table so the Activity feed
/// (which is backed by `cmd_list_recent_jobs`) can surface it. Best-effort;
/// failures are logged but don't break the pipeline.
async fn insert_job_row(
    pool: &SqlitePool,
    project_id: i64,
    role: &str,
    payload: &Value,
    result: Option<&Value>,
    error: Option<&str>,
) -> Result<()> {
    let status = if error.is_some() { "errored" } else { "done" };
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
    let res = sqlx::query(
        "INSERT INTO jobs (project_id, agent_role, payload_json, status, started_at, finished_at, result_json, error) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(project_id)
    .bind(role)
    .bind(payload.to_string())
    .bind(status)
    .bind(&now)
    .bind(&now)
    .bind(result.map(|v| v.to_string()))
    .bind(error)
    .execute(pool)
    .await;
    if let Err(e) = res {
        tracing::warn!("insert pod job row failed: {e}");
    }
    Ok(())
}

struct PipelineOutcome {
    product_id: String,
    title: String,
    price_cents: i64,
}

async fn run_pipeline(result: &Value) -> Result<PipelineOutcome> {
    let api_key = secrets::get("printify_api_key")?.unwrap_or_default();
    if api_key.is_empty() {
        anyhow::bail!("printify_api_key not set — open Settings → Print-on-demand and verify a PAT");
    }
    let shop_id: i64 = secrets::get("printify_shop_id")?
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| anyhow::anyhow!("printify_shop_id missing — re-run Verify in Settings"))?;

    let title = result.get("title").and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("publisher result missing title"))?
        .to_string();
    let description = result.get("description").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let tags: Vec<String> = result.get("tags").and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let price_usd = result.get("price_usd").and_then(|v| v.as_f64()).unwrap_or(0.0);
    if price_usd <= 0.0 {
        anyhow::bail!("publisher result missing/zero price_usd");
    }
    let price_cents = (price_usd * 100.0).round() as i64;
    let asset_path_str = result.get("asset_path").and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("publisher result missing asset_path — designer didn't produce an SVG"))?;
    let asset_path = PathBuf::from(asset_path_str);
    if !asset_path.exists() {
        anyhow::bail!("asset_path {} doesn't exist on disk", asset_path.display());
    }

    // Step 1 — rasterize. Blocking work goes on the blocking pool.
    let svg_path = asset_path.clone();
    let print_png_path: PathBuf = tokio::task::spawn_blocking(move || {
        raster::rasterize_print_sibling(&svg_path, raster::STICKER_PRINT_TARGET_PX)
    }).await.context("rasterize join")??;
    let png_bytes = std::fs::read(&print_png_path).context("read print png")?;

    // Step 2 — discover blueprint + provider + variants (cache after first run).
    let (blueprint_id, provider_id, variant_ids) =
        resolve_or_discover_sticker_skus(&api_key).await?;

    // Step 3 — upload.
    let file_name = print_png_path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("sticker.png")
        .to_string();
    let uploaded = printify::upload_image_base64(&api_key, &file_name, &png_bytes).await?;

    // Step 4 — create product.
    let created = printify::create_product(
        &api_key, shop_id, &title, &description, &tags,
        price_cents, blueprint_id, provider_id, &variant_ids, &uploaded.id,
    ).await?;

    // Step 5 — publish to Etsy.
    printify::publish_product(&api_key, shop_id, &created.id).await?;

    Ok(PipelineOutcome { product_id: created.id, title, price_cents })
}

/// Look up the cached sticker SKU triplet (blueprint/provider/variants) from
/// the secret store. On first run, walk the Printify catalog and persist the
/// choice so we don't repeat the discovery on every job.
async fn resolve_or_discover_sticker_skus(api_key: &str) -> Result<(i64, i64, Vec<i64>)> {
    let cached_blueprint = secrets::get("printify_sticker_blueprint_id")?
        .and_then(|s| s.parse::<i64>().ok());
    let cached_provider = secrets::get("printify_sticker_provider_id")?
        .and_then(|s| s.parse::<i64>().ok());
    let cached_variants_json = secrets::get("printify_sticker_variant_ids")?;
    let cached_variants: Option<Vec<i64>> = cached_variants_json.as_ref()
        .and_then(|s| serde_json::from_str(s).ok());
    if let (Some(b), Some(p), Some(v)) = (cached_blueprint, cached_provider, cached_variants) {
        if !v.is_empty() {
            return Ok((b, p, v));
        }
    }

    // Walk: blueprints → first kiss-cut sticker; its providers → first; variants → small.
    let bp = printify::find_sticker_blueprint(api_key).await?;
    let providers = printify::list_print_providers(api_key, bp.id).await?;
    let provider = providers.into_iter().next()
        .ok_or_else(|| anyhow::anyhow!("blueprint {} has no print providers", bp.id))?;
    let variants = printify::list_variants(api_key, bp.id, provider.id).await?;
    let picked = printify::pick_small_variants(&variants, 2);
    if picked.is_empty() {
        anyhow::bail!("no usable sticker variants on blueprint {} provider {}", bp.id, provider.id);
    }

    secrets::set("printify_sticker_blueprint_id", &bp.id.to_string())?;
    secrets::set("printify_sticker_provider_id", &provider.id.to_string())?;
    secrets::set("printify_sticker_variant_ids", &serde_json::to_string(&picked)?)?;

    Ok((bp.id, provider.id, picked))
}
