CREATE TABLE IF NOT EXISTS pipeline_cycles (
    cycle_id TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL,
    niche TEXT,
    local_listing_id INTEGER,
    estimated_revenue_usd REAL,
    actual_revenue_usd REAL,
    total_cost_usd REAL NOT NULL DEFAULT 0,
    net_usd REAL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    closed INTEGER NOT NULL DEFAULT 0  -- 0=open, 1=closed
);
CREATE INDEX IF NOT EXISTS idx_pipeline_cycles_project ON pipeline_cycles (project_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    cycle_id TEXT NOT NULL,
    role TEXT NOT NULL,
    job_id INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_contributions_cycle ON agent_contributions (cycle_id);
CREATE INDEX IF NOT EXISTS idx_agent_contributions_role ON agent_contributions (project_id, role);

CREATE TABLE IF NOT EXISTS agent_wealth (
    project_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    lifetime_revenue_usd REAL NOT NULL DEFAULT 0,
    lifetime_cost_usd REAL NOT NULL DEFAULT 0,
    lifetime_net_usd REAL NOT NULL DEFAULT 0,
    cycles_count INTEGER NOT NULL DEFAULT 0,
    last_credit_at INTEGER,
    PRIMARY KEY (project_id, role)
);
