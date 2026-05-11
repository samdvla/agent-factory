use crate::{budget, etsy, etsy_publish, events::{EventBus, SupervisorEvent}, oauth_server, pnl, prompts, queue, secrets, supervisor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, State};
use tokio::sync::Mutex;

pub struct AppState {
    pub pool: SqlitePool,
    pub bus: EventBus,
    pub project_id: i64,
    pub supervisor_handle: Mutex<Option<supervisor::SupervisorHandle>>,
    /// Map of `state` nonce -> PKCE code_verifier for in-flight OAuth flows.
    pub pending_oauth: Mutex<HashMap<String, String>>,
}

#[derive(Serialize)]
pub struct StatusReport {
    pub running: bool,
    pub project_id: i64,
}

#[tauri::command]
pub async fn cmd_status(state: State<'_, Arc<AppState>>) -> Result<StatusReport, String> {
    let running = state.supervisor_handle.lock().await.is_some();
    Ok(StatusReport { running, project_id: state.project_id })
}

#[tauri::command]
pub async fn cmd_set_secret(key: String, value: String) -> Result<(), String> {
    secrets::set(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_get_secret(key: String) -> Result<Option<String>, String> {
    secrets::get(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_start_supervisor(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let mut guard = state.supervisor_handle.lock().await;
    if guard.is_some() { return Ok(()); }

    let api_key = secrets::get("anthropic_api_key")
        .ok()
        .flatten()
        .unwrap_or_default();
    // Read multi-tier USD budget caps from the secret store with defaults.
    let read_cap = |k: &str, default: f64| -> f64 {
        secrets::get(k)
            .ok()
            .flatten()
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(default)
    };
    let caps = budget::BudgetCaps {
        hourly_usd:  read_cap("hourly_budget_usd",  0.50),
        daily_usd:   read_cap("daily_budget_usd",   1.00),
        monthly_usd: read_cap("monthly_budget_usd", 20.00),
    };
    let api_key_env = ("ANTHROPIC_API_KEY".into(), api_key.clone());
    let make_spec = |role: &str, worker_dir: &str| supervisor::AgentSpec {
        role: role.into(),
        program: "python3.11".into(),
        args: vec!["-m".into(), role.into()],
        env: vec![
            api_key_env.clone(),
            ("PYTHONPATH".into(), format!("workers/{}", worker_dir)),
        ],
    };

    let agents = vec![
        supervisor::AgentSpec {
            role: "hello".into(),
            program: "python3.11".into(),
            args: vec!["-m".into(), "hello".into()],
            env: vec![
                api_key_env.clone(),
                ("PYTHONPATH".into(), "workers/hello".into()),
            ],
        },
        make_spec("research", "research"),
        make_spec("orchestrator", "orchestrator"),
        make_spec("designer", "designer"),
        make_spec("listing", "listing"),
        make_spec("publisher", "publisher"),
        make_spec("cfo", "cfo"),
        make_spec("cs", "cs"),
    ];

    let handle = supervisor::start(state.pool.clone(), state.bus.clone(), agents, state.project_id, caps)
        .await
        .map_err(|e| e.to_string())?;
    *guard = Some(handle);
    Ok(())
}

#[tauri::command]
pub async fn cmd_stop_supervisor(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let mut guard = state.supervisor_handle.lock().await;
    if let Some(h) = guard.take() {
        h.shutdown().await;
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct EnqueueArgs {
    pub agent_role: String,
    pub payload: Value,
}

#[tauri::command]
pub async fn cmd_enqueue(
    state: State<'_, Arc<AppState>>,
    args: EnqueueArgs,
) -> Result<i64, String> {
    queue::enqueue(&state.pool, state.project_id, &args.agent_role, args.payload)
        .await
        .map_err(|e| e.to_string())
}

pub fn forward_events_to_window(app: tauri::AppHandle, bus: EventBus) {
    let mut rx = bus.subscribe();
    tauri::async_runtime::spawn(async move {
        while let Ok(evt) = rx.recv().await {
            let _ = app.emit("supervisor.event", evt);
        }
    });
}

#[derive(Serialize)]
pub struct OAuthInit {
    pub authorize_url: String,
}

/// Kick off the Etsy OAuth + PKCE flow. Returns the constructed authorize URL
/// so the frontend can hand it to the system browser. A background task awaits
/// the redirect on `127.0.0.1:7330/callback`, exchanges the code for tokens,
/// fetches shop identity, and emits `etsy_connected` when done.
#[tauri::command]
pub async fn cmd_etsy_start_oauth(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<OAuthInit, String> {
    let keystring = secrets::get("etsy_api_keystring")
        .map_err(|e| format!("read keystring: {e}"))?
        .ok_or_else(|| {
            "Etsy keystring not set — store it in the keychain as etsy_api_keystring first."
                .to_string()
        })?;

    let (verifier, challenge) = etsy::generate_pkce();
    let oauth_state = etsy::generate_state();
    {
        let mut guard = state.pending_oauth.lock().await;
        guard.insert(oauth_state.clone(), verifier.clone());
    }
    let authorize_url = etsy::build_authorize_url(&keystring, &oauth_state, &challenge);

    // Spawn the callback waiter + exchange. We hold the AppState so we can
    // pop the verifier on success.
    let app_state = state.inner().clone();
    let keystring_for_task = keystring;
    let app_for_task = app.clone();
    tokio::spawn(async move {
        run_oauth_flow(app_for_task, app_state, keystring_for_task, oauth_state).await;
    });

    Ok(OAuthInit { authorize_url })
}

async fn run_oauth_flow(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    keystring: String,
    oauth_state: String,
) {
    let result: anyhow::Result<etsy::ShopInfo> = async {
        let cb = oauth_server::await_callback(Duration::from_secs(600)).await?;
        if cb.state != oauth_state {
            return Err(anyhow::anyhow!(
                "state mismatch — got `{}`, expected `{}`",
                cb.state,
                oauth_state
            ));
        }
        let verifier = {
            let mut guard = state.pending_oauth.lock().await;
            guard.remove(&cb.state)
        }
        .ok_or_else(|| anyhow::anyhow!("no pending verifier for state `{}`", cb.state))?;

        let client = reqwest::Client::new();
        let tokens =
            etsy::exchange_code(&client, &keystring, &cb.code, &verifier, etsy::TOKEN_URL).await?;
        etsy::persist_tokens(&tokens)?;
        let shop =
            etsy::fetch_shop_info(&client, &keystring, &tokens.access_token, etsy::API_BASE)
                .await?;
        etsy::persist_shop(&shop)?;
        let _ = secrets::delete("etsy_last_error");
        Ok(shop)
    }
    .await;

    match result {
        Ok(shop) => {
            tracing::info!("etsy connected: shop_id={} name={}", shop.shop_id, shop.shop_name);
            let _ = app.emit("etsy_connected", &shop);
        }
        Err(e) => {
            tracing::error!("etsy oauth flow failed: {e}");
            let _ = secrets::set("etsy_last_error", &e.to_string());
            // Drop the verifier on failure so a retry can start fresh.
            let mut guard = state.pending_oauth.lock().await;
            guard.remove(&oauth_state);
            let _ = app.emit("etsy_oauth_error", e.to_string());
        }
    }
}

#[tauri::command]
pub async fn cmd_etsy_status() -> Result<etsy::EtsyStatus, String> {
    Ok(etsy::load_status())
}

#[tauri::command]
pub async fn cmd_etsy_disconnect() -> Result<(), String> {
    etsy::disconnect().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_etsy_set_enabled(enabled: bool) -> Result<(), String> {
    secrets::set("real_etsy_enabled", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_etsy_get_enabled() -> Result<bool, String> {
    Ok(secrets::get("real_etsy_enabled")
        .map_err(|e| e.to_string())?
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false))
}

#[tauri::command]
pub async fn cmd_etsy_set_listing_cap(cap: i64) -> Result<(), String> {
    if !(0..=100).contains(&cap) {
        return Err("cap must be 0..=100".into());
    }
    secrets::set("daily_listing_cap", &cap.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_etsy_get_listing_cap() -> Result<i64, String> {
    Ok(secrets::get("daily_listing_cap")
        .map_err(|e| e.to_string())?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(etsy_publish::DEFAULT_DAILY_CAP))
}

#[derive(Serialize)]
pub struct EtsyPublishRow {
    pub id: i64,
    pub local_listing_id: i64,
    pub etsy_listing_id: i64,
    pub state: String,
    pub title: String,
    pub url: Option<String>,
    pub published_at: i64,
    pub activated_at: Option<i64>,
}

#[tauri::command]
pub async fn cmd_etsy_list_publishes(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<EtsyPublishRow>, String> {
    let rows = sqlx::query_as::<_, (i64, i64, i64, String, String, Option<String>, i64, Option<i64>)>(
        "SELECT id, local_listing_id, etsy_listing_id, state, title, url, published_at, activated_at \
         FROM etsy_publishes WHERE project_id = ? ORDER BY id DESC LIMIT 50",
    )
    .bind(state.project_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| EtsyPublishRow {
            id: r.0,
            local_listing_id: r.1,
            etsy_listing_id: r.2,
            state: r.3,
            title: r.4,
            url: r.5,
            published_at: r.6,
            activated_at: r.7,
        })
        .collect())
}

#[derive(Serialize)]
pub struct ActivateResult {
    pub etsy_listing_id: i64,
    pub url: Option<String>,
}

#[tauri::command]
pub async fn cmd_etsy_activate_listing(
    state: State<'_, Arc<AppState>>,
    local_listing_id: i64,
) -> Result<ActivateResult, String> {
    let row: Option<(i64, Option<String>)> = sqlx::query_as(
        "SELECT etsy_listing_id, url FROM etsy_publishes \
         WHERE project_id = ? AND local_listing_id = ? \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(state.project_id)
    .bind(local_listing_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    let (etsy_listing_id, url) = row
        .ok_or_else(|| format!("no etsy publish row for local_listing_id={local_listing_id}"))?;

    let status = etsy::load_status();
    if !status.connected {
        return Err("Etsy not connected".into());
    }
    let shop_id = status
        .shop_id
        .ok_or_else(|| "shop_id missing — reconnect Etsy".to_string())?;
    let keystring = secrets::get("etsy_api_keystring")
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "etsy_api_keystring not in keychain".to_string())?;

    let client = reqwest::Client::new();
    etsy_publish::activate_listing(&client, &keystring, shop_id, etsy_listing_id)
        .await
        .map_err(|e| format!("{:#}", e))?;

    let now = chrono::Utc::now().timestamp();
    if let Err(e) = sqlx::query(
        "UPDATE etsy_publishes SET state = 'active', activated_at = ? WHERE project_id = ? AND etsy_listing_id = ?",
    )
    .bind(now)
    .bind(state.project_id)
    .bind(etsy_listing_id)
    .execute(&state.pool)
    .await
    {
        tracing::warn!("update etsy_publishes after activate: {e}");
    }

    state
        .bus
        .send(SupervisorEvent::EtsyListingActivated { etsy_listing_id });

    Ok(ActivateResult {
        etsy_listing_id,
        url,
    })
}

/// Read-only: most recent closed cycles for the UI's P&L panel. Hot-path
/// safe — pull-based, no events emitted per-job.
#[tauri::command]
pub async fn cmd_list_recent_cycles(
    state: State<'_, Arc<AppState>>,
    limit: Option<i64>,
) -> Result<Vec<pnl::CycleSummary>, String> {
    pnl::list_recent_cycles(&state.pool, state.project_id, limit.unwrap_or(20))
        .await
        .map_err(|e| e.to_string())
}

/// Read-only: per-agent lifetime wealth aggregates.
#[tauri::command]
pub async fn cmd_list_wealth(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<pnl::AgentWealth>, String> {
    pnl::list_wealth(&state.pool, state.project_id)
        .await
        .map_err(|e| e.to_string())
}

/// Kill-switch: instantly halt all real Etsy publishing + posting. Flips the
/// `real_etsy_enabled` secret to `"false"` — pollers + auto-reply + draft
/// publish all re-read this secret on each tick / completion so the change
/// takes effect immediately. Re-enabling is a one-click flip in the panel.
#[tauri::command]
pub async fn cmd_etsy_kill_switch(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    secrets::set("real_etsy_enabled", "false").map_err(|e| e.to_string())?;
    state.bus.send(SupervisorEvent::EtsyKillSwitchTriggered);
    Ok(())
}

// ---------- Prompt customization ----------

/// Return defaults + active overrides + last-tweak metadata for the four
/// editable roles. Powers the PromptsPanel.
#[tauri::command]
pub async fn cmd_list_prompts() -> Result<HashMap<String, prompts::PromptRow>, String> {
    Ok(prompts::list_prompts())
}

#[derive(Deserialize)]
pub struct SetPromptOverrideArgs {
    pub role: String,
    pub system: String,
}

#[tauri::command]
pub async fn cmd_set_prompt_override(args: SetPromptOverrideArgs) -> Result<(), String> {
    prompts::set_override(&args.role, &args.system).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_clear_prompt_override(role: String) -> Result<(), String> {
    prompts::clear_override(&role).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_prompt_history(
    role: String,
    limit: Option<usize>,
) -> Result<Vec<prompts::PromptHistoryEntry>, String> {
    Ok(prompts::history_for(&role, limit.unwrap_or(5)))
}

// ---------- SVG asset reader ----------

/// Resolve `local_listing_id` to its SVG asset on disk and return the raw
/// SVG markup. The publisher records `(listing_id, asset_path)` pairs in
/// `~/.agent-factory/mock_etsy.json` — we walk that file to find the
/// asset_path. Returns `None` when the listing has no recorded asset.
#[tauri::command]
pub async fn cmd_read_asset_svg(listing_id: i64) -> Result<Option<String>, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = PathBuf::from(home)
        .join(".agent-factory")
        .join("mock_etsy.json");
    let text = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(_) => return Ok(None),
    };
    let records: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let asset_path = records.as_array().and_then(|arr| {
        arr.iter().rev().find_map(|r| {
            let lid = r.get("listing_id").and_then(|v| v.as_i64())?;
            if lid != listing_id {
                return None;
            }
            r.get("asset_path")
                .and_then(|v| v.as_str())
                .map(String::from)
        })
    });
    let Some(asset_path) = asset_path else {
        return Ok(None);
    };
    match std::fs::read_to_string(&asset_path) {
        Ok(svg) => Ok(Some(svg)),
        Err(_) => Ok(None),
    }
}

// ---------- First-listing review helpers ----------

#[derive(Serialize, Default)]
pub struct ListingReviewInfo {
    /// Etsy publish row state ('draft' | 'active' | ...).
    pub state: String,
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
    pub niche: Option<String>,
    pub price_usd: Option<f64>,
    pub url: Option<String>,
    /// Joined from pipeline_cycles when local_listing_id matches.
    pub cycle_id: Option<String>,
    pub estimated_revenue_usd: Option<f64>,
    pub total_cost_usd: Option<f64>,
    pub net_usd: Option<f64>,
    /// CFO rationale stored on the cfo agent_contributions row (if any).
    pub cfo_rationale: Option<String>,
    /// Count of currently-active publishes — used to decide if first-listing
    /// gating still applies.
    pub active_publish_count: i64,
    /// Configured first-listing review cap (default 3).
    pub first_listing_review_count: i64,
}

/// One-shot fetch for the review modal: pulls publish row, mock_etsy
/// metadata, optional cycle financials, and the current active-publish
/// count + configured first-listing-review cap.
#[tauri::command]
pub async fn cmd_etsy_listing_review_info(
    state: State<'_, Arc<AppState>>,
    local_listing_id: i64,
) -> Result<ListingReviewInfo, String> {
    let mut info = ListingReviewInfo::default();

    // 1) etsy_publishes row (state, title, url).
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(
        "SELECT state, title, url FROM etsy_publishes \
         WHERE project_id = ? AND local_listing_id = ? \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(state.project_id)
    .bind(local_listing_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    if let Some((st, title, url)) = row {
        info.state = st;
        info.title = title;
        info.url = url;
    }

    // 2) mock_etsy.json — description, tags, niche, price_usd.
    let home = std::env::var("HOME").unwrap_or_default();
    let mock_path = PathBuf::from(&home).join(".agent-factory").join("mock_etsy.json");
    if let Ok(text) = std::fs::read_to_string(&mock_path) {
        if let Ok(records) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(arr) = records.as_array() {
                if let Some(rec) = arr.iter().rev().find(|r| {
                    r.get("listing_id").and_then(|v| v.as_i64()) == Some(local_listing_id)
                }) {
                    if info.title.is_empty() {
                        info.title = rec
                            .get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                    }
                    info.description = rec
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    info.tags = rec
                        .get("tags")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|t| t.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    info.niche = rec.get("niche").and_then(|v| v.as_str()).map(String::from);
                    info.price_usd = rec.get("price_usd").and_then(|v| v.as_f64());
                }
            }
        }
    }

    // 3) pipeline_cycles join.
    let cycle: Option<(String, Option<f64>, f64, Option<f64>)> = sqlx::query_as(
        "SELECT cycle_id, estimated_revenue_usd, total_cost_usd, net_usd \
         FROM pipeline_cycles \
         WHERE project_id = ? AND local_listing_id = ? \
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(state.project_id)
    .bind(local_listing_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    if let Some((cid, rev, cost, net)) = cycle {
        info.cycle_id = Some(cid);
        info.estimated_revenue_usd = rev;
        info.total_cost_usd = Some(cost);
        info.net_usd = net;
    }

    // 4) active publish count.
    let active_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM etsy_publishes WHERE project_id = ? AND state = 'active'",
    )
    .bind(state.project_id)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(0);
    info.active_publish_count = active_count;

    // 5) configured review cap (default 3).
    info.first_listing_review_count = secrets::get("first_listing_review_count")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(3);

    Ok(info)
}

#[derive(serde::Serialize)]
pub struct BudgetStatus {
    pub today_usd: f64,
    pub hour_usd: f64,
    pub month_usd: f64,
    pub hourly_cap_usd: f64,
    pub daily_cap_usd: f64,
    pub monthly_cap_usd: f64,
    pub burn_per_hour_usd: f64,
}

#[tauri::command]
pub async fn cmd_budget_status(state: State<'_, Arc<AppState>>) -> Result<BudgetStatus, String> {
    let pool = &state.pool;
    let pid = state.project_id;
    let today_usd = budget::today_spend_usd(pool, pid).await.map_err(|e| e.to_string())?;
    let hour_usd  = budget::spend_window(pool, pid, 1).await.map_err(|e| e.to_string())?;
    let month_usd = budget::month_spend_usd(pool, pid).await.map_err(|e| e.to_string())?;
    let read = |k: &str, default: f64| -> f64 {
        secrets::get(k).ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(default)
    };
    Ok(BudgetStatus {
        today_usd,
        hour_usd,
        month_usd,
        hourly_cap_usd: read("hourly_budget_usd", 0.50),
        daily_cap_usd:  read("daily_budget_usd",  1.00),
        monthly_cap_usd: read("monthly_budget_usd", 20.00),
        burn_per_hour_usd: hour_usd,
    })
}

/// Start a smoke-test cycle: stamps a cycle id + start timestamp into secrets,
/// sets the smoke_pause_until flag so enforce_caps blocks real spend after the
/// cycle, then enqueues one research job tagged with the cycle id. The
/// downstream listing / publisher agents follow the normal pipeline.
#[tauri::command]
pub async fn cmd_start_smoke_test(
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    use chrono::Utc;
    let cycle_id = format!("smoke-{}", Utc::now().format("%Y%m%d%H%M%S"));
    secrets::set("smoke_cycle_id", &cycle_id).map_err(|e| e.to_string())?;
    let now_ts = Utc::now().timestamp().to_string();
    secrets::set("smoke_started_at", &now_ts).map_err(|e| e.to_string())?;
    // Set the pause flag so that once the cycle finishes, any further
    // enforce_caps calls block until cmd_resume_from_smoke_test is called.
    secrets::set("smoke_pause_until", "1").map_err(|e| e.to_string())?;
    // Enqueue one research job; downstream listing/publisher follow the normal pipeline.
    let payload = serde_json::json!({ "smoke": true, "cycle_id": cycle_id });
    queue::enqueue(&state.pool, state.project_id, "research", payload)
        .await
        .map_err(|e| e.to_string())?;
    Ok(cycle_id)
}

/// Lift the smoke-test pause: clears smoke_pause_until, smoke_cycle_id, and
/// smoke_started_at so that enforce_caps resumes normal cap checking.
#[tauri::command]
pub async fn cmd_resume_from_smoke_test() -> Result<(), String> {
    secrets::delete("smoke_pause_until").map_err(|e| e.to_string())?;
    secrets::delete("smoke_cycle_id").map_err(|e| e.to_string())?;
    secrets::delete("smoke_started_at").map_err(|e| e.to_string())?;
    Ok(())
}

/// Phase-2 stub for the Regenerate button: drops the local etsy_publishes
/// row for this listing and enqueues a fresh orchestrator cycle. We do NOT
/// touch the real Etsy listing (it stays as a draft on Etsy's side) — the
/// user can clean it up manually.
#[tauri::command]
pub async fn cmd_etsy_discard_draft(
    state: State<'_, Arc<AppState>>,
    local_listing_id: i64,
) -> Result<(), String> {
    sqlx::query(
        "DELETE FROM etsy_publishes \
         WHERE project_id = ? AND local_listing_id = ? AND state = 'draft'",
    )
    .bind(state.project_id)
    .bind(local_listing_id)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    queue::enqueue(
        &state.pool,
        state.project_id,
        "orchestrator",
        serde_json::json!({"trigger": "regenerate", "discarded_listing_id": local_listing_id}),
    )
    .await
    .map_err(|e| e.to_string())?;
    state
        .bus
        .send(SupervisorEvent::EtsyListingPublishFailed {
            local_listing_id,
            reason: "discarded by user (regenerate requested)".into(),
        });
    Ok(())
}
