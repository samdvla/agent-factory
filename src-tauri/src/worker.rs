use anyhow::{anyhow, Context};
use serde_json::Value;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

#[derive(Debug)]
pub enum WorkerEvent {
    Notification { method: String, params: Value },
    Stderr(String),
    Exited(Option<i32>),
}

pub struct Worker {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    next_id: Arc<Mutex<u64>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    events_rx: mpsc::Receiver<WorkerEvent>,
}

impl Worker {
    pub async fn spawn(program: &str, args: &[&str], env: &[(&str, &str)]) -> anyhow::Result<Self> {
        let mut cmd = Command::new(program);
        cmd.args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().context("spawn worker")?;

        let stdin = child.stdin.take().ok_or_else(|| anyhow!("no stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let stderr = child.stderr.take().ok_or_else(|| anyhow!("no stderr"))?;

        let (events_tx, events_rx) = mpsc::channel::<WorkerEvent>(64);
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        // stdout reader: demux responses (with id) from notifications (no id)
        {
            let pending = pending.clone();
            let events_tx = events_tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let v: Value = match serde_json::from_str(&line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if let Some(id) = v.get("id").and_then(|x| x.as_u64()) {
                        if let Some(tx) = pending.lock().await.remove(&id) {
                            let result = v.get("result").cloned().unwrap_or(Value::Null);
                            let _ = tx.send(result);
                        }
                    } else if let Some(method) = v.get("method").and_then(|m| m.as_str()) {
                        let params = v.get("params").cloned().unwrap_or(Value::Null);
                        let _ = events_tx
                            .send(WorkerEvent::Notification {
                                method: method.to_string(),
                                params,
                            })
                            .await;
                    }
                }
            });
        }

        // stderr reader
        {
            let events_tx = events_tx.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = reader.next_line().await {
                    let _ = events_tx.send(WorkerEvent::Stderr(line)).await;
                }
            });
        }

        Ok(Self {
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            next_id: Arc::new(Mutex::new(1)),
            pending,
            events_rx,
        })
    }

    pub async fn request(&self, method: &str, params: Value) -> anyhow::Result<Value> {
        let id = {
            let mut n = self.next_id.lock().await;
            let cur = *n;
            *n += 1;
            cur
        };
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let line = format!("{}\n", req);
        self.stdin.lock().await.write_all(line.as_bytes()).await?;
        self.stdin.lock().await.flush().await?;

        // Designer for 3D jobs is the slowest agent. Per-stage budgets
        // (calibrated from a real probe on 2026-05-13 after fixing the
        // Nano Banana model rename + the broken-IPv6 download hang):
        //   • Anthropic asset desc (Haiku, max_attempts=3): ~220s worst
        //     (measured ~5-10s typical)
        //   • nanobanana CLI Nano Banana Pro: 120s ceiling
        //     (measured 48s typical — Anthropic + nano combined)
        //   • Tripo image-to-3D poll: 240s ceiling
        //     (measured 82s typical end-to-end)
        //   • Higgsfield product-photoshoot enhance: 240s ceiling
        //     ↳ in-worker wall-clock guard skips when elapsed > 500s
        //   • Multi-angle pure-numpy rasterizer: ~30s for 5 angles
        // Worst-case sum without guards: 220+120+240+240+30 = 850s.
        // With Higgsfield skip-after-500s active: 220+120+240+0+30 = 610s.
        // Typical-day total: ~330s (5.5 min). 750s outer cap leaves ~140s
        // of headroom over the guarded worst case while still bounding
        // genuinely wedged processes.
        let value = tokio::time::timeout(std::time::Duration::from_secs(750), rx)
            .await
            .map_err(|_| anyhow!("worker request timed out"))??;
        Ok(value)
    }

    pub async fn next_event(&mut self) -> Option<WorkerEvent> {
        self.events_rx.recv().await
    }

    pub async fn shutdown(&mut self) -> anyhow::Result<()> {
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
        Ok(())
    }
}
