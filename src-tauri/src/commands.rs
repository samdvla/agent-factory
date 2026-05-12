use crate::{budget, etsy, etsy_polling, etsy_publish, events::{EventBus, SupervisorEvent}, oauth_server, pnl, prompts, queue, secrets, supervisor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, State};
use tokio::sync::Mutex;

/// Resolve the absolute path to the workspace's `workers/` directory.
/// In dev the Tauri binary runs with CWD=src-tauri (cargo package root), so
/// `workers/` lives one level up. In a normal run (CWD=project root) it's
/// just `./workers`. We probe both and return the first one that exists; if
/// neither does we fall back to `./workers` so the error message stays
/// recognizable.
fn workers_root_path() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let candidates = [cwd.join("workers"), cwd.join("..").join("workers")];
    for c in &candidates {
        if c.is_dir() {
            return c.canonicalize().unwrap_or_else(|_| c.clone());
        }
    }
    cwd.join("workers")
}

pub struct AppState {
    pub pool: SqlitePool,
    pub bus: EventBus,
    pub project_id: i64,
    pub supervisor_handle: Mutex<Option<supervisor::SupervisorHandle>>,
    /// Map of `state` nonce -> PKCE code_verifier for in-flight OAuth flows.
    pub pending_oauth: Mutex<HashMap<String, String>>,
    /// Handle to the in-flight OAuth task, if any. Aborted on new start.
    pub oauth_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
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

/// Spawn the three autonomous loops (boot orchestrator, fake CS messages, SI
/// tuner) only when `autonomous_loops_enabled=true`. Call this after the
/// supervisor handle is stored so workers are ready to claim jobs.
///
/// Loop-specific secrets (`fake_cs_messages_enabled`, `si_loop_enabled`) are
/// re-read on every tick inside each loop so kill-switches take effect
/// immediately without a restart.
fn spawn_autonomous_loops(pool: SqlitePool, project_id: i64, bus: EventBus) {
    // Boot orchestrator: enqueue one orchestrator job 2s after supervisor start.
    let pool_boot = pool.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        if let Err(e) = queue::enqueue(
            &pool_boot,
            project_id,
            "orchestrator",
            serde_json::json!({"trigger": "boot"}),
        ).await {
            tracing::warn!("autonomous boot-orchestrator enqueue failed: {e}");
        }
    });

    // Fake CS message loop — fires a CS job every 90s with a random topic.
    // Gated on `fake_cs_messages_enabled` secret, re-read every tick.
    let pool_for_cs = pool.clone();
    tauri::async_runtime::spawn(async move {
        // Wait for first listing to exist before starting CS.
        tokio::time::sleep(std::time::Duration::from_secs(45)).await;
        let topics = [
            "How do I download my purchase?",
            "Can I get a refund? I changed my mind.",
            "Could you customize this for my wedding?",
            "Is this licensed for commercial use?",
            "The PDF won't open on my phone.",
            "Can you send me higher resolution?",
            "Do you offer this in a different color?",
            "I love this! Could I get a discount on a bundle?",
        ];
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(90));
        interval.tick().await; // skip the immediate first tick
        loop {
            interval.tick().await;
            // Re-read the secret each tick — disable immediately without restart.
            let fake_enabled = secrets::get("fake_cs_messages_enabled")
                .ok()
                .flatten()
                .map(|v| v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            if !fake_enabled {
                continue;
            }
            // Pick a topic deterministically by time so it varies.
            let idx = (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0) as usize) % topics.len();
            let payload = serde_json::json!({
                "buyer_message": topics[idx],
                "trigger": "fake_message",
            });
            if let Err(e) = queue::enqueue(&pool_for_cs, project_id, "cs", payload).await {
                tracing::warn!("fake CS message enqueue failed: {e}");
            }
        }
    });

    // Real Etsy pollers — receipts + buyer DMs. HTTP only, no token spend.
    // Pollers are always spawned alongside autonomous loops; they silently
    // no-op unless `real_etsy_enabled=true` AND OAuth is connected.
    etsy_polling::spawn_pollers(
        pool.clone(),
        project_id,
        bus,
        std::time::Duration::from_secs(60),
    );

    // SI loop — every 5 min, run the SI agent to propose one prompt tweak.
    // Gated on `si_loop_enabled` secret, re-read every tick.
    let pool_for_si = pool.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
        interval.tick().await; // skip the immediate first tick
        loop {
            interval.tick().await;
            // Re-read the secret each tick — disable immediately without restart.
            let si_enabled = secrets::get("si_loop_enabled")
                .ok()
                .flatten()
                .map(|v| v.eq_ignore_ascii_case("true"))
                .unwrap_or(false);
            if !si_enabled {
                continue;
            }
            let payload = serde_json::json!({"trigger": "loop_b"});
            if let Err(e) = queue::enqueue(&pool_for_si, project_id, "si", payload).await {
                tracing::warn!("SI loop enqueue failed: {e}");
            }
        }
    });
}

