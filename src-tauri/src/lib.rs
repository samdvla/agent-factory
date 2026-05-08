pub mod budget;
pub mod commands;
pub mod db;
pub mod events;
pub mod heartbeat;
pub mod llm;
pub mod queue;
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
                pool,
                bus: bus.clone(),
                project_id,
                supervisor_handle: tokio::sync::Mutex::new(None),
            });
            app.manage(state);

            commands::forward_events_to_window(app.handle().clone(), bus);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::cmd_status,
            commands::cmd_set_secret,
            commands::cmd_get_secret,
            commands::cmd_start_supervisor,
            commands::cmd_stop_supervisor,
            commands::cmd_enqueue,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
