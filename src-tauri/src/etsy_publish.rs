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
/// 2078 corresponds to "Art & Collectibles > Prints > Digital Prints" — a
/// reasonable home for the digital-download products this pipeline currently
/// produces. (Verified live against Etsy's seller-taxonomy endpoint —
/// 68887 was the legacy id and is now rejected with `Invalid taxonomy_id`.)
pub const DEFAULT_TAXONOMY_ID: i64 = 2078;

/// Default daily cap on real Etsy publishes per project.
pub const DEFAULT_DAILY_CAP: i64 = 3;

/// Etsy's digital-file upload endpoint caps each file at 20 MB. We refuse
/// anything ≥ 19 MB so there's a small safety margin against multipart-form
/// overhead pushing a borderline file over the limit. Hitting this cap is
/// usually a Tripo PBR-textured GLB at full resolution — the fix is mesh
/// decimation upstream, but we still guard here so a borderline file doesn't
/// cost us a half-created draft on Etsy.
pub const ETSY_DIGITAL_FILE_MAX_BYTES: u64 = 19 * 1024 * 1024;

/// Etsy caps digital downloads at 5 files per listing. For bundles we
/// upload the primary STL at rank 1 plus up to 4 more at ranks 2-5.
/// Anything beyond gets silently dropped at the supervisor edge — the
/// designer's bundle cap (BUNDLE_MAX_ITEMS default 4) already keeps us
/// inside this ceiling; this constant exists as a defensive guard against
/// an env-var override that pushes the cap higher.
pub const ETSY_MAX_DIGITAL_FILES: usize = 5;

/// Returned from `publish_draft` when the digital asset is too large for
/// Etsy. Recognized by the supervisor so it emits a friendlier event and
/// skips the retry loop.
pub const ETSY_ASSET_TOO_LARGE_TAG: &str = "ETSY_ASSET_TOO_LARGE";

