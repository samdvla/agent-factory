use crate::budget;
use crate::events::{EventBus, SupervisorEvent};
use crate::queue;
use crate::worker::{Worker, WorkerEvent};
use serde_json::json;
use sqlx::SqlitePool;
use std::time::Duration;
use tokio::task::JoinHandle;

#[derive(Clone, Debug)]
pub struct AgentSpec {
    pub role: String,
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub struct SupervisorHandle {
    shutdown_tx: tokio::sync::watch::Sender<bool>,
    join_handles: Vec<JoinHandle<()>>,
}

impl SupervisorHandle {
    pub async fn shutdown(mut self) {
        let _ = self.shutdown_tx.send(true);
        for h in self.join_handles.drain(..) {
            let _ = h.await;
        }
    }
}

pub async fn start(
    pool: SqlitePool,
    bus: EventBus,
    agents: Vec<AgentSpec>,
    project_id: i64,
    daily_cap_usd: f64,
) -> anyhow::Result<SupervisorHandle> {
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let mut handles = Vec::new();

    for spec in agents {
        let pool = pool.clone();
        let bus = bus.clone();
        let mut shutdown_rx = shutdown_rx.clone();
        let handle = tokio::spawn(async move {
            let mut backoff = Duration::from_millis(500);
            loop {
                if *shutdown_rx.borrow() {
                    break;
                }

                let args_str: Vec<&str> = spec.args.iter().map(|s| s.as_str()).collect();
                let env_str: Vec<(&str, &str)> = spec.env.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                let worker = match Worker::spawn(&spec.program, &args_str, &env_str).await {
                    Ok(w) => {
                        bus.send(SupervisorEvent::AgentStarted {
                            role: spec.role.clone(),
                        });
                        backoff = Duration::from_millis(500);
                        w
                    }
                    Err(e) => {
                        tracing::error!("spawn failed for {}: {e}", spec.role);
                        tokio::time::sleep(backoff).await;
                        backoff = (backoff * 2).min(Duration::from_secs(60));
                        continue;
                    }
                };

                let crashed =
                    run_worker_loop(&spec.role, worker, &pool, &bus, &mut shutdown_rx, project_id, daily_cap_usd).await;

                bus.send(SupervisorEvent::AgentExited {
                    role: spec.role.clone(),
                    code: None,
                });

                if *shutdown_rx.borrow() {
                    break;
                }

                if crashed {
                    tokio::time::sleep(backoff).await;
                    backoff = (backoff * 2).min(Duration::from_secs(60));
                }
            }
        });
        handles.push(handle);
    }

    Ok(SupervisorHandle {
        shutdown_tx,
        join_handles: handles,
    })
}

/// Returns `true` if the worker crashed (should restart with backoff),
/// `false` if it exited cleanly due to a shutdown signal.
async fn run_worker_loop(
    role: &str,
    mut worker: Worker,
    pool: &SqlitePool,
    bus: &EventBus,
    shutdown_rx: &mut tokio::sync::watch::Receiver<bool>,
    project_id: i64,
    daily_cap_usd: f64,
) -> bool {
    // Poll interval for claiming the next job when the queue is empty.
    let mut poll_interval = tokio::time::interval(Duration::from_millis(250));
    poll_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Track which UTC day we last emitted BudgetCapped for, so we don't spam.
    let mut last_capped_day: Option<String> = None;

    loop {
        if *shutdown_rx.borrow() {
            let _ = worker.shutdown().await;
            return false;
        }

        // Use select! to interleave job claims with draining worker events
        // (notifications / stderr) without holding any lock across an await.
        tokio::select! {
            biased;

            // Drain worker events (notifications, stderr, unexpected exit).
            evt = worker.next_event() => {
                match evt {
                    Some(WorkerEvent::Notification { method, params }) => {
                        if method == "enqueue_handoff" {
                            let to_role = params.get("to_role")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let payload = params.get("payload")
                                .cloned()
                                .unwrap_or(serde_json::json!({}));
                            let delay_ms = params.get("delay_ms")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0);
                            if !to_role.is_empty() {
                                let pool_clone = pool.clone();
                                let from_role = role.to_string();
                                tokio::spawn(async move {
                                    if delay_ms > 0 {
                                        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                                    }
                                    if let Err(e) = queue::enqueue(&pool_clone, project_id, &to_role, payload).await {
                                        tracing::error!("delayed handoff enqueue failed: {e}");
                                    } else {
                                        tracing::info!("handoff enqueued: {} → {} (delay {}ms)", from_role, to_role, delay_ms);
                                    }
                                });
                            }
                        }
                        bus.send(SupervisorEvent::WorkerNotification {
                            role: role.into(),
                            method,
                            params,
                        });
                    }
                    Some(WorkerEvent::Stderr(line)) => {
                        tracing::debug!("[{role}] stderr: {line}");
                    }
                    Some(WorkerEvent::Exited(_)) | None => {
                        // Worker died unexpectedly while idle — restart.
                        return true;
                    }
                }
            }

            _ = poll_interval.tick() => {
                // Enforce daily budget cap BEFORE claiming the next job. If
                // we're capped, leave the job in the queue and try again in 60s.
                match budget::check_cap(pool, project_id, daily_cap_usd).await {
                    Ok(false) => {
                        let spent = budget::today_spend_usd(pool, project_id).await.unwrap_or(0.0);
                        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
                        if last_capped_day.as_deref() != Some(today.as_str()) {
                            bus.send(SupervisorEvent::BudgetCapped {
                                spent_usd: spent,
                                cap_usd: daily_cap_usd,
                            });
                            last_capped_day = Some(today);
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                        continue;
                    }
                    Ok(true) => {
                        // under cap — proceed to claim
                    }
                    Err(e) => {
                        tracing::error!("budget cap check failed: {e}");
                        // fail-open: keep working rather than wedging the pipeline
                    }
                }
                match queue::claim(pool, role).await {
                    Ok(Some(job)) => {
                        bus.send(SupervisorEvent::JobStarted {
                            role: role.into(),
                            job_id: job.id,
                        });

                        let payload: serde_json::Value =
                            serde_json::from_str(&job.payload_json).unwrap_or(json!({}));
                        let req = json!({"job_id": job.id, "payload": payload});
                        let job_id = job.id;

                        match worker.request("process_job", req).await {
                            Ok(result) => {
                                if let Err(e) = queue::complete(pool, job_id, result.clone()).await {
                                    tracing::error!("complete failed: {e}");
                                }
                                // Emit budget spend if the worker reported token usage.
                                if let (Some(tin), Some(tout), Some(model)) = (
                                    result.get("tokens_in").and_then(|v| v.as_u64()),
                                    result.get("tokens_out").and_then(|v| v.as_u64()),
                                    result.get("model").and_then(|v| v.as_str()),
                                ) {
                                    let cost = budget::cost_usd(model, tin, tout);
                                    if cost > 0.0 {
                                        // Persist to the budget_ledger BEFORE emitting so the
                                        // spend is durable at the moment the event fires.
                                        if let Err(e) = budget::record(pool, project_id, model, tin, tout).await {
                                            tracing::error!("budget::record failed: {e}");
                                        }
                                        bus.send(SupervisorEvent::BudgetSpent {
                                            role: role.into(),
                                            cost_usd: cost,
                                            tokens_in: tin,
                                            tokens_out: tout,
                                            model: model.to_string(),
                                        });
                                    }
                                }
                                bus.send(SupervisorEvent::JobCompleted {
                                    role: role.into(),
                                    job_id,
                                    result: result.clone(),
                                });

                                // CS auto-reply: if a CS job completed with a `reply` +
                                // `conversation_id`, the buyer didn't get escalated, AND
                                // real Etsy publishing is enabled, post the reply back to
                                // the Etsy conversation. All failure modes are non-fatal —
                                // we log and emit a generic warning event.
                                if role == "cs" {
                                    let real_enabled = crate::secrets::get("real_etsy_enabled")
                                        .ok()
                                        .flatten()
                                        .map(|v| v.eq_ignore_ascii_case("true"))
                                        .unwrap_or(false);
                                    let escalate = result
                                        .get("escalate")
                                        .and_then(|v| v.as_bool())
                                        .unwrap_or(false);
                                    let reply = result.get("reply").and_then(|v| v.as_str()).map(str::to_string);
                                    let conversation_id =
                                        result.get("conversation_id").and_then(|v| v.as_i64());
                                    if real_enabled && !escalate {
                                        if let (Some(reply), Some(conversation_id)) = (reply, conversation_id) {
                                            if conversation_id > 0 && !reply.trim().is_empty() {
                                                let status = crate::etsy::load_status();
                                                if let Some(shop_id) = status.shop_id {
                                                    if status.connected {
                                                        let bus_for_reply = bus.clone();
                                                        tokio::spawn(async move {
                                                            let client = reqwest::Client::new();
                                                            match crate::etsy_ingest::post_reply_with_status(
                                                                &client,
                                                                shop_id,
                                                                conversation_id,
                                                                &reply,
                                                            )
                                                            .await
                                                            {
                                                                Ok(()) => {
                                                                    bus_for_reply.send(
                                                                        SupervisorEvent::EtsyReplyPosted {
                                                                            conversation_id,
                                                                        },
                                                                    );
                                                                }
                                                                Err(e) => {
                                                                    tracing::warn!(
                                                                        "etsy post_reply failed for conv {}: {:#}",
                                                                        conversation_id, e
                                                                    );
                                                                    bus_for_reply.send(
                                                                        SupervisorEvent::JobFailed {
                                                                            role: "cs".into(),
                                                                            job_id,
                                                                            error: format!(
                                                                                "etsy reply failed: {:#}",
                                                                                e
                                                                            ),
                                                                        },
                                                                    );
                                                                }
                                                            }
                                                        });
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }

                                // If a publisher job completed AND the operator
                                // has explicitly flipped `real_etsy_enabled=true`,
                                // attempt a real Etsy draft publish in the
                                // background. Default (flag absent/false) is a
                                // full no-op so the sandbox pipeline keeps
                                // running unchanged.
                                if role == "publisher" {
                                    let real_enabled = crate::secrets::get("real_etsy_enabled")
                                        .ok()
                                        .flatten()
                                        .map(|v| v.eq_ignore_ascii_case("true"))
                                        .unwrap_or(false);
                                    if real_enabled {
                                        let bus_for_pub = bus.clone();
                                        let pool_for_pub = pool.clone();
                                        let project_id_for_pub = project_id;
                                        let result_clone = result.clone();
                                        tokio::spawn(async move {
                                            crate::etsy_publish::handle_publisher_complete(
                                                &pool_for_pub,
                                                project_id_for_pub,
                                                &bus_for_pub,
                                                &result_clone,
                                            )
                                            .await;
                                        });
                                    }
                                }

                                // If a designer job produced an SVG asset, kick
                                // off a background rasterization to a sibling
                                // .png at 2048px (Etsy requires raster ≥2000px).
                                if role == "designer" {
                                    if let Some(asset_path_str) = result
                                        .get("asset")
                                        .and_then(|a| a.get("asset_path"))
                                        .and_then(|p| p.as_str())
                                    {
                                        if asset_path_str.ends_with(".svg") {
                                            let path = std::path::PathBuf::from(asset_path_str);
                                            let bus_for_raster = bus.clone();
                                            let raster_job_id = job_id;
                                            tokio::spawn(async move {
                                                // Run on blocking pool — resvg is CPU-bound.
                                                let result = tokio::task::spawn_blocking(move || {
                                                    crate::raster::rasterize_to_sibling(&path)
                                                })
                                                .await;
                                                match result {
                                                    Ok(Ok(Some(png_path))) => {
                                                        let bytes = std::fs::metadata(&png_path)
                                                            .map(|m| m.len())
                                                            .unwrap_or(0);
                                                        bus_for_raster.send(
                                                            SupervisorEvent::AssetRasterized {
                                                                job_id: raster_job_id,
                                                                png_path: png_path
                                                                    .display()
                                                                    .to_string(),
                                                                bytes,
                                                            },
                                                        );
                                                    }
                                                    Ok(Ok(None)) => {
                                                        // already rasterized — silent
                                                    }
                                                    Ok(Err(e)) => {
                                                        tracing::warn!(
                                                            "rasterize failed for job {raster_job_id}: {e:#}"
                                                        );
                                                    }
                                                    Err(e) => {
                                                        tracing::warn!(
                                                            "rasterize task panicked for job {raster_job_id}: {e}"
                                                        );
                                                    }
                                                }
                                            });
                                        }
                                    }
                                }
                            }
                            Err(e) => {
                                let err_str = e.to_string();
                                let _ = queue::fail(pool, job_id, &err_str).await;
                                bus.send(SupervisorEvent::JobFailed {
                                    role: role.into(),
                                    job_id,
                                    error: err_str,
                                });
                                // Worker may be hung — kill and restart.
                                let _ = worker.shutdown().await;
                                return true;
                            }
                        }
                    }
                    Ok(None) => {
                        // Queue empty; next tick will try again.
                    }
                    Err(e) => {
                        tracing::error!("claim error: {e}");
                    }
                }
            }

            _ = shutdown_rx.changed() => {
                let _ = worker.shutdown().await;
                return false;
            }
        }
    }
}
