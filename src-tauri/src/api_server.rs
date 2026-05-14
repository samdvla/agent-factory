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
        .route("/api/etsy/rejections", get(etsy_rejections_handler))
        .route("/api/etsy/status", get(etsy_status_handler))
        .route("/api/agent_messages", get(agent_messages_handler))
        .route("/api/agent_messages_since", get(agent_messages_since_handler))
        .route("/api/recent_jobs", get(recent_jobs_handler))
        .route("/api/recent_jobs/count", get(recent_jobs_count_handler))
        .route("/api/unrated_jobs_count", get(unrated_jobs_count_handler))
        .route("/api/pinterest/status", get(pinterest_status_handler))
        .route("/api/pinterest/pins", get(pinterest_pins_handler))
        .route("/api/cults3d/status", get(cults3d_status_handler))
        .route("/api/cults3d/publishes", get(cults3d_publishes_handler))
        .route("/api/sketchfab/status", get(sketchfab_status_handler))
        .route("/api/sketchfab/publishes", get(sketchfab_publishes_handler))
        .route("/api/gumroad/status", get(gumroad_status_handler))
        .route("/api/gumroad/publishes", get(gumroad_publishes_handler))
        .route("/api/mmf/status", get(mmf_status_handler))
        .route("/api/mmf/publishes", get(mmf_publishes_handler))
        .route("/api/printify/status", get(printify_status_handler))
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

// ---- Etsy status / rejections ----

async fn etsy_status_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<crate::etsy::EtsyStatus>, StatusCode> {
    check_auth(&headers, &s.token)?;
    Ok(Json(crate::etsy::load_status()))
}

#[derive(serde::Deserialize)]
struct LimitQuery { limit: Option<i64> }

async fn etsy_rejections_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<LimitQuery>,
) -> Result<Json<Vec<commands::ListingRejectionRow>>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    sqlx::query_as::<_, commands::ListingRejectionRow>(
        "SELECT id, local_listing_id, cycle_id, title, niche, tags_json, description, rejected_at, reason \
         FROM listing_rejections WHERE project_id = ? ORDER BY rejected_at DESC LIMIT ?",
    )
    .bind(s.inner.project_id)
    .bind(limit)
    .fetch_all(&s.inner.pool)
    .await
    .map(Json)
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

// ---- Agent messages ----

#[derive(serde::Deserialize)]
struct AgentMessagesQuery { limit: Option<i64>, role: Option<String> }

async fn agent_messages_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<AgentMessagesQuery>,
) -> Result<Json<Vec<commands::AgentMessageRow>>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let limit = q.limit.unwrap_or(100).clamp(1, 1000);
    let mut sql = String::from(
        "SELECT id, from_role, to_role, topic, content, importance, job_id, ts \
         FROM agent_messages WHERE project_id = ?",
    );
    if q.role.is_some() {
        sql.push_str(" AND (from_role = ? OR to_role = ? OR to_role = '*')");
    }
    sql.push_str(" ORDER BY id DESC LIMIT ?");
    let mut sql_q = sqlx::query_as::<
        _,
        (i64, String, String, Option<String>, String, String, Option<i64>, i64),
    >(&sql)
    .bind(s.inner.project_id);
    if let Some(r) = q.role.as_ref() {
        sql_q = sql_q.bind(r).bind(r);
    }
    sql_q = sql_q.bind(limit);
    let rows = sql_q
        .fetch_all(&s.inner.pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(rows.into_iter().map(|r| commands::AgentMessageRow {
        id: r.0,
        from_role: r.1,
        to_role: r.2,
        topic: r.3,
        content: r.4,
        importance: r.5,
        job_id: r.6,
        ts: r.7,
    }).collect()))
}

#[derive(serde::Deserialize)]
struct SinceQuery { since_unix: i64 }

async fn agent_messages_since_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<SinceQuery>,
) -> Result<Json<i64>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_messages WHERE project_id = ? AND ts > ?",
    )
    .bind(s.inner.project_id)
    .bind(q.since_unix)
    .fetch_one(&s.inner.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(count))
}

