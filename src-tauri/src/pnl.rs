use anyhow::Result;
use serde::Serialize;
use sqlx::{Row, SqlitePool};

/// Summary of a closed pipeline cycle — what we emit on `PnlCycleClosed`
/// and what the UI surfaces via `cmd_list_recent_cycles`.
#[derive(Debug, Clone, Serialize)]
pub struct CycleSummary {
    pub cycle_id: String,
    pub niche: Option<String>,
    pub local_listing_id: Option<i64>,
    pub revenue_usd: f64,
    pub total_cost_usd: f64,
    pub net_usd: f64,
    pub contributor_count: i64,
}

/// Per-role wealth row — aggregate stats over every closed cycle the agent
/// contributed to. Used by upcoming dissolution decisions.
#[derive(Debug, Clone, Serialize)]
pub struct AgentWealth {
    pub role: String,
    pub lifetime_revenue_usd: f64,
    pub lifetime_cost_usd: f64,
    pub lifetime_net_usd: f64,
    pub cycles_count: i64,
}

/// Ensure a `pipeline_cycles` row exists for this `cycle_id`. Safe to call
/// many times — INSERT OR IGNORE leaves an existing row untouched.
pub async fn ensure_cycle(
    pool: &SqlitePool,
    project_id: i64,
    cycle_id: &str,
    niche: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "INSERT OR IGNORE INTO pipeline_cycles (cycle_id, project_id, niche, started_at) \
         VALUES (?, ?, ?, strftime('%s', 'now'))",
    )
    .bind(cycle_id)
    .bind(project_id)
    .bind(niche)
    .execute(pool)
    .await?;
    Ok(())
}

/// Record one job's contribution to a cycle. Wraps three writes in a single
/// transaction so we never observe an `agent_contributions` row without its
/// matching `pipeline_cycles` row.
pub async fn record_contribution(
    pool: &SqlitePool,
    project_id: i64,
    cycle_id: &str,
    role: &str,
    job_id: i64,
    cost_usd: f64,
    tokens_in: i64,
    tokens_out: i64,
    model: Option<&str>,
) -> Result<()> {
    let mut tx = pool.begin().await?;

    // Insert the cycle row if it doesn't exist yet — niche is unknown here.
    sqlx::query(
        "INSERT OR IGNORE INTO pipeline_cycles (cycle_id, project_id, started_at) \
         VALUES (?, ?, strftime('%s', 'now'))",
    )
    .bind(cycle_id)
    .bind(project_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "INSERT INTO agent_contributions \
         (project_id, cycle_id, role, job_id, cost_usd, tokens_in, tokens_out, model, occurred_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))",
    )
    .bind(project_id)
    .bind(cycle_id)
    .bind(role)
    .bind(job_id)
    .bind(cost_usd)
    .bind(tokens_in)
    .bind(tokens_out)
    .bind(model)
    .execute(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE pipeline_cycles SET total_cost_usd = total_cost_usd + ? WHERE cycle_id = ?",
    )
    .bind(cost_usd)
    .bind(cycle_id)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;
    Ok(())
}

