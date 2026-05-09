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
                    run_worker_loop(&spec.role, worker, &pool, &bus, &mut shutdown_rx, project_id).await;

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
) -> bool {
    // Poll interval for claiming the next job when the queue is empty.
    let mut poll_interval = tokio::time::interval(Duration::from_millis(250));
    poll_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

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
                                bus.send(SupervisorEvent::JobCompleted {
                                    role: role.into(),
                                    job_id,
                                    result,
                                });
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
