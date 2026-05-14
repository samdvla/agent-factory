use crate::{budget, etsy, etsy_polling, etsy_publish, events::{EventBus, SupervisorEvent}, oauth_server, pnl, printify, prompts, queue, secrets, supervisor};
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

    // Strategist loop — every 15 min, ALTERNATE between tuning the designer
    // (system_override) and tuning the orchestrator (strategist_notes).
    // Even ticks → designer; odd ticks → orchestrator. Each role sees a
    // refresh every 30 min, total spend unchanged from the single-target
    // schedule. Gated on `strategist_loop_enabled` secret (default true).
    let pool_for_strategist = pool.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(180)).await;
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(900));
        interval.tick().await; // skip the immediate first tick
        let mut tick: u64 = 0;
        loop {
            interval.tick().await;
            let enabled = secrets::get("strategist_loop_enabled")
                .ok()
                .flatten()
                .map(|v| v.eq_ignore_ascii_case("true"))
                .unwrap_or(true); // default on — see project_north_star
            if !enabled {
                continue;
            }
            let target = if tick % 2 == 0 { "designer" } else { "orchestrator" };
            let payload = serde_json::json!({
                "trigger": "strategist_loop",
                "target": target,
            });
            if let Err(e) = queue::enqueue(&pool_for_strategist, project_id, "strategist", payload).await {
                tracing::warn!("strategist loop enqueue failed: {e}");
            }
            tick = tick.wrapping_add(1);
        }
    });
}

#[derive(Serialize)]
pub struct PrintifyVerifyOk {
    pub shop_id: i64,
    pub shop_title: String,
    pub channel: String,
}

/// Verify the Printify Personal Access Token by listing connected shops. On
/// success, persist the picked Etsy shop's id so the rest of the pipeline can
/// publish without re-discovery. Returns the shop info for UI display.
#[tauri::command]
pub async fn cmd_printify_verify(api_key: String) -> Result<PrintifyVerifyOk, String> {
    if api_key.trim().is_empty() {
        return Err("Printify API key is empty".to_string());
    }
    let shops = printify::list_shops(&api_key)
        .await
        .map_err(|e| format!("Printify verify failed: {e}"))?;
    if shops.is_empty() {
        return Err("Printify account has no connected shops — connect SabiWabiGifts in the Printify dashboard first.".to_string());
    }
    let etsy = printify::pick_etsy_shop(&shops)
        .ok_or_else(|| format!(
            "No Etsy shop connected to this Printify account. Found: {}",
            shops.iter().map(|s| format!("{} ({})", s.title, s.sales_channel)).collect::<Vec<_>>().join(", ")
        ))?;
    // Persist the discovered shop_id so workers can use it without re-listing.
    secrets::set("printify_api_key", &api_key)
        .map_err(|e| format!("save printify_api_key: {e}"))?;
    secrets::set("printify_shop_id", &etsy.id.to_string())
        .map_err(|e| format!("save printify_shop_id: {e}"))?;
    Ok(PrintifyVerifyOk {
        shop_id: etsy.id,
        shop_title: etsy.title.clone(),
        channel: etsy.sales_channel.clone(),
    })
}

#[derive(Serialize)]
pub struct PrintifyStatus {
    pub key_present: bool,
    pub shop_id: Option<i64>,
    pub pod_enabled: bool,
}

#[derive(Serialize)]
pub struct TripoStatus {
    pub key_present: bool,
    pub balance: Option<i64>,
}

#[derive(Serialize)]
pub struct TripoVerifyOk {
    pub balance: i64,
}

/// Verify the Tripo API key by calling the user-balance endpoint. On success
/// persists the key + caches the most recent balance so the UI can show
/// remaining credits.
#[tauri::command]
pub async fn cmd_tripo_verify(api_key: String) -> Result<TripoVerifyOk, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Tripo API key is empty".to_string());
    }
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.tripo3d.ai/v2/openapi/user/balance")
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| format!("Tripo verify network error: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Tripo verify HTTP {status}: {body}"));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Tripo verify parse: {e}: {body}"))?;
    if parsed.get("code").and_then(|c| c.as_i64()) != Some(0) {
        return Err(format!("Tripo verify returned non-zero code: {body}"));
    }
    let balance = parsed
        .get("data")
        .and_then(|d| d.get("balance"))
        .and_then(|b| b.as_i64())
        .unwrap_or(0);
    secrets::set("tripo_api_key", key).map_err(|e| format!("save tripo_api_key: {e}"))?;
    let _ = secrets::set("tripo_last_balance", &balance.to_string());
    Ok(TripoVerifyOk { balance })
}

#[derive(Serialize)]
pub struct MeshyStatus {
    pub key_present: bool,
    pub balance: Option<i64>,
}

#[derive(Serialize)]
pub struct MeshyVerifyOk {
    pub balance: i64,
}

/// Verify the Meshy API key by calling the user-balance endpoint. On success
/// persists the key + caches the most recent balance.
#[tauri::command]
pub async fn cmd_meshy_verify(api_key: String) -> Result<MeshyVerifyOk, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Meshy API key is empty".to_string());
    }
    let client = reqwest::Client::new();
    let resp = client
        .get("https://api.meshy.ai/openapi/v1/balance")
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| format!("Meshy verify network error: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Meshy verify HTTP {status}: {body}"));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("Meshy verify parse: {e}: {body}"))?;
    // Meshy returns {"balance": N} at the top level on v1, or {"data": {"balance": N}} on some
    // tenants. Accept either.
    let balance = parsed
        .get("balance")
        .and_then(|b| b.as_i64())
        .or_else(|| parsed.get("data").and_then(|d| d.get("balance")).and_then(|b| b.as_i64()))
        .unwrap_or(0);
    secrets::set("meshy_api_key", key).map_err(|e| format!("save meshy_api_key: {e}"))?;
    let _ = secrets::set("meshy_last_balance", &balance.to_string());
    Ok(MeshyVerifyOk { balance })
}

#[tauri::command]
pub async fn cmd_meshy_status() -> Result<MeshyStatus, String> {
    let key_present = secrets::get("meshy_api_key")
        .ok()
        .flatten()
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    let balance = secrets::get("meshy_last_balance")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok());
    Ok(MeshyStatus { key_present, balance })
}

#[tauri::command]
pub async fn cmd_tripo_status() -> Result<TripoStatus, String> {
    let key_present = secrets::get("tripo_api_key")
        .ok()
        .flatten()
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    let balance = secrets::get("tripo_last_balance")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok());
    Ok(TripoStatus { key_present, balance })
}

// ─── Google AI (nanobanana / Gemini 2.5 Flash Image) ─────────────────────

#[derive(Serialize)]
pub struct GoogleAiStatus {
    pub key_present: bool,
}

#[derive(Serialize)]
pub struct GoogleAiVerifyOk {
    pub model: String,
}

/// Verify the Google API key by calling Gemini 2.5 Flash Image with a tiny
/// image-generation request. On success persists the key. Failure surfaces
/// the upstream HTTP body so quota / billing / safety errors are legible.
#[tauri::command]
pub async fn cmd_google_verify(api_key: String) -> Result<GoogleAiVerifyOk, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err("Google API key is empty".to_string());
    }
    let model = "gemini-2.5-flash-image";
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    );
    let body = serde_json::json!({
        "contents": [{"role": "user", "parts": [{"text": "a small red circle"}]}],
        "generationConfig": {
            "responseModalities": ["IMAGE"],
            "imageConfig": {"aspectRatio": "1:1"}
        }
    });
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("x-goog-api-key", key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Google verify network error: {e}"))?;
    let status = resp.status();
    let raw = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Google verify HTTP {status}: {raw}"));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("Google verify parse: {e}: {raw}"))?;
    if parsed.get("candidates").and_then(|c| c.as_array()).map(|a| a.is_empty()).unwrap_or(true) {
        return Err(format!("Google verify returned no candidates: {raw}"));
    }
    secrets::set("google_api_key", key).map_err(|e| format!("save google_api_key: {e}"))?;
    Ok(GoogleAiVerifyOk { model: model.into() })
}

#[tauri::command]
pub async fn cmd_google_status() -> Result<GoogleAiStatus, String> {
    let key_present = secrets::get("google_api_key")
        .ok()
        .flatten()
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    Ok(GoogleAiStatus { key_present })
}

/// Report current Printify config without exposing the PAT itself.
#[tauri::command]
pub async fn cmd_printify_status() -> Result<PrintifyStatus, String> {
    let key_present = secrets::get("printify_api_key")
        .ok()
        .flatten()
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    let shop_id = secrets::get("printify_shop_id")
        .ok()
        .flatten()
        .and_then(|s| s.parse::<i64>().ok());
    let pod_enabled = secrets::get("pod_enabled")
        .ok()
        .flatten()
        .map(|v| v == "true")
        .unwrap_or(false);
    Ok(PrintifyStatus { key_present, shop_id, pod_enabled })
}

#[tauri::command]
pub async fn cmd_start_supervisor(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    start_supervisor_with_state(Arc::clone(&*state)).await
}

