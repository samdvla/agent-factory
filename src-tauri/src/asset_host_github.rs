//! GitHub Releases-backed asset hosting.
//!
//! Cults3D (and other 3D marketplaces) pull assets from public HTTPS URLs
//! rather than accepting multipart uploads. GitHub Releases gives us
//! immutable HTTPS URLs for free, with no S3 account required: each asset
//! becomes a release artifact whose `browser_download_url` is what we hand
//! to the marketplace.
//!
//! The user supplies:
//!   - `github_asset_repo`  — "owner/name" of a PUBLIC repo they own
//!   - `github_asset_token` — a PAT (fine-grained or classic) with
//!     `contents:write` on that repo
//!
//! Each call to `host_listing_assets` creates a new release tagged
//! `asset-<job_id>-<timestamp>` and uploads both the model file (STL/GLB)
//! and the preview PNG to it. Returns the two public URLs.

use anyhow::{anyhow, Context, Result};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde::Deserialize;
use std::path::Path;

const GITHUB_API: &str = "https://api.github.com";
const UA: &str = "agent-factory/1.0";

#[derive(Debug, Clone)]
pub struct HostedAssets {
    pub file_url: String,
    pub image_url: String,
    /// Release id we just created — useful for cleanup if the publish step fails.
    pub release_id: i64,
    pub tag: String,
    /// Upload URL template for the release. Cached so callers can append
    /// extra bundle files to the same release without re-fetching it from
    /// GitHub. Cults3D consumes the resulting URLs as `fileUrls[]`.
    pub upload_url: String,
}

#[derive(Debug, Deserialize)]
struct ReleaseResp {
    id: i64,
    upload_url: String,
}

#[derive(Debug, Deserialize)]
struct UploadResp {
    browser_download_url: String,
}

fn auth_value(token: &str) -> String {
    format!("Bearer {token}")
}

/// Best-effort cleanup: delete a release on failure so we don't leak tags.
pub async fn delete_release(client: &reqwest::Client, repo: &str, token: &str, release_id: i64) {
    let url = format!("{GITHUB_API}/repos/{repo}/releases/{release_id}");
    let _ = client
        .delete(&url)
        .header(AUTHORIZATION, auth_value(token))
        .header(USER_AGENT, UA)
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await;
}

async fn create_release(
    client: &reqwest::Client,
    repo: &str,
    token: &str,
    tag: &str,
    name: &str,
) -> Result<ReleaseResp> {
    let url = format!("{GITHUB_API}/repos/{repo}/releases");
    let body = serde_json::json!({
        "tag_name": tag,
        "name": name,
        "body": "Auto-generated asset host release for an agent-factory listing.",
        "draft": false,
        "prerelease": false,
    });
    let resp = client
        .post(&url)
        .header(AUTHORIZATION, auth_value(token))
        .header(USER_AGENT, UA)
        .header(ACCEPT, "application/vnd.github+json")
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .context("github create release POST failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("github create release HTTP {status}: {text}"));
    }
    serde_json::from_str(&text).with_context(|| format!("parse release resp: {text}"))
}

/// Returns true if the error message from create_release looks like
/// GitHub's "Repository is empty" rejection. GitHub refuses to attach
/// releases to repos with zero commits.
fn is_empty_repo_error(err_msg: &str) -> bool {
    err_msg.contains("Repository is empty")
}

/// Initialize an empty repo by committing a README.md via the Contents
/// API. Idempotent: if the file already exists GitHub returns 422 which
/// we silently swallow (the repo already has a commit, which is all we
/// need for releases to work). This makes asset hosting work on a
/// freshly-created repo without the operator having to push manually.
async fn bootstrap_empty_repo(
    client: &reqwest::Client,
    repo: &str,
    token: &str,
) -> Result<()> {
    use base64::Engine;
    let url = format!("{GITHUB_API}/repos/{repo}/contents/README.md");
    let content_b64 = base64::engine::general_purpose::STANDARD.encode(
        "# Agent Factory Asset Host\n\n\
         Auto-initialized by agent-factory. Files in this repo are uploaded as \
         release assets and served to 3D marketplaces (Cults3D, etc.) as \
         public download URLs.\n",
    );
    let body = serde_json::json!({
        "message": "Initialize asset host repo",
        "content": content_b64,
    });
    let resp = client
        .put(&url)
        .header(AUTHORIZATION, auth_value(token))
        .header(USER_AGENT, UA)
        .header(ACCEPT, "application/vnd.github+json")
        .header(CONTENT_TYPE, "application/json")
        .json(&body)
        .send()
        .await
        .context("github bootstrap PUT contents failed")?;
    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }
    // 422 = file already exists / sha mismatch — that means another path
    // already created a commit, which is exactly what we wanted. Treat
    // as success so we don't break a repo that someone else just bootstrapped.
    if status == reqwest::StatusCode::UNPROCESSABLE_ENTITY {
        return Ok(());
    }
    let text = resp.text().await.unwrap_or_default();
    Err(anyhow!("github bootstrap HTTP {status}: {text}"))
}