#[derive(Debug, Clone)]
pub struct ListingDraft {
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub price_usd: f64,
    pub taxonomy_id: i64,
    /// Primary listing image — always uploaded as rank 1.
    pub png_path: PathBuf,
    /// Extra preview images (multi-angle 3D renders). Uploaded as rank
    /// 2..N. Empty for 2D / single-thumbnail listings.
    pub extra_png_paths: Vec<PathBuf>,
    /// Primary digital asset — always uploaded as file rank 1.
    pub svg_path: PathBuf,
    /// Additional digital files for bundle listings (one extra STL per
    /// bundle item beyond the primary). Each is uploaded as a separate
    /// file under the same listing_id with sequential rank 2..N. Empty
    /// for single-item listings; capped at ETSY_MAX_DIGITAL_FILES - 1.
    pub extra_svg_paths: Vec<PathBuf>,
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
    shop_id: i64,
    draft: &ListingDraft,
) -> Result<CreateListingResponse> {
    // Size-check the digital file BEFORE we POST to /listings so we don't
    // leave a half-created draft on Etsy that can't be completed.
    if let Ok(meta) = std::fs::metadata(&draft.svg_path) {
        let size = meta.len();
        if size > ETSY_DIGITAL_FILE_MAX_BYTES {
            let mb = (size as f64) / (1024.0 * 1024.0);
            anyhow::bail!(
                "{}: digital asset {} is {:.1} MB (Etsy cap is {} MB) — skipping publish; compress upstream or pick a smaller Tripo model",
                ETSY_ASSET_TOO_LARGE_TAG,
                draft.svg_path.display(),
                mb,
                ETSY_DIGITAL_FILE_MAX_BYTES / (1024 * 1024),
            );
        }
    }

    let access_token = etsy::ensure_fresh_token(client).await?;
    let create_resp = create_draft(client, &access_token, shop_id, draft)
        .await
        .context("create draft listing")?;
    upload_image(
        client,
        &access_token,
        shop_id,
        create_resp.listing_id,
        &draft.png_path,
        1,
    )
    .await
    .context("upload listing image")?;
    // Extra angle renders — rank 2..N. Etsy caps a listing at 10 images;
    // we trust the caller to have pre-trimmed but cap defensively here so
    // a runaway designer can't fail the whole publish.
    for (idx, extra) in draft.extra_png_paths.iter().take(9).enumerate() {
        let rank = (idx + 2) as i64;
        if let Err(e) = upload_image(
            client,
            &access_token,
            shop_id,
            create_resp.listing_id,
            extra,
            rank,
        )
        .await
        {
            // Don't fail the whole publish if one extra image upload fails.
            // The primary thumbnail is already up — partial gallery beats
            // dropping the listing entirely.
            tracing::warn!(
                "extra image rank {} upload failed for listing {}: {e}",
                rank,
                create_resp.listing_id
            );
        }
    }
    upload_file(
        client,
        &access_token,
        shop_id,
        create_resp.listing_id,
        &draft.svg_path,
        draft.job_id,
        1,
    )
    .await
    .context("upload listing digital file")?;

    // Bundle path: upload every additional STL under the same listing at
    // sequential ranks. Etsy hard-caps at 5 files/listing; we subtract the
    // primary's slot and refuse anything beyond. Per-file failures are
    // non-fatal — the primary file is already up, partial bundle still
    // ships; the supervisor's outcome log captures which item failed so we
    // can chase it offline.
    let extras_to_upload: Vec<&PathBuf> = draft
        .extra_svg_paths
        .iter()
        .take(ETSY_MAX_DIGITAL_FILES.saturating_sub(1))
        .collect();
    for (idx, extra) in extras_to_upload.iter().enumerate() {
        let rank = (idx + 2) as i64;
        // Size-guard each extra so we don't half-create a multi-file listing
        // when item 3 of 4 is over Etsy's 20 MB cap. Logging a warning + skip
        // beats a hard fail mid-bundle.
        if let Ok(meta) = std::fs::metadata(extra) {
            if meta.len() > ETSY_DIGITAL_FILE_MAX_BYTES {
                tracing::warn!(
                    "etsy bundle: skipping extra rank {} {} ({} bytes > {} MB cap)",
                    rank,
                    extra.display(),
                    meta.len(),
                    ETSY_DIGITAL_FILE_MAX_BYTES / (1024 * 1024),
                );
                continue;
            }
        }
        if let Err(e) = upload_file(
            client,
            &access_token,
            shop_id,
            create_resp.listing_id,
            extra,
            draft.job_id,
            rank,
        )
        .await
        {
            tracing::warn!(
                "etsy bundle: extra file rank {} upload failed for listing {}: {e}",
                rank,
                create_resp.listing_id,
            );
        }
    }
    Ok(create_resp)
}

async fn create_draft(
    client: &reqwest::Client,
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
    access_token: &str,
    shop_id: i64,
    listing_id: i64,
    png_path: &Path,
    rank: i64,
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
    let form = Form::new().part("image", part).text("rank", rank.to_string());
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

/// Map a file extension to the MIME type Etsy expects. Anything we don't
/// recognize falls back to `application/octet-stream`, which Etsy accepts
/// for arbitrary digital downloads.
fn mime_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        // 3D formats — Etsy doesn't have official MIME mappings for these,
        // model/* is the IETF-registered form for STL/GLB/OBJ.
        "stl" => "model/stl",
        "glb" => "model/gltf-binary",
        "gltf" => "model/gltf+json",
        "obj" => "model/obj",
        "fbx" => "application/octet-stream",
        _ => "application/octet-stream",
    }
}

/// Parse `result.asset_paths` into the list of extra digital files to upload
/// alongside the primary. Single-listing back-compat: when the field is
/// missing or contains only the primary path, the returned vec is empty and
/// the publish flow runs unchanged.
///
/// Filtering rules:
///   • Drop non-string entries.
///   • Drop paths that don't exist on disk.
///   • Drop the primary path (already uploaded as rank 1).
///   • Cap at Etsy's per-listing file ceiling minus 1.
pub fn extract_extra_asset_paths(
    result: &serde_json::Value,
    primary: &Path,
) -> Vec<PathBuf> {
    result
        .get("asset_paths")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(PathBuf::from)
                .filter(|p| p.exists() && p != primary)
                .take(ETSY_MAX_DIGITAL_FILES.saturating_sub(1))
                .collect()
        })
        .unwrap_or_default()
}

