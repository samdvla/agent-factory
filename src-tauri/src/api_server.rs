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

use crate::commands::{self, AppState};
use crate::{budget, pnl, secrets};

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
        .route("/api/today_stats", get(today_stats_handler))
        .route("/api/recent_cycles", get(recent_cycles_handler))
        .route("/api/wealth", get(wealth_handler))
        .route("/api/budget", get(budget_handler))
        .route("/api/etsy/publishes", get(etsy_publishes_handler))
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

// ---- Read-only data endpoints: bodies inlined from commands.rs so the
// laptop UI can mirror the mini's live state. Mutating endpoints (start,
// stop, set_secret, enqueue) ship in a later phase.

#[derive(serde::Deserialize)]
struct CyclesQuery { limit: Option<i64> }

async fn today_stats_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<commands::TodayStats>, StatusCode> {
    check_auth(&headers, &s.token)?;
    commands::today_stats_with(&s.inner.pool, s.inner.project_id)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn recent_cycles_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<CyclesQuery>,
) -> Result<Json<Vec<pnl::CycleSummary>>, StatusCode> {
    check_auth(&headers, &s.token)?;
    pnl::list_recent_cycles(&s.inner.pool, s.inner.project_id, q.limit.unwrap_or(20))
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn wealth_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<pnl::AgentWealth>>, StatusCode> {
    check_auth(&headers, &s.token)?;
    pnl::list_wealth(&s.inner.pool, s.inner.project_id)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn budget_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let pool = &s.inner.pool;
    let pid = s.inner.project_id;
    let today_usd = budget::today_spend_usd(pool, pid).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let hour_usd  = budget::spend_window(pool, pid, 1).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let month_usd = budget::month_spend_usd(pool, pid).await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let read = |k: &str, default: f64| -> f64 {
        secrets::get(k).ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(default)
    };
    Ok(Json(json!({
        "today_usd": today_usd,
        "hour_usd": hour_usd,
        "month_usd": month_usd,
        "hourly_cap_usd": read("hourly_budget_usd", 0.50),
        "daily_cap_usd":  read("daily_budget_usd",  1.00),
        "monthly_cap_usd": read("monthly_budget_usd", 20.00),
        "burn_per_hour_usd": hour_usd,
    })))
}

async fn etsy_publishes_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<Vec<commands::EtsyPublishRow>>, StatusCode> {
    check_auth(&headers, &s.token)?;
    commands::etsy_list_publishes_with(&s.inner.pool, s.inner.project_id)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}
