//! Cults3D publish orchestration.
//!
//! Fires from supervisor.rs when a publisher job completes with
//! `product_type` in {"stl_file", "3d_model"} AND `cults3d_enabled=true`.
//!
//! Flow:
//!   1. Read STL/GLB + preview PNG paths from the publisher result.
//!   2. Host both at public HTTPS URLs via `asset_host_github`.
//!   3. Resolve a Cults3D categoryId (cached, refreshed weekly).
//!   4. Call `cults3d::create_creation` with `madeWithAi: true`.
//!   5. Insert a row into `cults3d_publishes`.
//!   6. Emit `Cults3dPublished` (success) or `Cults3dPublishFailed`.
//!
//! All failures are non-fatal — the Etsy/POD route runs independently.

use crate::asset_host_github;
use crate::cults3d;
use crate::events::{EventBus, SupervisorEvent};
use crate::secrets;
use serde_json::Value;
use sqlx::SqlitePool;
use std::path::PathBuf;

pub const DEFAULT_DAILY_CAP: i64 = 5;

fn creds_from_secrets() -> Option<cults3d::Creds> {
    let username = secrets::get("cults3d_username").ok().flatten().unwrap_or_default();
    let api_key = secrets::get("cults3d_api_key").ok().flatten().unwrap_or_default();
    if username.is_empty() || api_key.is_empty() {
        return None;
    }
    Some(cults3d::Creds { username, api_key })
}

async fn cached_categories(
    client: &reqwest::Client,
    creds: &cults3d::Creds,
) -> Option<Vec<cults3d::Category>> {
    // Refresh weekly. Stored as compact JSON in a secret.
    let now = chrono::Utc::now().timestamp();
    let cached_ts = secrets::get("cults3d_categories_ts")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    if now - cached_ts < 7 * 24 * 3600 {
        if let Some(json) = secrets::get("cults3d_categories_json").ok().flatten() {
            if let Ok(parsed) = serde_json::from_str::<Vec<cults3d::Category>>(&json) {
                if !parsed.is_empty() {
                    return Some(parsed);
                }
            }
        }
    }
    match cults3d::list_categories(client, creds).await {
        Ok(cats) if !cats.is_empty() => {
            if let Ok(s) = serde_json::to_string(&cats) {
                let _ = secrets::set("cults3d_categories_json", &s);
                let _ = secrets::set("cults3d_categories_ts", &now.to_string());
            }
            Some(cats)
        }
        _ => None,
    }
}

