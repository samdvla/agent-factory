-- Gumroad publishes — Gumroad's file-attach API is best-effort; if it
-- fails we still record the product (state='published_no_file') so the UI
-- can prompt the operator to upload the file manually.
CREATE TABLE IF NOT EXISTS gumroad_publishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    local_listing_id INTEGER,
    gumroad_product_id TEXT,            -- Gumroad product id
    title TEXT NOT NULL,
    short_url TEXT,                     -- gumroad.com/l/xxxxx
    edit_url TEXT,                      -- dashboard edit link
    price_usd REAL,
    state TEXT NOT NULL DEFAULT 'pending',
       -- pending | published | published_no_file | errored
    error TEXT,
    warning TEXT,
    published_at INTEGER NOT NULL,
    day TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_gumroad_publishes_project_day
    ON gumroad_publishes (project_id, day);
CREATE INDEX IF NOT EXISTS idx_gumroad_publishes_product
    ON gumroad_publishes (gumroad_product_id);
