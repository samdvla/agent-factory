use sqlx::SqlitePool;

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
    let (pin, pout) = price_per_million(model);
    let usd = (tokens_in as f64) * pin / 1_000_000.0 + (tokens_out as f64) * pout / 1_000_000.0;
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
