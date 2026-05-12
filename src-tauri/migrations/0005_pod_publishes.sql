-- Tracks Printify product publishes (POD path) so we can enforce the
-- new-shop velocity cap that prevents Etsy from suspending us. Mirrors the
-- shape of etsy_publishes but is a separate table because POD products
-- live in Printify first; the etsy_listing_id only comes back later via
-- Printify's webhook.
CREATE TABLE IF NOT EXISTS pod_publishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    printify_product_id TEXT NOT NULL,
    title TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    published_at INTEGER NOT NULL,  -- epoch seconds
    day TEXT NOT NULL               -- 'YYYY-MM-DD' UTC, for daily-cap counting
);
CREATE INDEX IF NOT EXISTS idx_pod_publishes_day ON pod_publishes (project_id, day);
