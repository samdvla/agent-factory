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
    routing::{get, post},
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
        // Mutating endpoints (phase 2). All POST, all bearer-auth.
        .route("/api/supervisor/start", post(supervisor_start_handler))
        .route("/api/supervisor/stop", post(supervisor_stop_handler))
        .route("/api/secrets/set", post(secrets_set_handler))
        .route("/api/secrets/get", post(secrets_get_handler))
        .route("/api/enqueue", post(enqueue_handler))
        .route("/api/etsy/kill_switch", post(etsy_kill_switch_handler))
        .route("/api/jobs/rate", post(rate_job_handler))
        .route("/api/agent_messages/post", post(post_agent_message_handler))
        // Phase 2 batch 2 — listing review actions + smoke-test triggers.
        .route("/api/etsy/listings/activate", post(etsy_activate_listing_handler))
        .route("/api/etsy/listings/discard", post(etsy_discard_draft_handler))
        .route("/api/etsy/listings/regenerate", post(etsy_regenerate_draft_handler))
        .route("/api/etsy/listings/reject", post(etsy_reject_draft_handler))
        .route("/api/etsy/listings/restore", post(etsy_restore_rejected_handler))
        .route("/api/etsy/listings/cancel_regeneration", post(etsy_cancel_regeneration_handler))
        .route("/api/smoke_test/start", post(smoke_test_start_handler))
        .route("/api/smoke_test/resume", post(smoke_test_resume_handler))
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

// ─────────────────────────────────────────────────────────────────────────────
// Mutating endpoints (phase 2)
// ─────────────────────────────────────────────────────────────────────────────
//
// Every handler below requires bearer auth, just like the read endpoints.
// They mirror the matching Tauri command's body but call the same
// underlying helpers (queue::enqueue, secrets::*, EventBus emit, etc.) so
// the laptop and the mini converge on identical behavior.

async fn supervisor_start_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<()>, StatusCode> {
    check_auth(&headers, &s.token)?;
    commands::start_supervisor_with_state(Arc::clone(&s.inner))
        .await
        .map(Json)
        .map_err(|e| {
            tracing::warn!("api supervisor/start: {e}");
            StatusCode::INTERNAL_SERVER_ERROR
        })
}

async fn supervisor_stop_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<()>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let mut guard = s.inner.supervisor_handle.lock().await;
    if let Some(h) = guard.take() {
        h.shutdown().await;
    }
    Ok(Json(()))
}

#[derive(serde::Deserialize)]
struct SecretSetBody { key: String, value: String }

async fn secrets_set_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<SecretSetBody>,
) -> Result<Json<()>, StatusCode> {
    check_auth(&headers, &s.token)?;
    secrets::set(&body.key, &body.value).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(()))
}

#[derive(serde::Deserialize)]
struct SecretGetBody { key: String }

