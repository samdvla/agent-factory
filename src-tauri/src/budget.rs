use sqlx::SqlitePool;

/// Compute USD cost from token counts and model name.
/// Uses the same pricing table as `record()`. Single source of truth.
pub fn cost_usd(model: &str, tokens_in: u64, tokens_out: u64) -> f64 {
    let (pin, pout) = price_per_million(model);
    (tokens_in as f64 / 1_000_000.0) * pin + (tokens_out as f64 / 1_000_000.0) * pout
}

fn price_per_million(model: &str) -> (f64, f64) {
    // (input_usd_per_million, output_usd_per_million)
    // Source: Anthropic public pricing as of 2026-05; update if pricing changes.
    if model.starts_with("claude-haiku-4-5") {
        (0.80, 4.00)
    } else if model.starts_with("claude-sonnet-4") {
        (3.00, 15.00)
    } else if model.starts_with("claude-opus-4") {
        (15.00, 75.00)
    } else {
        (3.00, 15.00) // sane default
    }
}

pub async fn record(
    pool: &SqlitePool,
    project_id: i64,
    model: &str,
    tokens_in: u64,
    tokens_out: u64,
) -> anyhow::Result<()> {
    let usd = cost_usd(model, tokens_in, tokens_out);
    sqlx::query(
        "INSERT INTO budget_ledger (project_id, day, model, tokens_in, tokens_out, usd_cost) VALUES (?, date('now'), ?, ?, ?, ?)"
    )
    .bind(project_id)
    .bind(model)
    .bind(tokens_in as i64)
    .bind(tokens_out as i64)
    .bind(usd)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn today_spend_usd(pool: &SqlitePool, project_id: i64) -> anyhow::Result<f64> {
    let usd: Option<f64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(usd_cost), 0.0) FROM budget_ledger WHERE project_id = ? AND day = date('now')"
    )
    .bind(project_id)
    .fetch_one(pool)
    .await?;
    Ok(usd.unwrap_or(0.0))
}

pub async fn check_cap(pool: &SqlitePool, project_id: i64, daily_cap_usd: f64) -> anyhow::Result<bool> {
    let spent = today_spend_usd(pool, project_id).await?;
    Ok(spent < daily_cap_usd)
}

/// Sum of usd_cost for ledger rows with `ts >= now() - <hours> hours`.
/// Note: ledger rows store ts via `datetime('now')` default — UTC by sqlite convention.
pub async fn spend_window(
    pool: &SqlitePool,
    project_id: i64,
    hours: i64,
) -> anyhow::Result<f64> {
    let usd: Option<f64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(usd_cost), 0.0) FROM budget_ledger \
         WHERE project_id = ? AND ts >= datetime('now', ?)"
    )
    .bind(project_id)
    .bind(format!("-{hours} hours"))
    .fetch_one(pool)
    .await?;
    Ok(usd.unwrap_or(0.0))
}

/// Sum of usd_cost for ledger rows in the current calendar month (UTC).
pub async fn month_spend_usd(
    pool: &SqlitePool,
    project_id: i64,
) -> anyhow::Result<f64> {
    let usd: Option<f64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(usd_cost), 0.0) FROM budget_ledger \
         WHERE project_id = ? AND day >= date('now', 'start of month')"
    )
    .bind(project_id)
    .fetch_one(pool)
    .await?;
    Ok(usd.unwrap_or(0.0))
}

/// Pure cost estimate for pre-flight cap checks. No DB access.
/// Use this with conservative input counts (e.g. char/4 heuristic).
pub fn estimate_cost(model: &str, est_tokens_in: u64, est_tokens_out: u64) -> f64 {
    cost_usd(model, est_tokens_in, est_tokens_out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    /// Build an in-memory sqlite pool with the bare-minimum schema this module
    /// touches. Avoids running the full migrations against ":memory:".
    async fn setup_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1) // a shared :memory: db must use a single conn
            .connect_with(opts)
            .await
            .expect("open in-memory sqlite");
        sqlx::query(
            "CREATE TABLE budget_ledger (\
                id INTEGER PRIMARY KEY AUTOINCREMENT,\
                project_id INTEGER NOT NULL,\
                day TEXT NOT NULL,\
                model TEXT NOT NULL,\
                tokens_in INTEGER NOT NULL DEFAULT 0,\
                tokens_out INTEGER NOT NULL DEFAULT 0,\
                usd_cost REAL NOT NULL DEFAULT 0.0,\
                ts TEXT NOT NULL DEFAULT (datetime('now'))\
            )",
        )
        .execute(&pool)
        .await
        .expect("create budget_ledger");
        pool
    }

    #[tokio::test]
    async fn check_cap_returns_false_when_spend_exceeds_cap() {
        let pool = setup_pool().await;
        // Sonnet at $3/M in + $15/M out. 1M in = $3.00, 0 out → $3.00.
        record(&pool, 1, "claude-sonnet-4-6", 1_000_000, 0).await.unwrap();
        // Cap of $1 → over.
        let under_cap = check_cap(&pool, 1, 1.00).await.unwrap();
        assert!(!under_cap, "expected check_cap=false when spend ($3) > cap ($1)");
        let spent = today_spend_usd(&pool, 1).await.unwrap();
        assert!(spent > 1.00, "today spend should exceed cap, got {spent}");
    }

    #[tokio::test]
    async fn check_cap_returns_true_when_spend_below_cap() {
        let pool = setup_pool().await;
        // 1k tokens in @ $3/M → $0.003
        record(&pool, 1, "claude-sonnet-4-6", 1_000, 0).await.unwrap();
        let under_cap = check_cap(&pool, 1, 1.00).await.unwrap();
        assert!(under_cap, "expected check_cap=true when spend < cap");
    }

    #[test]
    fn cost_usd_matches_record_pricing_for_haiku() {
        // Haiku: $0.80/M in, $4.00/M out → 1M in + 1M out = $0.80 + $4.00 = $4.80
        let usd = cost_usd("claude-haiku-4-5-20251001", 1_000_000, 1_000_000);
        assert!((usd - 4.80).abs() < 1e-9, "expected 4.80, got {usd}");
    }

    #[test]
    fn cost_usd_matches_record_pricing_for_sonnet() {
        let usd = cost_usd("claude-sonnet-4-6", 1_000_000, 0);
        assert!((usd - 3.00).abs() < 1e-9, "expected 3.00, got {usd}");
    }

    #[test]
    fn cost_usd_matches_record_pricing_for_opus() {
        let usd = cost_usd("claude-opus-4-7", 0, 1_000_000);
        assert!((usd - 75.00).abs() < 1e-9, "expected 75.00, got {usd}");
    }
}
