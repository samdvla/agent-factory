use crate::{etsy, etsy_publish, events::{EventBus, SupervisorEvent}, oauth_server, queue, secrets, supervisor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::collections::HashMap;
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
    let daily_cap_usd: f64 = secrets::get("daily_budget_usd")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(1.00);
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

    let handle = supervisor::start(state.pool.clone(), state.bus.clone(), agents, state.project_id, daily_cap_usd)
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