// ---- Recent jobs ----

#[derive(serde::Deserialize)]
struct RecentJobsQuery {
    limit: Option<i64>,
    offset: Option<i64>,
    role: Option<String>,
    since_unix: Option<i64>,
}

async fn recent_jobs_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<RecentJobsQuery>,
) -> Result<Json<Vec<commands::JobRow>>, StatusCode> {
    check_auth(&headers, &s.token)?;
    commands::list_recent_jobs_with(
        &s.inner.pool,
        s.inner.project_id,
        q.limit,
        q.offset,
        q.role,
        q.since_unix,
    )
    .await
    .map(Json)
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(serde::Deserialize)]
struct CountJobsQuery { role: Option<String>, since_unix: Option<i64> }

async fn recent_jobs_count_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<CountJobsQuery>,
) -> Result<Json<i64>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let mut sql = String::from(
        "SELECT COUNT(*) FROM jobs WHERE project_id = ? AND status IN ('done','errored')",
    );
    if q.role.is_some() {
        sql.push_str(" AND agent_role = ?");
    }
    if q.since_unix.is_some() {
        sql.push_str(" AND CAST(strftime('%s', COALESCE(finished_at, scheduled_at)) AS INTEGER) >= ?");
    }
    let mut sql_q = sqlx::query_scalar::<_, i64>(&sql).bind(s.inner.project_id);
    if let Some(r) = q.role.as_ref() {
        sql_q = sql_q.bind(r);
    }
    if let Some(u) = q.since_unix {
        sql_q = sql_q.bind(u);
    }
    sql_q.fetch_one(&s.inner.pool).await.map(Json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn unrated_jobs_count_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<SinceQuery>,
) -> Result<Json<i64>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM jobs j \
         LEFT JOIN job_feedback f ON f.job_id = j.id AND f.rater = 'operator' \
         WHERE j.project_id = ? AND j.status IN ('done','errored') \
         AND CAST(strftime('%s', COALESCE(j.finished_at, j.scheduled_at)) AS INTEGER) >= ? \
         AND f.id IS NULL",
    )
    .bind(s.inner.project_id)
    .bind(q.since_unix)
    .fetch_one(&s.inner.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(count))
}

// ---- Pinterest ----

async fn pinterest_status_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<commands::PinterestStatus>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let creds_present = secrets::get("pinterest_access_token").ok().flatten().map(|v| !v.is_empty()).unwrap_or(false)
        && secrets::get("pinterest_board_id").ok().flatten().map(|v| !v.is_empty()).unwrap_or(false);
    let board_name = secrets::get("pinterest_board_name").ok().flatten();
    let enabled = secrets::get("pinterest_enabled").ok().flatten()
        .map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let (today_count, daily_cap) = crate::pinterest_publish::today_status(&s.inner.pool, s.inner.project_id)
        .await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(commands::PinterestStatus { creds_present, board_name, enabled, daily_cap, today_count }))
}

async fn pinterest_pins_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    axum::extract::Query(q): axum::extract::Query<LimitQuery>,
) -> Result<Json<Vec<commands::PinterestPinRow>>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let limit = q.limit.unwrap_or(50).clamp(1, 500);
    let rows = sqlx::query_as::<_, (i64, Option<i64>, Option<String>, String, Option<String>, Option<String>, String, Option<String>, i64)>(
        "SELECT id, local_listing_id, pinterest_pin_id, title, url, etsy_url, state, error, published_at \
         FROM pinterest_pins WHERE project_id = ? ORDER BY id DESC LIMIT ?",
    )
    .bind(s.inner.project_id)
    .bind(limit)
    .fetch_all(&s.inner.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(rows.into_iter().map(|r| commands::PinterestPinRow {
        id: r.0, local_listing_id: r.1, pinterest_pin_id: r.2, title: r.3,
        url: r.4, etsy_url: r.5, state: r.6, error: r.7, published_at: r.8,
    }).collect()))
}

