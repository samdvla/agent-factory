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
    BudgetSpent { role: String, cost_usd: f64, tokens_in: u64, tokens_out: u64, model: String },
    BudgetCapped { spent_usd: f64, cap_usd: f64 },
    AssetRasterized { job_id: i64, png_path: String, bytes: u64 },
    EtsyListingPublished {
        local_listing_id: i64,
        etsy_listing_id: i64,
        title: String,
        url: Option<String>,
        state: String,
    },
    EtsyListingPublishFailed {
        local_listing_id: i64,
        reason: String,
    },
    EtsyListingCapped { count: i64, cap: i64 },
    EtsyListingActivated { etsy_listing_id: i64 },
    EtsyReceiptIngested {
        receipt_id: i64,
        transactions_count: usize,
        revenue_usd: f64,
    },
    EtsyMessageIngested {
        conversation_id: i64,
        /// First 80 chars of the buyer's message.
        snippet: String,
    },
    EtsyReplyPosted {
        conversation_id: i64,
    },
    EtsyKillSwitchTriggered,
    PnlCycleClosed {
        cycle_id: String,
        niche: Option<String>,
        revenue_usd: f64,
        total_cost_usd: f64,
        net_usd: f64,
        contributor_count: i64,
    },
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