/// Close a cycle: sum costs, compute net, distribute per-role share into
/// `agent_wealth`, and mark the cycle row closed. Idempotent — calling on
/// an already-closed cycle returns its existing summary unchanged.
pub async fn close_cycle(
    pool: &SqlitePool,
    project_id: i64,
    cycle_id: &str,
    revenue_usd: f64,
    local_listing_id: Option<i64>,
) -> Result<CycleSummary> {
    let mut tx = pool.begin().await?;

    // Idempotency: if already closed, return the stored summary.
    let existing: Option<(Option<String>, Option<i64>, Option<f64>, f64, Option<f64>, i64)> =
        sqlx::query_as(
            "SELECT niche, local_listing_id, estimated_revenue_usd, total_cost_usd, net_usd, closed \
             FROM pipeline_cycles WHERE cycle_id = ?",
        )
        .bind(cycle_id)
        .fetch_optional(&mut *tx)
        .await?;

    if let Some((niche, local_id, est_rev, total_cost, net, closed)) = existing.clone() {
        if closed == 1 {
            let contributor_count: i64 = sqlx::query_scalar(
                "SELECT COUNT(DISTINCT role) FROM agent_contributions WHERE cycle_id = ?",
            )
            .bind(cycle_id)
            .fetch_one(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(CycleSummary {
                cycle_id: cycle_id.to_string(),
                niche,
                local_listing_id: local_id,
                revenue_usd: est_rev.unwrap_or(0.0),
                total_cost_usd: total_cost,
                net_usd: net.unwrap_or(0.0),
                contributor_count,
            });
        }
    } else {
        // The cycle row doesn't exist — defensively create it so we always
        // emit a coherent summary.
        sqlx::query(
            "INSERT INTO pipeline_cycles (cycle_id, project_id, started_at) \
             VALUES (?, ?, strftime('%s', 'now'))",
        )
        .bind(cycle_id)
        .bind(project_id)
        .execute(&mut *tx)
        .await?;
    }

    // Aggregate per-role costs.
    let rows = sqlx::query(
        "SELECT role, SUM(cost_usd) AS total FROM agent_contributions \
         WHERE cycle_id = ? GROUP BY role",
    )
    .bind(cycle_id)
    .fetch_all(&mut *tx)
    .await?;

    let per_role: Vec<(String, f64)> = rows
        .into_iter()
        .map(|r| {
            let role: String = r.get("role");
            let total: f64 = r.get("total");
            (role, total)
        })
        .collect();

    let total_cost: f64 = per_role.iter().map(|(_, c)| *c).sum();
    let net = revenue_usd - total_cost;
    let contributor_count = per_role.len() as i64;

    // Mark the cycle closed.
    let niche: Option<String> = sqlx::query_scalar(
        "SELECT niche FROM pipeline_cycles WHERE cycle_id = ?",
    )
    .bind(cycle_id)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(
        "UPDATE pipeline_cycles SET \
            estimated_revenue_usd = ?, \
            local_listing_id = ?, \
            net_usd = ?, \
            total_cost_usd = ?, \
            ended_at = strftime('%s', 'now'), \
            closed = 1 \
         WHERE cycle_id = ?",
    )
    .bind(revenue_usd)
    .bind(local_listing_id)
    .bind(net)
    .bind(total_cost)
    .bind(cycle_id)
    .execute(&mut *tx)
    .await?;

    // Distribute per-role wealth. If total_cost is 0 (shouldn't happen but
    // be defensive: orchestrator alone always has a cost), split equally.
    if contributor_count > 0 {
        for (role, role_cost) in &per_role {
            let (role_revenue_share, role_net_share) = if total_cost > 0.0 {
                let share = role_cost / total_cost;
                (revenue_usd * share, net * share)
            } else {
                let n = contributor_count as f64;
                (revenue_usd / n, net / n)
            };

            sqlx::query(
                "INSERT INTO agent_wealth \
                    (project_id, role, lifetime_revenue_usd, lifetime_cost_usd, lifetime_net_usd, cycles_count, last_credit_at) \
                 VALUES (?, ?, ?, ?, ?, 1, strftime('%s', 'now')) \
                 ON CONFLICT(project_id, role) DO UPDATE SET \
                    lifetime_revenue_usd = lifetime_revenue_usd + excluded.lifetime_revenue_usd, \
                    lifetime_cost_usd = lifetime_cost_usd + excluded.lifetime_cost_usd, \
                    lifetime_net_usd = lifetime_net_usd + excluded.lifetime_net_usd, \
                    cycles_count = cycles_count + 1, \
                    last_credit_at = excluded.last_credit_at",
            )
            .bind(project_id)
            .bind(role)
            .bind(role_revenue_share)
            .bind(role_cost)
            .bind(role_net_share)
            .execute(&mut *tx)
            .await?;
        }
    }

    tx.commit().await?;

    // Reconcile: ledger-sum for this cycle should match total_cost_usd.
    let ledger_sum: Option<f64> = sqlx::query_scalar(
        "SELECT SUM(cost_usd) FROM agent_contributions WHERE cycle_id = ?",
    )
    .bind(cycle_id)
    .fetch_one(pool)
    .await
    .ok();
    if let Some(sum) = ledger_sum {
        if (sum - total_cost).abs() > 0.01 {
            tracing::warn!(
                cycle_id = %cycle_id,
                ledger_sum = sum,
                pnl_sum = total_cost,
                "pnl/ledger reconciliation mismatch > $0.01"
            );
        }
    }

    Ok(CycleSummary {
        cycle_id: cycle_id.to_string(),
        niche,
        local_listing_id,
        revenue_usd,
        total_cost_usd: total_cost,
        net_usd: net,
        contributor_count,
    })
}

pub async fn list_recent_cycles(
    pool: &SqlitePool,
    project_id: i64,
    limit: i64,
) -> Result<Vec<CycleSummary>> {
    let rows = sqlx::query(
        "SELECT cycle_id, niche, local_listing_id, \
            COALESCE(estimated_revenue_usd, 0.0) AS revenue_usd, \
            total_cost_usd, \
            COALESCE(net_usd, 0.0) AS net_usd \
         FROM pipeline_cycles \
         WHERE project_id = ? AND closed = 1 \
         ORDER BY started_at DESC \
         LIMIT ?",
    )
    .bind(project_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;

    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        let cycle_id: String = r.get("cycle_id");
        let contributor_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(DISTINCT role) FROM agent_contributions WHERE cycle_id = ?",
        )
        .bind(&cycle_id)
        .fetch_one(pool)
        .await
        .unwrap_or(0);
        out.push(CycleSummary {
            cycle_id,
            niche: r.get("niche"),
            local_listing_id: r.get("local_listing_id"),
            revenue_usd: r.get("revenue_usd"),
            total_cost_usd: r.get("total_cost_usd"),
            net_usd: r.get("net_usd"),
            contributor_count,
        });
    }
    Ok(out)
}