// ---- Cults3D ----

async fn cults3d_status_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<commands::Cults3dStatus>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let creds_present = secrets::get("cults3d_username").ok().flatten().map(|v| !v.is_empty()).unwrap_or(false)
        && secrets::get("cults3d_api_key").ok().flatten().map(|v| !v.is_empty()).unwrap_or(false);
    let asset_host_configured = secrets::get("github_asset_repo").ok().flatten().map(|v| !v.is_empty()).unwrap_or(false)
        && secrets::get("github_asset_token").ok().flatten().map(|v| !v.is_empty()).unwrap_or(false);
    let enabled = secrets::get("cults3d_enabled").ok().flatten()
        .map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let daily_cap = secrets::get("cults3d_daily_cap").ok().flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(crate::cults3d_publish::DEFAULT_DAILY_CAP);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let today_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM cults3d_publishes WHERE project_id = ? AND day = ? AND state = 'published'",
    )
    .bind(s.inner.project_id).bind(&today).fetch_one(&s.inner.pool).await.unwrap_or(0);
    Ok(Json(commands::Cults3dStatus { creds_present, asset_host_configured, enabled, daily_cap, today_count }))
}

async fn cults3d_publishes_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let rows: Vec<serde_json::Value> = sqlx::query_as::<_, (i64, Option<i64>, Option<String>, String, Option<String>, Option<f64>, String, Option<String>, i64)>(
        "SELECT id, local_listing_id, cults3d_creation_id, title, url, price_usd, state, error, published_at \
         FROM cults3d_publishes WHERE project_id = ? ORDER BY id DESC LIMIT 50",
    )
    .bind(s.inner.project_id)
    .fetch_all(&s.inner.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .into_iter()
    .map(|r| json!({
        "id": r.0, "local_listing_id": r.1, "cults3d_creation_id": r.2, "title": r.3,
        "url": r.4, "price_usd": r.5, "state": r.6, "error": r.7, "published_at": r.8,
    }))
    .collect();
    Ok(Json(json!(rows)))
}

// ---- Sketchfab ----

async fn sketchfab_status_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<commands::SketchfabStatus>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let creds_present = secrets::get("sketchfab_api_token").ok().flatten().map(|v| !v.is_empty()).unwrap_or(false);
    let enabled = secrets::get("sketchfab_enabled").ok().flatten().map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let sell_on_store = secrets::get("sketchfab_sell_on_store").ok().flatten().map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let daily_cap = secrets::get("sketchfab_daily_cap").ok().flatten().and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(crate::sketchfab_publish::DEFAULT_DAILY_CAP);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let today_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sketchfab_publishes WHERE project_id = ? AND day = ? AND state = 'published'",
    )
    .bind(s.inner.project_id).bind(&today).fetch_one(&s.inner.pool).await.unwrap_or(0);
    Ok(Json(commands::SketchfabStatus { creds_present, enabled, sell_on_store, daily_cap, today_count }))
}

async fn sketchfab_publishes_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let rows: Vec<serde_json::Value> = sqlx::query_as::<_, (i64, Option<i64>, Option<String>, Option<String>, String, Option<String>, Option<f64>, String, Option<String>, Option<String>, i64)>(
        "SELECT id, local_listing_id, sketchfab_uid, store_product_id, title, url, price_usd, state, error, warning, published_at \
         FROM sketchfab_publishes WHERE project_id = ? ORDER BY id DESC LIMIT 50",
    )
    .bind(s.inner.project_id)
    .fetch_all(&s.inner.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .into_iter()
    .map(|r| json!({
        "id": r.0, "local_listing_id": r.1, "sketchfab_uid": r.2, "store_product_id": r.3,
        "title": r.4, "url": r.5, "price_usd": r.6, "state": r.7, "error": r.8, "warning": r.9, "published_at": r.10,
    }))
    .collect();
    Ok(Json(json!(rows)))
}

// ---- Gumroad ----

