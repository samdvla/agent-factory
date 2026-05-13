-- Unified revenue ledger for sales across every marketplace.
--
-- Mirrors budget_ledger on the spend side: one row per individual sale,
-- write-once, queries roll up by date / source / listing. Etsy is the
-- only producer today (receipts poller writes a row per paid transaction)
-- but Cults3D / Sketchfab / Gumroad / MMF / Pinterest get the same shape
-- as soon as their receipt-polling integrations come online.
--
-- The CHECK on `source` is a soft contract — adding a new marketplace
-- means dropping a new value here in a follow-up migration, not silently
-- writing unknown sources that mis-attribute revenue.
CREATE TABLE revenue_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    -- Local-time date string (YYYY-MM-DD) keyed off `ts` for daily rollups.
    day TEXT NOT NULL DEFAULT (date('now')),
    -- Marketplace the sale came from. Must match one of the known
    -- integrations so unknown values don't silently bypass attribution.
    source TEXT NOT NULL CHECK (source IN (
        'etsy', 'cults3d', 'sketchfab', 'gumroad', 'mmf', 'pinterest', 'other'
    )),
    -- Foreign listing id on the marketplace (Etsy receipt_id, Cults3D
    -- order_id, etc.). Nullable for sources that don't expose one.
    marketplace_id TEXT,
    -- Gross sale price before any marketplace fees. The buyer-facing
    -- USD figure on the receipt.
    gross_usd REAL NOT NULL,
    -- Marketplace fees deducted (Etsy transaction + payment-processing,
    -- Gumroad processor fee, etc.). 0.0 when fees are unknown or
    -- bundled — net_usd is the source of truth for what we keep.
    fees_usd REAL NOT NULL DEFAULT 0.0,
    -- Take-home revenue after fees. Topbar's Net pill subtracts the
    -- lifetime spend ledger from SUM(net_usd) over this table.
    net_usd REAL NOT NULL,
    -- Link back to the local listing record so per-cycle P&L can
    -- attribute revenue to the cycle that produced this sale. Not a
    -- foreign key — `local_listing_id` is the per-marketplace numeric
    -- handle the workers assign, not a row in a single listings table.
    listing_local_id INTEGER,
    ts TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_revenue_ledger_day ON revenue_ledger(project_id, day);
CREATE INDEX idx_revenue_ledger_source ON revenue_ledger(project_id, source, day);
CREATE INDEX idx_revenue_ledger_listing ON revenue_ledger(project_id, listing_local_id);

-- De-dupe guard: same (project, source, marketplace_id) only inserts
-- once. The Etsy receipts poller is idempotent (re-runs the same window
-- can resurface paid receipts), so without this we'd double-count.
CREATE UNIQUE INDEX idx_revenue_ledger_dedupe
    ON revenue_ledger(project_id, source, marketplace_id)
    WHERE marketplace_id IS NOT NULL;