/// Headless / autostart entry point: lib.rs setup calls this when
/// AGENT_FACTORY_AUTOSTART (or --autostart) is set on the mini server.
/// Same logic as cmd_start_supervisor; that command now thin-wraps this.
pub async fn start_supervisor_with_state(state: Arc<AppState>) -> Result<(), String> {
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
    // Shop focus — single source of truth for what kind of product mix the
    // pipeline should pursue. "3d_only" makes orchestrator rotate ONLY between
    // stl_file / 3d_model; "2d_only" reverts to the original 2D rotation;
    // "mixed" includes 3D when keys are present. Default 3d_only — the user
    // pivoted the shop to 3D after seeing Tripo's quality.
    let shop_focus = secrets::get("shop_focus")
        .ok()
        .flatten()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "3d_only".into());
    let shop_focus_env: (String, String) = ("SHOP_FOCUS".into(), shop_focus.clone());

    // Character pool — which archetype tiers the orchestrator + research
    // are allowed to mine. Default `all` (user explicitly wants the full
    // spectrum). High-IP content still gates at publish time.
    let character_pool = secrets::get("character_pool")
        .ok()
        .flatten()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "all".into());
    let character_pool_env: (String, String) =
        ("CHARACTER_POOL".into(), character_pool.clone());

    // Image-to-3D provider — user wants Tripo by default with Meshy as a
    // swap-in. The designer reads this when routing nanobanana renders to
    // a 3D backend. Text-to-3D continues to use the meshy → tripo fallback
    // chain (this setting does not affect that path).
    let image_to_3d_provider = secrets::get("image_to_3d_provider")
        .ok()
        .flatten()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "tripo".into());
    let image_to_3d_env: (String, String) = (
        "IMAGE_TO_3D_PROVIDER".into(),
        image_to_3d_provider.clone(),
    );

    // 3D generation providers (text-to-3D) — optional. When either is
    // present, orchestrator rotates stl_file / 3d_model into the product mix
    // and designer routes 3D briefs to Meshy (preferred) or Tripo.
    let meshy_key = secrets::get("meshy_api_key").ok().flatten().unwrap_or_default();
    let meshy_env: Option<(String, String)> = if meshy_key.is_empty() {
        None
    } else {
        Some(("MESHY_API_KEY".into(), meshy_key))
    };
    let tripo_key = secrets::get("tripo_api_key").ok().flatten().unwrap_or_default();
    let tripo_env: Option<(String, String)> = if tripo_key.is_empty() {
        None
    } else {
        Some(("TRIPO_API_KEY".into(), tripo_key))
    };
    // Google API key — formerly used by nanobanana for direct Gemini 2.5
    // Flash Image calls. Designer was migrated to Higgsfield CLI's
    // nano_banana_pro, so the worker no longer reads GOOGLE_API_KEY. The
    // env var is still injected here in case any other path (or future
    // worker) wants it; the Settings UI verify panel also remains
    // functional for users who want to keep a Google key configured.
    let google_key = secrets::get("google_api_key").ok().flatten().unwrap_or_default();
    let google_env: Option<(String, String)> = if google_key.is_empty() {
        None
    } else {
        Some(("GOOGLE_API_KEY".into(), google_key))
    };
    // Direct Google AI Studio image-generation key. When set, the
    // designer's nanobanana dispatcher prefers the direct Gemini path
    // (gemini-3.1-flash-image-preview at ~$0.067/image) over the
    // Higgsfield CLI's nano_banana_pro bundle. This is the cheapest
    // route once a Higgsfield plan is depleted. Key lives in secrets
    // under `gemini_image_api_key`; get one at
    // https://aistudio.google.com/apikey.
    let gemini_image_key = secrets::get("gemini_image_api_key")
        .ok().flatten().unwrap_or_default();
    let gemini_image_env: Option<(String, String)> = if gemini_image_key.is_empty() {
        None
    } else {
        Some(("GEMINI_IMAGE_API_KEY".into(), gemini_image_key))
    };
    // YouTube Data API key — used by research's trends fetcher for the
    // YouTube trending source. Optional: if missing, research skips
    // YouTube but still hits Reddit + Google Trends.
    let youtube_key = secrets::get("youtube_api_key").ok().flatten().unwrap_or_default();
    let youtube_env: Option<(String, String)> = if youtube_key.is_empty() {
        None
    } else {
        Some(("YOUTUBE_API_KEY".into(), youtube_key))
    };
    // Higgsfield product-photoshoot enhancement — designer reads this env
    // var to decide whether to upgrade preview.png through Higgsfield.
    // Auth + CLI install are managed externally (CLI's own credential
    // cache); we only carry the on/off flag.
    let higgsfield_enabled = secrets::get("higgsfield_enabled")
        .ok()
        .flatten()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let higgsfield_env: (String, String) = (
        "HIGGSFIELD_ENABLED".into(),
        if higgsfield_enabled { "true".into() } else { "false".into() },
    );
    // UI sandbox mode — workers read this to decide whether simulated
    // signals (CFO buyer panel) are allowed. In Live mode this is "false"
    // and any worker that would otherwise invent revenue/sales numbers
    // emits a real zero instead, so the topbar Revenue/Net only counts
    // actual Etsy receipts. Re-snapshotted at supervisor start; toggling
    // the UI mode without restarting the supervisor keeps the previous
    // value (same coarse contract as the other env flags above).
    let ui_sandbox_value = secrets::get("ui_sandbox_mode").ok().flatten()
        .map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let ui_sandbox_env: (String, String) = (
        "UI_SANDBOX_MODE".into(),
        if ui_sandbox_value { "true".into() } else { "false".into() },
    );
    // Resolve the absolute path to the `workers/` dir. The Tauri dev binary
    // runs with CWD=src-tauri (cargo's package root), so relative
    // "workers/foo" would resolve to src-tauri/workers/foo and fail with
    // "No module named foo". Anchor to the project root instead.
    let workers_root = workers_root_path();
    let make_spec = {
        let api_key_env = api_key_env.clone();
        let effective_base_url = effective_base_url.clone();
        let workers_root = workers_root.clone();
        let meshy_env = meshy_env.clone();
        let tripo_env = tripo_env.clone();
        let google_env = google_env.clone();
        let gemini_image_env = gemini_image_env.clone();
        let youtube_env = youtube_env.clone();
        let higgsfield_env = higgsfield_env.clone();
        let shop_focus_env = shop_focus_env.clone();
        let character_pool_env = character_pool_env.clone();
        let image_to_3d_env = image_to_3d_env.clone();
        let ui_sandbox_env = ui_sandbox_env.clone();
        move |role: &str, worker_dir: &str| {
            let mut env = vec![
                api_key_env.clone(),
                shop_focus_env.clone(),
                character_pool_env.clone(),
                image_to_3d_env.clone(),
                ui_sandbox_env.clone(),
                ("PYTHONPATH".into(), workers_root.join(worker_dir).to_string_lossy().into_owned()),
            ];
            if let Some(ref u) = effective_base_url {
                env.push(("ANTHROPIC_BASE_URL".into(), u.clone()));
            }
            if let Some(ref m) = meshy_env {
                env.push(m.clone());
            }
            if let Some(ref t) = tripo_env {
                env.push(t.clone());
            }
            if let Some(ref g) = google_env {
                env.push(g.clone());
            }
            if let Some(ref gi) = gemini_image_env {
                env.push(gi.clone());
            }
            if let Some(ref y) = youtube_env {
                env.push(y.clone());
            }
            env.push(higgsfield_env.clone());
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
        make_spec("strategist", "strategist"),
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
                    let _ = app.emit("supervisor:event", &evt);
                }
                // Receiver is behind — keep the forwarder alive; losing it over
                // a backlog burst was the original "agents stay still" bug.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
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
    pub parent_listing_id: Option<i64>,
}

#[tauri::command]
pub async fn cmd_etsy_list_publishes(
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<EtsyPublishRow>, String> {
    let rows = sqlx::query_as::<
        _,
        (i64, i64, i64, String, String, Option<String>, i64, Option<i64>, Option<i64>),
    >(
        "SELECT id, local_listing_id, etsy_listing_id, state, title, url, published_at, activated_at, parent_listing_id \
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
            parent_listing_id: r.8,
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
    // The keystring isn't passed through anymore — etsy::api_key_header() reads
    // it (plus etsy_shared_secret) from the keychain inside every request — but
    // we still surface a missing key here so the UI gets a clear error.
    if secrets::get("etsy_api_keystring")
        .map_err(|e| e.to_string())?
        .map(|k| k.is_empty())
        .unwrap_or(true)
    {
        return Err("etsy_api_keystring not in keychain".into());
    }

    let client = reqwest::Client::new();
    etsy_publish::activate_listing(&client, shop_id, etsy_listing_id)
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

#[derive(Serialize, Default, Clone)]
pub struct MarketplaceResyncStats {
    pub checked: i64,
    /// Listings the marketplace returned 404 for — we mark these
    /// `expired` locally. The Etsy panel tabs already hide that state;
    /// other marketplaces will too once the panel re-fetches.
    pub expired: i64,
    /// Listings whose remote state differed from ours; we updated the
    /// local row to match. Currently only set by Etsy (the only
    /// marketplace where we read remote state out of the API response).
    pub updated_state: i64,
    pub unchanged: i64,
    pub errors: i64,
}

#[derive(Serialize, Default)]
pub struct ResyncAllResult {
    pub etsy: MarketplaceResyncStats,
    pub cults3d: MarketplaceResyncStats,
    pub sketchfab: MarketplaceResyncStats,
    pub mmf: MarketplaceResyncStats,
    pub gumroad: MarketplaceResyncStats,
    pub pinterest: MarketplaceResyncStats,
}

/// Generic URL-existence check across any of our marketplace tables.
/// Used for every marketplace where listings live at a stable public URL
/// (Cults3D, Sketchfab, MMF, Gumroad, Pinterest). Etsy needs API-based
/// resync instead because drafts aren't publicly visible.
///
/// `table` and `url_col` are hardcoded callers — never user-provided — so
/// the runtime-formatted SQL is safe from injection.
async fn resync_via_public_url(
    client: &reqwest::Client,
    pool: &sqlx::SqlitePool,
    project_id: i64,
    table: &'static str,
    url_col: &'static str,
) -> MarketplaceResyncStats {
    let mut stats = MarketplaceResyncStats::default();
    let select_sql = format!(
        "SELECT id, {url_col}, state FROM {table} WHERE project_id = ?"
    );
    let update_sql = format!("UPDATE {table} SET state = 'expired' WHERE id = ?");

    let rows: Vec<(i64, Option<String>, String)> =
        match sqlx::query_as(&select_sql).bind(project_id).fetch_all(pool).await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("resync {table}: SELECT failed: {e}");
                return stats;
            }
        };

    for (id, url_opt, state) in rows {
        stats.checked += 1;
        // 'expired' rows stay parked — we don't bother re-checking them.
        if state == "expired" {
            stats.unchanged += 1;
            continue;
        }
        // Rows that never got a public URL recorded (pending / errored
        // publishes) are skipped — there's nothing to check against.
        let Some(url) = url_opt.filter(|u| !u.is_empty()) else {
            stats.unchanged += 1;
            continue;
        };
        let resp = match client.get(&url).send().await {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("resync {table}: GET {url} failed: {e}");
                stats.errors += 1;
                continue;
            }
        };
        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            if let Err(e) = sqlx::query(&update_sql)
                .bind(id)
                .execute(pool)
                .await
            {
                tracing::warn!("resync {table}: UPDATE expired failed for id={id}: {e}");
                stats.errors += 1;
                continue;
            }
            stats.expired += 1;
        } else {
            stats.unchanged += 1;
        }
    }
    stats
}

/// Resync every marketplace in one shot. Etsy uses its API to detect
/// pruned drafts (which aren't publicly addressable); the others use a
/// plain HTTP GET to the stored public listing URL and mark 404s as
/// expired. Returns per-marketplace stats so the UI can render a single
/// "Synced N listings: X expired" line.
#[tauri::command]
pub async fn cmd_resync_all_marketplaces(
    state: State<'_, Arc<AppState>>,
) -> Result<ResyncAllResult, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| e.to_string())?;

    let mut result = ResyncAllResult::default();

    // Etsy — API-based. Best effort: failures here don't sink the rest.
    match etsy_resync_inner(&state, &client).await {
        Ok(s) => result.etsy = s,
        Err(e) => {
            tracing::warn!("resync etsy failed: {e}");
            result.etsy.errors = 1;
        }
    }

    // The remaining marketplaces share the URL-existence path.
    result.cults3d =
        resync_via_public_url(&client, &state.pool, state.project_id, "cults3d_publishes", "url")
            .await;
    result.sketchfab = resync_via_public_url(
        &client,
        &state.pool,
        state.project_id,
        "sketchfab_publishes",
        "url",
    )
    .await;
    result.mmf =
        resync_via_public_url(&client, &state.pool, state.project_id, "mmf_publishes", "url")
            .await;
    result.gumroad = resync_via_public_url(
        &client,
        &state.pool,
        state.project_id,
        "gumroad_publishes",
        "short_url",
    )
    .await;
    result.pinterest = resync_via_public_url(
        &client,
        &state.pool,
        state.project_id,
        "pinterest_pins",
        "url",
    )
    .await;

    // Single refresh signal so the Etsy panel re-reads (other panels poll
    // every 15s, so they'll pick up changes naturally).
    let etsy_changed = result.etsy.expired + result.etsy.updated_state;
    if etsy_changed > 0 {
        state.bus.send(SupervisorEvent::EtsyDraftRestored {
            local_listing_id: 0,
        });
    }

    Ok(result)
}

/// Etsy's resync path, factored out so cmd_resync_all_marketplaces can
/// call it without going through Tauri's command frame.
async fn etsy_resync_inner(
    state: &State<'_, Arc<AppState>>,
    client: &reqwest::Client,
) -> Result<MarketplaceResyncStats, String> {
    let etsy_status = etsy::load_status();
    if !etsy_status.connected {
        return Err("Etsy not connected".into());
    }
    let shop_id = etsy_status
        .shop_id
        .ok_or_else(|| "shop_id missing — reconnect Etsy".to_string())?;
    if secrets::get("etsy_api_keystring")
        .map_err(|e| e.to_string())?
        .map(|k| k.is_empty())
        .unwrap_or(true)
    {
        return Err("etsy_api_keystring not in keychain".into());
    }

    let rows: Vec<(i64, i64, String)> = sqlx::query_as(
        "SELECT local_listing_id, etsy_listing_id, state FROM etsy_publishes \
         WHERE project_id = ?",
    )
    .bind(state.project_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    let access_token = etsy::ensure_fresh_token(client)
        .await
        .map_err(|e| format!("{e:#}"))?;
    let api_key = etsy::api_key_header().map_err(|e| e.to_string())?;

    let mut result = MarketplaceResyncStats::default();

    for (local_id, etsy_id, local_state) in rows {
        result.checked += 1;
        let url = format!(
            "{}/shops/{}/listings/{}",
            etsy::API_BASE,
            shop_id,
            etsy_id
        );
        let resp = match client
            .get(&url)
            .bearer_auth(&access_token)
            .header("x-api-key", &api_key)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("etsy resync GET failed for {etsy_id}: {e}");
                result.errors += 1;
                continue;
            }
        };
        let status_code = resp.status();
        if status_code == reqwest::StatusCode::NOT_FOUND {
            if local_state == "expired" {
                result.unchanged += 1;
                continue;
            }
            if let Err(e) = sqlx::query(
                "UPDATE etsy_publishes SET state = 'expired' \
                 WHERE project_id = ? AND local_listing_id = ?",
            )
            .bind(state.project_id)
            .bind(local_id)
            .execute(&state.pool)
            .await
            {
                tracing::warn!("etsy resync UPDATE expired failed for {local_id}: {e}");
                result.errors += 1;
                continue;
            }
            result.expired += 1;
            continue;
        }
        if !status_code.is_success() {
            tracing::warn!(
                "etsy resync GET HTTP {} for listing {}",
                status_code, etsy_id
            );
            result.errors += 1;
            continue;
        }
        let body: serde_json::Value = match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("etsy resync parse JSON failed for {etsy_id}: {e}");
                result.errors += 1;
                continue;
            }
        };
        let remote_state = body
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("draft");
        if remote_state == local_state {
            result.unchanged += 1;
            continue;
        }
        if let Err(e) = sqlx::query(
            "UPDATE etsy_publishes SET state = ? \
             WHERE project_id = ? AND local_listing_id = ?",
        )
        .bind(remote_state)
        .bind(state.project_id)
        .bind(local_id)
        .execute(&state.pool)
        .await
        {
            tracing::warn!("etsy resync UPDATE state failed for {local_id}: {e}");
            result.errors += 1;
            continue;
        }
        result.updated_state += 1;
    }

    Ok(result)
}

