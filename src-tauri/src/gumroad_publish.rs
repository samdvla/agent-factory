//! Gumroad publish orchestration.
//!
//! Fires from supervisor.rs when a publisher job completes with a 3D
//! `product_type` AND `gumroad_enabled=true`.
//!
//! The flow uploads the printable STL (and the textured GLB preview)
//! through Gumroad's S3 presign flow, creates the product with those
//! files attached, then attaches a cover image. A product is only
//! recorded once its primary file is attached — we never leave empty
//! shells behind. Cover-image and extra-file failures are non-fatal and
//! surface in the `warning` column.

use crate::asset_host_github;
use crate::events::{EventBus, SupervisorEvent};
use crate::gumroad::{self, CreateProductInput, UploadedFile};
use crate::secrets;
use serde_json::Value;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};

pub fn creds_from_secrets() -> Option<gumroad::Creds> {
    let access_token = secrets::get("gumroad_access_token").ok().flatten().unwrap_or_default();
    if access_token.is_empty() {
        return None;
    }
    Some(gumroad::Creds { access_token })
}

/// Append the AI-generation disclosure to a description if it isn't
/// already mentioned. Gumroad has no structured "AI" tag, so disclosure
/// lives in the product description.
pub fn with_ai_disclosure(description_raw: &str) -> String {
    let lower = description_raw.to_lowercase();
    if lower.contains("generated with ai") || lower.contains("ai-generated") {
        description_raw.to_string()
    } else {
        format!("{description_raw}\n\n— Generated with AI.")
    }
}

/// Outcome of uploading the listing's files to Gumroad storage.
pub struct UploadedAssets {
    pub files: Vec<UploadedFile>,
    pub warnings: Vec<String>,
}

/// Upload the primary STL plus any extra files (textured GLB) via the
/// presign flow. The primary (index 0) is mandatory — if it fails the
/// whole call fails so we never create an empty product. Extra-file
/// failures collect into `warnings`.
pub async fn upload_listing_files(
    client: &reqwest::Client,
    creds: &gumroad::Creds,
    title: &str,
    primary: &Path,
    extras: &[PathBuf],
) -> Result<UploadedAssets, String> {
    let mut files: Vec<UploadedFile> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    match gumroad::upload_product_file(client, creds, primary).await {
        Ok(url) => files.push(UploadedFile {
            url,
            display_name: title.to_string(),
        }),
        Err(e) => return Err(format!("primary file upload failed: {e:#}")),
    }

    for extra in extras {
        let name = extra
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("<unnamed>");
        match gumroad::upload_product_file(client, creds, extra).await {
            Ok(url) => files.push(UploadedFile {
                url,
                display_name: format!("{title} — textured 3D preview (GLB)"),
            }),
            Err(e) => {
                tracing::warn!("gumroad extra file upload failed ({name}): {e:#}");
                warnings.push(format!("extra file {name} failed to upload: {e:#}"));
            }
        }
    }

    Ok(UploadedAssets { files, warnings })
}

