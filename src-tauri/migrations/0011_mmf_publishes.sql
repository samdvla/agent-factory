-- MyMiniFactory publishes — MMF's API key write access may be restricted on
-- some accounts; errors are surfaced in `state='errored'` rows.
CREATE TABLE IF NOT EXISTS mmf_publishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    local_listing_id INTEGER,
    mmf_object_id TEXT,
    title TEXT NOT NULL,
    url TEXT,
    price_usd REAL,
    state TEXT NOT NULL DEFAULT 'pending',  -- pending | published | errored
    error TEXT,
    warning TEXT,
    published_at INTEGER NOT NULL,
    day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mmf_publishes_project_day
    ON mmf_publishes (project_id, day);
CREATE INDEX IF NOT EXISTS idx_mmf_publishes_object
    ON mmf_publishes (mmf_object_id);