async fn secrets_get_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<SecretGetBody>,
) -> Result<Json<Option<String>>, StatusCode> {
    check_auth(&headers, &s.token)?;
    secrets::get(&body.key).map(Json).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

#[derive(serde::Deserialize)]
struct EnqueueBody { agent_role: String, payload: serde_json::Value }

async fn enqueue_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<EnqueueBody>,
) -> Result<Json<i64>, StatusCode> {
    check_auth(&headers, &s.token)?;
    // Mirror the same safety gate cmd_enqueue uses: refuse pipeline jobs in
    // Live mode when real Etsy publishing is off (prevents silent dry-runs).
    let ui_sandbox = secrets::get("ui_sandbox_mode").ok().flatten()
        .map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let real_etsy = secrets::get("real_etsy_enabled").ok().flatten()
        .map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let smoke_active = secrets::get("smoke_cycle_id").ok().flatten()
        .filter(|s| !s.is_empty()).is_some();
    let role = body.agent_role.as_str();
    let is_pipeline_role = matches!(role, "research" | "orchestrator" | "designer" | "listing" | "publisher");
    if is_pipeline_role && !ui_sandbox && !real_etsy && !smoke_active {
        return Err(StatusCode::CONFLICT);
    }
    crate::queue::enqueue(&s.inner.pool, s.inner.project_id, &body.agent_role, body.payload)
        .await
        .map(Json)
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

async fn etsy_kill_switch_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<()>, StatusCode> {
    check_auth(&headers, &s.token)?;
    secrets::set("real_etsy_enabled", "false").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    s.inner.bus.send(crate::events::SupervisorEvent::EtsyKillSwitchTriggered);
    Ok(Json(()))
}

#[derive(serde::Deserialize)]
struct RateJobBody { job_id: i64, rating: Option<String>, note: Option<String> }

async fn rate_job_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<RateJobBody>,
) -> Result<Json<()>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let now = chrono::Utc::now().timestamp();
    match body.rating.as_deref() {
        Some("up") | Some("down") => {
            let rating = body.rating.unwrap();
            sqlx::query(
                "INSERT INTO job_feedback (job_id, rating, note, rater, created_at) \
                 VALUES (?, ?, ?, 'operator', ?) \
                 ON CONFLICT(job_id, rater) DO UPDATE SET \
                   rating = excluded.rating, note = excluded.note, created_at = excluded.created_at",
            )
            .bind(body.job_id).bind(rating).bind(body.note).bind(now)
            .execute(&s.inner.pool).await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        None => {
            sqlx::query("DELETE FROM job_feedback WHERE job_id = ? AND rater = 'operator'")
                .bind(body.job_id)
                .execute(&s.inner.pool).await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
        }
        Some(_) => return Err(StatusCode::BAD_REQUEST),
    }
    // Best-effort snapshot + SI wake-up (same as cmd_rate_job).
    let _ = commands::snapshot_operator_feedback_to_disk(&s.inner.pool, s.inner.project_id).await;
    let _ = crate::queue::enqueue(
        &s.inner.pool,
        s.inner.project_id,
        "si",
        serde_json::json!({"trigger": "operator_rating", "job_id": body.job_id}),
    ).await;
    Ok(Json(()))
}

#[derive(serde::Deserialize)]
struct PostMessageBody {
    from_role: String,
    to_role: String,
    topic: Option<String>,
    content: String,
    importance: Option<String>,
    job_id: Option<i64>,
}

async fn post_agent_message_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<PostMessageBody>,
) -> Result<Json<i64>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let importance = body.importance.unwrap_or_else(|| "info".into());
    if !["info", "heads_up", "critical"].contains(&importance.as_str()) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let to = if body.to_role.trim().is_empty() { "*".into() } else { body.to_role };
    let now = chrono::Utc::now().timestamp();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO agent_messages (project_id, from_role, to_role, topic, content, importance, job_id, ts) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(s.inner.project_id)
    .bind(&body.from_role)
    .bind(&to)
    .bind(&body.topic)
    .bind(&body.content)
    .bind(&importance)
    .bind(body.job_id)
    .bind(now)
    .fetch_one(&s.inner.pool).await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(id))
}

// ---- Listing review actions ----

#[derive(serde::Deserialize)]
struct ListingIdBody { local_listing_id: i64 }

