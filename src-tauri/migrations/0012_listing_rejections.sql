-- New lifecycle states ('queued', 'rejected') are added by widening the
-- comment in 0002 — the column is TEXT with no CHECK constraint, so no
-- DDL change is required for the state column itself. Only the schema
-- additions live here.

ALTER TABLE etsy_publishes ADD COLUMN parent_listing_id INTEGER;

CREATE TABLE IF NOT EXISTS listing_rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    local_listing_id INTEGER NOT NULL,
    cycle_id TEXT,
    title TEXT NOT NULL,
    niche TEXT,
    tags_json TEXT NOT NULL,       -- JSON array of tag strings
    description TEXT NOT NULL,
    rejected_at INTEGER NOT NULL,  -- unix ms
    reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_listing_rejections_project
    ON listing_rejections (project_id, rejected_at DESC);