#[tauri::command]
pub async fn cmd_start_supervisor(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    let mut guard = state.supervisor_handle.lock().await;
    if guard.is_some() { return Ok(()); }

    let direct_key = secrets::get("anthropic_api_key").ok().flatten().unwrap_or_default();
    let bridge_url = secrets::get("anthropic_bridge_url").ok().flatten()
        .filter(|s| !s.is_empty());
    let bridge_key = secrets::get("anthropic_bridge_key").ok().flatten()
        .filter(|s| !s.is_empty());

    let (effective_base_url, effective_key) = match (bridge_url.as_ref(), bridge_key.as_ref()) {
        (Some(u), Some(k)) => (Some(u.clone()), k.clone()),
        _ => (None, direct_key),
    };

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
    let api_key_env: (String, String) = ("ANTHROPIC_API_KEY".into(), effective_key.clone());
    // Resolve the absolute path to the `workers/` dir. The Tauri dev binary
    // runs with CWD=src-tauri (cargo's package root), so relative
    // "workers/foo" would resolve to src-tauri/workers/foo and fail with
    // "No module named foo". Anchor to the project root instead.
    let workers_root = workers_root_path();
    let make_spec = {
        let api_key_env = api_key_env.clone();
        let effective_base_url = effective_base_url.clone();
        let workers_root = workers_root.clone();
        move |role: &str, worker_dir: &str| {
            let mut env = vec![
                api_key_env.clone(),
                ("PYTHONPATH".into(), workers_root.join(worker_dir).to_string_lossy().into_owned()),
            ];
            if let Some(ref u) = effective_base_url {
                env.push(("ANTHROPIC_BASE_URL".into(), u.clone()));
            }
            supervisor::AgentSpec {
                role: role.into(),
                program: "python3.11".into(),
                args: vec!["-m".into(), role.into()],
                env,
            }
        }
    };

    let agents = vec![
        {
            let mut env = vec![
                api_key_env.clone(),
                ("PYTHONPATH".into(), workers_root.join("hello").to_string_lossy().into_owned()),
            ];
            if let Some(ref u) = effective_base_url {
                env.push(("ANTHROPIC_BASE_URL".into(), u.clone()));
            }
            supervisor::AgentSpec {
                role: "hello".into(),
                program: "python3.11".into(),
                args: vec!["-m".into(), "hello".into()],
                env,
            }
        },
        make_spec("research", "research"),
        make_spec("orchestrator", "orchestrator"),
        make_spec("designer", "designer"),
        make_spec("listing", "listing"),
        make_spec("publisher", "publisher"),
        make_spec("cfo", "cfo"),
        make_spec("cs", "cs"),
        make_spec("si", "si"),
    ];

    let handle = supervisor::start(state.pool.clone(), state.bus.clone(), agents, state.project_id, caps)
        .await
        .map_err(|e| e.to_string())?;
    *guard = Some(handle);

    // Only spawn the autonomous loops when explicitly opted in. Default is
    // false so a fresh Start leaves the queue empty — zero spend until the
    // user enqueues a job (e.g. smoke test) or enables autonomous mode.
    let autonomous_enabled = secrets::get("autonomous_loops_enabled")
        .ok()
        .flatten()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if autonomous_enabled {
        spawn_autonomous_loops(state.pool.clone(), state.project_id, state.bus.clone());
    }

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
    // Safety check: refuse pipeline jobs when Live UI mode is on but real
    // Etsy publishing is off. This prevents silent dry-runs where the user
    // believes they are publishing but nothing reaches Etsy.
    let ui_sandbox = secrets::get("ui_sandbox_mode").ok().flatten()
        .map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let real_etsy = secrets::get("real_etsy_enabled").ok().flatten()
        .map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let smoke_active = secrets::get("smoke_cycle_id").ok().flatten()
        .filter(|s| !s.is_empty()).is_some();
    let role = args.agent_role.as_str();
    let is_pipeline_role = matches!(role, "research" | "orchestrator" | "designer" | "listing" | "publisher");
    if is_pipeline_role && !ui_sandbox && !real_etsy && !smoke_active {
        return Err("Pipeline jobs are blocked: Live mode is on but Real Etsy publishing is off. Either enable Real publishing in Settings (Etsy section) or switch to Sandbox mode.".to_string());
    }
    queue::enqueue(&state.pool, state.project_id, &args.agent_role, args.payload)
        .await
        .map_err(|e| e.to_string())
}