async fn etsy_activate_listing_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<ListingIdBody>,
) -> Result<Json<commands::ActivateResult>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let row: Option<(i64, Option<String>)> = sqlx::query_as(
        "SELECT etsy_listing_id, url FROM etsy_publishes \
         WHERE project_id = ? AND local_listing_id = ? \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(s.inner.project_id)
    .bind(body.local_listing_id)
    .fetch_optional(&s.inner.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let (etsy_listing_id, url) = row.ok_or(StatusCode::NOT_FOUND)?;

    let status = crate::etsy::load_status();
    if !status.connected {
        return Err(StatusCode::CONFLICT);
    }
    let shop_id = status.shop_id.ok_or(StatusCode::CONFLICT)?;
    if secrets::get("etsy_api_keystring").ok().flatten().map(|k| k.is_empty()).unwrap_or(true) {
        return Err(StatusCode::CONFLICT);
    }

    let client = reqwest::Client::new();
    crate::etsy_publish::activate_listing(&client, shop_id, etsy_listing_id)
        .await
        .map_err(|e| {
            tracing::warn!("api activate: {e:#}");
            StatusCode::BAD_GATEWAY
        })?;

    let now = chrono::Utc::now().timestamp();
    if let Err(e) = sqlx::query(
        "UPDATE etsy_publishes SET state = 'active', activated_at = ? WHERE project_id = ? AND etsy_listing_id = ?",
    )
    .bind(now)
    .bind(s.inner.project_id)
    .bind(etsy_listing_id)
    .execute(&s.inner.pool)
    .await
    {
        tracing::warn!("update etsy_publishes after activate: {e}");
    }

    s.inner.bus.send(crate::events::SupervisorEvent::EtsyListingActivated { etsy_listing_id });
    Ok(Json(commands::ActivateResult { etsy_listing_id, url }))
}

async fn etsy_regenerate_draft_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<ListingIdBody>,
) -> Result<Json<()>, StatusCode> {
    check_auth(&headers, &s.token)?;
    sqlx::query(
        "UPDATE etsy_publishes SET state = 'queued' \
         WHERE project_id = ? AND local_listing_id = ? AND state = 'draft'",
    )
    .bind(s.inner.project_id)
    .bind(body.local_listing_id)
    .execute(&s.inner.pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    crate::queue::enqueue(
        &s.inner.pool,
        s.inner.project_id,
        "orchestrator",
        serde_json::json!({"trigger": "regenerate", "regenerate_from": body.local_listing_id}),
    )
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    s.inner.bus.send(crate::events::SupervisorEvent::EtsyDraftRegenerated {
        local_listing_id: body.local_listing_id,
    });
    Ok(Json(()))
}

async fn etsy_discard_draft_handler(
    state: State<ApiState>,
    headers: HeaderMap,
    body: Json<ListingIdBody>,
) -> Result<Json<()>, StatusCode> {
    // Per cmd_etsy_discard_draft: discard == regenerate (kept for UI clarity).
    etsy_regenerate_draft_handler(state, headers, body).await
}

#[derive(serde::Deserialize)]
struct RejectBody { local_listing_id: i64, reason: Option<String> }

async fn etsy_reject_draft_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<RejectBody>,
) -> Result<Json<()>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let pid = s.inner.project_id;
    let pool = &s.inner.pool;

    let title: String = sqlx::query_scalar(
        "SELECT title FROM etsy_publishes \
         WHERE project_id = ? AND local_listing_id = ? \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(pid).bind(body.local_listing_id)
    .fetch_optional(pool).await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
    .unwrap_or_default();

    // publisher_output.json: description, tags, niche.
    let home = std::env::var("HOME").unwrap_or_default();
    let pub_path = std::path::PathBuf::from(&home).join(".agent-factory").join("publisher_output.json");
    let mut description = String::new();
    let mut tags: Vec<String> = Vec::new();
    let mut niche: Option<String> = None;
    if let Ok(text) = std::fs::read_to_string(&pub_path) {
        if let Ok(records) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(arr) = records.as_array() {
                if let Some(rec) = arr.iter().rev().find(|r| {
                    r.get("listing_id").and_then(|v| v.as_i64()) == Some(body.local_listing_id)
                }) {
                    description = rec.get("description").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                    tags = rec.get("tags").and_then(|v| v.as_array())
                        .map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect())
                        .unwrap_or_default();
                    niche = rec.get("niche").and_then(|v| v.as_str()).map(String::from);
                }
            }
        }
    }

    let cycle_id: Option<String> = sqlx::query_scalar(
        "SELECT cycle_id FROM pipeline_cycles \
         WHERE project_id = ? AND local_listing_id = ? \
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(pid).bind(body.local_listing_id)
    .fetch_optional(pool).await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let rejected_at = chrono::Utc::now().timestamp_millis();
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());

    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query(
        "UPDATE etsy_publishes SET state = 'rejected' \
         WHERE project_id = ? AND local_listing_id = ?",
    )
    .bind(pid).bind(body.local_listing_id)
    .execute(&mut *tx).await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query(
        "INSERT INTO listing_rejections \
         (project_id, local_listing_id, cycle_id, title, niche, tags_json, description, rejected_at, reason) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(pid).bind(body.local_listing_id).bind(cycle_id.as_deref())
    .bind(&title).bind(niche.as_deref()).bind(&tags_json).bind(&description)
    .bind(rejected_at).bind(body.reason.as_deref())
    .execute(&mut *tx).await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let _ = commands::snapshot_rejections_to_disk(pool, pid).await;
    s.inner.bus.send(crate::events::SupervisorEvent::EtsyDraftRejected {
        local_listing_id: body.local_listing_id,
    });
    Ok(Json(()))
}

