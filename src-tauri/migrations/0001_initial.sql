PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    room TEXT NOT NULL DEFAULT '',
    model_tier TEXT NOT NULL CHECK (model_tier IN ('haiku','sonnet','opus')),
    source_path TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','working','paused','crashed','quarantined','killed')),
    started_at TEXT,
    last_heartbeat TEXT,
    token_spend_today INTEGER NOT NULL DEFAULT 0,
    UNIQUE(project_id, role)
);

CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    queue TEXT NOT NULL DEFAULT 'default',
    agent_role TEXT NOT NULL,
    parent_job_id INTEGER REFERENCES jobs(id),
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','errored','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT,
    result_json TEXT,
    error TEXT
);
CREATE INDEX idx_jobs_status_scheduled ON jobs(status, scheduled_at);
CREATE INDEX idx_jobs_agent_role_status ON jobs(agent_role, status);

CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
    agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_project_ts ON events(project_id, ts);

CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','agent','system')),
    content TEXT NOT NULL,
    ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    scope TEXT NOT NULL CHECK (scope IN ('global','agent','niche','listing')),
    key TEXT NOT NULL,
    value_json TEXT NOT NULL,
    embedding BLOB,
    ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_memory_project_scope ON memory(project_id, scope);

CREATE TABLE outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE experiments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    hypothesis TEXT NOT NULL,
    variants_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','complete','aborted')),
    winner TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT
);

CREATE TABLE budget_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0,
    usd_cost REAL NOT NULL DEFAULT 0.0,
    ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_budget_project_day ON budget_ledger(project_id, day);

CREATE TABLE gates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_class TEXT NOT NULL UNIQUE,
    enabled INTEGER NOT NULL DEFAULT 0,
    threshold_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE gate_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    action_class TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
    decided_at TEXT
);

CREATE TABLE patches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    diff TEXT NOT NULL,
    rationale TEXT NOT NULL,
    test_results TEXT,
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','applying','applied','rejected','rolled_back')),
    applied_at TEXT
);

CREATE TABLE schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cron TEXT NOT NULL,
    agent_role TEXT NOT NULL,
    payload_template TEXT NOT NULL,
    last_fired_at TEXT
);

INSERT INTO gates (action_class, enabled) VALUES
    ('code.self_modify', 1),
    ('account.create', 1),
    ('money.spend', 0),
    ('etsy.publish', 0);