/// Thin wrapper so the existing per-Etsy resync button keeps working.
#[tauri::command]
pub async fn cmd_etsy_resync_listings(
    state: State<'_, Arc<AppState>>,
) -> Result<MarketplaceResyncStats, String> {
    let client = reqwest::Client::new();
    let r = etsy_resync_inner(&state, &client).await?;
    if r.expired + r.updated_state > 0 {
        state.bus.send(SupervisorEvent::EtsyDraftRestored {
            local_listing_id: 0,
        });
    }
    Ok(r)
}

/// Resync a single marketplace. The frontend calls this per-panel from a
/// "Sync with <marketplace>" button. Dispatches by name — same helpers
/// the resync-all command uses. Etsy uses its API path; everything else
/// uses public URL existence checks.
#[tauri::command]
pub async fn cmd_resync_marketplace(
    state: State<'_, Arc<AppState>>,
    marketplace: String,
) -> Result<MarketplaceResyncStats, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(3))
        .build()
        .map_err(|e| e.to_string())?;
    let stats = match marketplace.as_str() {
        "etsy" => {
            let r = etsy_resync_inner(&state, &client).await?;
            if r.expired + r.updated_state > 0 {
                state.bus.send(SupervisorEvent::EtsyDraftRestored {
                    local_listing_id: 0,
                });
            }
            r
        }
        "cults3d" => {
            resync_via_public_url(
                &client,
                &state.pool,
                state.project_id,
                "cults3d_publishes",
                "url",
            )
            .await
        }
        "sketchfab" => {
            resync_via_public_url(
                &client,
                &state.pool,
                state.project_id,
                "sketchfab_publishes",
                "url",
            )
            .await
        }
        "mmf" => {
            resync_via_public_url(
                &client,
                &state.pool,
                state.project_id,
                "mmf_publishes",
                "url",
            )
            .await
        }
        "gumroad" => {
            resync_via_public_url(
                &client,
                &state.pool,
                state.project_id,
                "gumroad_publishes",
                "short_url",
            )
            .await
        }
        "pinterest" => {
            resync_via_public_url(
                &client,
                &state.pool,
                state.project_id,
                "pinterest_pins",
                "url",
            )
            .await
        }
        other => return Err(format!("unknown marketplace: {other}")),
    };
    Ok(stats)
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

// ---------- Operator steering ----------
//
// Operator-driven standing instructions, layered on top of whatever
// `system_override` the strategist last wrote. The four LLM-driven roles
// (research, designer, listing, cs) read these at job time and append them
// to their system prompt; non-LLM agents (orchestrator, cfo, etc.) ignore
// them. The ChatPanel hides the Steer button for ignored roles, so this is
// never exposed to the operator as a dead-end action.

/// Roles that actually honor operator steers. Mirrors `prompts::ROLES` but
/// re-exported as a Vec so the frontend can ask whether to show the Steer
/// button for a given agentId.
#[tauri::command]
pub async fn cmd_agent_steer_roles() -> Result<Vec<String>, String> {
    Ok(prompts::ROLES.iter().map(|s| s.to_string()).collect())
}

#[derive(Deserialize)]
pub struct AgentSteerAddArgs {
    pub role: String,
    pub text: String,
    /// Absolute paths to reference images previously saved via
    /// `cmd_agent_steer_save_image`. Empty / omitted for text-only steers.
    #[serde(default)]
    pub image_paths: Vec<String>,
}

#[tauri::command]
pub async fn cmd_agent_steer_add(args: AgentSteerAddArgs) -> Result<(), String> {
    prompts::add_operator_steer(&args.role, &args.text, args.image_paths)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_agent_steer_list(role: String) -> Result<Vec<prompts::SteerEntry>, String> {
    Ok(prompts::list_operator_steers(&role))
}

#[tauri::command]
pub async fn cmd_agent_steer_clear(role: String) -> Result<(), String> {
    prompts::clear_operator_steers(&role).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
pub struct AgentSteerSaveImageArgs {
    pub role: String,
    /// Raw image bytes; the frontend reads the file (or clipboard image)
    /// and passes them as a byte array. We never accept a path here — the
    /// sandbox should be the only writer to steer-assets/.
    pub bytes: Vec<u8>,
    /// File extension without the dot: "png" / "jpg" / "webp" / "gif".
    pub ext: String,
}

/// Save reference image bytes under `~/.agent-factory/steer-assets/<role>/`
/// and return the absolute path. The ChatPanel passes this path back to
/// `cmd_agent_steer_add` so the new steer carries a stable on-disk reference.
/// Validation (size, extension allowlist, per-role ROLES check) lives in
/// `prompts::save_steer_image`.
#[tauri::command]
pub async fn cmd_agent_steer_save_image(
    args: AgentSteerSaveImageArgs,
) -> Result<String, String> {
    let path = prompts::save_steer_image(&args.role, &args.bytes, &args.ext)
        .map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
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

/// Legacy alias for cmd_etsy_regenerate_draft. The Discard button was
/// renamed to Regenerate when the Queue tab was introduced — this entry
/// stays so external tooling that still calls the old name keeps working.
#[tauri::command]
pub async fn cmd_etsy_discard_draft(
    state: State<'_, Arc<AppState>>,
    local_listing_id: i64,
) -> Result<(), String> {
    cmd_etsy_regenerate_draft(state, local_listing_id).await
}

/// Regenerate: move the draft into the Queue tab (state='queued') and
/// enqueue an orchestrator job that will produce a successor draft using
/// this listing as feedback. We keep the row so the Queue tab can show
/// lineage until the successor is activated.
#[tauri::command]
pub async fn cmd_etsy_regenerate_draft(
    state: State<'_, Arc<AppState>>,
    local_listing_id: i64,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE etsy_publishes SET state = 'queued' \
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
        serde_json::json!({
            "trigger": "regenerate",
            "regenerate_from": local_listing_id,
        }),
    )
    .await
    .map_err(|e| e.to_string())?;
    state
        .bus
        .send(SupervisorEvent::EtsyDraftRegenerated { local_listing_id });
    Ok(())
}

#[derive(Serialize, sqlx::FromRow)]
pub struct ListingRejectionRow {
    pub id: i64,
    pub local_listing_id: i64,
    pub cycle_id: Option<String>,
    pub title: String,
    pub niche: Option<String>,
    /// JSON array of tag strings (as stored).
    pub tags_json: String,
    pub description: String,
    /// Unix millis.
    pub rejected_at: i64,
    pub reason: Option<String>,
}

/// Reject: transition the draft to 'rejected', persist a learning record,
/// snapshot the recent rejections to ~/.agent-factory/rejections.json so the
/// Python research worker can inject an "Avoid:" block into its system
/// prompt, and emit a refresh event.
#[tauri::command]
pub async fn cmd_etsy_reject_draft(
    state: State<'_, Arc<AppState>>,
    local_listing_id: i64,
    reason: Option<String>,
) -> Result<(), String> {
    // Pull the metadata we need for the learning record. Title comes from the
    // publish row; description / tags / niche / cycle_id come from the same
    // sources cmd_etsy_listing_review_info reads.
    let title: String = sqlx::query_scalar(
        "SELECT title FROM etsy_publishes \
         WHERE project_id = ? AND local_listing_id = ? \
         ORDER BY id DESC LIMIT 1",
    )
    .bind(state.project_id)
    .bind(local_listing_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?
    .unwrap_or_default();

    // publisher_output.json: description, tags, niche.
    let home = std::env::var("HOME").unwrap_or_default();
    let pub_path = PathBuf::from(&home).join(".agent-factory").join("publisher_output.json");
    let mut description = String::new();
    let mut tags: Vec<String> = Vec::new();
    let mut niche: Option<String> = None;
    if let Ok(text) = std::fs::read_to_string(&pub_path) {
        if let Ok(records) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(arr) = records.as_array() {
                if let Some(rec) = arr.iter().rev().find(|r| {
                    r.get("listing_id").and_then(|v| v.as_i64()) == Some(local_listing_id)
                }) {
                    description = rec
                        .get("description")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    tags = rec
                        .get("tags")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|t| t.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default();
                    niche = rec.get("niche").and_then(|v| v.as_str()).map(String::from);
                }
            }
        }
    }

    // cycle_id from pipeline_cycles (if any).
    let cycle_id: Option<String> = sqlx::query_scalar(
        "SELECT cycle_id FROM pipeline_cycles \
         WHERE project_id = ? AND local_listing_id = ? \
         ORDER BY started_at DESC LIMIT 1",
    )
    .bind(state.project_id)
    .bind(local_listing_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    let rejected_at = chrono::Utc::now().timestamp_millis();
    let tags_json = serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into());

    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query(
        "UPDATE etsy_publishes SET state = 'rejected' \
         WHERE project_id = ? AND local_listing_id = ?",
    )
    .bind(state.project_id)
    .bind(local_listing_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query(
        "INSERT INTO listing_rejections \
         (project_id, local_listing_id, cycle_id, title, niche, tags_json, description, rejected_at, reason) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(state.project_id)
    .bind(local_listing_id)
    .bind(cycle_id.as_deref())
    .bind(&title)
    .bind(niche.as_deref())
    .bind(&tags_json)
    .bind(&description)
    .bind(rejected_at)
    .bind(reason.as_deref())
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;

    if let Err(e) = snapshot_rejections_to_disk(&state.pool, state.project_id).await {
        tracing::warn!("rejections snapshot failed: {e}");
    }

    state
        .bus
        .send(SupervisorEvent::EtsyDraftRejected { local_listing_id });
    Ok(())
}

/// Restore: pull a rejected listing back into Drafts. Removes the matching
/// rejection learning rows so the orchestrator's avoid-list doesn't keep
/// fighting the user's reversal.
#[tauri::command]
pub async fn cmd_etsy_restore_rejected(
    state: State<'_, Arc<AppState>>,
    local_listing_id: i64,
) -> Result<(), String> {
    let mut tx = state.pool.begin().await.map_err(|e| e.to_string())?;
    sqlx::query(
        "UPDATE etsy_publishes SET state = 'draft' \
         WHERE project_id = ? AND local_listing_id = ? AND state = 'rejected'",
    )
    .bind(state.project_id)
    .bind(local_listing_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    sqlx::query(
        "DELETE FROM listing_rejections \
         WHERE project_id = ? AND local_listing_id = ?",
    )
    .bind(state.project_id)
    .bind(local_listing_id)
    .execute(&mut *tx)
    .await
    .map_err(|e| e.to_string())?;
    tx.commit().await.map_err(|e| e.to_string())?;

    if let Err(e) = snapshot_rejections_to_disk(&state.pool, state.project_id).await {
        tracing::warn!("rejections snapshot failed: {e}");
    }

    state
        .bus
        .send(SupervisorEvent::EtsyDraftRestored { local_listing_id });
    Ok(())
}

/// Cancel a queued regeneration: flip the row back to 'rejected'. The
/// orchestrator job that was enqueued may still run; the publisher will
/// see the row is no longer in 'queued' and drop the successor link.
#[tauri::command]
pub async fn cmd_etsy_cancel_regeneration(
    state: State<'_, Arc<AppState>>,
    local_listing_id: i64,
) -> Result<(), String> {
    sqlx::query(
        "UPDATE etsy_publishes SET state = 'rejected' \
         WHERE project_id = ? AND local_listing_id = ? AND state = 'queued'",
    )
    .bind(state.project_id)
    .bind(local_listing_id)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    state
        .bus
        .send(SupervisorEvent::EtsyDraftRejected { local_listing_id });
    Ok(())
}

#[tauri::command]
pub async fn cmd_etsy_list_rejections(
    state: State<'_, Arc<AppState>>,
    limit: Option<i64>,
) -> Result<Vec<ListingRejectionRow>, String> {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let rows: Vec<ListingRejectionRow> = sqlx::query_as(
        "SELECT id, local_listing_id, cycle_id, title, niche, tags_json, description, rejected_at, reason \
         FROM listing_rejections WHERE project_id = ? ORDER BY rejected_at DESC LIMIT ?",
    )
    .bind(state.project_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Write the most recent rejection summaries to a JSON file the Python
/// research worker reads at prompt-build time. Snapshot-on-write keeps the
/// worker side trivial — no DB connection from Python, no IPC.
///
/// File: `~/.agent-factory/rejections.json`
/// Shape: `{ "rejections": [{ "title": str, "niche": str | null }, ...] }`
///
/// Public so the integration test can exercise the exact path Python depends on.
pub async fn snapshot_rejections_to_disk(pool: &SqlitePool, project_id: i64) -> anyhow::Result<()> {
    let rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT title, niche FROM listing_rejections \
         WHERE project_id = ? ORDER BY rejected_at DESC LIMIT 30",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    let entries: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(title, niche)| serde_json::json!({ "title": title, "niche": niche }))
        .collect();
    let blob = serde_json::json!({ "rejections": entries });

    let home = std::env::var("HOME").unwrap_or_default();
    let dir = PathBuf::from(&home).join(".agent-factory");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("rejections.json");
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&blob)?)?;
    std::fs::rename(&tmp, &path)?;
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
    offset: Option<i64>,
    role: Option<String>,
    since_unix: Option<i64>,
) -> Result<Vec<JobRow>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let offset = offset.unwrap_or(0).max(0);
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
    sql.push_str(" ORDER BY j.id DESC LIMIT ? OFFSET ?");

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
    q = q.bind(offset);

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

/// Total terminal-state job count for the current project, optionally
/// filtered by role. Powers the Activity Feed's pagination — UI divides
/// this by page size to compute total pages.
#[tauri::command]
pub async fn cmd_count_recent_jobs(
    state: State<'_, Arc<AppState>>,
    role: Option<String>,
    since_unix: Option<i64>,
) -> Result<i64, String> {
    let mut sql = String::from(
        "SELECT COUNT(*) FROM jobs \
         WHERE project_id = ? AND status IN ('done','errored')",
    );
    if role.is_some() {
        sql.push_str(" AND agent_role = ?");
    }
    if since_unix.is_some() {
        sql.push_str(" AND CAST(strftime('%s', COALESCE(finished_at, scheduled_at)) AS INTEGER) >= ?");
    }
    let mut q = sqlx::query_scalar::<_, i64>(&sql).bind(state.project_id);
    if let Some(r) = role.as_ref() {
        q = q.bind(r);
    }
    if let Some(s) = since_unix {
        q = q.bind(s);
    }
    q.fetch_one(&state.pool).await.map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct AgentTodayStats {
    pub role: String,
    pub tokens_today: i64,
    pub completed_today: i64,
    pub failed_today: i64,
}

#[derive(serde::Serialize)]
pub struct RevenueBySource {
    pub source: String,
    pub net_usd: f64,
    pub sales_count: i64,
}

#[derive(serde::Serialize)]
pub struct SpendByModel {
    pub model: String,
    pub usd: f64,
    pub calls: i64,
}

#[derive(serde::Serialize)]
pub struct TodayStats {
    /// Today-only LLM + provider + Etsy spend. Daily caps still read
    /// this number. Kept for backwards compat with the existing UI;
    /// the TopBar Net pill now reads the lifetime fields.
    pub budget_today_usd: f64,
    pub revenue_today_usd: f64,
    /// Lifetime totals (all time, every marketplace, every cost line).
    /// budget_lifetime_usd sums budget_ledger; revenue_lifetime_usd
    /// sums revenue_ledger.net_usd. Net = revenue - budget. Single
    /// source of truth for the Revenue / Net pill.
    pub budget_lifetime_usd: f64,
    pub revenue_lifetime_usd: f64,
    pub revenue_by_source: Vec<RevenueBySource>,
    pub spend_by_model: Vec<SpendByModel>,
    pub per_agent: Vec<AgentTodayStats>,
}

/// Today's totals for the in-memory counters the UI displays (budget pill,
/// revenue pill, per-agent tokens/completed/failed). Called on app mount so
/// a restart in the middle of the day doesn't wipe morning numbers to zero.
///
/// "Today" = local day boundary via SQLite `date('now')` — matches how the
/// budget_ledger writes its `day` column.
///
/// All three queries are single-table aggregates with date-indexed WHERE
/// clauses, so the whole hydration completes in a few ms even at 10k+
/// historical rows.
#[tauri::command]
pub async fn cmd_today_stats(state: State<'_, Arc<AppState>>) -> Result<TodayStats, String> {
    let pool = &state.pool;
    let pid = state.project_id;

    // Budget: sum today's budget_ledger rows. Authoritative source — the
    // budget cap logic also reads from here, so they stay in sync.
    let budget_today_usd: f64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(usd_cost), 0.0) FROM budget_ledger \
         WHERE project_id = ? AND day = date('now')",
    )
    .bind(pid)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Revenue: sum REAL actual revenue from closed cycles only. We used to
    // fall back to `estimated_revenue_usd` when actual was null, but the
    // CFO worker's buyer-panel simulation populates `estimated_revenue_usd`
    // with invented sales numbers — that meant the topbar pill showed a
    // big profit before a single buyer paid. Today = cycles started today.
    // `actual_revenue_usd` is written by the Etsy receipts poller when a
    // buyer actually pays (see `pnl::apply_actual_revenue`).
    let revenue_today_usd: f64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(COALESCE(actual_revenue_usd, 0.0)), 0.0) \
         FROM pipeline_cycles \
         WHERE project_id = ? AND date(datetime(started_at, 'unixepoch')) = date('now')",
    )
    .bind(pid)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Per-agent: today's tokens + done/errored counts in a single grouped
    // query. json_extract is fine because the date filter narrows the scan
    // to today's rows (typically <500), and COALESCE handles workers like
    // publisher whose result_json doesn't include token fields.
    let rows: Vec<(String, i64, i64, i64)> = sqlx::query_as(
        "SELECT agent_role, \
            COALESCE(SUM(\
                COALESCE(CAST(json_extract(result_json, '$.tokens_in')  AS INTEGER), 0) + \
                COALESCE(CAST(json_extract(result_json, '$.tokens_out') AS INTEGER), 0) \
            ), 0) AS tokens_today, \
            SUM(CASE WHEN status='done'    THEN 1 ELSE 0 END) AS completed_today, \
            SUM(CASE WHEN status='errored' THEN 1 ELSE 0 END) AS failed_today \
         FROM jobs \
         WHERE project_id = ? \
           AND status IN ('done','errored') \
           AND date(COALESCE(finished_at, scheduled_at)) = date('now') \
         GROUP BY agent_role",
    )
    .bind(pid)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let per_agent: Vec<AgentTodayStats> = rows
        .into_iter()
        .map(|(role, tokens, done, errored)| AgentTodayStats {
            role,
            tokens_today: tokens,
            completed_today: done,
            failed_today: errored,
        })
        .collect();

    let budget_lifetime_usd = crate::budget::lifetime_spend_usd(pool, pid)
        .await
        .map_err(|e| e.to_string())?;
    let revenue_lifetime_usd = crate::revenue::lifetime_revenue_usd(pool, pid)
        .await
        .map_err(|e| e.to_string())?;
    let revenue_by_source: Vec<RevenueBySource> = crate::revenue::lifetime_revenue_by_source(pool, pid)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(source, net_usd, sales_count)| RevenueBySource { source, net_usd, sales_count })
        .collect();
    let spend_by_model: Vec<SpendByModel> = crate::budget::lifetime_spend_by_model(pool, pid)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(model, usd, calls)| SpendByModel { model, usd, calls })
        .collect();

    Ok(TodayStats {
        budget_today_usd,
        revenue_today_usd,
        budget_lifetime_usd,
        revenue_lifetime_usd,
        revenue_by_source,
        spend_by_model,
        per_agent,
    })
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
    if let Err(e) = snapshot_operator_feedback_to_disk(&state.pool, state.project_id).await {
        tracing::warn!("operator feedback snapshot failed: {e}");
    }
    // Wake the Self-Improvement Lab so the operator's signal gets relayed into
    // a worker prompt this cycle — don't wait for the next outcomes batch.
    // Best-effort: a failure here doesn't invalidate the rating.
    if let Err(e) = queue::enqueue(
        &state.pool,
        state.project_id,
        "si",
        serde_json::json!({"trigger": "operator_rating", "job_id": args.job_id}),
    )
    .await
    {
        tracing::warn!("enqueue si after rating failed: {e}");
    }
    Ok(())
}

