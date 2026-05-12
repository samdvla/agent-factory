pub mod budget;
pub mod commands;
pub mod db;
pub mod etsy;
pub mod etsy_ingest;
pub mod etsy_polling;
pub mod etsy_publish;
pub mod events;
pub mod heartbeat;
pub mod llm;
pub mod oauth_server;
pub mod pnl;
pub mod prompts;
pub mod queue;
pub mod raster;
pub mod secrets;
pub mod supervisor;
pub mod worker;

use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&app_data_dir).ok();
            let db_path = app_data_dir.join("db.sqlite");

            let pool = tauri::async_runtime::block_on(async {
                db::open(&db_path).await.expect("open db")
            });

            let project_id: i64 = tauri::async_runtime::block_on(async {
                let existing: Option<i64> = sqlx::query_scalar(
                    "SELECT id FROM projects WHERE name = 'default' LIMIT 1"
                ).fetch_optional(&pool).await.expect("query project");
                if let Some(id) = existing {
                    id
                } else {
                    sqlx::query_scalar(
                        "INSERT INTO projects (name, goal, status) VALUES ('default','sandbox','active') RETURNING id"
                    ).fetch_one(&pool).await.expect("insert project")
                }
            });

            let bus = events::EventBus::new();
            let state = Arc::new(commands::AppState {
                pool: pool.clone(),
                bus: bus.clone(),
                project_id,
                supervisor_handle: tokio::sync::Mutex::new(None),
                pending_oauth: tokio::sync::Mutex::new(std::collections::HashMap::new()),
                oauth_task: tokio::sync::Mutex::new(None),
            });

            commands::forward_events_to_window(app.handle().clone(), bus.clone());

            // Migrate legacy mock_etsy.json → publisher_output.json once on
            // startup. Silently ignored if the old file does not exist or the
            // rename fails (e.g. new file already present).
            {
                let data_dir = std::env::var("AGENT_FACTORY_DATA")
                    .unwrap_or_else(|_| {
                        let home = std::env::var("HOME").unwrap_or_default();
                        format!("{home}/.agent-factory")
                    });
                let old_path = std::path::PathBuf::from(&data_dir).join("mock_etsy.json");
                let new_path = std::path::PathBuf::from(&data_dir).join("publisher_output.json");
                if old_path.exists() && !new_path.exists() {
                    if let Err(e) = std::fs::rename(&old_path, &new_path) {
                        tracing::warn!("mock_etsy.json migration failed: {e}");
                    }
                }
            }

            // Migrate old single-field bridge config to the split pair.
            // If the user had anthropic_base_url set and anthropic_api_key
            // starting with "brg_", move them into the new dedicated slots and
            // delete the old keys. Idempotent: a second run finds the old keys
            // absent and skips silently.
            {
                let old_url = secrets::get("anthropic_base_url").ok().flatten();
                let old_key = secrets::get("anthropic_api_key").ok().flatten();
                if let (Some(url), Some(key)) = (old_url, old_key) {
                    if !url.is_empty() && key.starts_with("brg_") {
                        if let Err(e) = secrets::set("anthropic_bridge_url", &url) {
                            tracing::warn!("bridge migration: failed to set anthropic_bridge_url: {e}");
                        } else if let Err(e) = secrets::set("anthropic_bridge_key", &key) {
                            tracing::warn!("bridge migration: failed to set anthropic_bridge_key: {e}");
                        } else {
                            let _ = secrets::delete("anthropic_base_url");
                            let _ = secrets::delete("anthropic_api_key");
                            tracing::info!("bridge migration: moved anthropic_base_url + anthropic_api_key -> anthropic_bridge_url + anthropic_bridge_key");
                        }
                    }
                }
            }

            // Supervisor does NOT auto-start. The user must click Start in the
            // top bar, which calls cmd_start_supervisor. This keeps idle spend
            // at zero — no jobs are enqueued until the user explicitly acts.

            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::cmd_status,
            commands::cmd_set_secret,
            commands::cmd_get_secret,
            commands::cmd_start_supervisor,
            commands::cmd_stop_supervisor,
            commands::cmd_enqueue,
            commands::cmd_etsy_start_oauth,
            commands::cmd_etsy_status,
            commands::cmd_etsy_last_error,
            commands::cmd_etsy_clear_last_error,
            commands::cmd_etsy_disconnect,
            commands::cmd_etsy_set_enabled,
            commands::cmd_etsy_get_enabled,
            commands::cmd_etsy_set_listing_cap,
            commands::cmd_etsy_get_listing_cap,
            commands::cmd_etsy_list_publishes,
            commands::cmd_etsy_activate_listing,
            commands::cmd_etsy_kill_switch,
            commands::cmd_list_recent_cycles,
            commands::cmd_list_wealth,
            commands::cmd_list_prompts,
            commands::cmd_set_prompt_override,
            commands::cmd_clear_prompt_override,
            commands::cmd_prompt_history,
            commands::cmd_read_asset_svg,
            commands::cmd_etsy_listing_review_info,
            commands::cmd_etsy_discard_draft,
            commands::cmd_budget_status,
            commands::cmd_start_smoke_test,
            commands::cmd_resume_from_smoke_test,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
