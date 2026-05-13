pub mod asset_host_github;
pub mod budget;
pub mod commands;
pub mod cults3d;
pub mod cults3d_publish;
pub mod db;
pub mod etsy;
pub mod etsy_ingest;
pub mod etsy_polling;
pub mod etsy_publish;
pub mod events;
pub mod gumroad;
pub mod gumroad_publish;
pub mod heartbeat;
pub mod llm;
pub mod mmf_oauth;
pub mod myminifactory;
pub mod myminifactory_publish;
pub mod oauth_server;
pub mod pinterest;
pub mod pinterest_publish;
pub mod pnl;
pub mod pod_publish;
pub mod printify;
pub mod prompts;
pub mod queue;
pub mod raster;
pub mod revenue;
pub mod secrets;
pub mod sketchfab;
pub mod sketchfab_publish;
pub mod supervisor;
pub mod worker;

use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Default to `info` so app-level tracing::info/warn/error always reach the
    // terminal in dev — without RUST_LOG, the prior `from_default_env()` was
    // an empty filter and our diagnostic messages went nowhere. RUST_LOG
    // still overrides this when set.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,agent_factory_lib=debug")),
        )
        .init();

    tauri::Builder::default()
        // Initialize the opener plugin so JS-side `openUrl(...)` works.
        // Without this Tauri 2 throws "plugin opener not found" the moment
        // any caller tries to launch a system browser (Etsy OAuth, MMF
        // OAuth, listing external-link buttons, etc.). The plugin crate +
        // capability permission were already in the build manifest;
        // initializing it here is the missing wire.
        .plugin(tauri_plugin_opener::init())
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

                // Write the SQLite db path to ~/.agent-factory/db_path.txt so
                // Python workers (rater_bot) can find the same database
                // without hardcoding Tauri's platform-specific app_data_dir.
                std::fs::create_dir_all(&data_dir).ok();
                let path_file = std::path::PathBuf::from(&data_dir).join("db_path.txt");
                if let Some(s) = db_path.to_str() {
                    let _ = std::fs::write(&path_file, s);
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
            commands::cmd_etsy_resync_listings,
            commands::cmd_resync_all_marketplaces,
            commands::cmd_resync_marketplace,
            commands::cmd_etsy_kill_switch,
            commands::cmd_list_recent_cycles,
            commands::cmd_list_wealth,
            commands::cmd_list_prompts,
            commands::cmd_set_prompt_override,
            commands::cmd_clear_prompt_override,
            commands::cmd_prompt_history,
            commands::cmd_agent_steer_roles,
            commands::cmd_agent_steer_add,
            commands::cmd_agent_steer_list,
            commands::cmd_agent_steer_clear,
            commands::cmd_agent_steer_save_image,
            commands::cmd_read_asset_svg,
            commands::cmd_etsy_listing_review_info,
            commands::cmd_etsy_discard_draft,
            commands::cmd_etsy_regenerate_draft,
            commands::cmd_etsy_reject_draft,
            commands::cmd_etsy_restore_rejected,
            commands::cmd_etsy_cancel_regeneration,
            commands::cmd_etsy_list_rejections,
            commands::cmd_budget_status,
            commands::cmd_start_smoke_test,
            commands::cmd_resume_from_smoke_test,
            commands::cmd_list_recent_jobs,
            commands::cmd_count_recent_jobs,
            commands::cmd_today_stats,
            commands::cmd_rate_job,
            commands::cmd_chat_with_agent,
            commands::cmd_read_job_svg,
            commands::cmd_unrated_job_count,
            commands::cmd_printify_verify,
            commands::cmd_printify_status,
            commands::cmd_post_agent_message,
            commands::cmd_list_agent_messages,
            commands::cmd_agent_messages_since,
            commands::cmd_tripo_verify,
            commands::cmd_tripo_status,
            commands::cmd_meshy_verify,
            commands::cmd_meshy_status,
            commands::cmd_cults3d_verify,
            commands::cmd_cults3d_set_enabled,
            commands::cmd_cults3d_status,
            commands::cmd_cults3d_set_daily_cap,
            commands::cmd_cults3d_list_publishes,
            commands::cmd_pinterest_verify,
            commands::cmd_pinterest_set_enabled,
            commands::cmd_pinterest_set_daily_cap,
            commands::cmd_pinterest_disconnect,
            commands::cmd_pinterest_status,
            commands::cmd_pinterest_list_pins,
            commands::cmd_sketchfab_verify,
            commands::cmd_sketchfab_set_enabled,
            commands::cmd_sketchfab_status,
            commands::cmd_sketchfab_set_daily_cap,
            commands::cmd_sketchfab_set_sell_on_store,
            commands::cmd_sketchfab_list_publishes,
            commands::cmd_gumroad_verify,
            commands::cmd_gumroad_set_enabled,
            commands::cmd_gumroad_status,
            commands::cmd_gumroad_set_daily_cap,
            commands::cmd_gumroad_list_publishes,
            commands::cmd_mmf_verify,
            commands::cmd_mmf_set_enabled,
            commands::cmd_mmf_set_sell_paid,
            commands::cmd_mmf_status,
            commands::cmd_mmf_set_daily_cap,
            commands::cmd_mmf_list_publishes,
            commands::cmd_mmf_start_oauth,
            commands::cmd_mmf_disconnect,
            commands::cmd_mmf_last_oauth_error,
            commands::cmd_youtube_verify,
            commands::cmd_youtube_status,
            commands::cmd_higgsfield_status,
            commands::cmd_higgsfield_set_enabled,
            commands::cmd_github_asset_host_verify,
            commands::cmd_read_job_asset,
            commands::cmd_read_listing_asset,
            commands::cmd_get_shop_focus,
            commands::cmd_set_shop_focus,
            commands::cmd_get_character_pool,
            commands::cmd_set_character_pool,
            commands::cmd_get_image_to_3d_provider,
            commands::cmd_set_image_to_3d_provider,
            commands::cmd_google_verify,
            commands::cmd_google_status,
            commands::cmd_telegram_status,
            commands::cmd_telegram_verify,
            commands::cmd_telegram_set_enabled,
            commands::cmd_telegram_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
