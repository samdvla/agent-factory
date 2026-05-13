//! Pinterest API v5 client.
//!
//! Auth model: manually-pasted long-lived access token (Pinterest issues
//! 30-day tokens from the developer dashboard). We store it in the keychain
//! under `pinterest_access_token` + `pinterest_board_id`. The user re-pastes
//! when the token expires. Full OAuth lives behind a follow-on PR once we've
//! validated that Pinterest actually drives Etsy traffic for our niches.
//!
//! Posting path: `POST /v5/pins` with bearer token, base64-encoded image,
//! board_id, title, description, and the destination link (the Etsy listing
//! URL — that's the whole point of Pinterest for Etsy).

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::secrets;

const PINTEREST_API_BASE: &str = "https://api.pinterest.com/v5";

/// Per Pinterest's API docs, pin titles cap at 100 chars and descriptions
/// at 500. We truncate cleanly at the char boundary so multibyte titles
/// don't panic. The constants live here so the publish module can also
/// reference them when building the request body.
pub const PINTEREST_TITLE_MAX_CHARS: usize = 100;
pub const PINTEREST_DESCRIPTION_MAX_CHARS: usize = 500;

#[derive(Debug, Clone)]
pub struct PinterestCreds {
    pub access_token: String,
    pub board_id: String,
}

#[derive(Debug, Serialize)]
struct CreatePinRequest<'a> {
    board_id: &'a str,
    title: String,
    description: String,
    link: Option<&'a str>,
    media_source: MediaSource,
}

#[derive(Debug, Serialize)]
#[serde(tag = "source_type", rename_all = "snake_case")]
enum MediaSource {
    ImageBase64 {
        content_type: String,
        data: String,
    },
}

#[derive(Debug, Deserialize)]
pub struct CreatePinResponse {
    pub id: String,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

/// Read access_token + board_id from the keychain. Returns None when either
/// is missing or empty — caller treats that as "not configured".
pub fn creds_from_secrets() -> Option<PinterestCreds> {
    let access_token = secrets::get("pinterest_access_token").ok().flatten()?;
    let board_id = secrets::get("pinterest_board_id").ok().flatten()?;
    if access_token.trim().is_empty() || board_id.trim().is_empty() {
        return None;
    }
    Some(PinterestCreds {
        access_token: access_token.trim().to_string(),
        board_id: board_id.trim().to_string(),
    })
}

/// Truncate text to `max` chars (not bytes) so multi-byte titles don't
/// panic on the boundary. Pinterest enforces these caps server-side anyway
/// but we want a clean payload, not a 422.
pub fn truncate_to_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// Build the multipart-style JSON body Pinterest's /v5/pins expects.
/// Exposed for testing — the request body is the easiest invariant to lock
/// without standing up an HTTP mock.
pub fn build_pin_body(
    board_id: &str,
    title: &str,
    description: &str,
    link: Option<&str>,
    image_bytes: &[u8],
    content_type: &str,
) -> serde_json::Value {
    let req = CreatePinRequest {
        board_id,
        title: truncate_to_chars(title, PINTEREST_TITLE_MAX_CHARS),
        description: truncate_to_chars(description, PINTEREST_DESCRIPTION_MAX_CHARS),
        link,
        media_source: MediaSource::ImageBase64 {
            content_type: content_type.to_string(),
            data: B64.encode(image_bytes),
        },
    };
    serde_json::to_value(&req).expect("CreatePinRequest must serialize")
}

/// Create a pin from a local image file. Returns the new pin's id + url
/// on success. Failures bubble up as anyhow errors with the response body
/// preserved for diagnostics — Pinterest's 4xx bodies are usually
/// `{"code": ..., "message": "..."}` and worth keeping.
pub async fn create_pin_from_file(
    client: &reqwest::Client,
    creds: &PinterestCreds,
    image_path: &Path,
    title: &str,
    description: &str,
    link: Option<&str>,
) -> Result<CreatePinResponse> {
    let bytes = std::fs::read(image_path)
        .with_context(|| format!("read pinterest pin image {}", image_path.display()))?;
    if bytes.is_empty() {
        return Err(anyhow!("pinterest pin image is empty: {}", image_path.display()));
    }
    let content_type = match image_path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        _ => "image/png", // pinterest_pin.py always emits PNG; defensive default
    };
    let body = build_pin_body(
        &creds.board_id,
        title,
        description,
        link,
        &bytes,
        content_type,
    );
    let url = format!("{PINTEREST_API_BASE}/pins");
    let resp = client
        .post(&url)
        .bearer_auth(&creds.access_token)
        .json(&body)
        .send()
        .await
        .context("pinterest POST /v5/pins failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("pinterest create-pin HTTP {status}: {text}"));
    }
    serde_json::from_str(&text)
        .with_context(|| format!("parse pinterest create-pin response: {text}"))
}