/// Wrap create_release with one auto-recovery for the empty-repo case.
/// First create attempt → if it fails with "Repository is empty", commit
/// a README via the Contents API then retry. One retry only — if the
/// second create_release still fails we surface the error as before.
async fn create_release_with_bootstrap(
    client: &reqwest::Client,
    repo: &str,
    token: &str,
    tag: &str,
    name: &str,
) -> Result<ReleaseResp> {
    match create_release(client, repo, token, tag, name).await {
        Ok(r) => Ok(r),
        Err(e) => {
            let msg = format!("{e:#}");
            if !is_empty_repo_error(&msg) {
                return Err(e);
            }
            tracing::info!(
                "github asset host: repo {repo} is empty — bootstrapping with a README and retrying"
            );
            bootstrap_empty_repo(client, repo, token)
                .await
                .with_context(|| "bootstrap empty repo before release create")?;
            create_release(client, repo, token, tag, name).await
        }
    }
}

async fn upload_asset(
    client: &reqwest::Client,
    upload_url: &str,
    token: &str,
    file_path: &Path,
    file_name: &str,
    content_type: &str,
) -> Result<String> {
    // upload_url comes back as e.g.
    //   "https://uploads.github.com/repos/foo/bar/releases/123/assets{?name,label}"
    // We strip the {?...} template and append our own ?name= query.
    let base = upload_url.split('{').next().unwrap_or(upload_url);
    let url = format!("{base}?name={}", urlencoding::encode(file_name));
    let bytes = std::fs::read(file_path)
        .with_context(|| format!("read asset {}", file_path.display()))?;
    let resp = client
        .post(&url)
        .header(AUTHORIZATION, auth_value(token))
        .header(USER_AGENT, UA)
        .header(ACCEPT, "application/vnd.github+json")
        .header(CONTENT_TYPE, content_type)
        .body(bytes)
        .send()
        .await
        .context("github upload asset POST failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("github upload asset HTTP {status}: {text}"));
    }
    let parsed: UploadResp =
        serde_json::from_str(&text).with_context(|| format!("parse upload resp: {text}"))?;
    Ok(parsed.browser_download_url)
}

/// Host the model file (.stl/.glb) and the preview PNG. Both URLs are
/// returned; the caller passes them to the marketplace as
/// `fileUrls` / `imageUrls`. On any error after release creation we attempt
/// to delete the release so we don't leave orphans behind.
pub async fn host_listing_assets(
    client: &reqwest::Client,
    repo: &str,
    token: &str,
    job_id: i64,
    model_path: &Path,
    preview_png_path: &Path,
) -> Result<HostedAssets> {
    if repo.is_empty() || !repo.contains('/') {
        return Err(anyhow!("github asset repo must be 'owner/name', got {repo:?}"));
    }
    if token.is_empty() {
        return Err(anyhow!("github asset token is empty"));
    }
    let ts = chrono::Utc::now().timestamp();
    let tag = format!("asset-{job_id}-{ts}");
    let name = format!("agent-factory asset {job_id}");

    let release = create_release_with_bootstrap(client, repo, token, &tag, &name).await?;

    let model_name = model_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow!("model path has no filename"))?;
    let png_name = preview_png_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow!("preview path has no filename"))?;

    let model_mime = match model_path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("stl") => "model/stl",
        Some("glb") => "model/gltf-binary",
        Some("zip") => "application/zip",
        Some("obj") => "model/obj",
        _ => "application/octet-stream",
    };

    let file_url = match upload_asset(
        client,
        &release.upload_url,
        token,
        model_path,
        model_name,
        model_mime,
    )
    .await
    {
        Ok(u) => u,
        Err(e) => {
            delete_release(client, repo, token, release.id).await;
            return Err(e.context("upload model asset"));
        }
    };
    let image_url = match upload_asset(
        client,
        &release.upload_url,
        token,
        preview_png_path,
        png_name,
        "image/png",
    )
    .await
    {
        Ok(u) => u,
        Err(e) => {
            delete_release(client, repo, token, release.id).await;
            return Err(e.context("upload preview png"));
        }
    };

    Ok(HostedAssets {
        file_url,
        image_url,
        release_id: release.id,
        tag,
        upload_url: release.upload_url,
    })
}