/// Best-effort cover image: host the preview PNG at a public URL via the
/// GitHub asset host, hand it to Gumroad's cover endpoint, then drop the
/// throwaway release. Returns a warning string on any failure (cover is
/// never fatal). Returns `None` on success or when no cover is possible.
pub async fn attach_cover_best_effort(
    client: &reqwest::Client,
    creds: &gumroad::Creds,
    product_id: &str,
    job_id: i64,
    cover_png: Option<&Path>,
) -> Option<String> {
    let png = cover_png?;
    if !png.exists() {
        return Some(format!("cover image missing on disk: {}", png.display()));
    }
    // The hero render is sometimes WebP bytes in a .png file — Gumroad
    // rejects WebP covers, so guarantee a real PNG before hosting.
    let png = match crate::raster::ensure_real_png(png) {
        Ok(p) => p,
        Err(e) => return Some(format!("cover transcode failed: {e:#}")),
    };
    let repo = secrets::get("github_asset_repo").ok().flatten().unwrap_or_default();
    let token = secrets::get("github_asset_token").ok().flatten().unwrap_or_default();
    if repo.is_empty() || token.is_empty() {
        return Some(
            "cover skipped — GitHub asset host not configured (need repo + token)".into(),
        );
    }

    let hosted =
        match asset_host_github::host_cover_image(client, &repo, &token, job_id, &png).await {
            Ok(h) => h,
            Err(e) => return Some(format!("cover host failed: {e:#}")),
        };

    let cover_result = gumroad::add_cover(client, creds, product_id, &hosted.image_url).await;
    // Gumroad has downloaded its own copy by now — drop the throwaway release.
    asset_host_github::delete_release(client, &repo, &token, hosted.release_id).await;

    match cover_result {
        Ok(()) => None,
        Err(e) => Some(format!("cover attach failed: {e:#}")),
    }
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
    let description = with_ai_disclosure(
        publisher_result
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or(""),
    );
    let price_usd = publisher_result
        .get("price_usd")
        .and_then(|v| v.as_f64())
        .unwrap_or(4.99);
    let niche = publisher_result
        .get("niche")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let tags: Vec<String> = publisher_result
        .get("tags")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|t| t.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let job_id = publisher_result
        .get("job_id")
        .and_then(|v| v.as_i64())
        .unwrap_or(local_listing_id);

    let fail = |reason: String| {
        bus.send(SupervisorEvent::GumroadPublishFailed {
            local_listing_id,
            reason,
        });
    };

    let Some(asset_path_str) = publisher_result
        .get("asset_path")
        .and_then(|v| v.as_str())
        .map(String::from)
    else {
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

    // No artificial daily cap — Gumroad imposes no product-count limit, so
    // publish as fast as the pipeline produces.
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();

    // Attach the textured GLB alongside the printable STL so the buyer
    // gets the colored model as a bonus download. STL stays primary.
    let glb_candidate: Vec<PathBuf> = publisher_result
        .get("glb_path")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .filter(|p| p.exists() && *p != file_path)
        .into_iter()
        .collect();

    // Cover = the hero render that sits next to the STL as <stem>.png —
    // the same primary-image convention Etsy and Cults3D use. The
    // preview_pngs list also carries turntable frames (<stem>-angle-N.png);
    // angle-0 there is frequently the *back* of the model, so never use it.
    let cover_png: Option<PathBuf> = Some(file_path.with_extension("png"));

    let client = reqwest::Client::new();
    let now = chrono::Utc::now().timestamp();

    // Step 1: upload files. Primary failure aborts before any product
    // is created — no empty shells.
    let uploaded =
        match upload_listing_files(&client, &creds, &title, &file_path, &glb_candidate).await {
            Ok(u) => u,
            Err(reason) => {
                record_error(pool, project_id, local_listing_id, &title, &reason, now, &today)
                    .await;
                fail(format!("gumroad upload failed: {reason}"));
                return;
            }
        };
    let mut warnings = uploaded.warnings;

    // Step 2: create the product with files attached.
    let input = CreateProductInput {
        name: title.clone(),
        description,
        price_usd,
        tags,
    };
    let res = match gumroad::create_product(&client, &creds, &input, &uploaded.files).await {
        Ok(r) => r,
        Err(e) => {
            let reason = format!("gumroad create failed: {e:#}");
            record_error(pool, project_id, local_listing_id, &title, &reason, now, &today).await;
            fail(reason);
            return;
        }
    };

    // Step 3: cover image (best effort).
    if let Some(w) =
        attach_cover_best_effort(&client, &creds, &res.product_id, job_id, cover_png.as_deref())
            .await
    {
        warnings.push(w);
    }

    let warning = if warnings.is_empty() {
        None
    } else {
        Some(warnings.join("; "))
    };

    if let Err(e) = sqlx::query(
        "INSERT INTO gumroad_publishes \
         (project_id, local_listing_id, gumroad_product_id, title, short_url, edit_url, \
          price_usd, state, warning, published_at, day) \
         VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)",
    )
    .bind(project_id)
    .bind(local_listing_id)
    .bind(&res.product_id)
    .bind(&title)
    .bind(res.short_url.as_deref())
    .bind(res.edit_url.as_deref())
    .bind(price_usd)
    .bind(warning.as_deref())
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
        file_attached: true,
    });
}

async fn record_error(
    pool: &SqlitePool,
    project_id: i64,
    local_listing_id: i64,
    title: &str,
    reason: &str,
    now: i64,
    today: &str,
) {
    if let Err(e) = sqlx::query(
        "INSERT INTO gumroad_publishes \
         (project_id, local_listing_id, title, state, error, published_at, day) \
         VALUES (?, ?, ?, 'errored', ?, ?, ?)",
    )
    .bind(project_id)
    .bind(local_listing_id)
    .bind(title)
    .bind(reason)
    .bind(now)
    .bind(today)
    .execute(pool)
    .await
    {
        tracing::warn!("gumroad_publishes errored insert failed: {e}");
    }
}
