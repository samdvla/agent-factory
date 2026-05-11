//! Etsy OAuth 2.0 + PKCE helpers, token persistence, and shop identity.
//!
//! Public client flow per Etsy Open API v3:
//! - `client_id` is the Etsy app keystring (stored in keychain as
//!   `etsy_api_keystring`). The shared secret is NOT used in the public PKCE
//!   token exchange — it's only relevant for app-to-app server flows we don't
//!   use here.
//! - Tokens persist in keychain: `etsy_access_token`, `etsy_refresh_token`,
//!   `etsy_token_expires_at` (epoch seconds, with a 60s safety margin).
//! - Shop identity persists as `etsy_shop_id`, `etsy_shop_name`.

use anyhow::{anyhow, Context};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::Rng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::secrets;

pub const REDIRECT_URI: &str = "http://localhost:7330/callback";
pub const SCOPES: &str = "listings_w listings_r transactions_r feedback_r email_r";
pub const AUTHORIZE_URL: &str = "https://www.etsy.com/oauth/connect";
pub const TOKEN_URL: &str = "https://api.etsy.com/v3/public/oauth/token";
pub const API_BASE: &str = "https://api.etsy.com/v3/application";

const URL_SAFE_ALPHABET: &[u8] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct TokenSet {
    pub access_token: String,
    pub refresh_token: String,
    /// Epoch seconds when the token expires (already adjusted with a 60s
    /// safety margin so callers can use a strict `<` comparison).
    pub expires_at: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct ShopInfo {
    pub shop_id: i64,
    pub shop_name: String,
    pub user_id: i64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct EtsyStatus {
    pub connected: bool,
    pub shop_id: Option<i64>,
    pub shop_name: Option<String>,
    pub expires_at: Option<i64>,
    pub needs_refresh: bool,
}

#[derive(Deserialize, Debug)]
struct TokenResponse {
    access_token: String,
    refresh_token: String,
    expires_in: i64,
    #[allow(dead_code)]
    token_type: Option<String>,
}

/// Generate a (code_verifier, code_challenge) pair per RFC 7636.
/// The verifier is 64 URL-safe chars (within the 43..=128 range Etsy accepts),
/// the challenge is `base64url_no_padding(sha256(verifier))`.
pub fn generate_pkce() -> (String, String) {
    let mut rng = rand::thread_rng();
    let verifier: String = (0..64)
        .map(|_| {
            let idx = rng.gen_range(0..URL_SAFE_ALPHABET.len());
            URL_SAFE_ALPHABET[idx] as char
        })
        .collect();
    let challenge = code_challenge(&verifier);
    (verifier, challenge)
}

fn code_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

/// 32-char URL-safe random state nonce.
pub fn generate_state() -> String {
    let mut rng = rand::thread_rng();
    (0..32)
        .map(|_| {
            let idx = rng.gen_range(0..URL_SAFE_ALPHABET.len());
            URL_SAFE_ALPHABET[idx] as char
        })
        .collect()
}

pub fn build_authorize_url(keystring: &str, state: &str, code_challenge: &str) -> String {
    let mut url = url::Url::parse(AUTHORIZE_URL).expect("AUTHORIZE_URL parses");
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("scope", SCOPES)
        .append_pair("client_id", keystring)
        .append_pair("state", state)
        .append_pair("code_challenge", code_challenge)
        .append_pair("code_challenge_method", "S256");
    url.into()
}

pub async fn exchange_code(
    client: &reqwest::Client,
    keystring: &str,
    code: &str,
    code_verifier: &str,
    token_url: &str,
) -> anyhow::Result<TokenSet> {
    let form = [
        ("grant_type", "authorization_code"),
        ("client_id", keystring),
        ("redirect_uri", REDIRECT_URI),
        ("code", code),
        ("code_verifier", code_verifier),
    ];
    let resp = client
        .post(token_url)
        .form(&form)
        .send()
        .await
        .context("token endpoint POST failed")?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!(
            "token endpoint returned {status}: {body}"
        ));
    }
    let parsed: TokenResponse =
        serde_json::from_str(&body).with_context(|| format!("parse token JSON: {body}"))?;
    Ok(token_set_from_response(parsed))
}

