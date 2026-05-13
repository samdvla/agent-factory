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
    caps: budget::BudgetCaps,
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
                    run_worker_loop(&spec.role, worker, &pool, &bus, &mut shutdown_rx, project_id, caps).await;

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
    caps: budget::BudgetCaps,
) -> bool {
    // Poll interval for claiming the next job when the queue is empty.
    let mut poll_interval = tokio::time::interval(Duration::from_millis(250));
    poll_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // Track which UTC day we last emitted BudgetCapped for, so we don't spam.
    let mut last_capped_day: Option<chrono::NaiveDate> = None;

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
                // Smoke-test 10-minute timeout: if a smoke cycle is in flight and has
                // been running > 10 minutes, emit TimedOut, set the pause flag, and
                // clear the start markers.
                if let (Some(started), Some(cycle_id)) = (
                    crate::secrets::get("smoke_started_at").ok().flatten().filter(|s| !s.is_empty()).and_then(|s| s.parse::<i64>().ok()),
                    crate::secrets::get("smoke_cycle_id").ok().flatten().filter(|s| !s.is_empty()),
                ) {
                    if chrono::Utc::now().timestamp() - started > 600 {
                        bus.send(SupervisorEvent::SmokeTestCycleComplete {
                            cycle_id: cycle_id.clone(),
                            listing_id: None,
                            spend_usd: 0.0,
                            duration_ms: 600_000,
                            status: crate::events::SmokeTestStatus::TimedOut,
                        });
                        let _ = crate::secrets::set("smoke_pause_until", "1");
                        let _ = crate::secrets::delete("smoke_cycle_id");
                        let _ = crate::secrets::delete("smoke_started_at");
                    }
                }

                // Enforce multi-tier caps BEFORE claiming the next job.
                // Pre-flight estimate: assume up to 1500 input tokens + 800 output for
                // an average job (conservative for haiku, low for sonnet/opus).
                let est = budget::estimate_cost("claude-sonnet-4-6", 1500, 800);
                match budget::enforce_caps(pool, project_id, caps, est).await {
                    Ok(budget::CapOutcome::Capped { scope, spent_usd, cap_usd }) => {
                        let today_utc = chrono::Utc::now().date_naive();
                        if last_capped_day != Some(today_utc) {
                            bus.send(SupervisorEvent::BudgetCapped {
                                spent_usd, cap_usd, scope,
                            });
                            last_capped_day = Some(today_utc);
                        }
                        continue;
                    }
                    Ok(budget::CapOutcome::Ok) => {}
                    Err(e) => {
                        tracing::error!("enforce_caps errored: {e}");
                        continue;
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
                                // Persist + emit spend; emit Unreported if the worker
                                // succeeded but didn't return token usage.
                                let tin = result.get("tokens_in").and_then(|v| v.as_u64());
                                let tout = result.get("tokens_out").and_then(|v| v.as_u64());
                                let model = result.get("model").and_then(|v| v.as_str());
                                match (tin, tout, model) {
                                    (Some(tin), Some(tout), Some(model)) => {
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

                                            // Per-cycle P&L: attribute this job's
                                            // cost to its pipeline cycle. Fire-and-
                                            // forget on a tokio task so the worker
                                            // loop never blocks on a DB write.
                                            if let Some(cycle_id_str) = result.get("cycle_id").and_then(|v| v.as_str()) {
                                                let pool_for_pnl = pool.clone();
                                                let project_id_for_pnl = project_id;
                                                let role_for_pnl = role.to_string();
                                                let cycle_for_pnl = cycle_id_str.to_string();
                                                let tin_i = tin as i64;
                                                let tout_i = tout as i64;
                                                let cost_for_pnl = cost;
                                                let model_for_pnl = model.to_string();
                                                let niche_for_pnl: Option<String> = result
                                                    .get("niche_seed")
                                                    .or_else(|| result.get("brief").and_then(|b| b.get("niche")))
                                                    .or_else(|| result.get("niche"))
                                                    .and_then(|v| v.as_str())
                                                    .map(String::from);
                                                tokio::spawn(async move {
                                                    let _ = crate::pnl::ensure_cycle(
                                                        &pool_for_pnl,
                                                        project_id_for_pnl,
                                                        &cycle_for_pnl,
                                                        niche_for_pnl.as_deref(),
                                                    )
                                                    .await;
                                                    if let Err(e) = crate::pnl::record_contribution(
                                                        &pool_for_pnl,
                                                        project_id_for_pnl,
                                                        &cycle_for_pnl,
                                                        &role_for_pnl,
                                                        job_id,
                                                        cost_for_pnl,
                                                        tin_i,
                                                        tout_i,
                                                        Some(&model_for_pnl),
                                                    )
                                                    .await
                                                    {
                                                        tracing::warn!("pnl record_contribution failed: {e}");
                                                    }
                                                });
                                            }
                                        }
                                    }
                                    _ => {
                                        bus.send(SupervisorEvent::BudgetUnreported {
                                            role: role.into(),
                                            job_id,
                                        });
                                    }
                                }
                                bus.send(SupervisorEvent::JobCompleted {
                                    role: role.into(),
                                    job_id,
                                    result: result.clone(),
                                });

                                // Agent-to-agent message logging. Workers can
                                // attach a top-level `messages` array of
                                // {from, to, topic?, content, importance?} to
                                // teach / nudge other agents. Mirror each into
                                // the agent_messages table so the UI can show a
                                // conversation log.
                                if let Some(msgs) = result.get("messages").and_then(|v| v.as_array()) {
                                    let pool_msgs = pool.clone();
                                    let bus_msgs = bus.clone();
                                    let role_msgs = role.to_string();
                                    let msgs_owned: Vec<serde_json::Value> = msgs.clone();
                                    let job_id_msgs = job_id;
                                    let project_id_msgs = project_id;
                                    tokio::spawn(async move {
                                        let now = chrono::Utc::now().timestamp();
                                        for m in &msgs_owned {
                                            let from = m.get("from").and_then(|v| v.as_str())
                                                .unwrap_or(role_msgs.as_str()).to_string();
                                            let to = m.get("to").and_then(|v| v.as_str())
                                                .unwrap_or("*").to_string();
                                            let topic = m.get("topic").and_then(|v| v.as_str()).map(String::from);
                                            let content = m.get("content").and_then(|v| v.as_str())
                                                .unwrap_or("").to_string();
                                            if content.is_empty() { continue; }
                                            let importance = m.get("importance").and_then(|v| v.as_str())
                                                .filter(|i| matches!(*i, "info" | "heads_up" | "critical"))
                                                .unwrap_or("info").to_string();
                                            let job_link = m.get("job_id").and_then(|v| v.as_i64())
                                                .or(Some(job_id_msgs));
                                            let insert = sqlx::query(
                                                "INSERT INTO agent_messages \
                                                 (project_id, from_role, to_role, topic, content, importance, job_id, ts) \
                                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                            )
                                            .bind(project_id_msgs)
                                            .bind(&from)
                                            .bind(&to)
                                            .bind(&topic)
                                            .bind(&content)
                                            .bind(&importance)
                                            .bind(job_link)
                                            .bind(now)
                                            .execute(&pool_msgs)
                                            .await;
                                            if let Err(e) = insert {
                                                tracing::warn!("agent_messages insert failed: {e}");
                                                continue;
                                            }
                                            bus_msgs.send(SupervisorEvent::WorkerNotification {
                                                role: from.clone(),
                                                method: "agent_message".into(),
                                                params: serde_json::json!({
                                                    "from": from,
                                                    "to": to,
                                                    "topic": topic,
                                                    "content": content,
                                                    "importance": importance,
                                                    "ts": now,
                                                }),
                                            });
                                        }
                                    });
                                }

                                // CFO closes the pipeline cycle: sum contributions,
                                // compute true net (using gross_usd so Etsy fees are
                                // excluded from cost-margin math), distribute wealth.
                                // Background task so the worker loop never blocks.
                                if role == "cfo" {
                                    if let (Some(cycle_id_str), Some(revenue)) = (
                                        result.get("cycle_id").and_then(|v| v.as_str()),
                                        result.get("gross_usd").and_then(|v| v.as_f64()),
                                    ) {
                                        let pool_close = pool.clone();
                                        let bus_close = bus.clone();
                                        let project_id_close = project_id;
                                        let cycle_close = cycle_id_str.to_string();
                                        let local_id: Option<i64> =
                                            result.get("listing_id").and_then(|v| v.as_i64());
                                        tokio::spawn(async move {
                                            // Give cfo's own contribution INSERT a moment to land
                                            // before we read the contributions table.
                                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                            match crate::pnl::close_cycle(
                                                &pool_close,
                                                project_id_close,
                                                &cycle_close,
                                                revenue,
                                                local_id,
                                            )
                                            .await
                                            {
                                                Ok(summary) => {
                                                    bus_close.send(SupervisorEvent::PnlCycleClosed {
                                                        cycle_id: summary.cycle_id.clone(),
                                                        niche: summary.niche.clone(),
                                                        revenue_usd: summary.revenue_usd,
                                                        total_cost_usd: summary.total_cost_usd,
                                                        net_usd: summary.net_usd,
                                                        contributor_count: summary.contributor_count,
                                                    });
                                                }
                                                Err(e) => tracing::warn!("pnl close_cycle failed: {e}"),
                                            }
                                        });
                                    }

                                    // Continuous-cycle hook: when autonomous loops are
                                    // enabled and a CFO cycle just closed, queue the
                                    // next orchestrator job after a small dwell so the
                                    // floor never goes idle. Smoke-test cycles set
                                    // `smoke_cycle_id` and intentionally pause after
                                    // one cycle — we honor that and skip re-firing.
                                    let auto_on = crate::secrets::get("autonomous_loops_enabled")
                                        .ok().flatten()
                                        .map(|v| v.eq_ignore_ascii_case("true"))
                                        .unwrap_or(false);
                                    let in_smoke = crate::secrets::get("smoke_cycle_id")
                                        .ok().flatten()
                                        .filter(|v| !v.is_empty())
                                        .is_some();
                                    if auto_on && !in_smoke {
                                        let pool_next = pool.clone();
                                        let project_id_next = project_id;
                                        tokio::spawn(async move {
                                            tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                                            if let Err(e) = queue::enqueue(
                                                &pool_next,
                                                project_id_next,
                                                "orchestrator",
                                                json!({"trigger": "continuous"}),
                                            ).await {
                                                tracing::warn!("continuous orchestrator enqueue failed: {e}");
                                            }
                                        });
                                    }
                                }

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
                                    // Defense-in-depth: if the publisher result lacks an
                                    // asset_path, every downstream marketplace handler
                                    // (POD/Cults3D/Sketchfab/Gumroad/MMF/Etsy) will fail
                                    // with the same "missing asset_path" error. Emit one
                                    // JobFailed event and skip the fan-out instead of
                                    // cascading five identical errors to the UI.
                                    let has_asset = result.get("asset_path")
                                        .and_then(|v| v.as_str())
                                        .map(|s| !s.is_empty())
                                        .unwrap_or(false);
                                    if !has_asset {
                                        bus.send(SupervisorEvent::JobFailed {
                                            role: "publisher".into(),
                                            job_id,
                                            error: "publisher result missing asset_path — skipping marketplace fan-out (upstream designer produced no asset)".into(),
                                        });
                                        continue;
                                    }

                                    let pod_enabled = crate::secrets::get("pod_enabled")
                                        .ok().flatten()
                                        .map(|v| v.eq_ignore_ascii_case("true"))
                                        .unwrap_or(false);
                                    let product_type = result.get("product_type")
                                        .and_then(|v| v.as_str())
                                        .unwrap_or("");
                                    let route_to_pod = pod_enabled && product_type == "sticker";
                                    let is_3d = matches!(product_type, "stl_file" | "3d_model");

                                    if route_to_pod {
                                        // POD path: skip direct Etsy publish — Printify
                                        // will create the Etsy draft on our behalf.
                                        let bus_for_pod = bus.clone();
                                        let pool_for_pod = pool.clone();
                                        let project_id_for_pod = project_id;
                                        let result_clone = result.clone();
                                        tokio::spawn(async move {
                                            crate::pod_publish::handle_publisher_complete_pod(
                                                &pool_for_pod,
                                                project_id_for_pod,
                                                &bus_for_pod,
                                                &result_clone,
                                            )
                                            .await;
                                        });
                                    } else {
                                        let real_enabled = crate::secrets::get("real_etsy_enabled")
                                            .ok().flatten()
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

                                    // Parallel Cults3D fan-out for 3D assets. Runs alongside
                                    // (not instead of) the Etsy path — same mesh listed on
                                    // both stores. Gated on cults3d_enabled so disabled
                                    // accounts pay zero cost.
                                    let cults3d_enabled = crate::secrets::get("cults3d_enabled")
                                        .ok().flatten()
                                        .map(|v| v.eq_ignore_ascii_case("true"))
                                        .unwrap_or(false);
                                    if is_3d && cults3d_enabled {
                                        let bus_for_c3d = bus.clone();
                                        let pool_for_c3d = pool.clone();
                                        let project_id_for_c3d = project_id;
                                        let result_clone = result.clone();
                                        tokio::spawn(async move {
                                            crate::cults3d_publish::handle_publisher_complete_cults3d(
                                                &pool_for_c3d,
                                                project_id_for_c3d,
                                                &bus_for_c3d,
                                                &result_clone,
                                            )
                                            .await;
                                        });
                                    }

                                    // Parallel Sketchfab fan-out for 3D assets. Same pattern:
                                    // gated on sketchfab_enabled, runs alongside Etsy + Cults3D.
                                    let sketchfab_enabled = crate::secrets::get("sketchfab_enabled")
                                        .ok().flatten()
                                        .map(|v| v.eq_ignore_ascii_case("true"))
                                        .unwrap_or(false);
                                    if is_3d && sketchfab_enabled {
                                        let bus_for_sf = bus.clone();
                                        let pool_for_sf = pool.clone();
                                        let project_id_for_sf = project_id;
                                        let result_clone = result.clone();
                                        tokio::spawn(async move {
                                            crate::sketchfab_publish::handle_publisher_complete_sketchfab(
                                                &pool_for_sf,
                                                project_id_for_sf,
                                                &bus_for_sf,
                                                &result_clone,
                                            )
                                            .await;
                                        });
                                    }

                                    // Parallel Gumroad fan-out. Same pattern.
                                    let gumroad_enabled = crate::secrets::get("gumroad_enabled")
                                        .ok().flatten()
                                        .map(|v| v.eq_ignore_ascii_case("true"))
                                        .unwrap_or(false);
                                    if is_3d && gumroad_enabled {
                                        let bus_for_gr = bus.clone();
                                        let pool_for_gr = pool.clone();
                                        let project_id_for_gr = project_id;
                                        let result_clone = result.clone();
                                        tokio::spawn(async move {
                                            crate::gumroad_publish::handle_publisher_complete_gumroad(
                                                &pool_for_gr,
                                                project_id_for_gr,
                                                &bus_for_gr,
                                                &result_clone,
                                            )
                                            .await;
                                        });
                                    }

                                    // Parallel MyMiniFactory fan-out. Same pattern.
                                    let mmf_enabled = crate::secrets::get("mmf_enabled")
                                        .ok().flatten()
                                        .map(|v| v.eq_ignore_ascii_case("true"))
                                        .unwrap_or(false);
                                    if is_3d && mmf_enabled {
                                        let bus_for_mmf = bus.clone();
                                        let pool_for_mmf = pool.clone();
                                        let project_id_for_mmf = project_id;
                                        let result_clone = result.clone();
                                        tokio::spawn(async move {
                                            crate::myminifactory_publish::handle_publisher_complete_mmf(
                                                &pool_for_mmf,
                                                project_id_for_mmf,
                                                &bus_for_mmf,
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
