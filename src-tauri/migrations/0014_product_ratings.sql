-- Operator-supplied product ratings, captured via the Telegram rater bot.
-- Each row is one star-rating + optional note for one local_listing_id.
-- Re-rating is allowed (multiple rows per listing); the orchestrator's
-- few-shot reader takes the MOST RECENT row per listing.
--
-- Why this exists: the shop has zero-to-few sales for the first dozens of
-- drafts, so outcomes.jsonl (which only carries sale events) gives the
-- orchestrator no signal. Operator ratings short-circuit that — every
-- draft can be judged on craft quality + niche fit before any sale lands.
CREATE TABLE IF NOT EXISTS product_ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    local_listing_id INTEGER NOT NULL,
    stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    note TEXT,
    source TEXT NOT NULL DEFAULT 'telegram',  -- 'telegram' | future channels
    created_at INTEGER NOT NULL                -- epoch seconds
);
CREATE INDEX IF NOT EXISTS idx_product_ratings_listing
    ON product_ratings (project_id, local_listing_id);
CREATE INDEX IF NOT EXISTS idx_product_ratings_created
    ON product_ratings (created_at);

-- Tracks which drafts the Telegram rater bot has already posted, so a
-- restart doesn't re-post the same listing N times. One Telegram message
-- per draft per project.
CREATE TABLE IF NOT EXISTS telegram_postings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    local_listing_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,    -- Telegram message_id of the rating prompt
    posted_at INTEGER NOT NULL,
    UNIQUE (project_id, local_listing_id)
);
