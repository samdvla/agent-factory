use crate::{etsy, events::EventBus, oauth_server, queue, secrets, supervisor};
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
