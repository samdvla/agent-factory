//! MyMiniFactory API v2 client.
//!
//! Base URL: https://www.myminifactory.com/api/v2/
//! Auth: `key` query parameter (personal API key) OR OAuth Bearer token.
//! Get keys at https://www.myminifactory.com/settings/developer
//!
//! MMF's API surface around writes (creating objects, uploading files) has
//! historically required OAuth + approved developer status. The personal
//! API key works for GET and some writes. We build assuming the key path;
//! if MMF rejects the write call, we surface the error in the UI so the
//! operator can switch to OAuth or upload manually.
//!
//! Endpoints used:
//!   - GET  /api/v2/me?key=…           — verify
//!   - POST /api/v2/objects?key=…      — create object (multipart)

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use std::path::Path;
use std::time::Duration;

const API_BASE: &str = "https://www.myminifactory.com/api/v2";
const UA: &str = "agent-factory/1.0";

/// Authentication material for MMF API calls.
///
/// `api_key`: the legacy personal API key, used ONLY for the verify path
///            (reads from /me / /objects). MMF's write endpoints reject
///            personal keys with HTTP 401 — that's why we have OAuth.
/// `access_token`: an OAuth 2.0 access token from the authorization-code
///            flow. Required for create_object_with_file (writes).
///
/// Callers should populate exactly one of these depending on the call site.
#[derive(Debug, Clone)]
pub struct Creds {
    pub api_key: String,
}

#[derive(Debug, Clone)]
pub struct CreateObjectInput {
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    /// MMF category — best-effort slug like "miniatures", "art", "household".
    pub category: Option<String>,
    /// USD price; 0.0 for free.
    pub price_usd: f64,
}

#[derive(Debug, Clone)]
pub struct CreateObjectResult {
    pub object_id: String,
    pub url: Option<String>,
    pub file_attached: bool,
    pub warning: Option<String>,
}

#[derive(Debug, Deserialize)]
struct MeResp {
    // /users/me returns username:"me" as a literal placeholder; we prefer
    // the real display name if it's present. Email is also returned on
    // /me-shape endpoints when the key has owner-level scope.
    username: Option<String>,
    name: Option<String>,
    email: Option<String>,
    id: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct CreateObjectResp {
    id: Option<serde_json::Value>,
    url: Option<String>,
    short_url: Option<String>,
    /// Per-file upload IDs returned by the create-object call. Step 2 of
    /// the upload flow needs these to address the binary POST.
    files: Option<Vec<CreateObjectFileEntry>>,
    /// Per-image upload IDs — present when the create-object body carried
    /// an `images` array. Parallel in shape to `files`.
    images: Option<Vec<CreateObjectFileEntry>>,
}

#[derive(Debug, Deserialize)]
struct CreateObjectFileEntry {
    upload_id: Option<String>,
    #[allow(dead_code)]
    filename: Option<String>,
}

/// Verify the API key. Returns username for the UI to display.
///
/// MMF's API has moved endpoints a few times — `/me` historically existed
/// but currently 404s with a generic HTML page (the New Relic-wrapped MMF
/// web 404, not a JSON API error). We try the known shapes in order and
/// accept the first JSON-200 as proof the key works:
///   1. /api/v2/users/me?key=…   (current convention)
///   2. /api/v2/me?key=…         (legacy)
///   3. /api/v2/objects?key=…&per_page=1   (read-with-auth — always returns
///       200 + a JSON list when the key is valid)
///
/// On all-fail, we surface the LAST status + a 200-char snippet of the body
/// so the user can see what MMF actually said.
pub async fn verify(client: &reqwest::Client, creds: &Creds) -> Result<String> {
    let endpoints = [
        format!("{API_BASE}/users/me"),
        format!("{API_BASE}/me"),
        format!("{API_BASE}/objects"),
    ];
    let mut last_err: Option<String> = None;
    for (i, url) in endpoints.iter().enumerate() {
        let mut req = client
            .get(url)
            .query(&[("key", creds.api_key.as_str())])
            .header("User-Agent", UA)
            .timeout(Duration::from_secs(30));
        if i == 2 {
            // /objects path: cap the page so we don't pull a heavy list.
            req = req.query(&[("per_page", "1")]);
        }
        let resp = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = Some(format!("network: {e}"));
                continue;
            }
        };
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        if !status.is_success() {
            // Trim HTML/error snippet so the UI alert doesn't explode.
            let snippet = text.chars().take(200).collect::<String>();
            last_err = Some(format!("{} HTTP {status}: {snippet}", url));
            continue;
        }
        // Try to pull a user-facing name out of whatever the endpoint
        // returned — fall back to "myminifactory" if the response shape is
        // unfamiliar but a 200 came back (key is valid; identity unclear).
        if let Ok(me) = serde_json::from_str::<MeResp>(&text) {
            // Filter the literal "me" placeholder MMF returns for the
            // /users/me endpoint — prefer the real name when present.
            let real_username = me.username.filter(|u| u.as_str() != "me");
            return Ok(me
                .name
                .or(real_username)
                .or(me.email)
                .or_else(|| me.id.map(|v| v.to_string()))
                .unwrap_or_else(|| "myminifactory".into()));
        }
        return Ok("myminifactory".into());
    }
    Err(anyhow!(
        "mmf verify failed on all endpoints. Last error: {}",
        last_err.unwrap_or_else(|| "unknown".into())
    ))
}

