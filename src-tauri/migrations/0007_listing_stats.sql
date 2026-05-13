-- Per-listing impression stats from Etsy's /listings/{id}/stats endpoint.
-- One row per (listing, poll-tick) — keeps a time series so we can see
-- whether a draft is gaining views/favorites over time, not just a snapshot.
-- The strategist + orchestrator read this to learn from impressions even
-- before any sale lands.
CREATE TABLE IF NOT EXISTS listing_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    etsy_listing_id INTEGER NOT NULL,
    local_listing_id INTEGER,
    views INTEGER NOT NULL DEFAULT 0,
    favorites INTEGER NOT NULL DEFAULT 0,
    total_orders INTEGER NOT NULL DEFAULT 0,
    ts INTEGER NOT NULL  -- epoch seconds
);
CREATE INDEX IF NOT EXISTS idx_listing_stats_listing_ts
    ON listing_stats (etsy_listing_id, ts);
CREATE INDEX IF NOT EXISTS idx_listing_stats_project_ts
    ON listing_stats (project_id, ts);
