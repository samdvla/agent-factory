//! Unified revenue ledger.
//!
//! Every paid sale from every marketplace lands here. Etsy is the only
//! producer today; Cults3D / Sketchfab / Gumroad / MMF / Pinterest get
//! the same shape as soon as their receipt-polling integrations come
//! online (each ingest call passes its own `source` value).
//!
//! Pairs with `budget.rs` on the spend side. The TopBar Net pill is
//! `lifetime_revenue_usd() - budget::lifetime_spend_usd()`.
use sqlx::SqlitePool;

/// Sources that can write into the revenue ledger. Mirrors the CHECK
/// constraint in `migrations/0015_revenue_ledger.sql`; adding a value
/// here without updating that migration will fail at insert time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevenueSource {
    Etsy,
    Cults3d,
    Sketchfab,
    Gumroad,
    Mmf,
    Pinterest,
    Other,
}

impl RevenueSource {
    pub fn as_str(self) -> &'static str {
        match self {
            RevenueSource::Etsy => "etsy",
            RevenueSource::Cults3d => "cults3d",
            RevenueSource::Sketchfab => "sketchfab",
            RevenueSource::Gumroad => "gumroad",
            RevenueSource::Mmf => "mmf",
            RevenueSource::Pinterest => "pinterest",
            RevenueSource::Other => "other",
        }
    }
}

/// Record one paid transaction. `marketplace_id` is the source's own
/// receipt / order id; pass `None` when the source doesn't expose one,
/// but prefer a stable handle so the UNIQUE dedupe index protects
/// against double-counting on poller re-runs.
///
/// `net_usd` is what we actually keep — the source of truth for the
/// Net pill. `gross_usd` and `fees_usd` are kept around for analytics
/// breakdowns but the topbar reads `net_usd` only.
pub async fn record(
    pool: &SqlitePool,
    project_id: i64,
    source: RevenueSource,
    marketplace_id: Option<&str>,
    gross_usd: f64,
    fees_usd: f64,
    net_usd: f64,
    listing_local_id: Option<i64>,
) -> anyhow::Result<()> {
    // INSERT OR IGNORE relies on the partial UNIQUE index on
    // (project_id, source, marketplace_id) WHERE marketplace_id IS NOT
    // NULL. SQLite's ON CONFLICT clause requires a non-partial unique
    // constraint when columns are specified, but OR IGNORE works with
    // any unique index — exactly what we want for poller re-runs that
    // resurface the same Etsy receipt. When marketplace_id is NULL the
    // index doesn't match, so the insert lands as a fresh row (callers
    // for sources without stable ids accept the duplication risk).
    sqlx::query(
        "INSERT OR IGNORE INTO revenue_ledger \
         (project_id, source, marketplace_id, gross_usd, fees_usd, net_usd, listing_local_id) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(source.as_str())
    .bind(marketplace_id)
    .bind(gross_usd)
    .bind(fees_usd)
    .bind(net_usd)
    .bind(listing_local_id)
    .execute(pool)
    .await?;
    Ok(())
}

/// Sum of net_usd today (local date).
pub async fn today_revenue_usd(pool: &SqlitePool, project_id: i64) -> anyhow::Result<f64> {
    let usd: Option<f64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(net_usd), 0.0) FROM revenue_ledger \
         WHERE project_id = ? AND day = date('now')",
    )
    .bind(project_id)
    .fetch_one(pool)
    .await?;
    Ok(usd.unwrap_or(0.0))
}

/// Sum of net_usd across all marketplaces and all time. This is the
/// number TopBar.Net subtracts lifetime spend from.
pub async fn lifetime_revenue_usd(pool: &SqlitePool, project_id: i64) -> anyhow::Result<f64> {
    let usd: Option<f64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(net_usd), 0.0) FROM revenue_ledger WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_one(pool)
    .await?;
    Ok(usd.unwrap_or(0.0))
}

