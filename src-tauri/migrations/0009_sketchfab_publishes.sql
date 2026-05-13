-- Sketchfab publishes — every 3D asset we ship to Sketchfab records here so
-- the UI can show what's live, and so we can dedupe + cap daily volume.
CREATE TABLE IF NOT EXISTS sketchfab_publishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    local_listing_id INTEGER,           -- joins back to our internal listing id
    sketchfab_uid TEXT,                 -- model uid returned by Sketchfab
    store_product_id TEXT,              -- if put on Sketchfab Store (Pro+ only)
    title TEXT NOT NULL,
    url TEXT,                           -- public Sketchfab URL
    price_usd REAL,
    state TEXT NOT NULL DEFAULT 'pending',  -- pending | published | errored
    error TEXT,
    warning TEXT,                       -- non-fatal warning (e.g. store add failed)
    published_at INTEGER NOT NULL,
    day TEXT NOT NULL                   -- YYYY-MM-DD for per-day cap counting
);
CREATE INDEX IF NOT EXISTS idx_sketchfab_publishes_project_day
    ON sketchfab_publishes (project_id, day);
CREATE INDEX IF NOT EXISTS idx_sketchfab_publishes_uid
    ON sketchfab_publishes (sketchfab_uid);
