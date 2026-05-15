//! GitHub-backed asset hosting.
//!
//! Cults3D (and other 3D marketplaces) pull assets from public HTTPS URLs
//! rather than accepting multipart uploads.
//!
//! Listing assets are committed straight into the repo with the `git`
//! CLI (clone → commit → push) and served from `raw.githubusercontent.com`.
//! The git CLI — not the Git Data API — because the blob endpoint rejects
//! files over ~40-50 MB ("input too large to process") and generated STLs
//! routinely exceed that. Models over 95 MB are zipped before hosting so
//! they stay under GitHub's 100 MB push ceiling; Cults3D ingests ZIP fine.
//!
//! We deliberately do NOT use GitHub Release assets for listing files: a
//! release `browser_download_url` 302-redirects to an extensionless
//! `release-assets.githubusercontent.com` URL, and Cults3D parses the file
//! type from the URL path — it rejects the extensionless redirect target
//! with a generic "Unexpected error". A `raw.githubusercontent.com/<repo>/
//! <branch>/<path>/model.stl` URL keeps the filename + extension in the
//! path, which Cults3D ingests cleanly.
//!
//! Release assets ARE still used for transient cover-image hosting
//! (`host_cover_image`) — there the consumer (Gumroad) downloads the bytes
//! server-side and the release is deleted right after, so no repo bloat.
//!
//! The user supplies:
//!   - `github_asset_repo`  — "owner/name" of a PUBLIC repo they own
//!   - `github_asset_token` — a PAT (fine-grained or classic) with
//!     `contents:write` on that repo
//!
//! Note: committed listing assets accumulate in the repo's git history.
//! The operator is expected to periodically reset the repo to reclaim space.

use anyhow::{anyhow, Context, Result};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde::Deserialize;
use std::path::{Path, PathBuf};

const GITHUB_API: &str = "https://api.github.com";
const UA: &str = "agent-factory/1.0";

/// Directory name of the persistent asset-repo clone under the data dir.
const ASSET_REPO_DIRNAME: &str = "asset-repo";

/// Models above this size are zipped before hosting. GitHub hard-rejects a
/// `git push` carrying a blob over 100 MB; zipping a 120 MB STL drops it to
/// ~70 MB, safely under the ceiling. Cults3D accepts ZIP archives.
const LARGE_FILE_ZIP_THRESHOLD: u64 = 95_000_000;

#[derive(Debug, Clone)]
pub struct HostedAssets {
    /// `raw.githubusercontent.com` URL of the primary model file.
    pub file_url: String,
    /// `raw.githubusercontent.com` URLs of the preview images, in the order
    /// given (index 0 is the hero). Always at least one entry.
    pub image_urls: Vec<String>,
    /// `raw.githubusercontent.com` URLs of any extra model files (bundle
    /// items beyond the primary). Empty for single-model listings.
    pub extra_file_urls: Vec<String>,
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

fn basename(path: &Path) -> Result<String> {
    path.file_name()
        .and_then(|s| s.to_str())
        .map(String::from)
        .ok_or_else(|| anyhow!("path has no filename: {path:?}"))
}

// ---------------------------------------------------------------------------
// git-CLI asset hosting
// ---------------------------------------------------------------------------

/// Serializes all git operations on the shared local asset-repo clone — two
/// listings publishing at once must not race on the working tree.
fn repo_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Data directory for the persistent asset-repo clone. Mirrors the
/// `etsy_ingest` convention: honors `AGENT_FACTORY_DATA`, else `~/.agent-factory`.
fn data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("AGENT_FACTORY_DATA") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".agent-factory")
}

/// Remove a token from a string before it reaches a log or error message.
fn redact(s: &str, token: &str) -> String {
    if token.is_empty() {
        return s.to_string();
    }
    s.replace(token, "***")
}

/// Run `git -C <dir> <args>`; returns the captured output. `GIT_TERMINAL_PROMPT=0`
/// makes git fail fast instead of blocking on a credential prompt.
fn git_run(dir: &Path, args: &[&str]) -> Result<std::process::Output> {
    std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .with_context(|| format!("failed to spawn git {args:?}"))
}

/// Run a git command, erroring (token-redacted) on a non-zero exit.
fn git_ok(dir: &Path, args: &[&str], token: &str) -> Result<()> {
    let out = git_run(dir, args)?;
    if !out.status.success() {
        let stderr = redact(&String::from_utf8_lossy(&out.stderr), token);
        return Err(anyhow!("git {:?} failed: {}", args, stderr.trim()));
    }
    Ok(())
}