/// Roll up the most recent operator ratings into a per-role JSON file the
/// Python workers read at prompt-build time. Mirrors the rejections.json
/// pattern: snapshot-on-write, no DB access from Python, role-filtered so
/// each agent only sees feedback on its own outputs.
///
/// File: `~/.agent-factory/operator_feedback.json`
/// Shape: `{ "by_role": { "<role>": [{ "rating": "up"|"down", "note": str|null, "ts": int }, ...], ... } }`
pub async fn snapshot_operator_feedback_to_disk(
    pool: &SqlitePool,
    project_id: i64,
) -> anyhow::Result<()> {
    // Pull the last N ratings across all roles, joined to the originating job
    // so we know which agent's prompt should see this signal.
    let rows: Vec<(String, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT j.agent_role, f.rating, f.note, f.created_at \
         FROM job_feedback f \
         JOIN jobs j ON j.id = f.job_id \
         WHERE f.rater = 'operator' AND j.project_id = ? \
         ORDER BY f.created_at DESC LIMIT 80",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;

    let mut by_role: std::collections::BTreeMap<String, Vec<serde_json::Value>> =
        std::collections::BTreeMap::new();
    for (role, rating, note, ts) in rows {
        // Cap per-role entries so a long rating history can't blow out token
        // budgets when the agent reads its slice.
        let bucket = by_role.entry(role).or_default();
        if bucket.len() >= 15 {
            continue;
        }
        bucket.push(serde_json::json!({
            "rating": rating,
            "note": note,
            "ts": ts,
        }));
    }
    let blob = serde_json::json!({ "by_role": by_role });

    let home = std::env::var("HOME").unwrap_or_default();
    let dir = PathBuf::from(&home).join(".agent-factory");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("operator_feedback.json");
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&blob)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Read a 3D asset (GLB or STL) by job id, returned as base64 so the webview
/// can hand it to `<model-viewer>` via a data URL. The webview can't read
/// arbitrary paths off disk; this is the simplest, smallest-surface bridge.
/// Returns the asset shape and metadata so the UI knows which viewer to pick.
#[derive(Serialize)]
pub struct JobAssetInfo {
    /// "svg" | "glb" | "stl" | "png" | "none"
    pub kind: String,
    /// Path on disk (informational; the UI uses `data_base64` for the actual
    /// bytes).
    pub path: Option<String>,
    /// Sibling GLB path if we have one alongside an STL (the model-viewer
    /// can only render GLB; STL stays as a downloadable file).
    pub glb_path: Option<String>,
    pub bytes: u64,
    /// Base64 of the file bytes — empty when kind is "none" or file is huge.
    pub data_base64: String,
    /// Base64 of the sibling GLB bytes when present (so we always have a
    /// renderable preview for STL jobs).
    pub glb_data_base64: Option<String>,
    /// Sibling PNG preview, base64, when one exists alongside the asset.
    pub png_data_base64: Option<String>,
}

// Cap on the file size we'll base64-encode and ship through the Tauri IPC for
// inline 3D preview. Trade-off: bigger cap → modal can render larger meshes
// (Tripo/Meshy busts and props commonly land in the 20-40 MB range with
// detailed sculpts), but each preview open serializes ~1.33× the file size
// through JSON IPC. 50 MB → ~67 MB base64 transfer; sub-second on this Mac.
// If this ever becomes a UX problem, the better fix is to switch the
// frontend to Tauri's `convertFileSrc()` so the WebView loads the file
// directly from disk instead of through IPC — that scales to GB-class assets.
const MAX_INLINE_BYTES: u64 = 50 * 1024 * 1024;

fn classify(path: &std::path::Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    match ext.as_str() {
        "svg" => "svg",
        "glb" => "glb",
        "stl" => "stl",
        "png" => "png",
        _ => "none",
    }
}

fn read_b64(path: &std::path::Path) -> Option<String> {
    use base64::Engine;
    let bytes = std::fs::read(path).ok()?;
    Some(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
pub async fn cmd_read_job_asset(
    state: State<'_, Arc<AppState>>,
    job_id: i64,
) -> Result<JobAssetInfo, String> {
    let row: Option<(Option<String>,)> = sqlx::query_as(
        "SELECT result_json FROM jobs WHERE id = ? AND project_id = ?",
    )
    .bind(job_id)
    .bind(state.project_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut info = JobAssetInfo {
        kind: "none".into(),
        path: None,
        glb_path: None,
        bytes: 0,
        data_base64: String::new(),
        glb_data_base64: None,
        png_data_base64: None,
    };
    let Some((Some(result_json),)) = row else { return Ok(info) };
    let value: serde_json::Value = match serde_json::from_str(&result_json) {
        Ok(v) => v,
        Err(_) => return Ok(info),
    };
    // The designer writes asset.asset_path; the publisher mirrors it on the
    // top level for handoffs. Check both.
    let asset_path_str = value
        .get("asset")
        .and_then(|a| a.get("asset_path"))
        .and_then(|p| p.as_str())
        .or_else(|| value.get("asset_path").and_then(|p| p.as_str()));
    let Some(asset_path_str) = asset_path_str else { return Ok(info) };
    let path = std::path::PathBuf::from(asset_path_str);
    if !path.exists() {
        return Ok(info);
    }
    let kind = classify(&path);
    info.kind = kind.into();
    info.path = Some(path.display().to_string());
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    info.bytes = meta.len();
    if meta.len() <= MAX_INLINE_BYTES {
        if let Some(b) = read_b64(&path) {
            info.data_base64 = b;
        }
    }
    // For STL jobs, also surface the sibling GLB so <model-viewer> can render
    // a preview (model-viewer doesn't support STL natively).
    if kind == "stl" {
        let glb_path = path.with_extension("glb");
        if glb_path.exists() {
            info.glb_path = Some(glb_path.display().to_string());
            if let Ok(m) = std::fs::metadata(&glb_path) {
                if m.len() <= MAX_INLINE_BYTES {
                    info.glb_data_base64 = read_b64(&glb_path);
                }
            }
        }
    }
    // Sibling PNG preview, if any.
    let png_path = path.with_extension("png");
    if png_path.exists() {
        if let Ok(m) = std::fs::metadata(&png_path) {
            if m.len() <= MAX_INLINE_BYTES {
                info.png_data_base64 = read_b64(&png_path);
            }
        }
    }
    Ok(info)
}

/// Read the asset for a specific local_listing_id (the same shape as
/// `cmd_read_job_asset` but resolved via `publisher_output.json`). Used by
/// the listing-review modal so it can show SVG / GLB / STL uniformly.
#[tauri::command]
pub async fn cmd_read_listing_asset(listing_id: i64) -> Result<JobAssetInfo, String> {
    let mut info = JobAssetInfo {
        kind: "none".into(),
        path: None,
        glb_path: None,
        bytes: 0,
        data_base64: String::new(),
        glb_data_base64: None,
        png_data_base64: None,
    };
    let home = std::env::var("HOME").unwrap_or_default();
    let mock = PathBuf::from(home).join(".agent-factory").join("publisher_output.json");
    let text = match std::fs::read_to_string(&mock) {
        Ok(s) => s,
        Err(_) => return Ok(info),
    };
    let records: serde_json::Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return Ok(info),
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
    let Some(asset_path) = asset_path else { return Ok(info) };
    let path = std::path::PathBuf::from(&asset_path);
    if !path.exists() {
        return Ok(info);
    }
    let kind = classify(&path);
    info.kind = kind.into();
    info.path = Some(path.display().to_string());
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    info.bytes = meta.len();
    if meta.len() <= MAX_INLINE_BYTES {
        if let Some(b) = read_b64(&path) {
            info.data_base64 = b;
        }
    }
    if kind == "stl" {
        let glb_path = path.with_extension("glb");
        if glb_path.exists() {
            info.glb_path = Some(glb_path.display().to_string());
            if let Ok(m) = std::fs::metadata(&glb_path) {
                if m.len() <= MAX_INLINE_BYTES {
                    info.glb_data_base64 = read_b64(&glb_path);
                }
            }
        }
    }
    let png_path = path.with_extension("png");
    if png_path.exists() {
        if let Ok(m) = std::fs::metadata(&png_path) {
            if m.len() <= MAX_INLINE_BYTES {
                info.png_data_base64 = read_b64(&png_path);
            }
        }
    }
    Ok(info)
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

// ─── Agent ↔ Agent messages (Conversations log) ─────────────────────────

#[derive(Deserialize)]
pub struct PostAgentMessageArgs {
    pub from_role: String,
    pub to_role: String,
    pub topic: Option<String>,
    pub content: String,
    pub importance: Option<String>,
    pub job_id: Option<i64>,
}

#[derive(Serialize)]
pub struct AgentMessageRow {
    pub id: i64,
    pub from_role: String,
    pub to_role: String,
    pub topic: Option<String>,
    pub content: String,
    pub importance: String,
    pub job_id: Option<i64>,
    pub ts: i64,
}

/// Post a message from one agent to another (or '*' for broadcast). Used by
/// the supervisor to mirror worker-emitted messages, and also exposed so the
/// UI / boss can drop in a manual nudge.
#[tauri::command]
pub async fn cmd_post_agent_message(
    state: State<'_, Arc<AppState>>,
    args: PostAgentMessageArgs,
) -> Result<i64, String> {
    let importance = args.importance.unwrap_or_else(|| "info".into());
    if !["info", "heads_up", "critical"].contains(&importance.as_str()) {
        return Err(format!("invalid importance '{importance}'"));
    }
    let to = if args.to_role.trim().is_empty() { "*".into() } else { args.to_role };
    let now = chrono::Utc::now().timestamp();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO agent_messages (project_id, from_role, to_role, topic, content, importance, job_id, ts) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id",
    )
    .bind(state.project_id)
    .bind(&args.from_role)
    .bind(&to)
    .bind(&args.topic)
    .bind(&args.content)
    .bind(&importance)
    .bind(args.job_id)
    .bind(now)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(id)
}

/// List recent agent-to-agent messages, newest first. Optional `role` filter
/// matches messages sent FROM or TO that role (including broadcasts '*').
#[tauri::command]
pub async fn cmd_list_agent_messages(
    state: State<'_, Arc<AppState>>,
    limit: Option<i64>,
    role: Option<String>,
) -> Result<Vec<AgentMessageRow>, String> {
    let limit = limit.unwrap_or(100).clamp(1, 1000);
    let mut sql = String::from(
        "SELECT id, from_role, to_role, topic, content, importance, job_id, ts \
         FROM agent_messages WHERE project_id = ?",
    );
    if role.is_some() {
        sql.push_str(" AND (from_role = ? OR to_role = ? OR to_role = '*')");
    }
    sql.push_str(" ORDER BY id DESC LIMIT ?");

    let mut q = sqlx::query_as::<
        _,
        (i64, String, String, Option<String>, String, String, Option<i64>, i64),
    >(&sql)
    .bind(state.project_id);
    if let Some(r) = role.as_ref() {
        q = q.bind(r).bind(r);
    }
    q = q.bind(limit);
    let rows = q.fetch_all(&state.pool).await.map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| AgentMessageRow {
            id: r.0,
            from_role: r.1,
            to_role: r.2,
            topic: r.3,
            content: r.4,
            importance: r.5,
            job_id: r.6,
            ts: r.7,
        })
        .collect())
}

// ─── Shop focus (3D-only / 2D-only / Mixed) ──────────────────────────────

#[derive(Serialize)]
pub struct ShopFocus {
    pub value: String,
}

/// Read the current shop_focus. Defaults to "3d_only" — the user pivoted the
/// shop to 3D-only after the Tripo output looked good and the 2D ADHD-
/// printable drafts had zero sales after 58 listings.
#[tauri::command]
pub async fn cmd_get_shop_focus() -> Result<ShopFocus, String> {
    let value = secrets::get("shop_focus")
        .ok()
        .flatten()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "3d_only".into());
    Ok(ShopFocus { value })
}

#[tauri::command]
pub async fn cmd_set_shop_focus(value: String) -> Result<(), String> {
    let v = value.trim();
    if !["3d_only", "2d_only", "mixed"].contains(&v) {
        return Err(format!("invalid shop_focus '{v}' — must be 3d_only|2d_only|mixed"));
    }
    secrets::set("shop_focus", v).map_err(|e| e.to_string())
}

// ─── Character pool (IP-risk spectrum for 3D character output) ───────────
//
// Controls which character archetypes the orchestrator + research worker
// pull from when picking a niche. `popular_ip` (anime/movie/game/TV
// derivatives) is HIGH IP RISK — the publisher still routes those through
// the manual approval gate (see ip_risk_approvals table). Default `all` so
// the pipeline explores the full spectrum; the gate prevents accidental
// auto-publish of risky content.

#[derive(Serialize)]
pub struct CharacterPool {
    pub value: String,
}

const CHARACTER_POOLS: &[&str] = &[
    "original_anime",
    "mythology",
    "own_universe",
    "popular_ip",
    "safe",
    "all",
];

#[tauri::command]
pub async fn cmd_get_character_pool() -> Result<CharacterPool, String> {
    let value = secrets::get("character_pool")
        .ok()
        .flatten()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "all".into());
    Ok(CharacterPool { value })
}