/// Entry point called from supervisor.rs on a successful publisher job that
/// produced a 3D asset and has Cults3D enabled.
pub async fn handle_publisher_complete_cults3d(
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
    let description = publisher_result
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let tags: Vec<String> = publisher_result
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
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

    // Closure that records the failure to BOTH the UI bus AND the
    // cults3d_publishes table so early-exit reasons survive a restart and
    // operators can audit them in the Activity tab. Previously these
    // early-exits only fired a bus event — the table stayed empty and we
    // had no way to know why publishes weren't happening.
    let title_for_fail = title.clone();
    let today_for_fail = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let pool_for_fail = pool.clone();
    let project_id_for_fail = project_id;
    let bus_for_fail = bus.clone();
    let fail = |reason: String| {
        let title = title_for_fail.clone();
        let today = today_for_fail.clone();
        let pool = pool_for_fail.clone();
        let project_id = project_id_for_fail;
        let bus = bus_for_fail.clone();
        let reason_for_log = reason.clone();
        tokio::spawn(async move {
            tracing::warn!("cults3d_publish skip: {reason_for_log}");
            let now = chrono::Utc::now().timestamp();
            let _ = sqlx::query(
                "INSERT INTO cults3d_publishes \
                 (project_id, local_listing_id, title, state, error, published_at, day) \
                 VALUES (?, ?, ?, 'errored', ?, ?, ?)",
            )
            .bind(project_id)
            .bind(local_listing_id)
            .bind(&title)
            .bind(&reason_for_log)
            .bind(now)
            .bind(&today)
            .execute(&pool)
            .await;
            bus.send(SupervisorEvent::Cults3dPublishFailed {
                local_listing_id,
                reason: reason_for_log,
            });
        });
        let _ = reason;
    };

    let Some(asset_path_str) = asset_path_str else {
        fail("publisher result has no asset_path".into());
        return;
    };
    let stl_path = PathBuf::from(&asset_path_str);
    let png_path = stl_path.with_extension("png");
    if !stl_path.exists() {
        fail(format!("stl missing at {}", stl_path.display()));
        return;
    }
    if !png_path.exists() {
        fail(format!("preview png missing at {}", png_path.display()));
        return;
    }

    // Bundle: extra STL files for multi-file Cults3D listings. We host each
    // in the SAME GitHub release as the primary so the marketplace links
    // them as a unit (one release per Cults3D creation). Filter to existing
    // entries that aren't the primary; an empty list means single-file
    // listing (back-compat).
    let extra_stl_paths: Vec<PathBuf> = publisher_result
        .get("asset_paths")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(PathBuf::from)
                .filter(|p| p.exists() && *p != stl_path)
                .collect()
        })
        .unwrap_or_default();
    // Cults3D doesn't publish a hard file-count cap on creations. We mirror
    // Etsy's 5-file ceiling (4 extras) so the same designer-side bundle cap
    // (BUNDLE_MAX_ITEMS=4) doesn't accidentally split into a longer
    // marketplace list than every other platform.
    const CULTS3D_MAX_EXTRA_FILES: usize = 4;
    let extra_stl_paths: Vec<PathBuf> = extra_stl_paths
        .into_iter()
        .take(CULTS3D_MAX_EXTRA_FILES)
        .collect();

    let Some(creds) = creds_from_secrets() else {
        fail("cults3d credentials missing (set username + api_key)".into());
        return;
    };
    let github_repo = secrets::get("github_asset_repo").ok().flatten().unwrap_or_default();
    let github_token = secrets::get("github_asset_token").ok().flatten().unwrap_or_default();
    if github_repo.is_empty() || github_token.is_empty() {
        fail("github asset host not configured (need repo + token)".into());
        return;
    }

    // Daily cap.
    let cap: i64 = secrets::get("cults3d_daily_cap")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_DAILY_CAP);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM cults3d_publishes WHERE project_id = ? AND day = ? AND state = 'published'",
    )
    .bind(project_id)
    .bind(&today)
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    if count >= cap {
        bus.send(SupervisorEvent::Cults3dCapped { count, cap });
        return;
    }

    let client = reqwest::Client::new();

    // Host the assets at public HTTPS URLs.
    let hosted = match asset_host_github::host_listing_assets(
        &client,
        &github_repo,
        &github_token,
        local_listing_id,
        &stl_path,
        &png_path,
    )
    .await
    {
        Ok(h) => h,
        Err(e) => {
            fail(format!("github asset host failed: {e:#}"));
            return;
        }
    };

    // Bundle: upload each extra STL into the SAME GitHub release so all
    // bundle files share the listing's tag. Per-file failures are
    // non-fatal — the primary STL is already hosted and the listing can
    // ship with N-1 items rather than failing entirely. Each successful
    // URL gets collected into the file_urls list below.
    let mut file_urls: Vec<String> = vec![hosted.file_url.clone()];
    for (idx, extra) in extra_stl_paths.iter().enumerate() {
        match asset_host_github::upload_extra_model(
            &client,
            &hosted.upload_url,
            &github_token,
            local_listing_id,
            idx,
            extra,
        )
        .await
        {
            Ok(extra_url) => file_urls.push(extra_url),
            Err(e) => {
                tracing::warn!(
                    "cults3d bundle: extra STL {} of {} ({}) host failed: {e:#}",
                    idx + 1,
                    extra_stl_paths.len(),
                    extra.display(),
                );
            }
        }
    }

    // Categorize.
    let categories = cached_categories(&client, &creds).await;
    let category_id = categories
        .as_deref()
        .and_then(|cats| cults3d::pick_category(cats, &niche, &tags));

    let input = cults3d::CreateCreationInput {
        name: title.clone(),
        description,
        image_urls: vec![hosted.image_url.clone()],
        file_urls: file_urls.clone(),
        currency: "USD".into(),
        download_price: price_usd,
        license_code: "cults_cu".into(),
        category_id,
        sub_category_ids: vec![],
        tag_names: tags,
        locale: "EN".into(),
        made_with_ai: true,
    };

    let now = chrono::Utc::now().timestamp();
    match cults3d::create_creation(&client, &creds, &input).await {
        Ok(res) => {
            if let Err(e) = sqlx::query(
                "INSERT INTO cults3d_publishes \
                 (project_id, local_listing_id, cults3d_creation_id, title, url, \
                  file_url, image_url, price_usd, state, published_at, day) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?)",
            )
            .bind(project_id)
            .bind(local_listing_id)
            .bind(&res.creation_id)
            .bind(&title)
            .bind(&res.url)
            .bind(&hosted.file_url)
            .bind(&hosted.image_url)
            .bind(price_usd)
            .bind(now)
            .bind(&today)
            .execute(pool)
            .await
            {
                tracing::warn!("cults3d_publishes insert failed: {e}");
            }
            let _ = crate::etsy_ingest::append_marketplace_publish_outcome(
                "cults3d_publish",
                local_listing_id,
                &niche,
                &title,
                &res.creation_id,
                Some(&res.url),
                price_usd,
            );
            bus.send(SupervisorEvent::Cults3dPublished {
                local_listing_id,
                creation_id: res.creation_id.clone(),
                url: res.url.clone(),
            });
        }
        Err(e) => {
            // Don't leave the host release orphaned.
            asset_host_github::delete_release(
                &client,
                &github_repo,
                &github_token,
                hosted.release_id,
            )
            .await;
            let reason = format!("cults3d createCreation failed: {e:#}");
            if let Err(db_err) = sqlx::query(
                "INSERT INTO cults3d_publishes \
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
                tracing::warn!("cults3d_publishes errored insert failed: {db_err}");
            }
            fail(reason);
        }
    }
}
