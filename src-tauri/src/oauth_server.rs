//! Tiny single-shot HTTP server for the OAuth redirect callback.
//!
//! Binds 127.0.0.1:7330, accepts ONE connection, parses `?code=...&state=...`
//! from the request line, writes a small HTML success page, and shuts down.
//! We hand-roll the HTTP bits rather than pull in a server framework — the
//! server lives for at most a single request.

use std::time::Duration;

use anyhow::{anyhow, Context};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub const CALLBACK_PORT: u16 = 7330;
pub const CALLBACK_PATH: &str = "/callback";

#[derive(Debug, Clone)]
pub struct CallbackParams {
    pub code: String,
    pub state: String,
}

const SUCCESS_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Agent Factory</title></head><body style=\"font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#0d0e10;color:#e8e8e8;\"><h1>Connected!</h1><p>You can close this tab and return to Agent Factory.</p></body></html>";

const ERROR_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Agent Factory</title></head><body style=\"font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;background:#0d0e10;color:#ff8a93;\"><h1>OAuth error</h1><p>See Agent Factory for details.</p></body></html>";

/// Bind to localhost:7330 and wait up to `timeout` for ONE OAuth redirect.
pub async fn await_callback(timeout: Duration) -> anyhow::Result<CallbackParams> {
    let addr = format!("127.0.0.1:{CALLBACK_PORT}");
    let listener = TcpListener::bind(&addr)
        .await
        .with_context(|| format!("bind oauth callback server on {addr}"))?;
    let result = tokio::time::timeout(timeout, accept_one(&listener)).await;
    match result {
        Ok(inner) => inner,
        Err(_) => Err(anyhow!("OAuth callback timed out after {:?}", timeout)),
    }
}

async fn accept_one(listener: &TcpListener) -> anyhow::Result<CallbackParams> {
    let (mut socket, _peer) = listener
        .accept()
        .await
        .context("accept oauth callback connection")?;

    // Read just enough to capture the request line + headers. 4 KB is plenty
    // for a redirect URL — Etsy's auth codes are well under 200 chars.
    let mut buf = [0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(10), socket.read(&mut buf))
        .await
        .context("read request: timeout")?
        .context("read request from oauth callback socket")?;
    let req = std::str::from_utf8(&buf[..n]).context("oauth request was not valid UTF-8")?;

    // Request line is the first line: `GET /callback?code=...&state=... HTTP/1.1`
    let first_line = req.lines().next().unwrap_or("");
    let parts: Vec<&str> = first_line.split_whitespace().collect();
    let target = parts.get(1).copied().unwrap_or("");

    let params = parse_callback_query(target);
    let (body, status_line) = match &params {
        Ok(_) => (SUCCESS_HTML, "HTTP/1.1 200 OK"),
        Err(_) => (ERROR_HTML, "HTTP/1.1 400 Bad Request"),
    };
    let resp = format!(
        "{status_line}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {len}\r\nConnection: close\r\n\r\n{body}",
        len = body.len(),
    );
    let _ = socket.write_all(resp.as_bytes()).await;
    let _ = socket.shutdown().await;
    params
}

fn parse_callback_query(target: &str) -> anyhow::Result<CallbackParams> {
    // `target` is the request-target, e.g. "/callback?code=AAA&state=BBB".
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };
    if path != CALLBACK_PATH {
        return Err(anyhow!("unexpected callback path: {path}"));
    }
    let mut code: Option<String> = None;
    let mut state: Option<String> = None;
    let mut err: Option<String> = None;
    for pair in query.split('&').filter(|s| !s.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let decoded = percent_decode(v);
        match k {
            "code" => code = Some(decoded),
            "state" => state = Some(decoded),
            "error" => err = Some(decoded),
            "error_description" => {
                if err.is_none() {
                    err = Some(decoded);
                }
            }
            _ => {}
        }
    }
    if let Some(e) = err {
        return Err(anyhow!("oauth provider returned error: {e}"));
    }
    let code = code.ok_or_else(|| anyhow!("missing `code` in callback"))?;
    let state = state.ok_or_else(|| anyhow!("missing `state` in callback"))?;
    Ok(CallbackParams { code, state })
}

/// Minimal application/x-www-form-urlencoded percent decoder. We only need
/// to handle the characters Etsy actually produces in callback values (auth
/// codes are URL-safe ASCII, but state may contain '-' or '_').
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'+' {
            out.push(b' ');
            i += 1;
        } else if b == b'%' && i + 2 < bytes.len() {
            let hi = hex_val(bytes[i + 1]);
            let lo = hex_val(bytes[i + 2]);
            match (hi, lo) {
                (Some(h), Some(l)) => {
                    out.push((h << 4) | l);
                    i += 3;
                }
                _ => {
                    out.push(b);
                    i += 1;
                }
            }
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;
    use tokio::net::TcpStream;

    #[test]
    fn parse_callback_query_extracts_code_and_state() {
        let p = parse_callback_query("/callback?code=ABC123&state=NONCE-99").unwrap();
        assert_eq!(p.code, "ABC123");
        assert_eq!(p.state, "NONCE-99");
    }

    #[test]
    fn parse_callback_query_decodes_percent() {
        // The auth code "AB CD" is unusual but exercises the decoder.
        let p = parse_callback_query("/callback?code=AB%20CD&state=X").unwrap();
        assert_eq!(p.code, "AB CD");
    }

    #[test]
    fn parse_callback_query_surfaces_provider_error() {
        let err = parse_callback_query("/callback?error=access_denied&state=X").unwrap_err();
        assert!(err.to_string().contains("access_denied"));
    }

    #[test]
    fn parse_callback_query_rejects_wrong_path() {
        assert!(parse_callback_query("/nope?code=x&state=y").is_err());
    }

    /// Boot the callback server on a fresh ephemeral port, send a fake GET,
    /// and verify the parsed params + HTTP response.
    #[tokio::test]
    async fn test_callback_parses_query_string() {
        // Bind ourselves on an ephemeral port (port 0) so this test doesn't
        // conflict with a running app on :7330 or with parallel test runs.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move { accept_one(&listener).await });

        // Tiny client: connect, send a GET, read the response.
        let mut stream = TcpStream::connect(format!("127.0.0.1:{port}")).await.unwrap();
        let req = "GET /callback?code=fakecode&state=fakestate HTTP/1.1\r\nHost: localhost\r\n\r\n";
        stream.write_all(req.as_bytes()).await.unwrap();
        let mut resp = String::new();
        stream.read_to_string(&mut resp).await.unwrap();

        assert!(resp.starts_with("HTTP/1.1 200"), "got: {resp}");
        assert!(resp.contains("Content-Type: text/html"));
        assert!(resp.contains("Connected!"));

        let params = server.await.unwrap().unwrap();
        assert_eq!(params.code, "fakecode");
        assert_eq!(params.state, "fakestate");
    }
}
