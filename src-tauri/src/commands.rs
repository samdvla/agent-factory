use crate::{events::EventBus, queue, secrets, supervisor};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::SqlitePool;
use std::sync::Arc;
use tauri::{Emitter, State};
use tokio::sync::Mutex;

pub struct AppState {
    pub pool: SqlitePool,
    pub bus: EventBus,
    pub project_id: i64,
    pub supervisor_handle: Mutex<Option<supervisor::SupervisorHandle>>,
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

    let handle = supervisor::start(state.pool.clone(), state.bus.clone(), agents, state.project_id)
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
