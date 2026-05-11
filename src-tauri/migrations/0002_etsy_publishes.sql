CREATE TABLE IF NOT EXISTS etsy_publishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    local_listing_id INTEGER NOT NULL,
    etsy_listing_id INTEGER NOT NULL,
    state TEXT NOT NULL,        -- 'draft' | 'active' | 'inactive' | 'expired'
    title TEXT NOT NULL,
    url TEXT,
    published_at INTEGER NOT NULL,  -- epoch seconds
    activated_at INTEGER,
    day TEXT NOT NULL  -- 'YYYY-MM-DD' UTC, for daily cap counting
);
CREATE INDEX IF NOT EXISTS idx_etsy_publishes_day ON etsy_publishes (project_id, day);