/// Verify a (token, board_id) pair by fetching the board. Cheap probe —
/// returns Ok(board_name) when the token has access, Err otherwise. The
/// `cmd_pinterest_verify` Tauri command runs this before persisting.
pub async fn verify(
    client: &reqwest::Client,
    access_token: &str,
    board_id: &str,
) -> Result<String> {
    let url = format!("{PINTEREST_API_BASE}/boards/{board_id}");
    let resp = client
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .context("pinterest GET /v5/boards/{id} failed")?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("pinterest verify HTTP {status}: {text}"));
    }
    #[derive(Deserialize)]
    struct BoardResp {
        name: String,
    }
    let board: BoardResp = serde_json::from_str(&text)
        .with_context(|| format!("parse pinterest board response: {text}"))?;
    Ok(board.name)
}

/// Persist a verified token + board id. Called by `cmd_pinterest_verify`.
pub fn persist(access_token: &str, board_id: &str) -> Result<()> {
    secrets::set("pinterest_access_token", access_token)?;
    secrets::set("pinterest_board_id", board_id)?;
    Ok(())
}

/// Clear all Pinterest secrets. Called by `cmd_pinterest_disconnect`.
pub fn disconnect() -> Result<()> {
    for key in [
        "pinterest_access_token",
        "pinterest_board_id",
        "pinterest_board_name",
    ] {
        let _ = secrets::delete(key);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_chars_respects_codepoint_boundary() {
        let s = "é".repeat(150); // 150 chars, 300 bytes
        let out = truncate_to_chars(&s, 100);
        assert_eq!(out.chars().count(), 100);
        // Short strings pass through unchanged.
        assert_eq!(truncate_to_chars("short", 50), "short");
        // Exact boundary.
        assert_eq!(truncate_to_chars("abcde", 5), "abcde");
    }

    #[test]
    fn build_pin_body_truncates_title_and_description() {
        let long_title: String = "T".repeat(200);
        let long_desc: String = "D".repeat(1000);
        let body = build_pin_body(
            "board123",
            &long_title,
            &long_desc,
            Some("https://etsy.com/listing/42"),
            b"fake-image-bytes",
            "image/png",
        );
        let title = body["title"].as_str().unwrap();
        let desc = body["description"].as_str().unwrap();
        assert_eq!(title.chars().count(), PINTEREST_TITLE_MAX_CHARS);
        assert_eq!(desc.chars().count(), PINTEREST_DESCRIPTION_MAX_CHARS);
    }

    #[test]
    fn build_pin_body_uses_base64_image_source() {
        let body = build_pin_body(
            "bX",
            "title",
            "desc",
            None,
            b"hello",
            "image/png",
        );
        assert_eq!(body["board_id"], "bX");
        assert_eq!(body["link"], serde_json::Value::Null);
        assert_eq!(body["media_source"]["source_type"], "image_base64");
        assert_eq!(body["media_source"]["content_type"], "image/png");
        // base64("hello") = "aGVsbG8="
        assert_eq!(body["media_source"]["data"], "aGVsbG8=");
    }

    #[test]
    fn build_pin_body_omits_link_when_none() {
        let body = build_pin_body("bX", "t", "d", None, b"x", "image/png");
        // serde_json represents Option::None as Value::Null. The Pinterest
        // API treats null link as "no destination" which is what we want.
        assert!(body.get("link").is_some());
        assert!(body["link"].is_null());
    }

    #[test]
    fn build_pin_body_includes_link_when_some() {
        let body = build_pin_body(
            "bX",
            "t",
            "d",
            Some("https://www.etsy.com/listing/12345"),
            b"x",
            "image/png",
        );
        assert_eq!(body["link"], "https://www.etsy.com/listing/12345");
    }
}