#[tauri::command]
pub async fn cmd_set_character_pool(value: String) -> Result<(), String> {
    let v = value.trim();
    if !CHARACTER_POOLS.contains(&v) {
        return Err(format!(
            "invalid character_pool '{v}' — must be one of {}",
            CHARACTER_POOLS.join("|")
        ));
    }
    secrets::set("character_pool", v).map_err(|e| e.to_string())
}

// ─── Image-to-3D provider selection (tripo | meshy) ──────────────────────
//
// The designer can route character-style briefs through a 2D reference
// render (nanobanana) and then a image-to-3D provider. Both Tripo + Meshy
// are wired; user defaults to Tripo today and can flip to Meshy without a
// rebuild. Text-to-3D still uses the existing fallback chain (Meshy →
// Tripo) — this setting governs ONLY the image-to-3D route.

#[derive(Serialize)]
pub struct ImageTo3dProvider {
    pub value: String,
}

const IMAGE_TO_3D_PROVIDERS: &[&str] = &["tripo", "meshy"];

#[tauri::command]
pub async fn cmd_get_image_to_3d_provider() -> Result<ImageTo3dProvider, String> {
    let value = secrets::get("image_to_3d_provider")
        .ok()
        .flatten()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "tripo".into());
    Ok(ImageTo3dProvider { value })
}

#[tauri::command]
pub async fn cmd_set_image_to_3d_provider(value: String) -> Result<(), String> {
    let v = value.trim();
    if !IMAGE_TO_3D_PROVIDERS.contains(&v) {
        return Err(format!(
            "invalid image_to_3d_provider '{v}' — must be one of {}",
            IMAGE_TO_3D_PROVIDERS.join("|")
        ));
    }
    secrets::set("image_to_3d_provider", v).map_err(|e| e.to_string())
}

// ─── Cults3D + GitHub asset host ─────────────────────────────────────────

#[derive(Serialize)]
pub struct Cults3dStatus {
    pub creds_present: bool,
    pub asset_host_configured: bool,
    pub enabled: bool,
    pub daily_cap: i64,
    pub today_count: i64,
}

#[derive(Serialize)]
pub struct Cults3dVerifyOk {
    pub username: String,
}

#[derive(Serialize)]
pub struct AssetHostVerifyOk {
    pub repo: String,
    pub default_branch: String,
}

#[tauri::command]
pub async fn cmd_cults3d_verify(username: String, api_key: String) -> Result<Cults3dVerifyOk, String> {
    let u = username.trim();
    let k = api_key.trim();
    if u.is_empty() || k.is_empty() {
        return Err("Cults3D username and api_key are both required".into());
    }
    let client = reqwest::Client::new();
    let creds = crate::cults3d::Creds {
        username: u.into(),
        api_key: k.into(),
    };
    let username = crate::cults3d::verify(&client, &creds)
        .await
        .map_err(|e| format!("{e:#}"))?;
    secrets::set("cults3d_username", u).map_err(|e| format!("save username: {e}"))?;
    secrets::set("cults3d_api_key", k).map_err(|e| format!("save api_key: {e}"))?;
    Ok(Cults3dVerifyOk { username })
}

