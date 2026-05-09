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
                pool: pool.clone(),
                bus: bus.clone(),
                project_id,
                supervisor_handle: tokio::sync::Mutex::new(None),
            });

            commands::forward_events_to_window(app.handle().clone(), bus.clone());

            // Auto-start the supervisor so the floor is live the moment the
            // window paints. Failures are non-fatal — the user can still hit
            // Start in the top bar to retry.
            let api_key = secrets::get("anthropic_api_key")
                .ok()
                .flatten()
                .unwrap_or_default();

            let auto_state = state.clone();
            let pool_for_job = pool.clone();
            let project_id_for_job = project_id;
            tauri::async_runtime::spawn(async move {
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
                    make_spec("si", "si"),
                ];
                match supervisor::start(pool_for_job.clone(), bus, agents, project_id_for_job).await {
                    Ok(handle) => {
                        let mut guard = auto_state.supervisor_handle.lock().await;
                        *guard = Some(handle);
                        tracing::info!("supervisor auto-started");

                        // Auto-enqueue an orchestrator job to kick off the full pipeline.
                        let pool_boot = pool_for_job.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                            if let Err(e) = queue::enqueue(
                                &pool_boot,
                                project_id_for_job,
                                "orchestrator",
                                serde_json::json!({"trigger": "boot"}),
                            ).await {
                                tracing::warn!("auto-enqueue orchestrator failed: {e}");
                            }
                        });

                        // Fake buyer message generator — fires a CS job every 90s with a
                        // random topic. Gives the CS agent something to do until real Etsy
                        // messages flow in.
                        let pool_for_cs = pool_for_job.clone();
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
                                // Pick a topic deterministically by time so it varies.
                                let idx = (std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_secs())
                                    .unwrap_or(0) as usize) % topics.len();
                                let payload = serde_json::json!({
                                    "buyer_message": topics[idx],
                                    "trigger": "fake_message",
                                });
                                if let Err(e) = queue::enqueue(&pool_for_cs, project_id_for_job, "cs", payload).await {
                                    tracing::warn!("fake message enqueue failed: {e}");
                                }
                            }
                        });

                        // SI loop — every 5 minutes, ask the SI agent to inspect recent
                        // outcomes and propose at most one prompt tweak. The agent itself
                        // skips if there aren't enough outcomes yet.
                        let pool_for_si = pool_for_job.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                            let mut interval = tokio::time::interval(std::time::Duration::from_secs(300));
                            interval.tick().await; // skip the immediate first tick
                            loop {
                                interval.tick().await;
                                let payload = serde_json::json!({"trigger": "loop_b"});
                                if let Err(e) = queue::enqueue(&pool_for_si, project_id_for_job, "si", payload).await {
                                    tracing::warn!("si enqueue failed: {e}");
                                }
                            }
                        });
                    }
                    Err(e) => tracing::error!("supervisor auto-start failed: {e}"),
                }
            });

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
