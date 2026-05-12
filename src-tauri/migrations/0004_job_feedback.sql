-- Human (or future boss-agent) ratings on agent job outputs.
-- One rating per (job, rater). Updating an existing rating overwrites in place.
CREATE TABLE IF NOT EXISTS job_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    rating TEXT NOT NULL CHECK (rating IN ('up','down')),
    note TEXT,
    rater TEXT NOT NULL DEFAULT 'operator',
    created_at INTEGER NOT NULL,
    UNIQUE(job_id, rater)
);
CREATE INDEX IF NOT EXISTS idx_job_feedback_rating ON job_feedback(rating);
CREATE INDEX IF NOT EXISTS idx_job_feedback_created ON job_feedback(created_at DESC);