#[tauri::command]
pub async fn cmd_cults3d_set_enabled(enabled: bool) -> Result<(), String> {
    secrets::set("cults3d_enabled", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_cults3d_status(state: State<'_, Arc<AppState>>) -> Result<Cults3dStatus, String> {
    let creds_present = secrets::get("cults3d_username").ok().flatten().map(|v| !v.is_empty()).unwrap_or(false)
        && secrets::get("cults3d_api_key").ok().flatten().map(|v| !v.is_empty()).unwrap_or(false);
    let asset_host_configured = secrets::get("github_asset_repo").ok().flatten().map(|v| !v.is_empty()).unwrap_or(false)
        && secrets::get("github_asset_token").ok().flatten().map(|v| !v.is_empty()).unwrap_or(false);
    let enabled = secrets::get("cults3d_enabled").ok().flatten()
        .map(|v| v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let daily_cap = secrets::get("cults3d_daily_cap")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(crate::cults3d_publish::DEFAULT_DAILY_CAP);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let today_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM cults3d_publishes WHERE project_id = ? AND day = ? AND state = 'published'",
    )
    .bind(state.project_id)
    .bind(&today)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(0);
    Ok(Cults3dStatus {
        creds_present,
        asset_host_configured,
        enabled,
        daily_cap,
        today_count,
    })
}

#[tauri::command]
pub async fn cmd_cults3d_set_daily_cap(cap: i64) -> Result<(), String> {
    if !(0..=50).contains(&cap) {
        return Err("cap must be 0..=50".into());
    }
    secrets::set("cults3d_daily_cap", &cap.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_github_asset_host_verify(repo: String, token: String) -> Result<AssetHostVerifyOk, String> {
    let r = repo.trim();
    let t = token.trim();
    if r.is_empty() || t.is_empty() {
        return Err("repo and token are both required".into());
    }
    let client = reqwest::Client::new();
    let branch = crate::asset_host_github::verify(&client, r, t)
        .await
        .map_err(|e| format!("{e:#}"))?;
    secrets::set("github_asset_repo", r).map_err(|e| format!("save repo: {e}"))?;
    secrets::set("github_asset_token", t).map_err(|e| format!("save token: {e}"))?;
    Ok(AssetHostVerifyOk {
        repo: r.into(),
        default_branch: branch,
    })
}

#[derive(Serialize)]
pub struct Cults3dPublishRow {
    pub id: i64,
    pub local_listing_id: Option<i64>,
    pub cults3d_creation_id: Option<String>,
    pub title: String,
    pub url: Option<String>,
    pub file_url: Option<String>,
    pub image_url: Option<String>,
    pub price_usd: Option<f64>,
    pub state: String,
    pub error: Option<String>,
    pub published_at: i64,
}

#[tauri::command]
pub async fn cmd_cults3d_list_publishes(
    state: State<'_, Arc<AppState>>,
    limit: Option<i64>,
) -> Result<Vec<Cults3dPublishRow>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let rows = sqlx::query_as::<
        _,
        (
            i64,
            Option<i64>,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<f64>,
            String,
            Option<String>,
            i64,
        ),
    >(
        "SELECT id, local_listing_id, cults3d_creation_id, title, url, file_url, image_url, \
         price_usd, state, error, published_at \
         FROM cults3d_publishes WHERE project_id = ? \
         ORDER BY id DESC LIMIT ?",
    )
    .bind(state.project_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| Cults3dPublishRow {
            id: r.0,
            local_listing_id: r.1,
            cults3d_creation_id: r.2,
            title: r.3,
            url: r.4,
            file_url: r.5,
            image_url: r.6,
            price_usd: r.7,
            state: r.8,
            error: r.9,
            published_at: r.10,
        })
        .collect())
}

// ─── Pinterest (manual access-token paste) ───────────────────────────────

#[derive(Serialize)]
pub struct PinterestStatus {
    pub creds_present: bool,
    pub board_name: Option<String>,
    pub enabled: bool,
    pub daily_cap: i64,
    pub today_count: i64,
}

#[derive(Serialize)]
pub struct PinterestVerifyOk {
    pub board_name: String,
}

/// Verify the (access_token, board_id) pair by fetching the board from
/// Pinterest's v5 API. On success persists both + caches the board name so
/// the Settings UI can show "Connected: <board name>".
#[tauri::command]
pub async fn cmd_pinterest_verify(
    access_token: String,
    board_id: String,
) -> Result<PinterestVerifyOk, String> {
    let t = access_token.trim();
    let b = board_id.trim();
    if t.is_empty() || b.is_empty() {
        return Err("Pinterest access token and board id are both required".into());
    }
    let client = reqwest::Client::new();
    let board_name = crate::pinterest::verify(&client, t, b)
        .await
        .map_err(|e| format!("{e:#}"))?;
    crate::pinterest::persist(t, b).map_err(|e| format!("save creds: {e}"))?;
    let _ = secrets::set("pinterest_board_name", &board_name);
    Ok(PinterestVerifyOk { board_name })
}

#[tauri::command]
pub async fn cmd_pinterest_set_enabled(enabled: bool) -> Result<(), String> {
    secrets::set("pinterest_enabled", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_pinterest_set_daily_cap(cap: i64) -> Result<(), String> {
    if !(0..=50).contains(&cap) {
        return Err("cap must be 0..=50".into());
    }
    secrets::set("pinterest_daily_cap", &cap.to_string()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_pinterest_disconnect() -> Result<(), String> {
    crate::pinterest::disconnect().map_err(|e| e.to_string())?;
    // Also clear the enable flag so a disconnected Pinterest can't fire
    // half-configured publishes if the operator later toggles enable back on.
    let _ = secrets::set("pinterest_enabled", "false");
    Ok(())
}

#[tauri::command]
pub async fn cmd_pinterest_status(
    state: State<'_, Arc<AppState>>,
) -> Result<PinterestStatus, String> {
    let creds_present = secrets::get("pinterest_access_token")
        .ok()
        .flatten()
        .map(|v| !v.is_empty())
        .unwrap_or(false)
        && secrets::get("pinterest_board_id")
            .ok()
            .flatten()
            .map(|v| !v.is_empty())
            .unwrap_or(false);
    let board_name = secrets::get("pinterest_board_name").ok().flatten();
    let enabled = secrets::get("pinterest_enabled")
        .ok()
        .flatten()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let (today_count, daily_cap) =
        crate::pinterest_publish::today_status(&state.pool, state.project_id)
            .await
            .map_err(|e| e.to_string())?;
    Ok(PinterestStatus {
        creds_present,
        board_name,
        enabled,
        daily_cap,
        today_count,
    })
}

#[derive(Serialize)]
pub struct PinterestPinRow {
    pub id: i64,
    pub local_listing_id: Option<i64>,
    pub pinterest_pin_id: Option<String>,
    pub title: String,
    pub url: Option<String>,
    pub etsy_url: Option<String>,
    pub state: String,
    pub error: Option<String>,
    pub published_at: i64,
}

#[tauri::command]
pub async fn cmd_pinterest_list_pins(
    state: State<'_, Arc<AppState>>,
    limit: Option<i64>,
) -> Result<Vec<PinterestPinRow>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let rows = sqlx::query_as::<
        _,
        (
            i64,
            Option<i64>,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
            i64,
        ),
    >(
        "SELECT id, local_listing_id, pinterest_pin_id, title, url, etsy_url, state, error, published_at \
         FROM pinterest_pins WHERE project_id = ? \
         ORDER BY id DESC LIMIT ?",
    )
    .bind(state.project_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| PinterestPinRow {
            id: r.0,
            local_listing_id: r.1,
            pinterest_pin_id: r.2,
            title: r.3,
            url: r.4,
            etsy_url: r.5,
            state: r.6,
            error: r.7,
            published_at: r.8,
        })
        .collect())
}

/// Count of agent messages newer than `since_unix` — used by the CommandRail
/// to badge unread conversation activity.
#[tauri::command]
pub async fn cmd_agent_messages_since(
    state: State<'_, Arc<AppState>>,
    since_unix: i64,
) -> Result<i64, String> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_messages WHERE project_id = ? AND ts > ?",
    )
    .bind(state.project_id)
    .bind(since_unix)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(count)
}

/// Count of unrated jobs newer than `since_unix` — used by the CommandRail
/// badge so it tracks new outputs since the boss last opened Activity, instead
/// of accumulating into a useless "99+".
#[tauri::command]
pub async fn cmd_unrated_job_count(
    state: State<'_, Arc<AppState>>,
    since_unix: i64,
) -> Result<i64, String> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM jobs j \
         LEFT JOIN job_feedback f ON f.job_id = j.id AND f.rater = 'operator' \
         WHERE j.project_id = ? AND j.status IN ('done','errored') \
         AND CAST(strftime('%s', COALESCE(j.finished_at, j.scheduled_at)) AS INTEGER) >= ? \
         AND f.id IS NULL",
    )
    .bind(state.project_id)
    .bind(since_unix)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(count)
}

// ─── Sketchfab ───────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct SketchfabStatus {
    pub creds_present: bool,
    pub enabled: bool,
    pub sell_on_store: bool,
    pub daily_cap: i64,
    pub today_count: i64,
}

#[derive(Serialize)]
pub struct SketchfabVerifyOk {
    pub username: String,
}

#[tauri::command]
pub async fn cmd_sketchfab_verify(api_token: String) -> Result<SketchfabVerifyOk, String> {
    let t = api_token.trim();
    if t.is_empty() {
        return Err("Sketchfab API token is required".into());
    }
    let client = reqwest::Client::new();
    let creds = crate::sketchfab::Creds { api_token: t.into() };
    let username = crate::sketchfab::verify(&client, &creds)
        .await
        .map_err(|e| format!("{e:#}"))?;
    secrets::set("sketchfab_api_token", t).map_err(|e| format!("save token: {e}"))?;
    Ok(SketchfabVerifyOk { username })
}