/// Per-marketplace lifetime breakdown for the analytics panel.
pub async fn lifetime_revenue_by_source(
    pool: &SqlitePool,
    project_id: i64,
) -> anyhow::Result<Vec<(String, f64, i64)>> {
    let rows: Vec<(String, f64, i64)> = sqlx::query_as(
        "SELECT source, COALESCE(SUM(net_usd), 0.0) AS net, COUNT(*) AS sales \
         FROM revenue_ledger \
         WHERE project_id = ? \
         GROUP BY source \
         ORDER BY net DESC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    async fn setup_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("open in-memory sqlite");
        sqlx::query(
            "CREATE TABLE revenue_ledger (\
                id INTEGER PRIMARY KEY AUTOINCREMENT,\
                project_id INTEGER NOT NULL,\
                day TEXT NOT NULL DEFAULT (date('now')),\
                source TEXT NOT NULL,\
                marketplace_id TEXT,\
                gross_usd REAL NOT NULL,\
                fees_usd REAL NOT NULL DEFAULT 0.0,\
                net_usd REAL NOT NULL,\
                listing_local_id INTEGER,\
                ts TEXT NOT NULL DEFAULT (datetime('now'))\
            )",
        )
        .execute(&pool)
        .await
        .expect("create revenue_ledger");
        sqlx::query(
            "CREATE UNIQUE INDEX idx_revenue_ledger_dedupe \
             ON revenue_ledger(project_id, source, marketplace_id) \
             WHERE marketplace_id IS NOT NULL",
        )
        .execute(&pool)
        .await
        .expect("create dedupe index");
        pool
    }

    #[tokio::test]
    async fn lifetime_revenue_sums_every_source() {
        let pool = setup_pool().await;
        record(&pool, 1, RevenueSource::Etsy, Some("receipt-1"), 11.0, 1.10, 9.90, Some(42))
            .await.unwrap();
        record(&pool, 1, RevenueSource::Cults3d, Some("order-7"), 8.00, 1.20, 6.80, None)
            .await.unwrap();
        record(&pool, 1, RevenueSource::Gumroad, Some("g-9"), 5.00, 0.50, 4.50, None)
            .await.unwrap();

        let total = lifetime_revenue_usd(&pool, 1).await.unwrap();
        let expected = 9.90 + 6.80 + 4.50;
        assert!((total - expected).abs() < 1e-9);

        let by_source = lifetime_revenue_by_source(&pool, 1).await.unwrap();
        assert_eq!(by_source.len(), 3);
        // Sorted by net desc — Etsy is the largest.
        assert_eq!(by_source[0].0, "etsy");
        assert!((by_source[0].1 - 9.90).abs() < 1e-9);
    }

    #[tokio::test]
    async fn record_is_idempotent_per_marketplace_id() {
        // Pollers re-run the same window; the same Etsy receipt must
        // not show up twice in lifetime_revenue.
        let pool = setup_pool().await;
        record(&pool, 1, RevenueSource::Etsy, Some("receipt-1"), 11.0, 1.10, 9.90, Some(42))
            .await.unwrap();
        // Same source + marketplace_id → ON CONFLICT DO NOTHING.
        record(&pool, 1, RevenueSource::Etsy, Some("receipt-1"), 11.0, 1.10, 9.90, Some(42))
            .await.unwrap();
        let total = lifetime_revenue_usd(&pool, 1).await.unwrap();
        assert!((total - 9.90).abs() < 1e-9, "expected $9.90, got {total}");
    }

    #[tokio::test]
    async fn record_without_marketplace_id_allows_duplicates() {
        // When marketplace_id is NULL the unique index doesn't apply,
        // so each call inserts a fresh row. Used for sources that
        // don't expose stable receipt ids — the operator is responsible
        // for not double-recording in that case.
        let pool = setup_pool().await;
        record(&pool, 1, RevenueSource::Other, None, 5.0, 0.0, 5.0, None)
            .await.unwrap();
        record(&pool, 1, RevenueSource::Other, None, 5.0, 0.0, 5.0, None)
            .await.unwrap();
        let total = lifetime_revenue_usd(&pool, 1).await.unwrap();
        assert!((total - 10.0).abs() < 1e-9);
    }
}
