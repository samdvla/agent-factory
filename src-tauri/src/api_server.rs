//! HTTP + SSE API server for the headless agent-factory mini.
//!
//! Bound on 0.0.0.0:<port> when AGENT_FACTORY_API_PORT is set in the
//! environment (the LaunchAgent plist sets it on the mini). Bearer-token
//! auth on every route except /healthz; the token is read from the secret
//! store under `api_server_token` and generated on first launch.
//!
//! Phase 1 scope: read-only endpoints + an SSE stream of supervisor events
//! so the laptop UI can mirror the mini's live state. Mutating commands
//! (start/stop supervisor, set secrets, etc.) ship later.

use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{sse::Event, sse::KeepAlive, Sse},
    routing::get,
    Json, Router,
};
use serde_json::json;
use tokio_stream::{wrappers::BroadcastStream, StreamExt};
use tower_http::cors::CorsLayer;

use crate::commands::AppState;

#[derive(Clone)]
struct ApiState {
    inner: Arc<AppState>,
    token: String,
}

/// Resolve the API token: read from the secret store, or generate + persist
/// a new 32-byte hex one. Returns Ok(token) in both cases.
pub fn resolve_or_create_token() -> anyhow::Result<String> {
    if let Some(existing) = crate::secrets::get("api_server_token")?
        .filter(|s| !s.is_empty())
    {
        return Ok(existing);
    }
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let token = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    crate::secrets::set("api_server_token", &token)?;
    Ok(token)
}

/// Bind axum on `bind_addr` and serve. This future runs forever; spawn it.
pub async fn run(state: Arc<AppState>, bind_addr: String, token: String) -> anyhow::Result<()> {
    let api_state = ApiState { inner: state, token };

    let app = Router::new()
        .route("/healthz", get(healthz))
        .route("/api/status", get(status_handler))
        .route("/api/events", get(events_handler))
        .with_state(api_state)
        // The laptop's Vite dev server runs on a different origin (typically
        // tauri://localhost or http://localhost:1420). For now allow any
        // origin with bearer-token auth as the security perimeter.
        .layer(CorsLayer::permissive());

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .map_err(|e| anyhow::anyhow!("api_server bind {bind_addr}: {e}"))?;
    tracing::info!("api_server: listening on {bind_addr}");
    axum::serve(listener, app).await?;
    Ok(())
}

async fn healthz() -> &'static str {
    "ok"
}

fn check_auth(headers: &HeaderMap, expected: &str) -> Result<(), StatusCode> {
    let h = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok());
    match h.and_then(|s| s.strip_prefix("Bearer ")) {
        Some(tok) if tok == expected => Ok(()),
        _ => Err(StatusCode::UNAUTHORIZED),
    }
}

async fn status_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let running = s.inner.supervisor_handle.lock().await.is_some();
    Ok(Json(json!({
        "running": running,
        "project_id": s.inner.project_id,
    })))
}

async fn events_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Sse<impl tokio_stream::Stream<Item = Result<Event, std::convert::Infallible>>>, StatusCode>
{
    check_auth(&headers, &s.token)?;
    let rx = s.inner.bus.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|res| {
        res.ok().map(|evt| {
            let data = serde_json::to_string(&evt).unwrap_or_else(|_| "null".into());
            Ok::<_, std::convert::Infallible>(Event::default().data(data))
        })
    });
    Ok(Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15))))
}
