use std::collections::HashMap;
use std::time::{Duration, Instant};

pub struct HeartbeatTracker {
    interval: Duration,
    misses_allowed: u32,
    last: HashMap<String, Instant>,
}

impl HeartbeatTracker {
    pub fn new(interval: Duration, misses_allowed: u32) -> Self {
        Self {
            interval,
            misses_allowed,
            last: HashMap::new(),
        }
    }

    pub fn ping(&mut self, agent: &str) {
        self.last.insert(agent.to_string(), Instant::now());
    }

    pub fn is_alive(&self, agent: &str) -> bool {
        match self.last.get(agent) {
            Some(t) => t.elapsed() < self.interval * self.misses_allowed,
            None => false,
        }
    }

    pub fn stale_workers(&self) -> Vec<String> {
        self.last.iter()
            .filter_map(|(name, t)| {
                if t.elapsed() >= self.interval * self.misses_allowed {
                    Some(name.clone())
                } else {
                    None
                }
            })
            .collect()
    }

    pub fn forget(&mut self, agent: &str) {
        self.last.remove(agent);
    }
}
