//! MyMiniFactory OAuth 2.0 client.
//!
//! MMF's write endpoints (`POST /api/v2/object` + `POST /api/v2/file`) reject
//! personal API keys with HTTP 401 — they accept only OAuth Bearer tokens
//! granted via the standard authorization-code flow. This module wires:
//!
//!   - Authorize URL builder
//!   - Code → tokens exchange
//!   - Refresh-token rotation
//!   - Token cache with proactive refresh
//!
//! Endpoints (per MMF's official api-documentation repo):
//!   - Authorize: `https://auth.myminifactory.com/web/authorize`
//!   - Token:     `https://auth.myminifactory.com/v1/oauth/tokens`
//!
//! Operator workflow:
//!   1. Register an application at myminifactory.com/settings/developer to
//!      get `client_id` + `client_secret`. Set the redirect_uri to
//!      `http://localhost:7330/callback` (matches our oauth_server bind).
//!   2. Paste those creds into Settings → MyMiniFactory → "Connect via
//!      OAuth", click the button — the system browser opens the authorize
//!      URL, the operator approves, MMF redirects back to our local
//!      listener, we exchange the code for tokens.
//!   3. Tokens persist in secrets; the publish path uses them via
//!      `ensure_fresh_token()` which refreshes proactively.

use anyhow::{anyhow, bail, Context, Result};
use rand::Rng;
use serde::Deserialize;

use crate::secrets;

pub const AUTHORIZE_URL: &str = "https://auth.myminifactory.com/web/authorize";
pub const TOKEN_URL: &str = "https://auth.myminifactory.com/v1/oauth/tokens";
/// Must match what the operator registered for their MMF app. We use the
/// same local-callback port as Etsy because oauth_server is single-shot.
pub const REDIRECT_URI: &str = "http://localhost:7330/callback";

/// Refresh the access token if it expires within this many seconds. Gives
/// the publish path margin so a token doesn't expire mid-upload.
const REFRESH_MARGIN_SECONDS: i64 = 60;

/// Token bundle as returned by MMF's `/v1/oauth/tokens` endpoint.
#[derive(Debug, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub expires_in: i64,
    /// MMF returns "Bearer" — kept for forward compatibility but we don't
    /// branch on it; all requests use `Authorization: Bearer <token>`.
    #[allow(dead_code)]
    pub token_type: String,
    /// MMF MAY rotate the refresh token on each refresh; when it does we
    /// must persist the new one and discard the old (per RFC 6749).
    pub refresh_token: Option<String>,
    /// Optional — MMF includes this on the token response. We keep it for
    /// debugging / status display.
    pub user_id: Option<serde_json::Value>,
}

pub fn generate_state() -> String {
    rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect()
}

pub fn build_authorize_url(client_id: &str, state: &str) -> String {
    let cid = urlencoding::encode(client_id);
    let redirect = urlencoding::encode(REDIRECT_URI);
    let st = urlencoding::encode(state);
    format!(
        "{AUTHORIZE_URL}?client_id={cid}&redirect_uri={redirect}&response_type=code&state={st}"
    )
}

pub async fn exchange_code(
    client: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    code: &str,
) -> Result<Tokens> {
    let resp = client
        .post(TOKEN_URL)
        .basic_auth(client_id, Some(client_secret))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", REDIRECT_URI),
        ])
        .send()
        .await
        .context("mmf oauth token exchange POST failed")?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("mmf oauth exchange HTTP {status}: {body}");
    }
    serde_json::from_str::<Tokens>(&body)
        .with_context(|| format!("parse mmf token response: {body}"))
}

pub async fn refresh_tokens(
    client: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<Tokens> {
    let resp = client
        .post(TOKEN_URL)
        .basic_auth(client_id, Some(client_secret))
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .context("mmf oauth refresh POST failed")?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("mmf oauth refresh HTTP {status}: {body}");
    }
    serde_json::from_str::<Tokens>(&body)
        .with_context(|| format!("parse mmf refresh response: {body}"))
}

pub fn persist_tokens(t: &Tokens) -> Result<()> {
    secrets::set("mmf_access_token", &t.access_token)
        .context("save mmf_access_token")?;
    if let Some(rt) = &t.refresh_token {
        secrets::set("mmf_refresh_token", rt).context("save mmf_refresh_token")?;
    }
    let expires_at = chrono::Utc::now().timestamp() + t.expires_in;
    secrets::set("mmf_token_expires_at", &expires_at.to_string())
        .context("save mmf_token_expires_at")?;
    if let Some(uid) = &t.user_id {
        let uid_str = match uid {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string(),
        };
        let _ = secrets::set("mmf_oauth_user_id", &uid_str);
    }
    Ok(())
}

/// Return a valid access token, refreshing if it's expired or close to it.
/// Errors if not connected (no token in keychain) or refresh fails.
pub async fn ensure_fresh_token(client: &reqwest::Client) -> Result<String> {
    let access = secrets::get("mmf_access_token")
        .context("read mmf_access_token")?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            anyhow!(
                "MMF not connected — no OAuth access token. Connect via \
                 Settings → MyMiniFactory."
            )
        })?;
    let expires_at = secrets::get("mmf_token_expires_at")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0);
    let now = chrono::Utc::now().timestamp();
    if expires_at > now + REFRESH_MARGIN_SECONDS {
        return Ok(access);
    }
    // Token expired or close — try refresh.
    let refresh = secrets::get("mmf_refresh_token")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            anyhow!(
                "MMF token expired and no refresh token recorded — \
                 reconnect via Settings → MyMiniFactory."
            )
        })?;
    let client_id = secrets::get("mmf_client_id")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("mmf_client_id missing — reconnect required"))?;
    let client_secret = secrets::get("mmf_client_secret")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("mmf_client_secret missing — reconnect required"))?;
    let tokens = refresh_tokens(client, &client_id, &client_secret, &refresh).await?;
    persist_tokens(&tokens)?;
    Ok(tokens.access_token)
}

/// Drop persisted tokens. Keeps `mmf_client_id` / `mmf_client_secret` so a
/// reconnect doesn't require re-pasting them.
pub fn disconnect() -> Result<()> {
    let _ = secrets::delete("mmf_access_token");
    let _ = secrets::delete("mmf_refresh_token");
    let _ = secrets::delete("mmf_token_expires_at");
    let _ = secrets::delete("mmf_oauth_user_id");
    Ok(())
}

/// Quick connectedness probe — used by `cmd_mmf_status` to surface
/// "Connected via OAuth" vs "Not connected".
pub fn is_connected() -> bool {
    secrets::get("mmf_access_token")
        .ok()
        .flatten()
        .map(|s| !s.is_empty())
        .unwrap_or(false)
}