pub async fn refresh(
    client: &reqwest::Client,
    keystring: &str,
    refresh_token: &str,
    token_url: &str,
) -> anyhow::Result<TokenSet> {
    let form = [
        ("grant_type", "refresh_token"),
        ("client_id", keystring),
        ("refresh_token", refresh_token),
    ];
    let resp = client
        .post(token_url)
        .form(&form)
        .send()
        .await
        .context("refresh token POST failed")?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!(
            "refresh endpoint returned {status}: {body}"
        ));
    }
    let parsed: TokenResponse =
        serde_json::from_str(&body).with_context(|| format!("parse refresh JSON: {body}"))?;
    Ok(token_set_from_response(parsed))
}

fn token_set_from_response(resp: TokenResponse) -> TokenSet {
    let now = chrono::Utc::now().timestamp();
    let expires_at = now + resp.expires_in - 60;
    TokenSet {
        access_token: resp.access_token,
        refresh_token: resp.refresh_token,
        expires_at,
    }
}

/// Extract the `user_id` prefix from an Etsy access token of the form
/// `{user_id}.xxxxx`.
fn user_id_from_token(access_token: &str) -> anyhow::Result<i64> {
    let prefix = access_token
        .split('.')
        .next()
        .ok_or_else(|| anyhow!("access token missing user_id prefix"))?;
    prefix
        .parse::<i64>()
        .with_context(|| format!("access_token prefix `{prefix}` is not numeric"))
}

pub async fn fetch_shop_info(
    client: &reqwest::Client,
    keystring: &str,
    access_token: &str,
    api_base: &str,
) -> anyhow::Result<ShopInfo> {
    let user_id = user_id_from_token(access_token)?;
    let url = format!("{api_base}/users/{user_id}/shops");
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("x-api-key", keystring)
        .send()
        .await
        .context("fetch shop info GET failed")?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!("shops endpoint returned {status}: {body}"));
    }
    let value: serde_json::Value =
        serde_json::from_str(&body).with_context(|| format!("parse shops JSON: {body}"))?;
    // Etsy returns a `results` array even when there's a single shop. Some
    // deployments return the shop object directly — handle both.
    let first = if let Some(arr) = value.get("results").and_then(|v| v.as_array()) {
        arr.first().cloned()
    } else if value.is_array() {
        value.as_array().and_then(|a| a.first().cloned())
    } else if value.get("shop_id").is_some() {
        Some(value.clone())
    } else {
        None
    };
    let shop = first.ok_or_else(|| anyhow!("no shops returned for user {user_id}"))?;
    let shop_id = shop
        .get("shop_id")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| anyhow!("shop_id missing or not an integer"))?;
    let shop_name = shop
        .get("shop_name")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    Ok(ShopInfo { shop_id, shop_name, user_id })
}

/// Read all token + shop secrets and assemble the current connection status.
pub fn load_status() -> EtsyStatus {
    let access = secrets::get("etsy_access_token").ok().flatten();
    let expires_at = secrets::get("etsy_token_expires_at")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok());
    let shop_id = secrets::get("etsy_shop_id")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok());
    let shop_name = secrets::get("etsy_shop_name").ok().flatten();
    let connected = access.is_some() && shop_id.is_some();
    let now = chrono::Utc::now().timestamp();
    // Treat anything expiring within 5 minutes as needing refresh.
    let needs_refresh = expires_at.map(|e| e < now + 300).unwrap_or(false);
    EtsyStatus {
        connected,
        shop_id,
        shop_name,
        expires_at,
        needs_refresh,
    }
}

/// Persist a TokenSet to keychain under the canonical key names.
pub fn persist_tokens(tokens: &TokenSet) -> anyhow::Result<()> {
    secrets::set("etsy_access_token", &tokens.access_token)?;
    secrets::set("etsy_refresh_token", &tokens.refresh_token)?;
    secrets::set("etsy_token_expires_at", &tokens.expires_at.to_string())?;
    Ok(())
}

pub fn persist_shop(shop: &ShopInfo) -> anyhow::Result<()> {
    secrets::set("etsy_shop_id", &shop.shop_id.to_string())?;
    secrets::set("etsy_shop_name", &shop.shop_name)?;
    Ok(())
}

/// Clear all Etsy-related secrets.
pub fn disconnect() -> anyhow::Result<()> {
    for key in [
        "etsy_access_token",
        "etsy_refresh_token",
        "etsy_token_expires_at",
        "etsy_shop_id",
        "etsy_shop_name",
        "etsy_last_error",
    ] {
        let _ = secrets::delete(key);
    }
    Ok(())
}