async fn etsy_restore_rejected_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<ListingIdBody>,
) -> Result<Json<()>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let pool = &s.inner.pool;
    let pid = s.inner.project_id;
    let mut tx = pool.begin().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query(
        "UPDATE etsy_publishes SET state = 'draft' \
         WHERE project_id = ? AND local_listing_id = ? AND state = 'rejected'",
    )
    .bind(pid).bind(body.local_listing_id)
    .execute(&mut *tx).await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    sqlx::query("DELETE FROM listing_rejections WHERE project_id = ? AND local_listing_id = ?")
        .bind(pid).bind(body.local_listing_id)
        .execute(&mut *tx).await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tx.commit().await.map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let _ = commands::snapshot_rejections_to_disk(pool, pid).await;
    s.inner.bus.send(crate::events::SupervisorEvent::EtsyDraftRestored {
        local_listing_id: body.local_listing_id,
    });
    Ok(Json(()))
}

async fn etsy_cancel_regeneration_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
    Json(body): Json<ListingIdBody>,
) -> Result<Json<()>, StatusCode> {
    check_auth(&headers, &s.token)?;
    sqlx::query(
        "UPDATE etsy_publishes SET state = 'rejected' \
         WHERE project_id = ? AND local_listing_id = ? AND state = 'queued'",
    )
    .bind(s.inner.project_id).bind(body.local_listing_id)
    .execute(&s.inner.pool).await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    s.inner.bus.send(crate::events::SupervisorEvent::EtsyDraftRejected {
        local_listing_id: body.local_listing_id,
    });
    Ok(Json(()))
}

// ---- Smoke test ----

async fn smoke_test_start_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<String>, StatusCode> {
    check_auth(&headers, &s.token)?;
    let _ = secrets::delete("smoke_pause_until");
    // Force a clean supervisor restart (stop then start) so workers are alive.
    {
        let mut guard = s.inner.supervisor_handle.lock().await;
        if let Some(h) = guard.take() {
            h.shutdown().await;
        }
    }
    commands::start_supervisor_with_state(Arc::clone(&s.inner))
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    tokio::time::sleep(Duration::from_millis(800)).await;

    let cycle_id = format!("smoke-{}", chrono::Utc::now().format("%Y%m%d%H%M%S"));
    secrets::set("smoke_cycle_id", &cycle_id).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let now_ts = chrono::Utc::now().timestamp().to_string();
    secrets::set("smoke_started_at", &now_ts).map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let prior_real = secrets::get("real_etsy_enabled").ok().flatten().unwrap_or_default();
    secrets::set("pre_smoke_real_etsy_enabled", &prior_real).ok();
    secrets::set("real_etsy_enabled", "true").ok();
    let payload = serde_json::json!({ "smoke": true, "cycle_id": cycle_id });
    crate::queue::enqueue(&s.inner.pool, s.inner.project_id, "research", payload)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(Json(cycle_id))
}

async fn smoke_test_resume_handler(
    State(s): State<ApiState>,
    headers: HeaderMap,
) -> Result<Json<()>, StatusCode> {
    check_auth(&headers, &s.token)?;
    secrets::delete("smoke_pause_until").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    secrets::delete("smoke_cycle_id").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    secrets::delete("smoke_started_at").map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let prior = secrets::get("pre_smoke_real_etsy_enabled").ok().flatten().unwrap_or_default();
    if prior.is_empty() {
        let _ = secrets::delete("real_etsy_enabled");
    } else {
        let _ = secrets::set("real_etsy_enabled", &prior);
    }
    let _ = secrets::delete("pre_smoke_real_etsy_enabled");
    Ok(Json(()))
}