/// Create an object + upload one or more files, following the documented
/// two-step MMF API flow:
///   1. POST /api/v2/object — JSON body with metadata + files[{filename, bytes}].
///      The `files` array carries one entry per uploaded file; the response
///      echoes the array with a per-entry `upload_id`.
///   2. POST /api/v2/file?upload_id=… — raw binary body of the file. Repeated
///      once per file, using the matching upload_id from step 1.
///
/// `file_paths` is taken in order: index 0 is the primary (STL), additional
/// entries are extras (textured GLB, alternate format). All-or-nothing on the
/// primary — if its upload fails the whole call errors. Extra-file failures
/// are non-fatal: the object is published with whatever uploaded, and the
/// `warning` field describes which extras dropped so the operator can re-
/// upload manually from the MMF dashboard.
///
/// `image_paths` are preview images (PNG/JPG). MMF renders the object's
/// gallery from its `images` array — without them the listing has no
/// picture. They go up via the same declare-then-upload flow as files
/// (`POST /image?upload_id=…`) and are entirely best-effort.
///
/// Previous implementation used `POST /api/v2/objects` (plural) with
/// multipart in a single call, which MMF rejects with 405 Method Not
/// Allowed — that route only accepts GET (list objects). The plural-vs-
/// singular drift cost every prior upload attempt.
///
/// Auth: ONLY uses `Authorization: Bearer <access_token>`. MMF rejects
/// personal API keys for object creation (HTTP 401), so this path is
/// OAuth-only. Callers MUST pass a fresh access token obtained via
/// `crate::mmf_oauth::ensure_fresh_token`.
pub async fn create_object_with_file(
    client: &reqwest::Client,
    access_token: &str,
    input: &CreateObjectInput,
    file_paths: &[&Path],
    image_paths: &[&Path],
) -> Result<CreateObjectResult> {
    if file_paths.is_empty() {
        return Err(anyhow!("mmf create-object: at least one file required"));
    }

    // Read every file up-front so step 1 knows the byte counts. MMF needs
    // exact sizes in the `files` array — it pre-allocates server-side slots.
    let mut prepared: Vec<(String, Vec<u8>)> = Vec::with_capacity(file_paths.len());
    for path in file_paths {
        let bytes = tokio::fs::read(path)
            .await
            .with_context(|| format!("read file {}", path.display()))?;
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("model.stl")
            .to_string();
        prepared.push((filename, bytes));
    }
    // Same for preview images — declared in the create call, then rendered
    // into the object's gallery.
    let mut prepared_images: Vec<(String, Vec<u8>)> = Vec::with_capacity(image_paths.len());
    for path in image_paths {
        let bytes = tokio::fs::read(path)
            .await
            .with_context(|| format!("read image {}", path.display()))?;
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("preview.png")
            .to_string();
        prepared_images.push((filename, bytes));
    }

    // Step 1 — create the object metadata + receive an upload_id per file.
    let files_meta: Vec<serde_json::Value> = prepared
        .iter()
        .map(|(filename, bytes)| {
            serde_json::json!({
                "filename": filename,
                "bytes": bytes.len() as u64,
            })
        })
        .collect();
    let mut body = serde_json::json!({
        "name": input.name,
        "description": input.description,
        "tags": input.tags.join(","),
        "files": files_meta,
    });
    if !prepared_images.is_empty() {
        // MMF renders the object's gallery from its `images` array; image
        // entries use the `size` key (3D files use `bytes`).
        body["images"] = serde_json::Value::Array(
            prepared_images
                .iter()
                .map(|(filename, bytes)| {
                    serde_json::json!({ "filename": filename, "size": bytes.len() as u64 })
                })
                .collect(),
        );
    }
    if let Some(cat) = &input.category {
        body["category"] = serde_json::Value::String(cat.clone());
    }
    let create_resp = client
        .post(format!("{API_BASE}/object"))
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json; charset=utf-8")
        .header("User-Agent", UA)
        .json(&body)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .context("mmf POST /object failed")?;
    let create_status = create_resp.status();
    let create_text = create_resp.text().await.unwrap_or_default();
    if !create_status.is_success() {
        return Err(anyhow!(
            "mmf create-object HTTP {create_status}: {create_text}"
        ));
    }
    let create_parsed: CreateObjectResp = serde_json::from_str(&create_text)
        .with_context(|| format!("parse create-object JSON: {create_text}"))?;
    let object_id = create_parsed
        .id
        .clone()
        .map(|v| match v {
            serde_json::Value::String(s) => s,
            other => other.to_string(),
        })
        .ok_or_else(|| anyhow!("mmf create-object: missing id"))?;
    let returned_files = create_parsed
        .files
        .as_ref()
        .ok_or_else(|| anyhow!("mmf create-object: missing files[] in response: {create_text}"))?;
    if returned_files.len() < prepared.len() {
        return Err(anyhow!(
            "mmf create-object: response carried {} files, expected {}: {}",
            returned_files.len(), prepared.len(), create_text
        ));
    }

    // Step 2 — upload each file's bytes against its matching upload_id.
    // The PRIMARY upload (index 0) is the only one that hard-fails; extras
    // collect into a warning so the listing still ships if e.g. only the
    // GLB upload times out.
    let mut dropped_extras: Vec<String> = Vec::new();
    for (idx, (filename, bytes)) in prepared.into_iter().enumerate() {
        let upload_id = returned_files
            .get(idx)
            .and_then(|f| f.upload_id.clone())
            .ok_or_else(|| {
                anyhow!(
                    "mmf create-object: missing files[{idx}].upload_id in response: {create_text}"
                )
            })?;
        let upload_resp = client
            .post(format!("{API_BASE}/file"))
            .query(&[("upload_id", upload_id.as_str())])
            .header("Authorization", format!("Bearer {access_token}"))
            .header("Content-Type", "application/octet-stream")
            .header("Content-Disposition", format!("filename=\"{filename}\""))
            .header("User-Agent", UA)
            .body(bytes)
            .timeout(Duration::from_secs(300))
            .send()
            .await;
        match upload_resp {
            Ok(r) if r.status().is_success() => {}
            Ok(r) => {
                let status = r.status();
                let text = r.text().await.unwrap_or_default();
                if idx == 0 {
                    return Err(anyhow!(
                        "mmf primary file upload HTTP {status}: {text}"
                    ));
                }
                tracing::warn!(
                    "mmf extra file upload failed (idx={idx} file={filename}): HTTP {status}: {text}"
                );
                dropped_extras.push(filename);
            }
            Err(e) => {
                if idx == 0 {
                    return Err(anyhow!("mmf primary file upload failed: {e}"));
                }
                tracing::warn!(
                    "mmf extra file upload failed (idx={idx} file={filename}): {e}"
                );
                dropped_extras.push(filename);
            }
        }
    }

    // Step 2b — upload each preview image's bytes via the image endpoint.
    // All best-effort: a missing picture degrades the listing but never
    // blocks the publish (the 3D files are what matter).
    let returned_images: &[CreateObjectFileEntry] =
        create_parsed.images.as_deref().unwrap_or(&[]);
    for (idx, (filename, bytes)) in prepared_images.into_iter().enumerate() {
        let Some(upload_id) = returned_images.get(idx).and_then(|f| f.upload_id.clone())
        else {
            tracing::warn!("mmf create-object: missing images[{idx}].upload_id");
            dropped_extras.push(filename);
            continue;
        };
        let lower = filename.to_lowercase();
        let content_type = if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
            "image/jpeg"
        } else if lower.ends_with(".gif") {
            "image/gif"
        } else {
            "image/png"
        };
        let upload_resp = client
            .post(format!("{API_BASE}/image"))
            .query(&[("upload_id", upload_id.as_str())])
            .header("Authorization", format!("Bearer {access_token}"))
            .header("Content-Type", content_type)
            .header("Content-Disposition", format!("filename=\"{filename}\""))
            .header("User-Agent", UA)
            .body(bytes)
            .timeout(Duration::from_secs(120))
            .send()
            .await;
        match upload_resp {
            Ok(r) if r.status().is_success() => {}
            Ok(r) => {
                let status = r.status();
                let text = r.text().await.unwrap_or_default();
                tracing::warn!(
                    "mmf image upload failed (file={filename}): HTTP {status}: {text}"
                );
                dropped_extras.push(filename);
            }
            Err(e) => {
                tracing::warn!("mmf image upload failed (file={filename}): {e}");
                dropped_extras.push(filename);
            }
        }
    }

    let warning = if dropped_extras.is_empty() {
        None
    } else {
        Some(format!(
            "{} extra file/image(s) failed to upload: {}",
            dropped_extras.len(),
            dropped_extras.join(", ")
        ))
    };

    Ok(CreateObjectResult {
        object_id,
        url: create_parsed.url.or(create_parsed.short_url),
        file_attached: true,
        warning,
    })
}

/// Heuristic MMF category from niche/tags.
pub fn pick_category(niche: &str, tags: &[String]) -> Option<String> {
    let hay = format!("{} {}", niche, tags.join(" ")).to_lowercase();
    let table: &[(&str, &[&str])] = &[
        ("miniatures", &["miniature", "mini", "tabletop", "dnd", "warhammer", "figurine"]),
        ("toys", &["toy", "game", "puzzle"]),
        ("art", &["art", "sculpture", "statue", "decor", "decoration"]),
        ("jewelry", &["jewelry", "ring", "pendant", "earring", "necklace"]),
        ("household", &["household", "kitchen", "bathroom", "home", "vase", "holder"]),
        ("gadgets", &["gadget", "tool", "phone", "device"]),
        ("fashion", &["fashion", "clothing", "wearable"]),
    ];
    for (slug, kws) in table {
        if kws.iter().any(|kw| hay.contains(kw)) {
            return Some((*slug).to_string());
        }
    }
    None
}