/// Return a valid access token, refreshing if the stored one is expired.
/// The new token (and rotated refresh token) is persisted before returning.
pub async fn ensure_fresh_token(client: &reqwest::Client) -> anyhow::Result<String> {
    let access = secrets::get("etsy_access_token")?
        .ok_or_else(|| anyhow!("no etsy_access_token stored — connect Etsy first"))?;
    let expires_at = secrets::get("etsy_token_expires_at")?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);
    let now = chrono::Utc::now().timestamp();
    if expires_at >= now + 60 {
        return Ok(access);
    }
    let refresh_token = secrets::get("etsy_refresh_token")?
        .ok_or_else(|| anyhow!("no refresh token stored"))?;
    let keystring = secrets::get("etsy_api_keystring")?
        .ok_or_else(|| anyhow!("no etsy_api_keystring stored"))?;
    let fresh = refresh(client, &keystring, &refresh_token, TOKEN_URL).await?;
    persist_tokens(&fresh)?;
    Ok(fresh.access_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pkce_challenge_is_sha256_base64url() {
        // Fixture from RFC 7636 §4.2:
        //   verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        //   challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        let v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        let c = code_challenge(v);
        assert_eq!(c, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn test_generated_pkce_roundtrip() {
        let (v, c) = generate_pkce();
        assert!(v.len() >= 43 && v.len() <= 128, "verifier length {}", v.len());
        assert_eq!(c, code_challenge(&v));
        // Verifier must be URL-safe (subset of [A-Za-z0-9-_])
        assert!(v
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
    }

    #[test]
    fn test_state_length_and_charset() {
        let s = generate_state();
        assert_eq!(s.len(), 32);
        assert!(s
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_'));
    }

    #[test]
    fn test_authorize_url_has_required_params() {
        let url = build_authorize_url("KEY123", "STATE456", "CHAL789");
        let parsed = url::Url::parse(&url).expect("authorize URL parses");
        assert_eq!(parsed.host_str(), Some("www.etsy.com"));
        assert_eq!(parsed.path(), "/oauth/connect");
        let q: std::collections::HashMap<_, _> =
            parsed.query_pairs().into_owned().collect();
        assert_eq!(q.get("response_type").map(String::as_str), Some("code"));
        assert_eq!(q.get("client_id").map(String::as_str), Some("KEY123"));
        assert_eq!(q.get("state").map(String::as_str), Some("STATE456"));
        assert_eq!(q.get("code_challenge").map(String::as_str), Some("CHAL789"));
        assert_eq!(q.get("code_challenge_method").map(String::as_str), Some("S256"));
        assert_eq!(q.get("redirect_uri").map(String::as_str), Some(REDIRECT_URI));
        assert_eq!(q.get("scope").map(String::as_str), Some(SCOPES));
    }

    #[test]
    fn test_user_id_extraction() {
        assert_eq!(user_id_from_token("12345.abcdef").unwrap(), 12345);
        assert!(user_id_from_token("noprefix").is_err());
        assert!(user_id_from_token("abc.def").is_err());
    }

    #[tokio::test]
    async fn test_exchange_code_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/token")
            .match_header("content-type", "application/x-www-form-urlencoded")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"access_token":"42.abc","refresh_token":"r123","expires_in":3600,"token_type":"Bearer"}"#,
            )
            .create_async()
            .await;
        let client = reqwest::Client::new();
        let url = format!("{}/token", server.url());
        let before = chrono::Utc::now().timestamp();
        let ts = exchange_code(&client, "KEY", "CODE", "VERIFIER", &url)
            .await
            .expect("exchange ok");
        let after = chrono::Utc::now().timestamp();
        mock.assert_async().await;
        assert_eq!(ts.access_token, "42.abc");
        assert_eq!(ts.refresh_token, "r123");
        // expires_at = now + 3600 - 60, bounded by [before, after] of the call.
        assert!(ts.expires_at >= before + 3600 - 60);
        assert!(ts.expires_at <= after + 3600 - 60);
    }

    #[tokio::test]
    async fn test_refresh_parses_response() {
        let mut server = mockito::Server::new_async().await;
        let mock = server
            .mock("POST", "/token")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(
                r#"{"access_token":"42.new","refresh_token":"r456","expires_in":7200}"#,
            )
            .create_async()
            .await;
        let client = reqwest::Client::new();
        let url = format!("{}/token", server.url());
        let ts = refresh(&client, "KEY", "OLD_R", &url)
            .await
            .expect("refresh ok");
        mock.assert_async().await;
        assert_eq!(ts.access_token, "42.new");
        assert_eq!(ts.refresh_token, "r456");
    }
}