/// Extract the textured GLB(s) the designer produced alongside the STL(s).
/// These ride along in the buyer's digital-download bundle so they can preview
/// the colored, textured model in any GLB viewer (Windows 3D Viewer, Blender,
/// Sketchfab, browser model-viewer) before slicing/printing — the STL alone
/// only shows topology, which under-sells the work.
///
/// Filtering mirrors `extract_extra_asset_paths`: drop non-existent / primary
/// duplicates / non-strings. Caller is responsible for keeping the combined
/// extras + GLB count within `ETSY_MAX_DIGITAL_FILES - 1`.
pub fn extract_extra_glb_paths(
    result: &serde_json::Value,
    primary: &Path,
    already_included: &[PathBuf],
) -> Vec<PathBuf> {
    let mut from_list: Vec<PathBuf> = result
        .get("glb_paths")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(PathBuf::from)
                .filter(|p| p.exists() && p != primary && !already_included.contains(p))
                .collect()
        })
        .unwrap_or_default();
    // Single-listing fallback: when `glb_paths` isn't a list, the designer
    // still emits the singular `glb_path` on every image-to-3D cycle.
    if from_list.is_empty() {
        if let Some(p) = result
            .get("glb_path")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
        {
            if p.exists() && p != *primary && !already_included.contains(&p) {
                from_list.push(p);
            }
        }
    }
    from_list
}

/// Build the upload filename for an Etsy digital asset.
///
/// Rank 1 keeps the legacy `agent-factory-asset-{job}.stl` form so anything
/// pattern-matching on the old filename still works. Rank 2+ embeds the
/// rank into the filename so the per-listing file list shows each bundle
/// item as a distinct download (Etsy renders the filename in the buyer's
/// "Downloads" panel).
pub fn build_upload_filename(asset_path: &Path, job_id: i64, rank: i64) -> String {
    let ext = asset_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    if rank <= 1 {
        format!("agent-factory-asset-{job_id}.{ext}")
    } else {
        format!("agent-factory-asset-{job_id}-{rank}.{ext}")
    }
}