/// Ensure `<data_dir>/asset-repo` is a healthy clone of `repo`. Clones it
/// (shallow) when absent; discards and re-clones a corrupt directory. The
/// remote URL and committer identity are always refreshed so a rotated
/// token or a clone from older code still works.
fn ensure_clone(repo_dir: &Path, repo: &str, token: &str) -> Result<()> {
    let url = format!("https://x-access-token:{token}@github.com/{repo}.git");
    let healthy = repo_dir.join(".git").is_dir()
        && git_run(repo_dir, &["rev-parse", "--is-inside-work-tree"])
            .map(|o| o.status.success())
            .unwrap_or(false);
    if !healthy {
        if repo_dir.exists() {
            std::fs::remove_dir_all(repo_dir)
                .with_context(|| format!("clear stale clone {}", repo_dir.display()))?;
        }
        if let Some(parent) = repo_dir.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let out = std::process::Command::new("git")
            .args(["clone", "--depth", "1", &url])
            .arg(repo_dir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .context("failed to spawn git clone")?;
        if !out.status.success() {
            let stderr = redact(&String::from_utf8_lossy(&out.stderr), token);
            return Err(anyhow!("git clone {repo} failed: {}", stderr.trim()));
        }
    }
    // Refresh remote URL (rotated token) + committer identity every time.
    git_ok(repo_dir, &["remote", "set-url", "origin", &url], token)?;
    git_ok(repo_dir, &["config", "user.email", "factory@agent-factory.local"], token)?;
    git_ok(repo_dir, &["config", "user.name", "agent-factory"], token)?;
    Ok(())
}

/// Current branch name of the clone (falls back to `main`).
fn clone_branch(repo_dir: &Path, token: &str) -> Result<String> {
    let out = git_run(repo_dir, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    if !out.status.success() {
        let stderr = redact(&String::from_utf8_lossy(&out.stderr), token);
        return Err(anyhow!("git rev-parse HEAD failed: {}", stderr.trim()));
    }
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        return Ok("main".to_string());
    }
    Ok(branch)
}

/// Zip `src` to a flat archive when it exceeds the push-safe size limit.
/// Returns the path to host: the zip for an oversized file, otherwise `src`.
fn maybe_zip_large(src: &Path, work_dir: &Path) -> Result<PathBuf> {
    let size = std::fs::metadata(src)
        .with_context(|| format!("stat {}", src.display()))?
        .len();
    if size <= LARGE_FILE_ZIP_THRESHOLD {
        return Ok(src.to_path_buf());
    }
    std::fs::create_dir_all(work_dir).ok();
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("model");
    let zip_path = work_dir.join(format!("{stem}.zip"));
    if zip_path.exists() {
        std::fs::remove_file(&zip_path).ok();
    }
    // `-j` flattens stored paths, `-1` is fast compression — STLs still
    // shrink ~40%, which is enough to clear the 100 MB push ceiling.
    let out = std::process::Command::new("zip")
        .args(["-j", "-q", "-1"])
        .arg(&zip_path)
        .arg(src)
        .output()
        .context("failed to spawn zip")?;
    if !out.status.success() {
        return Err(anyhow!(
            "zip {} failed: {}",
            src.display(),
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(zip_path)
}

/// Blocking: clone/sync the asset repo, copy `files` into `assets/<job_id>/`
/// (zipping oversized models), commit and push. Returns `(branch, final
/// repo-relative paths in the same order as `files`)`.
fn host_blocking(
    repo: String,
    token: String,
    job_id: i64,
    files: Vec<(String, PathBuf)>,
) -> Result<(String, Vec<String>)> {
    let repo_dir = data_dir().join(ASSET_REPO_DIRNAME);
    ensure_clone(&repo_dir, &repo, &token)?;
    let branch = clone_branch(&repo_dir, &token)?;

    // Sync the working tree to the remote head, discarding any local cruft
    // (an interrupted prior run, or an operator repo reset).
    if git_ok(&repo_dir, &["fetch", "origin", &branch], &token).is_ok() {
        let _ = git_ok(
            &repo_dir,
            &["reset", "--hard", &format!("origin/{branch}")],
            &token,
        );
        let _ = git_ok(&repo_dir, &["clean", "-fd"], &token);
    }

    // Copy every file into assets/<job_id>/, zipping oversized models.
    let zip_tmp = data_dir().join("asset-zip-tmp").join(job_id.to_string());
    let listing_rel = format!("assets/{job_id}");
    std::fs::create_dir_all(repo_dir.join(&listing_rel))
        .with_context(|| format!("create {listing_rel} in clone"))?;
    let mut final_paths: Vec<String> = Vec::with_capacity(files.len());
    for (planned_repo_path, local) in &files {
        let hosted_src = maybe_zip_large(local, &zip_tmp)?;
        // Keep the planned directory but take the (possibly rewritten)
        // basename, so a zipped model lands as `<name>.zip`.
        let bn = hosted_src
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or_else(|| anyhow!("hosted file has no name"))?;
        let final_rel = match planned_repo_path.rsplit_once('/') {
            Some((dir, _)) => format!("{dir}/{bn}"),
            None => bn.to_string(),
        };
        std::fs::copy(&hosted_src, repo_dir.join(&final_rel))
            .with_context(|| format!("copy into clone: {final_rel}"))?;
        final_paths.push(final_rel);
    }
    std::fs::remove_dir_all(&zip_tmp).ok();

    git_ok(&repo_dir, &["add", &listing_rel], &token)?;
    // `commit` exits non-zero when there is nothing to commit (a re-publish
    // of an identical listing) — tolerate that and proceed to push.
    let _ = git_run(
        &repo_dir,
        &["commit", "-m", &format!("asset host: listing {job_id}")],
    );

    // Push, rebasing onto the remote head if another listing landed first.
    let mut last_err = String::new();
    for attempt in 0..4 {
        let out = git_run(&repo_dir, &["push", "origin", &branch])?;
        if out.status.success() {
            return Ok((branch, final_paths));
        }
        last_err = redact(&String::from_utf8_lossy(&out.stderr), &token);
        tracing::info!(
            "asset push attempt {} failed, rebasing: {}",
            attempt + 1,
            last_err.trim()
        );
        let _ = git_ok(&repo_dir, &["fetch", "origin", &branch], &token);
        if git_ok(&repo_dir, &["rebase", &format!("origin/{branch}")], &token).is_err() {
            let _ = git_run(&repo_dir, &["rebase", "--abort"]);
        }
    }
    Err(anyhow!("git push failed after retries: {}", last_err.trim()))
}

/// Host the model file (.stl/.glb), one or more preview PNGs, and any extra
/// bundle models by committing them into the asset repo via the git CLI.
/// Returns `raw.githubusercontent.com` URLs — these keep the filename +
/// extension in the path, which marketplaces (Cults3D) require to detect
/// the file type. All files for one listing land in a single commit.
pub async fn host_listing_assets(
    repo: &str,
    token: &str,
    job_id: i64,
    model_path: &Path,
    preview_png_paths: &[PathBuf],
    extra_model_paths: &[PathBuf],
) -> Result<HostedAssets> {
    if repo.is_empty() || !repo.contains('/') {
        return Err(anyhow!("github asset repo must be 'owner/name', got {repo:?}"));
    }
    if token.is_empty() {
        return Err(anyhow!("github asset token is empty"));
    }
    if preview_png_paths.is_empty() {
        return Err(anyhow!("host_listing_assets: no preview images given"));
    }

    // Plan (repo_path, local_path). Order: model, then images, then extras
    // — host_blocking preserves it so we can slice the URLs back out.
    let mut planned: Vec<(String, PathBuf)> = Vec::new();
    planned.push((
        format!("assets/{job_id}/{}", basename(model_path)?),
        model_path.to_path_buf(),
    ));
    for img in preview_png_paths {
        planned.push((format!("assets/{job_id}/{}", basename(img)?), img.clone()));
    }
    for (i, extra) in extra_model_paths.iter().enumerate() {
        // Index-prefix extras so two bundle items can't collide on basename.
        planned.push((
            format!("assets/{job_id}/extra-{}-{}", i + 1, basename(extra)?),
            extra.clone(),
        ));
    }
    let n_images = preview_png_paths.len();

    let repo_s = repo.to_string();
    let token_s = token.to_string();
    let _guard = repo_lock().lock().await;
    let (branch, repo_paths) = tokio::task::spawn_blocking(move || {
        host_blocking(repo_s, token_s, job_id, planned)
    })
    .await
    .context("asset host task panicked")??;

    let raw = |rel: &str| format!("https://raw.githubusercontent.com/{repo}/{branch}/{rel}");
    Ok(HostedAssets {
        file_url: raw(&repo_paths[0]),
        image_urls: repo_paths[1..1 + n_images].iter().map(|p| raw(p)).collect(),
        extra_file_urls: repo_paths[1 + n_images..].iter().map(|p| raw(p)).collect(),
    })
}

/// A cover image hosted on a throwaway GitHub release. Gumroad's cover
/// endpoint downloads the URL server-side and keeps its own copy, so the
/// caller deletes `release_id` once the marketplace has ingested the URL.
#[derive(Debug, Clone)]
pub struct HostedCover {
    pub image_url: String,
    pub release_id: i64,
}

/// Host a single preview PNG at a public HTTPS URL. Used for marketplaces
/// (Gumroad) whose cover-image endpoint accepts a URL rather than a
/// multipart upload. Unlike `host_listing_assets` this uploads only the
/// image — the caller is expected to `delete_release` afterwards since the
/// URL is needed only transiently.
pub async fn host_cover_image(
    client: &reqwest::Client,
    repo: &str,
    token: &str,
    job_id: i64,
    preview_png_path: &Path,
) -> Result<HostedCover> {
    if repo.is_empty() || !repo.contains('/') {
        return Err(anyhow!("github asset repo must be 'owner/name', got {repo:?}"));
    }
    if token.is_empty() {
        return Err(anyhow!("github asset token is empty"));
    }
    let ts = chrono::Utc::now().timestamp();
    let tag = format!("cover-{job_id}-{ts}");
    let name = format!("agent-factory cover {job_id}");

    let release = create_release_with_bootstrap(client, repo, token, &tag, &name).await?;

    let png_name = preview_png_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| anyhow!("preview path has no filename"))?;

    match upload_asset(
        client,
        &release.upload_url,
        token,
        preview_png_path,
        png_name,
        "image/png",
    )
    .await
    {
        Ok(image_url) => Ok(HostedCover {
            image_url,
            release_id: release.id,
        }),
        Err(e) => {
            delete_release(client, repo, token, release.id).await;
            Err(e.context("upload cover png"))
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Real round-trip against the configured asset repo: host a model +
    /// two preview images via the git CLI and confirm every returned
    /// `raw.githubusercontent.com` URL resolves. Ignored by default (needs
    /// network + secrets) — run with:
    ///   cargo test --lib -- --ignored host_listing_assets_round_trips
    #[tokio::test]
    #[ignore]
    async fn host_listing_assets_round_trips_via_git_cli() {
        let home = std::env::var("HOME").unwrap();
        let secrets: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(format!("{home}/.agent-factory/secrets.dev.json"))
                .expect("read secrets.dev.json"),
        )
        .expect("parse secrets");
        let repo = secrets["github_asset_repo"].as_str().unwrap().to_string();
        let token = secrets["github_asset_token"].as_str().unwrap().to_string();

        let dir = std::env::temp_dir().join("aht-rs-test");
        std::fs::create_dir_all(&dir).unwrap();
        let job_id: i64 = 990001;
        let stl = dir.join(format!("{job_id}.stl"));
        std::fs::write(&stl, b"solid t\nendsolid t\n").unwrap();
        let img0 = dir.join(format!("{job_id}-tex-0.png"));
        let img1 = dir.join(format!("{job_id}-clay-0.png"));
        std::fs::write(&img0, b"fake-hero-png").unwrap();
        std::fs::write(&img1, b"fake-clay-png").unwrap();

        let hosted = host_listing_assets(
            &repo,
            &token,
            job_id,
            &stl,
            &[img0.clone(), img1.clone()],
            &[],
        )
        .await
        .expect("host_listing_assets failed");

        assert_eq!(hosted.image_urls.len(), 2, "expected 2 image urls");
        assert!(
            hosted.file_url.ends_with(&format!("{job_id}.stl")),
            "file_url: {}",
            hosted.file_url
        );
        assert!(hosted.image_urls[0].ends_with("-tex-0.png"));
        assert!(hosted.extra_file_urls.is_empty());

        // raw.githubusercontent.com can lag a few seconds behind a push.
        let client = reqwest::Client::new();
        for url in std::iter::once(&hosted.file_url).chain(hosted.image_urls.iter()) {
            let mut resolved = false;
            for _ in 0..15 {
                if client
                    .get(url)
                    .send()
                    .await
                    .map(|r| r.status().is_success())
                    .unwrap_or(false)
                {
                    resolved = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
            }
            assert!(resolved, "url never resolved: {url}");
        }
    }
}
