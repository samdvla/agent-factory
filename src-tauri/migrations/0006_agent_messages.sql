-- Agent-to-agent message channel so agents can share insights and learn
-- from each other, not just hand off task payloads. UI surfaces this as
-- a "Conversations" view so the boss can see how the team is reasoning.
CREATE TABLE IF NOT EXISTS agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    from_role TEXT NOT NULL,
    to_role TEXT NOT NULL,        -- specific role or '*' for broadcast
    topic TEXT,                   -- optional tag, e.g. 'prompt_update', 'design_brief'
    content TEXT NOT NULL,
    importance TEXT NOT NULL DEFAULT 'info' CHECK (importance IN ('info','heads_up','critical')),
    job_id INTEGER,               -- optional link back to a jobs.id
    ts INTEGER NOT NULL           -- epoch seconds
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_to_ts ON agent_messages (to_role, ts);
CREATE INDEX IF NOT EXISTS idx_agent_messages_ts ON agent_messages (ts);