pub async fn list_wealth(pool: &SqlitePool, project_id: i64) -> Result<Vec<AgentWealth>> {
    let rows = sqlx::query(
        "SELECT role, lifetime_revenue_usd, lifetime_cost_usd, lifetime_net_usd, cycles_count \
         FROM agent_wealth WHERE project_id = ? ORDER BY lifetime_net_usd DESC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| AgentWealth {
            role: r.get("role"),
            lifetime_revenue_usd: r.get("lifetime_revenue_usd"),
            lifetime_cost_usd: r.get("lifetime_cost_usd"),
            lifetime_net_usd: r.get("lifetime_net_usd"),
            cycles_count: r.get("cycles_count"),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    /// In-memory pool with just the pnl schema. A shared `:memory:` db must
    /// use a single connection or each handle sees its own (empty) database.
    async fn setup_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(opts)
            .await
            .expect("open in-memory sqlite");
        let migration = include_str!("../migrations/0003_pnl.sql");
        // Each CREATE statement is separated by a `;` followed by a newline.
        for stmt in migration.split(';') {
            let s = stmt.trim();
            if s.is_empty() {
                continue;
            }
            sqlx::query(s)
                .execute(&pool)
                .await
                .expect("apply pnl migration");
        }
        pool
    }

    #[tokio::test]
    async fn record_contribution_creates_cycle_row() {
        let pool = setup_pool().await;
        record_contribution(
            &pool,
            1,
            "cyc-abc",
            "research",
            42,
            0.05,
            1000,
            500,
            Some("claude-haiku-4-5"),
        )
        .await
        .unwrap();

        let cnt: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM pipeline_cycles WHERE cycle_id = 'cyc-abc'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(cnt, 1);
        let total: f64 =
            sqlx::query_scalar("SELECT total_cost_usd FROM pipeline_cycles WHERE cycle_id = 'cyc-abc'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!((total - 0.05).abs() < 1e-9);
    }

    #[tokio::test]
    async fn close_cycle_distributes_net_proportionally() {
        let pool = setup_pool().await;
        // Seed the cycle with a known niche so the summary carries it through.
        ensure_cycle(&pool, 1, "cyc-prop", Some("test niche"))
            .await
            .unwrap();
        // Three roles: research=0.10, designer=0.30, listing=0.10. total=0.50.
        record_contribution(&pool, 1, "cyc-prop", "research", 1, 0.10, 0, 0, None)
            .await
            .unwrap();
        record_contribution(&pool, 1, "cyc-prop", "designer", 2, 0.30, 0, 0, None)
            .await
            .unwrap();
        record_contribution(&pool, 1, "cyc-prop", "listing", 3, 0.10, 0, 0, None)
            .await
            .unwrap();

        // Revenue $10. net = 10 - 0.5 = 9.50.
        let summary = close_cycle(&pool, 1, "cyc-prop", 10.0, Some(777))
            .await
            .unwrap();
        assert_eq!(summary.contributor_count, 3);
        assert!((summary.total_cost_usd - 0.50).abs() < 1e-9);
        assert!((summary.net_usd - 9.50).abs() < 1e-9);
        assert_eq!(summary.niche.as_deref(), Some("test niche"));
        assert_eq!(summary.local_listing_id, Some(777));

        // designer's share: 0.30/0.50 = 60% of net = $5.70.
        let row: (f64, f64, f64, i64) = sqlx::query_as(
            "SELECT lifetime_revenue_usd, lifetime_cost_usd, lifetime_net_usd, cycles_count \
             FROM agent_wealth WHERE project_id = 1 AND role = 'designer'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!((row.0 - 6.0).abs() < 1e-9, "designer revenue share = $6.00, got {}", row.0);
        assert!((row.1 - 0.30).abs() < 1e-9);
        assert!((row.2 - 5.70).abs() < 1e-9, "designer net share = $5.70, got {}", row.2);
        assert_eq!(row.3, 1);
    }

    #[tokio::test]
    async fn close_cycle_handles_zero_total_cost() {
        let pool = setup_pool().await;
        // Two contributors with zero cost each — defensive split-equally branch.
        ensure_cycle(&pool, 1, "cyc-zero", Some("zero niche"))
            .await
            .unwrap();
        record_contribution(&pool, 1, "cyc-zero", "research", 1, 0.0, 0, 0, None)
            .await
            .unwrap();
        record_contribution(&pool, 1, "cyc-zero", "designer", 2, 0.0, 0, 0, None)
            .await
            .unwrap();

        let summary = close_cycle(&pool, 1, "cyc-zero", 4.0, None).await.unwrap();
        assert!((summary.net_usd - 4.0).abs() < 1e-9);
        assert_eq!(summary.contributor_count, 2);

        // Each role should get half net ($2.00).
        let net: f64 = sqlx::query_scalar(
            "SELECT lifetime_net_usd FROM agent_wealth WHERE project_id = 1 AND role = 'research'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!((net - 2.0).abs() < 1e-9, "research net = $2.00, got {}", net);
    }

    #[tokio::test]
    async fn close_cycle_is_idempotent() {
        let pool = setup_pool().await;
        ensure_cycle(&pool, 1, "cyc-idem", Some("idem")).await.unwrap();
        record_contribution(&pool, 1, "cyc-idem", "research", 1, 0.10, 0, 0, None)
            .await
            .unwrap();

        let s1 = close_cycle(&pool, 1, "cyc-idem", 5.0, None).await.unwrap();
        // Second call must not double-credit wealth.
        let s2 = close_cycle(&pool, 1, "cyc-idem", 5.0, None).await.unwrap();
        assert_eq!(s1.cycle_id, s2.cycle_id);
        assert!((s1.net_usd - s2.net_usd).abs() < 1e-9);

        let net: f64 = sqlx::query_scalar(
            "SELECT lifetime_net_usd FROM agent_wealth WHERE project_id = 1 AND role = 'research'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        // Single credit only: should equal s1.net_usd exactly.
        assert!((net - s1.net_usd).abs() < 1e-9);
    }

    #[tokio::test]
    async fn list_recent_cycles_returns_descending() {
        let pool = setup_pool().await;
        ensure_cycle(&pool, 1, "c1", Some("alpha")).await.unwrap();
        record_contribution(&pool, 1, "c1", "research", 1, 0.05, 0, 0, None)
            .await
            .unwrap();
        close_cycle(&pool, 1, "c1", 5.0, None).await.unwrap();

        // Force a 1-second gap so started_at differs (uses strftime seconds).
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        ensure_cycle(&pool, 1, "c2", Some("beta")).await.unwrap();
        record_contribution(&pool, 1, "c2", "research", 2, 0.10, 0, 0, None)
            .await
            .unwrap();
        close_cycle(&pool, 1, "c2", 8.0, None).await.unwrap();

        let cycles = list_recent_cycles(&pool, 1, 10).await.unwrap();
        assert_eq!(cycles.len(), 2);
        assert_eq!(cycles[0].cycle_id, "c2");
        assert_eq!(cycles[1].cycle_id, "c1");
    }
}