#[tauri::command]
pub async fn cmd_sketchfab_set_enabled(enabled: bool) -> Result<(), String> {
    secrets::set("sketchfab_enabled", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_sketchfab_set_sell_on_store(sell: bool) -> Result<(), String> {
    secrets::set("sketchfab_sell_on_store", if sell { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_sketchfab_status(
    state: State<'_, Arc<AppState>>,
) -> Result<SketchfabStatus, String> {
    let creds_present = secrets::get("sketchfab_api_token")
        .ok()
        .flatten()
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    let enabled = secrets::get("sketchfab_enabled")
        .ok()
        .flatten()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let sell_on_store = secrets::get("sketchfab_sell_on_store")
        .ok()
        .flatten()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let daily_cap = secrets::get("sketchfab_daily_cap")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(crate::sketchfab_publish::DEFAULT_DAILY_CAP);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let today_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM sketchfab_publishes WHERE project_id = ? AND day = ? AND state = 'published'",
    )
    .bind(state.project_id)
    .bind(&today)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(0);
    Ok(SketchfabStatus {
        creds_present,
        enabled,
        sell_on_store,
        daily_cap,
        today_count,
    })
}

#[tauri::command]
pub async fn cmd_sketchfab_set_daily_cap(cap: i64) -> Result<(), String> {
    if !(0..=50).contains(&cap) {
        return Err("cap must be 0..=50".into());
    }
    secrets::set("sketchfab_daily_cap", &cap.to_string()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct SketchfabPublishRow {
    pub id: i64,
    pub local_listing_id: Option<i64>,
    pub sketchfab_uid: Option<String>,
    pub store_product_id: Option<String>,
    pub title: String,
    pub url: Option<String>,
    pub price_usd: Option<f64>,
    pub state: String,
    pub error: Option<String>,
    pub warning: Option<String>,
    pub published_at: i64,
}

// ─── Higgsfield (product-photoshoot thumbnail enhancement) ─────────────

#[derive(Serialize)]
pub struct HiggsfieldStatus {
    pub cli_installed: bool,
    pub cli_authed: bool,
    pub enabled: bool,
}

#[tauri::command]
pub async fn cmd_higgsfield_status() -> Result<HiggsfieldStatus, String> {
    // Probe by shelling out — auth state lives inside the CLI's own
    // credential cache, we don't store anything in our secrets.
    let cli_installed = which("higgsfield").is_ok();
    let cli_authed = if cli_installed {
        tokio::task::spawn_blocking(|| {
            std::process::Command::new("higgsfield")
                .args(["account", "status"])
                .output()
                .ok()
                .map(|o| {
                    let combined = format!(
                        "{}{}",
                        String::from_utf8_lossy(&o.stdout),
                        String::from_utf8_lossy(&o.stderr)
                    )
                    .to_lowercase();
                    o.status.success()
                        && !combined.contains("session expired")
                        && !combined.contains("not authenticated")
                })
                .unwrap_or(false)
        })
        .await
        .unwrap_or(false)
    } else {
        false
    };
    let enabled = secrets::get("higgsfield_enabled")
        .ok()
        .flatten()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    Ok(HiggsfieldStatus {
        cli_installed,
        cli_authed,
        enabled,
    })
}

#[tauri::command]
pub async fn cmd_higgsfield_set_enabled(enabled: bool) -> Result<(), String> {
    secrets::set("higgsfield_enabled", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

// Tiny `which` helper — avoids adding a crate for a single shell-out probe.
fn which(bin: &str) -> Result<std::path::PathBuf, String> {
    let path_env = std::env::var_os("PATH").ok_or_else(|| "PATH unset".to_string())?;
    for dir in std::env::split_paths(&path_env) {
        let candidate = dir.join(bin);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(format!("{bin} not on PATH"))
}

// ─── YouTube Data API (for trend signals) ───────────────────────────────

#[derive(Serialize)]
pub struct YoutubeStatus {
    pub key_present: bool,
}

#[derive(Serialize)]
pub struct YoutubeVerifyOk {
    pub sample_video_title: String,
}

#[tauri::command]
pub async fn cmd_youtube_verify(api_key: String) -> Result<YoutubeVerifyOk, String> {
    let k = api_key.trim();
    if k.is_empty() {
        return Err("YouTube API key is required".into());
    }
    // Smallest possible ping — most-popular videos, US, 1 result.
    let url = format!(
        "https://www.googleapis.com/youtube/v3/videos?part=snippet&chart=mostPopular&regionCode=US&maxResults=1&key={}",
        urlencoding::encode(k)
    );
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("youtube GET failed: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("youtube HTTP {status}: {text}"));
    }
    let parsed: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("youtube parse error: {e} — body: {text}"))?;
    let title = parsed
        .get("items")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|i| i.get("snippet"))
        .and_then(|s| s.get("title"))
        .and_then(|t| t.as_str())
        .unwrap_or("(no items)")
        .to_string();
    secrets::set("youtube_api_key", k).map_err(|e| format!("save key: {e}"))?;
    Ok(YoutubeVerifyOk {
        sample_video_title: title,
    })
}

#[tauri::command]
pub async fn cmd_youtube_status() -> Result<YoutubeStatus, String> {
    let key_present = secrets::get("youtube_api_key")
        .ok()
        .flatten()
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    Ok(YoutubeStatus { key_present })
}

// ─── MyMiniFactory ───────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct MmfStatus {
    /// True when MMF OAuth has been connected (access token in keychain).
    /// We no longer treat the personal API key as "connected" since MMF
    /// rejects it for writes — only OAuth counts.
    pub creds_present: bool,
    pub enabled: bool,
    pub sell_paid: bool,
    pub daily_cap: i64,
    pub today_count: i64,
    /// Echo of client_id so the UI can show "App: XXXX" without exposing
    /// the secret. Empty when the operator hasn't registered an app yet.
    pub client_id: Option<String>,
    /// MMF user_id returned with the OAuth token, for UI display.
    pub oauth_user_id: Option<String>,
}

#[derive(Serialize)]
pub struct MmfVerifyOk {
    pub account: String,
}

#[tauri::command]
pub async fn cmd_mmf_verify(api_key: String) -> Result<MmfVerifyOk, String> {
    let k = api_key.trim();
    if k.is_empty() {
        return Err("MyMiniFactory API key is required".into());
    }
    let client = reqwest::Client::new();
    let creds = crate::myminifactory::Creds { api_key: k.into() };
    let account = crate::myminifactory::verify(&client, &creds)
        .await
        .map_err(|e| format!("{e:#}"))?;
    secrets::set("mmf_api_key", k).map_err(|e| format!("save key: {e}"))?;
    Ok(MmfVerifyOk { account })
}

#[tauri::command]
pub async fn cmd_mmf_set_enabled(enabled: bool) -> Result<(), String> {
    secrets::set("mmf_enabled", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_mmf_set_sell_paid(sell: bool) -> Result<(), String> {
    secrets::set("mmf_sell_paid", if sell { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_mmf_status(state: State<'_, Arc<AppState>>) -> Result<MmfStatus, String> {
    let creds_present = crate::mmf_oauth::is_connected();
    let enabled = secrets::get("mmf_enabled")
        .ok()
        .flatten()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let sell_paid = secrets::get("mmf_sell_paid")
        .ok()
        .flatten()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let daily_cap = secrets::get("mmf_daily_cap")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(crate::myminifactory_publish::DEFAULT_DAILY_CAP);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let today_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM mmf_publishes WHERE project_id = ? AND day = ? AND state = 'published'",
    )
    .bind(state.project_id)
    .bind(&today)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(0);
    let client_id = secrets::get("mmf_client_id").ok().flatten();
    let oauth_user_id = secrets::get("mmf_oauth_user_id").ok().flatten();
    Ok(MmfStatus {
        creds_present,
        enabled,
        sell_paid,
        daily_cap,
        today_count,
        client_id,
        oauth_user_id,
    })
}

/// Begin the MMF OAuth dance. Persists the client creds, builds the
/// authorize URL the frontend hands to the system browser, and kicks off
/// the same single-shot callback listener Etsy uses. On success the user
/// is connected; on failure `mmf_oauth_last_error` is set.
#[tauri::command]
pub async fn cmd_mmf_start_oauth(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    client_id: String,
    client_secret: String,
) -> Result<OAuthInit, String> {
    let cid = client_id.trim();
    let csec = client_secret.trim();
    if cid.is_empty() {
        return Err("MMF client_id is required. \
                    Register an app at myminifactory.com/settings/developer."
            .into());
    }
    // Allow empty client_secret — MMF may treat this app as a public
    // client (no secret required). Our exchange_code drops Basic auth
    // when the secret is empty and sends client_id in the body alone.
    secrets::set("mmf_client_id", cid).map_err(|e| format!("save client_id: {e}"))?;
    secrets::set("mmf_client_secret", csec).map_err(|e| format!("save client_secret: {e}"))?;

    let oauth_state = crate::mmf_oauth::generate_state();
    {
        let mut guard = state.pending_oauth.lock().await;
        // We reuse the same pending_oauth map as Etsy. The value here is a
        // sentinel so the callback handler can tell which provider this
        // state belongs to.
        guard.insert(oauth_state.clone(), "mmf".to_string());
    }
    let authorize_url = crate::mmf_oauth::build_authorize_url(cid, &oauth_state);

    // Cancel any in-flight OAuth task so we can rebind the callback port.
    {
        let mut guard = state.oauth_task.lock().await;
        if let Some(prev) = guard.take() {
            prev.abort();
        }
    }
    tokio::time::sleep(Duration::from_millis(150)).await;

    let app_state = state.inner().clone();
    let app_for_task = app.clone();
    let cid_for_task = cid.to_string();
    let csec_for_task = csec.to_string();
    let handle = tokio::spawn(async move {
        run_mmf_oauth_flow(app_for_task, app_state, cid_for_task, csec_for_task, oauth_state).await;
    });
    {
        let mut guard = state.oauth_task.lock().await;
        *guard = Some(handle);
    }

    Ok(OAuthInit { authorize_url })
}

async fn run_mmf_oauth_flow(
    app: tauri::AppHandle,
    state: Arc<AppState>,
    client_id: String,
    client_secret: String,
    oauth_state: String,
) {
    let result: anyhow::Result<()> = async {
        let cb = oauth_server::await_callback(Duration::from_secs(180)).await?;
        if cb.state != oauth_state {
            return Err(anyhow::anyhow!(
                "state mismatch — got `{}`, expected `{}`",
                cb.state,
                oauth_state
            ));
        }
        // Sentinel cleanup
        {
            let mut guard = state.pending_oauth.lock().await;
            guard.remove(&cb.state);
        }
        let client = reqwest::Client::new();
        let tokens = crate::mmf_oauth::exchange_code(&client, &client_id, &client_secret, &cb.code)
            .await?;
        crate::mmf_oauth::persist_tokens(&tokens)?;
        // Auto-enable MMF on first successful connect — the operator
        // ran the OAuth flow specifically because they want it on.
        let _ = secrets::set("mmf_enabled", "true");
        let _ = secrets::delete("mmf_oauth_last_error");
        Ok(())
    }
    .await;

    match result {
        Ok(()) => {
            tracing::info!("mmf oauth connected");
            let _ = app.emit("mmf_connected", true);
        }
        Err(e) => {
            tracing::error!("mmf oauth flow failed: {e}");
            let _ = secrets::set("mmf_oauth_last_error", &e.to_string());
            let mut guard = state.pending_oauth.lock().await;
            guard.remove(&oauth_state);
            let _ = app.emit("mmf_oauth_error", e.to_string());
        }
    }
}

#[tauri::command]
pub async fn cmd_mmf_disconnect() -> Result<(), String> {
    crate::mmf_oauth::disconnect().map_err(|e| e.to_string())?;
    let _ = secrets::set("mmf_enabled", "false");
    Ok(())
}

#[tauri::command]
pub async fn cmd_mmf_last_oauth_error() -> Result<Option<String>, String> {
    secrets::get("mmf_oauth_last_error").map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_mmf_set_daily_cap(cap: i64) -> Result<(), String> {
    if !(0..=50).contains(&cap) {
        return Err("cap must be 0..=50".into());
    }
    secrets::set("mmf_daily_cap", &cap.to_string()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct MmfPublishRow {
    pub id: i64,
    pub local_listing_id: Option<i64>,
    pub mmf_object_id: Option<String>,
    pub title: String,
    pub url: Option<String>,
    pub price_usd: Option<f64>,
    pub state: String,
    pub error: Option<String>,
    pub warning: Option<String>,
    pub published_at: i64,
}

#[tauri::command]
pub async fn cmd_mmf_list_publishes(
    state: State<'_, Arc<AppState>>,
    limit: Option<i64>,
) -> Result<Vec<MmfPublishRow>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let rows = sqlx::query_as::<
        _,
        (
            i64,
            Option<i64>,
            Option<String>,
            String,
            Option<String>,
            Option<f64>,
            String,
            Option<String>,
            Option<String>,
            i64,
        ),
    >(
        "SELECT id, local_listing_id, mmf_object_id, title, url, \
         price_usd, state, error, warning, published_at \
         FROM mmf_publishes WHERE project_id = ? \
         ORDER BY id DESC LIMIT ?",
    )
    .bind(state.project_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| MmfPublishRow {
            id: r.0,
            local_listing_id: r.1,
            mmf_object_id: r.2,
            title: r.3,
            url: r.4,
            price_usd: r.5,
            state: r.6,
            error: r.7,
            warning: r.8,
            published_at: r.9,
        })
        .collect())
}

// ─── Gumroad ─────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct GumroadStatus {
    pub creds_present: bool,
    pub enabled: bool,
    pub daily_cap: i64,
    pub today_count: i64,
}

#[derive(Serialize)]
pub struct GumroadVerifyOk {
    pub account: String,
}

#[tauri::command]
pub async fn cmd_gumroad_verify(access_token: String) -> Result<GumroadVerifyOk, String> {
    let t = access_token.trim();
    if t.is_empty() {
        return Err("Gumroad access token is required".into());
    }
    let client = reqwest::Client::new();
    let creds = crate::gumroad::Creds { access_token: t.into() };
    let account = crate::gumroad::verify(&client, &creds)
        .await
        .map_err(|e| format!("{e:#}"))?;
    secrets::set("gumroad_access_token", t).map_err(|e| format!("save token: {e}"))?;
    Ok(GumroadVerifyOk { account })
}

#[tauri::command]
pub async fn cmd_gumroad_set_enabled(enabled: bool) -> Result<(), String> {
    secrets::set("gumroad_enabled", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cmd_gumroad_status(
    state: State<'_, Arc<AppState>>,
) -> Result<GumroadStatus, String> {
    let creds_present = secrets::get("gumroad_access_token")
        .ok()
        .flatten()
        .map(|v| !v.is_empty())
        .unwrap_or(false);
    let enabled = secrets::get("gumroad_enabled")
        .ok()
        .flatten()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    let daily_cap = secrets::get("gumroad_daily_cap")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(crate::gumroad_publish::DEFAULT_DAILY_CAP);
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let today_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM gumroad_publishes WHERE project_id = ? AND day = ? AND state IN ('published','published_no_file')",
    )
    .bind(state.project_id)
    .bind(&today)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(0);
    Ok(GumroadStatus {
        creds_present,
        enabled,
        daily_cap,
        today_count,
    })
}

#[tauri::command]
pub async fn cmd_gumroad_set_daily_cap(cap: i64) -> Result<(), String> {
    if !(0..=50).contains(&cap) {
        return Err("cap must be 0..=50".into());
    }
    secrets::set("gumroad_daily_cap", &cap.to_string()).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct GumroadPublishRow {
    pub id: i64,
    pub local_listing_id: Option<i64>,
    pub gumroad_product_id: Option<String>,
    pub title: String,
    pub short_url: Option<String>,
    pub edit_url: Option<String>,
    pub price_usd: Option<f64>,
    pub state: String,
    pub error: Option<String>,
    pub warning: Option<String>,
    pub published_at: i64,
}

#[tauri::command]
pub async fn cmd_gumroad_list_publishes(
    state: State<'_, Arc<AppState>>,
    limit: Option<i64>,
) -> Result<Vec<GumroadPublishRow>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let rows = sqlx::query_as::<
        _,
        (
            i64,
            Option<i64>,
            Option<String>,
            String,
            Option<String>,
            Option<String>,
            Option<f64>,
            String,
            Option<String>,
            Option<String>,
            i64,
        ),
    >(
        "SELECT id, local_listing_id, gumroad_product_id, title, short_url, edit_url, \
         price_usd, state, error, warning, published_at \
         FROM gumroad_publishes WHERE project_id = ? \
         ORDER BY id DESC LIMIT ?",
    )
    .bind(state.project_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| GumroadPublishRow {
            id: r.0,
            local_listing_id: r.1,
            gumroad_product_id: r.2,
            title: r.3,
            short_url: r.4,
            edit_url: r.5,
            price_usd: r.6,
            state: r.7,
            error: r.8,
            warning: r.9,
            published_at: r.10,
        })
        .collect())
}

#[tauri::command]
pub async fn cmd_sketchfab_list_publishes(
    state: State<'_, Arc<AppState>>,
    limit: Option<i64>,
) -> Result<Vec<SketchfabPublishRow>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let rows = sqlx::query_as::<
        _,
        (
            i64,
            Option<i64>,
            Option<String>,
            Option<String>,
            String,
            Option<String>,
            Option<f64>,
            String,
            Option<String>,
            Option<String>,
            i64,
        ),
    >(
        "SELECT id, local_listing_id, sketchfab_uid, store_product_id, title, url, \
         price_usd, state, error, warning, published_at \
         FROM sketchfab_publishes WHERE project_id = ? \
         ORDER BY id DESC LIMIT ?",
    )
    .bind(state.project_id)
    .bind(limit)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|r| SketchfabPublishRow {
            id: r.0,
            local_listing_id: r.1,
            sketchfab_uid: r.2,
            store_product_id: r.3,
            title: r.4,
            url: r.5,
            price_usd: r.6,
            state: r.7,
            error: r.8,
            warning: r.9,
            published_at: r.10,
        })
        .collect())
}

// ───────────────────────────────────────────────────────────────────────────
// Chat-with-agent — lets the operator have a conversation with any role's
// persona. Goes through the same bridge proxy the workers use (so credits
// + budget caps are tracked uniformly). Stateless on the backend; the
// frontend keeps the conversation history and sends it whole each turn.
// ───────────────────────────────────────────────────────────────────────────

/// Trim the random suffix off a role id like "research-ab12" → "research".
/// hireResolver.ts generates ids as `${slug}-${random}` so this is the
/// canonical inverse. For ids without a dash (already a kind), return as-is.
fn role_kind_from_id(role_id: &str) -> String {
    if let Some((kind, _)) = role_id.rsplit_once('-') {
        if !kind.is_empty() {
            return kind.to_string();
        }
    }
    role_id.to_string()
}

/// Per-role chat persona. The system prompt sent to Claude when the
/// operator chats with this agent. Kept conversational + concise — these
/// are NOT the production worker prompts that demand structured JSON
/// output; they're the in-character chat voice for each role.
fn chat_persona_for(kind: &str) -> &'static str {
    match kind {
        "orchestrator" => "You are the Orchestrator at an AI-run 3D-asset Etsy shop selling STL + GLB files. You dispatch jobs across the research → designer → listing → publisher pipeline and handle failures. When the operator chats, reply in 1-3 sentences, in-character: focused on pipeline state, scheduling, and operational decisions. If they ask about specific live state you'd need DB access to know, say so plainly.",
        "research" => "You are the Market Research Analyst at an AI-run 3D-asset shop (STL + GLB on Etsy + Cults3D). You hunt for niches the shop can win in. Reply in 1-3 sentences, opinionated about demand signals, competition, and printability fit. Don't fabricate specific listing numbers — if asked for them, say you'd need to look them up.",
        "designer" => "You are the Designer at an AI-run 3D-asset shop. You translate Demand Briefs into concrete generation prompts for Tripo / Meshy / Nano Banana Pro. Reply in 1-3 sentences with strong opinions on style, stylization, printability, and composition. Stay in a designer's voice.",
        "listing" => "You are the Listing Copywriter at an AI-run 3D-asset Etsy shop. You write titles, tags, descriptions, and prices. Reply in 1-3 sentences with opinions about SEO, pricing psychology, buyer intent, and Etsy policy. Stay in a copywriter's voice.",
        "publisher" => "You are the Publisher at an AI-run 3D-asset shop. You push approved drafts to Etsy, Cults3D, Sketchfab, MyMiniFactory, and Gumroad. Reply in 1-3 sentences with opinions about marketplace fit, publishing cadence, and quality gates.",
        "cfo" => "You are the CFO at an AI-run 3D-asset shop. You track every dollar: token spend, generation credits, listing fees, revenue. Reply in 1-3 sentences with opinions on budget, runway, and P&L per niche. Never invent specific numbers — if asked for figures you'd need DB access for, say so.",
        "cs" => "You are Customer Support at an AI-run 3D-asset shop. You answer buyer DMs and handle returns / print-issue conversations. Reply in 1-3 sentences in a friendly professional voice — opinions about buyer sentiment, conversation quality, and refund policy.",
        "si" => "You are the Self-Improvement engine at an AI-run 3D-asset shop. You read recent outcomes and tune the team's system prompts to improve revenue. Reply in 1-3 sentences with opinions on what's working, what to tune next, and why the current overrides are what they are.",
        "strategist" => "You are the Design Strategist at an AI-run 3D-asset shop. You rewrite the Designer's system prompt to nudge it toward better-converting design choices. Reply in 1-3 sentences with opinions about composition, palette, audience, and what recent outcomes suggest you should change.",
        "guardian" => "You are the Guardian at an AI-run 3D-asset shop. You watch IP risk, content safety, and policy compliance across the pipeline. Reply in 1-3 sentences with opinions about trademark exposure, mythology / character / franchise lines, and what to escalate for manual review.",
        _ => "You are an AI staff member at an operator-run AI Etsy shop. Reply in 1-3 sentences, in-character. If the operator asks for specific data you'd need DB access to provide, say so plainly.",
    }
}

#[derive(serde::Deserialize)]
pub struct ChatTurn {
    pub from: String,  // "user" or "agent"
    pub text: String,
}

#[derive(serde::Serialize)]
pub struct ChatReply {
    pub text: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub model: String,
}

/// Have a conversational turn with an agent. The frontend owns history;
/// this command is stateless. Routes through the user's bridge proxy with
/// `anthropic_bridge_key` (NEVER a direct Anthropic key) so spend lands on
/// the same billing the workers use.
#[tauri::command]
pub async fn cmd_chat_with_agent(
    agent_id: String,
    history: Vec<ChatTurn>,
    message: String,
) -> Result<ChatReply, String> {
    let kind = role_kind_from_id(&agent_id);
    let persona = chat_persona_for(&kind);

    let bridge_url = secrets::get("anthropic_bridge_url")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "anthropic_bridge_url not set in secrets".to_string())?;
    let bridge_key = secrets::get("anthropic_bridge_key")
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "anthropic_bridge_key not set in secrets".to_string())?;

    // Build the Anthropic messages array from history. Skip empty entries
    // defensively — early-development UI sometimes left those around.
    let mut messages: Vec<serde_json::Value> = history
        .into_iter()
        .filter(|t| !t.text.trim().is_empty())
        .map(|t| {
            let role = if t.from == "user" { "user" } else { "assistant" };
            serde_json::json!({"role": role, "content": t.text})
        })
        .collect();
    // Anthropic requires the conversation to end with a user turn.
    let trimmed_msg = message.trim();
    if trimmed_msg.is_empty() {
        return Err("empty message".to_string());
    }
    messages.push(serde_json::json!({"role": "user", "content": trimmed_msg}));

    let model = "claude-haiku-4-5-20251001";
    let body = serde_json::json!({
        "model": model,
        "max_tokens": 400,
        "system": persona,
        "messages": messages,
    });
    let url = format!("{}/v1/messages", bridge_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("x-api-key", &bridge_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("chat: bridge network error: {e}"))?;
    let status = resp.status();
    let raw = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        // Keep the upstream body — bridge / Anthropic error envelopes carry
        // the actual diagnostic (quota, key invalid, etc.).
        return Err(format!("chat: bridge HTTP {status}: {}", raw.chars().take(400).collect::<String>()));
    }
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("chat: parse response: {e}: {raw}"))?;

    // Take the first text block from content[].
    let text = parsed.get("content")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.iter().find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text")))
        .and_then(|b| b.get("text"))
        .and_then(|t| t.as_str())
        .map(String::from)
        .ok_or_else(|| format!("chat: no text block in response: {raw}"))?;

    let usage = parsed.get("usage");
    let tokens_in = usage.and_then(|u| u.get("input_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);
    let tokens_out = usage.and_then(|u| u.get("output_tokens")).and_then(|v| v.as_u64()).unwrap_or(0);

    // Record spend so chat lands on the same hourly/daily/monthly cap the
    // workers track against. Fire-and-forget; if the recorder isn't
    // available we still return the reply.
    // (No project_id plumbed into this command yet — chat is "free-standing"
    //  and the budget ledger logs spend per project; for now skip if absent.
    //  TODO: thread project_id once chat becomes a regular activity.)

    Ok(ChatReply {
        text,
        tokens_in,
        tokens_out,
        model: model.to_string(),
    })
}

// ---------- Telegram rater bot config ----------
//
// telegram.json lives in ~/.agent-factory/ (same dir as outcomes.jsonl /
// ratings.jsonl) so the Python rater bot can read it without any IPC.
// Shape: { "bot_token": "...", "chat_id": <int>, "enabled": <bool> }.
//
// We persist it as a plain file (not the secrets table) so the worker —
// which has no SQLite-secrets access path — can pick it up directly.

fn telegram_config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    let data_dir = std::env::var("AGENT_FACTORY_DATA")
        .unwrap_or_else(|_| format!("{home}/.agent-factory"));
    PathBuf::from(data_dir).join("telegram.json")
}

#[derive(Default, serde::Serialize, serde::Deserialize)]
struct TelegramConfig {
    #[serde(default)]
    bot_token: String,
    #[serde(default)]
    chat_id: Option<i64>,
    #[serde(default = "default_true")]
    enabled: bool,
    #[serde(default)]
    bot_username: Option<String>,
}

fn default_true() -> bool {
    true
}

fn read_telegram_config() -> TelegramConfig {
    let path = telegram_config_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<TelegramConfig>(&s).ok())
        .unwrap_or_default()
}

fn write_telegram_config(cfg: &TelegramConfig) -> Result<(), String> {
    let path = telegram_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct TelegramStatus {
    pub creds_present: bool,
    pub bot_username: Option<String>,
    pub chat_id: Option<i64>,
    pub enabled: bool,
}

#[derive(Serialize)]
pub struct TelegramVerifyOk {
    pub bot_username: String,
}

#[tauri::command]
pub async fn cmd_telegram_status() -> Result<TelegramStatus, String> {
    let cfg = read_telegram_config();
    let creds_present = !cfg.bot_token.is_empty() && cfg.chat_id.is_some();
    Ok(TelegramStatus {
        creds_present,
        bot_username: cfg.bot_username,
        chat_id: cfg.chat_id,
        enabled: cfg.enabled,
    })
}

/// Validate (bot_token, chat_id) by hitting Telegram's getMe endpoint with
/// the token, then persist the pair to telegram.json. The chat_id is not
/// re-validated against Telegram — it's a numeric id the user pasted from
/// getUpdates, and the rater bot will surface any send failures.
#[tauri::command]
pub async fn cmd_telegram_verify(
    bot_token: String,
    chat_id: i64,
) -> Result<TelegramVerifyOk, String> {
    let token = bot_token.trim();
    if token.is_empty() {
        return Err("bot_token is required".into());
    }
    if chat_id == 0 {
        return Err("chat_id must be a non-zero integer".into());
    }
    let url = format!("https://api.telegram.org/bot{token}/getMe");
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("telegram getMe network error: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("telegram getMe HTTP {status}: {body}"));
    }
    let v: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("parse getMe: {e}"))?;
    if !v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
        return Err(format!("telegram getMe rejected: {body}"));
    }
    let bot_username = v
        .pointer("/result/username")
        .and_then(|x| x.as_str())
        .ok_or("telegram getMe response missing result.username")?
        .to_string();

    let cfg = TelegramConfig {
        bot_token: token.to_string(),
        chat_id: Some(chat_id),
        enabled: true,
        bot_username: Some(bot_username.clone()),
    };
    write_telegram_config(&cfg)?;
    Ok(TelegramVerifyOk { bot_username })
}

#[tauri::command]
pub async fn cmd_telegram_set_enabled(enabled: bool) -> Result<(), String> {
    let mut cfg = read_telegram_config();
    cfg.enabled = enabled;
    write_telegram_config(&cfg)
}

#[tauri::command]
pub async fn cmd_telegram_disconnect() -> Result<(), String> {
    let path = telegram_config_path();
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