pub fn forward_events_to_window(app: tauri::AppHandle, bus: EventBus) {
    let mut rx = bus.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(evt) => {
                    let _ = app.emit("supervisor.event", evt);
                }
                // Receiver is behind. Re-subscribe transparently and keep going
                // — losing the entire forwarder for the session over a backlog
                // burst was the real "agents stay still" bug.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("supervisor.event forwarder lagged {n} msgs; resuming");
                    continue;
                }
                // Channel closed — no senders left. Exit the task.
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
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

    // Cancel any in-flight OAuth task so we can rebind the callback port.
    {
        let mut guard = state.oauth_task.lock().await;
        if let Some(prev) = guard.take() {
            prev.abort();
        }
    }
    // Give the previous listener a moment to fully drop before we bind.
    tokio::time::sleep(Duration::from_millis(150)).await;

    let app_state = state.inner().clone();
    let keystring_for_task = keystring;
    let app_for_task = app.clone();
    let handle = tokio::spawn(async move {
        run_oauth_flow(app_for_task, app_state, keystring_for_task, oauth_state).await;
    });
    {
        let mut guard = state.oauth_task.lock().await;
        *guard = Some(handle);
    }

    Ok(OAuthInit { authorize_url })
}

async fn run_oauth_flow(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    keystring: String,
    oauth_state: String,
) {
    let result: anyhow::Result<etsy::ShopInfo> = async {
        let cb = oauth_server::await_callback(Duration::from_secs(180)).await?;
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

/// Read the most recent OAuth failure stored by `run_oauth_flow`.
/// Returns `None` if no error is recorded (cleared on successful connect).
#[tauri::command]
pub async fn cmd_etsy_last_error() -> Result<Option<String>, String> {
    secrets::get("etsy_last_error").map_err(|e| e.to_string())
}

/// Manually clear the stored OAuth error (used by the UI "Dismiss" affordance).
#[tauri::command]
pub async fn cmd_etsy_clear_last_error() -> Result<(), String> {
    let _ = secrets::delete("etsy_last_error");
    Ok(())
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
/// `~/.agent-factory/publisher_output.json` — we walk that file to find the
/// asset_path. Returns `None` when the listing has no recorded asset.
#[tauri::command]
pub async fn cmd_read_asset_svg(listing_id: i64) -> Result<Option<String>, String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = PathBuf::from(home)
        .join(".agent-factory")
        .join("publisher_output.json");
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

/// One-shot fetch for the review modal: pulls publish row, publisher_output
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

    // 2) publisher_output.json — description, tags, niche, price_usd.
    let home = std::env::var("HOME").unwrap_or_default();
    let mock_path = PathBuf::from(&home).join(".agent-factory").join("publisher_output.json");
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

/// Start a smoke-test cycle: ensures the supervisor is running, stamps a
/// cycle id + start timestamp into secrets, then enqueues one research job
/// tagged with the cycle id. The downstream listing / publisher agents
/// follow the normal pipeline.
/// NOTE: smoke_pause_until is NOT set here — it is set by the publisher's
/// completion hook (Task 11) after the cycle has actually produced a draft.
#[tauri::command]
pub async fn cmd_start_smoke_test(
    state: State<'_, Arc<AppState>>,
) -> Result<String, String> {
    use chrono::Utc;
    // Clear any lingering pause flag from a previous cycle that timed out or
    // wasn't manually resumed — without this, enforce_caps would cap every
    // worker on SmokePause and no job would ever claim.
    let _ = secrets::delete("smoke_pause_until");
    // Force a clean supervisor restart so workers are guaranteed alive.
    // The stored handle can be stale (workers crashed but handle wasn't
    // cleared) — short-circuiting on is_some() in cmd_start_supervisor
    // would leave us with no live workers. Stop-then-start fixes both.
    cmd_stop_supervisor(state.clone()).await?;
    cmd_start_supervisor(state.clone()).await?;
    // Give the workers a moment to come up and start polling.
    tokio::time::sleep(Duration::from_millis(800)).await;
    let cycle_id = format!("smoke-{}", Utc::now().format("%Y%m%d%H%M%S"));
    secrets::set("smoke_cycle_id", &cycle_id).map_err(|e| e.to_string())?;
    let now_ts = Utc::now().timestamp().to_string();
    secrets::set("smoke_started_at", &now_ts).map_err(|e| e.to_string())?;
    // Auto-enable real Etsy publishing for this cycle so the publisher actually
    // posts a draft. Stash the prior value so Resume can restore it.
    let prior_real = secrets::get("real_etsy_enabled").ok().flatten().unwrap_or_default();
    secrets::set("pre_smoke_real_etsy_enabled", &prior_real).ok();
    secrets::set("real_etsy_enabled", "true").ok();
    // Enqueue one research job; downstream listing/publisher follow the normal pipeline.
    let payload = serde_json::json!({ "smoke": true, "cycle_id": cycle_id });
    queue::enqueue(&state.pool, state.project_id, "research", payload)
        .await
        .map_err(|e| e.to_string())?;
    Ok(cycle_id)
}

/// Lift the smoke-test pause: clears smoke_pause_until, smoke_cycle_id, and
/// smoke_started_at so that enforce_caps resumes normal cap checking.
/// Also restores the prior value of `real_etsy_enabled` that the smoke test
/// temporarily flipped on.
#[tauri::command]
pub async fn cmd_resume_from_smoke_test() -> Result<(), String> {
    secrets::delete("smoke_pause_until").map_err(|e| e.to_string())?;
    secrets::delete("smoke_cycle_id").map_err(|e| e.to_string())?;
    secrets::delete("smoke_started_at").map_err(|e| e.to_string())?;
    // Restore real_etsy_enabled to whatever it was before the smoke test.
    let prior = secrets::get("pre_smoke_real_etsy_enabled").ok().flatten().unwrap_or_default();
    if prior.is_empty() {
        let _ = secrets::delete("real_etsy_enabled");
    } else {
        let _ = secrets::set("real_etsy_enabled", &prior);
    }
    let _ = secrets::delete("pre_smoke_real_etsy_enabled");
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

// ─── Activity feed: jobs + per-job ratings ──────────────────────────────

#[derive(Serialize)]
pub struct JobRow {
    pub id: i64,
    pub agent_role: String,
    pub status: String,
    pub payload_json: String,
    pub result_json: Option<String>,
    pub error: Option<String>,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub scheduled_at: String,
    /// Operator rating ('up' | 'down'), if any.
    pub rating: Option<String>,
    pub rating_note: Option<String>,
    pub rated_at: Option<i64>,
}

/// Recent jobs for the Activity feed. Returns done/errored jobs newest-first,
/// optionally filtered by role and a `since_unix` timestamp (seconds).
/// Joined with `job_feedback` so the UI can show each row's current rating
/// in one round trip.
#[tauri::command]
pub async fn cmd_list_recent_jobs(
    state: State<'_, Arc<AppState>>,
    limit: Option<i64>,
    role: Option<String>,
    since_unix: Option<i64>,
) -> Result<Vec<JobRow>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    // Build the query with optional WHERE filters. We always restrict to
    // terminal states so the feed only shows things the operator can
    // meaningfully rate.
    let mut sql = String::from(
        "SELECT j.id, j.agent_role, j.status, j.payload_json, j.result_json, j.error, \
         j.started_at, j.finished_at, j.scheduled_at, \
         f.rating, f.note, f.created_at \
         FROM jobs j \
         LEFT JOIN job_feedback f ON f.job_id = j.id AND f.rater = 'operator' \
         WHERE j.project_id = ? AND j.status IN ('done','errored')",
    );
    if role.is_some() {
        sql.push_str(" AND j.agent_role = ?");
    }
    if since_unix.is_some() {
        sql.push_str(" AND CAST(strftime('%s', COALESCE(j.finished_at, j.scheduled_at)) AS INTEGER) >= ?");
    }
    sql.push_str(" ORDER BY j.id DESC LIMIT ?");

    let mut q = sqlx::query_as::<
        _,
        (
            i64,
            String,
            String,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            Option<i64>,
        ),
    >(&sql)
    .bind(state.project_id);
    if let Some(r) = role.as_ref() {
        q = q.bind(r);
    }
    if let Some(s) = since_unix {
        q = q.bind(s);
    }
    q = q.bind(limit);

    let rows = q.fetch_all(&state.pool).await.map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| JobRow {
            id: r.0,
            agent_role: r.1,
            status: r.2,
            payload_json: r.3,
            result_json: r.4,
            error: r.5,
            started_at: r.6,
            finished_at: r.7,
            scheduled_at: r.8,
            rating: r.9,
            rating_note: r.10,
            rated_at: r.11,
        })
        .collect())
}

#[derive(Deserialize)]
pub struct RateJobArgs {
    pub job_id: i64,
    /// "up", "down", or null to clear the rating.
    pub rating: Option<String>,
    pub note: Option<String>,
}

/// Upsert a rating on a completed job. Pass `rating: null` to clear.
/// `rater` is fixed to 'operator' for now; a future boss-agent can use a
/// different value.
#[tauri::command]
pub async fn cmd_rate_job(
    state: State<'_, Arc<AppState>>,
    args: RateJobArgs,
) -> Result<(), String> {
    let now = chrono::Utc::now().timestamp();
    match args.rating.as_deref() {
        Some("up") | Some("down") => {
            let rating = args.rating.unwrap();
            sqlx::query(
                "INSERT INTO job_feedback (job_id, rating, note, rater, created_at) \
                 VALUES (?, ?, ?, 'operator', ?) \
                 ON CONFLICT(job_id, rater) DO UPDATE SET \
                   rating = excluded.rating, note = excluded.note, created_at = excluded.created_at",
            )
            .bind(args.job_id)
            .bind(rating)
            .bind(args.note)
            .bind(now)
            .execute(&state.pool)
            .await
            .map_err(|e| e.to_string())?;
        }
        None => {
            sqlx::query("DELETE FROM job_feedback WHERE job_id = ? AND rater = 'operator'")
                .bind(args.job_id)
                .execute(&state.pool)
                .await
                .map_err(|e| e.to_string())?;
        }
        Some(other) => return Err(format!("invalid rating '{other}' — must be 'up' or 'down'")),
    }
    Ok(())
}

/// Read the SVG asset produced by a designer job, looked up by job id.
/// The designer worker stores the path in its result JSON at
/// `asset.asset_path` and (for top-level publisher handoffs) `asset_path`.
/// Returns `None` if the job has no recorded asset, the file is missing,
/// or the job isn't a designer/publisher one.
#[tauri::command]
pub async fn cmd_read_job_svg(
    state: State<'_, Arc<AppState>>,
    job_id: i64,
) -> Result<Option<String>, String> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT result_json FROM jobs WHERE id = ? AND project_id = ?",
    )
    .bind(job_id)
    .bind(state.project_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    let Some((Some(result_json),)) = row else { return Ok(None) };
    let value: serde_json::Value = match serde_json::from_str(&result_json) {
        Ok(v) => v,
        Err(_) => return Ok(None),
    };
    let path = value
        .get("asset")
        .and_then(|a| a.get("asset_path"))
        .and_then(|v| v.as_str())
        .or_else(|| value.get("asset_path").and_then(|v| v.as_str()));
    let Some(path) = path else { return Ok(None) };
    match std::fs::read_to_string(path) {
        Ok(svg) => Ok(Some(svg)),
        Err(_) => Ok(None),
    }
}

/// Count of jobs in the last 24 h that don't yet have an operator rating —
/// used by the CommandRail badge to nudge the boss to review new outputs.
#[tauri::command]
pub async fn cmd_unrated_job_count(state: State<'_, Arc<AppState>>) -> Result<i64, String> {
    let cutoff = chrono::Utc::now().timestamp() - 24 * 3600;
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM jobs j \
         LEFT JOIN job_feedback f ON f.job_id = j.id AND f.rater = 'operator' \
         WHERE j.project_id = ? AND j.status IN ('done','errored') \
         AND CAST(strftime('%s', COALESCE(j.finished_at, j.scheduled_at)) AS INTEGER) >= ? \
         AND f.id IS NULL",
    )
    .bind(state.project_id)
    .bind(cutoff)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(count)
}
