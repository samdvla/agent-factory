-- Cults3D publishes — every 3D asset we ship to Cults3D records here so the
-- UI can show what's live, and so the impression poller can fan out later.
CREATE TABLE IF NOT EXISTS cults3d_publishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    local_listing_id INTEGER,           -- joins back to our internal listing id
    cults3d_creation_id TEXT,           -- opaque base64 id from Cults3D
    title TEXT NOT NULL,
    url TEXT,                           -- public Cults3D URL
    file_url TEXT,                      -- public HTTPS URL we passed in fileUrls
    image_url TEXT,                     -- public HTTPS URL we passed in imageUrls
    price_usd REAL,
    state TEXT NOT NULL DEFAULT 'pending',  -- pending | published | errored
    error TEXT,
    published_at INTEGER NOT NULL,
    day TEXT NOT NULL                   -- YYYY-MM-DD for per-day cap counting
);
CREATE INDEX IF NOT EXISTS idx_cults3d_publishes_project_day
    ON cults3d_publishes (project_id, day);
CREATE INDEX IF NOT EXISTS idx_cults3d_publishes_creation
    ON cults3d_publishes (cults3d_creation_id);
