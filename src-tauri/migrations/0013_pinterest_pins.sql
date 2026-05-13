-- Pinterest pins — every pin we push to Pinterest's /v5/pins endpoint
-- records here so the UI can show what's live, daily caps can be enforced,
-- and operators can audit failures.
--
-- Pinterest is the #1 external traffic source to Etsy (~41% of external
-- clicks per the Pinvine 2026 strategy report). Each pin links back to the
-- corresponding Etsy listing; etsy_url is kept here so the operator panel
-- can show the pin → listing chain without joining tables.
CREATE TABLE IF NOT EXISTS pinterest_pins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    local_listing_id INTEGER,           -- joins back to our internal listing id
    pinterest_pin_id TEXT,              -- opaque id from /v5/pins response
    title TEXT NOT NULL,
    url TEXT,                           -- public Pinterest pin URL
    etsy_url TEXT,                      -- destination URL (the listing being promoted)
    state TEXT NOT NULL DEFAULT 'pending',  -- pending | published | errored
    error TEXT,
    published_at INTEGER NOT NULL,
    day TEXT NOT NULL                   -- YYYY-MM-DD for per-day cap counting
);
CREATE INDEX IF NOT EXISTS idx_pinterest_pins_project_day
    ON pinterest_pins (project_id, day);
CREATE INDEX IF NOT EXISTS idx_pinterest_pins_pin
    ON pinterest_pins (pinterest_pin_id);