async fn upload_file(
    client: &reqwest::Client,
    access_token: &str,
    shop_id: i64,
    listing_id: i64,
    asset_path: &Path,
    job_id: i64,
    rank: i64,
) -> Result<()> {
    let url = format!(
        "{}/shops/{}/listings/{}/files",
        etsy::API_BASE,
        shop_id,
        listing_id
    );
    let bytes = std::fs::read(asset_path)
        .with_context(|| format!("read asset {}", asset_path.display()))?;
    let file_name = build_upload_filename(asset_path, job_id, rank);
    let mime = mime_for(asset_path);
    let part = Part::bytes(bytes)
        .file_name(file_name.clone())
        .mime_str(mime)
        .with_context(|| format!("asset mime ({mime})"))?;
    let form = Form::new()
        .part("file", part)
        .text("name", file_name)
        .text("rank", rank.to_string());
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

    // Surface a missing keystring early — api_key_header() would otherwise
    // fail mid-request. We don't capture the value; etsy::api_key_header()
    // pulls keystring + shared_secret from the keychain on every call.
    let keystring_present = crate::secrets::get("etsy_api_keystring")
        .ok()
        .flatten()
        .map(|k| !k.is_empty())
        .unwrap_or(false);
    if !keystring_present {
        bus.send(SupervisorEvent::EtsyListingPublishFailed {
            local_listing_id,
            reason: "etsy_api_keystring not in keychain".into(),
        });
        return;
    }

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

    // Multi-angle preview renders from the designer (3D briefs only).
    // Filter to entries that actually exist on disk + dedupe against the
    // primary png to avoid uploading the same image twice when the
    // designer included the thumbnail in preview_pngs.
    let extra_png_paths: Vec<PathBuf> = result
        .get("preview_pngs")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str())
                .map(PathBuf::from)
                .filter(|p| p.exists() && *p != png_path)
                .collect()
        })
        .unwrap_or_default();

    // Bundle digital files. Publisher emits `asset_paths` (list) for both
    // single + bundle listings; we filter to entries that exist, drop the
    // primary (already covered by svg_path), and cap at Etsy's per-listing
    // file ceiling. Single listings → empty extras → behaves identically to
    // the pre-bundle code path.
    let mut extra_svg_paths = extract_extra_asset_paths(result, &svg_path);
    // Also bundle the textured GLB(s) so the buyer can preview the colored,
    // PBR-shaded model before printing — the STL alone reads as a topology
    // ghost in most viewers and under-sells the work. We cap the combined
    // total at ETSY_MAX_DIGITAL_FILES - 1 (primary STL = rank 1).
    let glb_extras = extract_extra_glb_paths(result, &svg_path, &extra_svg_paths);
    let remaining = ETSY_MAX_DIGITAL_FILES
        .saturating_sub(1)
        .saturating_sub(extra_svg_paths.len());
    extra_svg_paths.extend(glb_extras.into_iter().take(remaining));

    // Optional rigged + animated GLBs from the Meshy rig+anim pass.
    // Only present when the designer detected a full-body humanoid
    // figurine. Etsy buyers value these as a "import into Blender / UE
    // and animate" upsell, so we ship them as additional digital files
    // (separate ranks → separate filenames in the buyer's Downloads).
    let rig_extras: Vec<PathBuf> = ["rigged_glb_path", "animated_glb_path",
                                    "walking_glb_path", "running_glb_path"]
        .iter()
        .filter_map(|k| {
            result
                .get(k)
                .and_then(|v| v.as_str())
                .map(PathBuf::from)
                .filter(|p| p.exists() && *p != *svg_path && !extra_svg_paths.contains(p))
        })
        .collect();
    let remaining = ETSY_MAX_DIGITAL_FILES
        .saturating_sub(1)
        .saturating_sub(extra_svg_paths.len());
    extra_svg_paths.extend(rig_extras.into_iter().take(remaining));

    // Pinterest source image. The publisher emits this path on every
    // 3D-listing cycle; we don't pre-validate existence here because the
    // pinterest_publish handler does that itself + records failures. None
    // means the publisher didn't generate a pin (PINTEREST_PIN_ENABLED=0
    // or the renderer failed silently).
    let pinterest_pin_path: Option<PathBuf> = result
        .get("pinterest_pin_path")
        .and_then(|v| v.as_str())
        .map(PathBuf::from);
    // Clone the strings we'll need AFTER the Etsy publish completes — the
    // draft consumes the originals.
    let description_for_pin = description.clone();
    let title_for_pin = title.clone();

    let draft = ListingDraft {
        title: title.clone(),
        description,
        tags,
        price_usd,
        taxonomy_id: DEFAULT_TAXONOMY_ID,
        png_path,
        extra_png_paths,
        svg_path,
        extra_svg_paths,
        job_id,
    };

    let client = reqwest::Client::new();
    let publish_res = publish_draft(&client, shop_id, &draft).await;
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
            // Etsy charges $0.20 per listing creation. Stamp it on the
            // budget_ledger so the topbar Net pill sees the real total
            // cost of shipping each listing, not just the LLM+mesh side.
            // The per-call rate lives in budget::per_call_usd under the
            // ledger model "etsy-listing-fee".
            if let Err(e) = crate::budget::record(
                pool, project_id, "etsy-listing-fee", 0, 0,
            ).await {
                tracing::error!("budget::record etsy-listing-fee failed: {e}");
            } else {
                bus.send(SupervisorEvent::BudgetSpent {
                    role: "publisher".into(),
                    cost_usd: crate::budget::cost_usd("etsy-listing-fee", 0, 0),
                    tokens_in: 0,
                    tokens_out: 0,
                    model: "etsy-listing-fee".to_string(),
                });
            }
            // Fire Pinterest pin in parallel. Pinterest needs the Etsy
            // URL (that's the whole funnel), so this only runs after a
            // successful Etsy publish. Every failure mode inside is
            // non-fatal — the Etsy listing already shipped.
            if let Some(pin_path) = pinterest_pin_path.clone() {
                let pool_for_pin = pool.clone();
                let bus_for_pin = bus.clone();
                let project_id_for_pin = project_id;
                let title_for_pin = title_for_pin.clone();
                let description_for_pin = description_for_pin.clone();
                let etsy_url_for_pin = url.clone();
                tokio::spawn(async move {
                    crate::pinterest_publish::pin_for_listing(
                        &pool_for_pin,
                        project_id_for_pin,
                        &bus_for_pin,
                        local_listing_id,
                        &title_for_pin,
                        &description_for_pin,
                        &pin_path,
                        etsy_url_for_pin.as_deref(),
                    )
                    .await;
                });
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

    // -------- Bundle (multi-file) tests -----------------------------------

    #[test]
    fn test_build_upload_filename_rank1_keeps_legacy_form() {
        let p = PathBuf::from("/tmp/123.stl");
        let name = build_upload_filename(&p, 123, 1);
        assert_eq!(name, "agent-factory-asset-123.stl");
        // Rank=0 (defensive: callers should always pass ≥1) also keeps the
        // legacy form so we never produce a `-0` filename.
        assert_eq!(
            build_upload_filename(&p, 123, 0),
            "agent-factory-asset-123.stl"
        );
    }

    #[test]
    fn test_build_upload_filename_rank_n_embeds_rank() {
        let p = PathBuf::from("/tmp/123.stl");
        assert_eq!(
            build_upload_filename(&p, 123, 2),
            "agent-factory-asset-123-2.stl"
        );
        assert_eq!(
            build_upload_filename(&p, 123, 5),
            "agent-factory-asset-123-5.stl"
        );
    }

    #[test]
    fn test_build_upload_filename_handles_missing_extension() {
        let p = PathBuf::from("/tmp/noextension");
        assert_eq!(
            build_upload_filename(&p, 7, 1),
            "agent-factory-asset-7.bin"
        );
    }

    #[test]
    fn test_extract_extra_asset_paths_empty_when_missing() {
        let v = serde_json::json!({ "title": "x" });
        let primary = PathBuf::from("/tmp/p.stl");
        assert!(extract_extra_asset_paths(&v, &primary).is_empty());
    }

    #[test]
    fn test_extract_extra_asset_paths_drops_primary_and_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let primary = tmp.path().join("primary.stl");
        let extra1 = tmp.path().join("extra1.stl");
        let extra2 = tmp.path().join("extra2.stl");
        let ghost = tmp.path().join("ghost.stl"); // never created
        std::fs::write(&primary, b"a").unwrap();
        std::fs::write(&extra1, b"b").unwrap();
        std::fs::write(&extra2, b"c").unwrap();

        let v = serde_json::json!({
            "asset_paths": [
                primary.to_string_lossy(),
                extra1.to_string_lossy(),
                extra2.to_string_lossy(),
                ghost.to_string_lossy(),
            ]
        });
        let out = extract_extra_asset_paths(&v, &primary);
        // primary dropped, ghost dropped, only the two existing extras remain.
        assert_eq!(out.len(), 2);
        assert!(out.contains(&extra1));
        assert!(out.contains(&extra2));
        assert!(!out.contains(&primary));
    }

    #[test]
    fn test_extract_extra_asset_paths_caps_at_max_minus_one() {
        let tmp = tempfile::tempdir().unwrap();
        let primary = tmp.path().join("primary.stl");
        std::fs::write(&primary, b"a").unwrap();
        let mut paths: Vec<String> = vec![primary.to_string_lossy().into()];
        // Create 10 extras — more than Etsy's 5-file ceiling.
        for i in 0..10 {
            let p = tmp.path().join(format!("e{i}.stl"));
            std::fs::write(&p, b"x").unwrap();
            paths.push(p.to_string_lossy().into());
        }
        let v = serde_json::json!({ "asset_paths": paths });
        let out = extract_extra_asset_paths(&v, &primary);
        // Cap = ETSY_MAX_DIGITAL_FILES - 1 = 4 extras (primary fills slot 5).
        assert_eq!(out.len(), ETSY_MAX_DIGITAL_FILES.saturating_sub(1));
    }

    #[test]
    fn test_extract_extra_asset_paths_ignores_non_string_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let primary = tmp.path().join("primary.stl");
        let extra = tmp.path().join("e.stl");
        std::fs::write(&primary, b"a").unwrap();
        std::fs::write(&extra, b"b").unwrap();
        let v = serde_json::json!({
            "asset_paths": [
                primary.to_string_lossy(),
                42,                       // bogus
                null,
                extra.to_string_lossy(),
                { "not": "a path" },
            ]
        });
        let out = extract_extra_asset_paths(&v, &primary);
        assert_eq!(out, vec![extra]);
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
            extra_png_paths: vec![],
            svg_path: PathBuf::from("/tmp/nope.svg"),
            extra_svg_paths: vec![],
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