async fn gumroad_status_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<commands::GumroadStatus>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let creds_present = secrets::get("gumroad_access_token").ok().flatten().map(|v| !v.is_empty()).unwrap_or(false);
    let enabled = secrets::get("gumroad_enabled").ok().flatten().map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let daily_cap = secrets::get("gumroad_daily_cap").ok().flatten().and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(crate::gumroad_publish::DEFAULT_DAILY_CAP);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let today_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM gumroad_publishes WHERE project_id = ? AND day = ? AND state IN ('published','published_no_file')",
    )
    .bind(s.inner.project_id).bind(&today).fetch_one(&s.inner.pool).await.unwrap_or(0);
    Ok(Json(commands::GumroadStatus { creds_present, enabled, daily_cap, today_count }))
}

async fn gumroad_publishes_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let rows: Vec<serde_json::Value> = sqlx::query_as::<_, (i64, Option<i64>, Option<String>, String, Option<String>, Option<String>, Option<f64>, String, Option<String>, Option<String>, i64)>(
        "SELECT id, local_listing_id, gumroad_product_id, title, short_url, edit_url, price_usd, state, error, warning, published_at \
         FROM gumroad_publishes WHERE project_id = ? ORDER BY id DESC LIMIT 50",
    )
    .bind(s.inner.project_id)
    .fetch_all(&s.inner.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .into_iter()
    .map(|r| json!({
        "id": r.0, "local_listing_id": r.1, "gumroad_product_id": r.2, "title": r.3,
        "short_url": r.4, "edit_url": r.5, "price_usd": r.6, "state": r.7, "error": r.8, "warning": r.9, "published_at": r.10,
    }))
    .collect();
    Ok(Json(json!(rows)))
}

// ---- MyMiniFactory ----

async fn mmf_status_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<commands::MmfStatus>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let creds_present = crate::mmf_oauth::is_connected();
    let enabled = secrets::get("mmf_enabled").ok().flatten().map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let sell_paid = secrets::get("mmf_sell_paid").ok().flatten().map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let daily_cap = secrets::get("mmf_daily_cap").ok().flatten().and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(crate::myminifactory_publish::DEFAULT_DAILY_CAP);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let today_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM mmf_publishes WHERE project_id = ? AND day = ? AND state = 'published'",
    )
    .bind(s.inner.project_id).bind(&today).fetch_one(&s.inner.pool).await.unwrap_or(0);
    let client_id = secrets::get("mmf_client_id").ok().flatten();
    let oauth_user_id = secrets::get("mmf_oauth_user_id").ok().flatten();
    Ok(Json(commands::MmfStatus { creds_present, enabled, sell_paid, daily_cap, today_count, client_id, oauth_user_id }))
}

async fn mmf_publishes_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let rows: Vec<serde_json::Value> = sqlx::query_as::<_, (i64, Option<i64>, Option<String>, String, Option<String>, String, Option<String>, i64)>(
        "SELECT id, local_listing_id, mmf_object_id, title, url, state, error, published_at \
         FROM mmf_publishes WHERE project_id = ? ORDER BY id DESC LIMIT 50",
    )
    .bind(s.inner.project_id)
    .fetch_all(&s.inner.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .into_iter()
    .map(|r| json!({
        "id": r.0, "local_listing_id": r.1, "mmf_object_id": r.2, "title": r.3,
        "url": r.4, "state": r.5, "error": r.6, "published_at": r.7,
    }))
    .collect();
    Ok(Json(json!(rows)))
}

// ---- Printify ----

async fn printify_status_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<commands::PrintifyStatus>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let key_present = secrets::get("printify_api_key").ok().flatten().map(|v| !v.is_empty()).unwrap_or(false);
    let shop_id = secrets::get("printify_shop_id").ok().flatten().and_then(|s| s.parse::<i64>().ok());
    let pod_enabled = secrets::get("pod_enabled").ok().flatten().map(|v| v == "true").unwrap_or(false);
    Ok(Json(commands::PrintifyStatus { key_present, shop_id, pod_enabled }))
}
