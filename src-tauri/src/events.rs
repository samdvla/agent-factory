use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::broadcast;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SupervisorEvent {
    AgentStarted { role: String },
    AgentExited { role: String, code: Option<i32> },
    JobStarted { role: String, job_id: i64 },
    JobCompleted { role: String, job_id: i64, result: Value },
    JobFailed { role: String, job_id: i64, error: String },
    WorkerNotification { role: String, method: String, params: Value },
    BudgetTick { project_id: i64, usd_today: f64 },
}

#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<SupervisorEvent>,
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { tx }
    }
    pub fn send(&self, evt: SupervisorEvent) {
        let _ = self.tx.send(evt);
    }
    pub fn subscribe(&self) -> broadcast::Receiver<SupervisorEvent> {
        self.tx.subscribe()
    }
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}
