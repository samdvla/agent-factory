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

/// Create an object + attach the file in a single multipart call.
pub async fn create_object_with_file(
    client: &reqwest::Client,
    creds: &Creds,
    input: &CreateObjectInput,
    file_path: &Path,
) -> Result<CreateObjectResult> {
    let bytes = tokio::fs::read(file_path)
        .await
        .with_context(|| format!("read file {}", file_path.display()))?;
    let filename = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("model.stl")
        .to_string();
    let tags_joined = input.tags.join(",");
    let price_str = format!("{:.2}", input.price_usd);

    let mut form = reqwest::multipart::Form::new()
        .text("name", input.name.clone())
        .text("description", input.description.clone())
        .text("tags", tags_joined)
        .text("price", price_str);
    if let Some(cat) = &input.category {
        form = form.text("category", cat.clone());
    }
    let file_part = reqwest::multipart::Part::bytes(bytes)
        .file_name(filename)
        .mime_str("application/octet-stream")?;
    form = form.part("file", file_part);

    let resp = client
        .post(format!("{API_BASE}/objects"))
        .query(&[("key", creds.api_key.as_str())])
        .header("User-Agent", UA)
        .multipart(form)
        .timeout(Duration::from_secs(180))
        .send()
        .await
        .context("mmf POST /objects failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("mmf create-object HTTP {status}: {text}"));
    }
    let parsed: CreateObjectResp = serde_json::from_str(&text)
        .with_context(|| format!("parse create-object JSON: {text}"))?;
    let object_id = parsed
        .id
        .map(|v| match v {
            serde_json::Value::String(s) => s,
            other => other.to_string(),
        })
        .ok_or_else(|| anyhow!("mmf create-object: missing id"))?;
    Ok(CreateObjectResult {
        object_id,
        url: parsed.url.or(parsed.short_url),
        file_attached: true,
        warning: None,
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