/// Append an extra model file to an EXISTING release (created by
/// `host_listing_assets`). Returns the public URL. Used by Cults3D's
/// bundle path: one release per listing carries every STL so the listing
/// page links to N downloads, not N separate releases. Each filename is
/// suffixed with an item index so two-stl bundles don't collide.
pub async fn upload_extra_model(
    client: &reqwest::Client,
    upload_url: &str,
    token: &str,
    job_id: i64,
    item_index: usize,
    model_path: &Path,
) -> Result<String> {
    if token.is_empty() {
        return Err(anyhow!("github asset token is empty"));
    }
    let ext = model_path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "stl" => "model/stl",
        "glb" => "model/gltf-binary",
        "zip" => "application/zip",
        "obj" => "model/obj",
        _ => "application/octet-stream",
    };
    // Pick a stable, unique-per-listing filename so GitHub doesn't collide.
    // The original `host_listing_assets` writes the asset under its source
    // basename, which can clash when two bundle items have nearby ids (the
    // designer uses job_id*100+idx so they're distinct, but defensive
    // suffixing keeps the upload deterministic regardless of source path).
    let file_name = format!(
        "agent-factory-asset-{job_id}-{idx}.{ext}",
        job_id = job_id,
        idx = item_index + 2, // matches Etsy's rank 2..N
        ext = if ext.is_empty() { "stl".to_string() } else { ext.clone() },
    );
    upload_asset(client, upload_url, token, model_path, &file_name, mime).await
}

/// Auth/permission ping: hit the repo endpoint with the token; success means
/// the token has access to the repo. Returns the default branch on success
/// so the UI can show something useful.
pub async fn verify(client: &reqwest::Client, repo: &str, token: &str) -> Result<String> {
    if repo.is_empty() || !repo.contains('/') {
        return Err(anyhow!("repo must be 'owner/name'"));
    }
    let url = format!("{GITHUB_API}/repos/{repo}");
    let resp = client
        .get(&url)
        .header(AUTHORIZATION, auth_value(token))
        .header(USER_AGENT, UA)
        .header(ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .context("github verify GET failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("github verify HTTP {status}: {text}"));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&text).with_context(|| format!("parse repo resp: {text}"))?;
    let private = parsed
        .get("private")
        .and_then(|b| b.as_bool())
        .unwrap_or(false);
    if private {
        return Err(anyhow!(
            "repo {repo} is private — Cults3D needs PUBLIC HTTPS URLs. Make it public, or pick another repo."
        ));
    }
    let default_branch = parsed
        .get("default_branch")
        .and_then(|s| s.as_str())
        .unwrap_or("main")
        .to_string();

    // GitHub's Releases API rejects repos that have zero commits with
    // HTTP 422 "Repository is empty". We detect that here at setup time
    // (the `size` field is 0 for an empty repo and the GET /repos
    // response omits `default_branch` for empty repos) and bootstrap a
    // README.md so the very first publish doesn't have to self-heal.
    // Idempotent — bootstrap_empty_repo treats 422-on-file-exists as ok.
    let size = parsed.get("size").and_then(|v| v.as_i64()).unwrap_or(0);
    let no_default_branch = parsed.get("default_branch").is_none()
        || parsed
            .get("default_branch")
            .map(|v| v.is_null())
            .unwrap_or(true);
    if size == 0 && no_default_branch {
        tracing::info!(
            "github asset host: repo {repo} is empty at verify time — \
             bootstrapping with README.md"
        );
        bootstrap_empty_repo(client, repo, token)
            .await
            .with_context(|| "bootstrap empty repo during verify")?;
    }

    Ok(default_branch)
}
