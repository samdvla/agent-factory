use agent_factory_lib::{db, budget};
use sqlx::SqlitePool;
use tempfile::TempDir;

async fn setup() -> (TempDir, SqlitePool, i64) {
    let tmp = TempDir::new().unwrap();
    let pool = db::open(&tmp.path().join("b.sqlite")).await.unwrap();
    let project_id: i64 = sqlx::query_scalar(
        "INSERT INTO projects (name, goal, status) VALUES ('test','t','active') RETURNING id"
    )
    .fetch_one(&pool).await.unwrap();
    (tmp, pool, project_id)
}

#[tokio::test]
async fn record_then_today_spend_returns_sum() {
    let (_tmp, pool, project_id) = setup().await;
    budget::record(&pool, project_id, "claude-haiku-4-5-20251001", 100, 50).await.unwrap();
    budget::record(&pool, project_id, "claude-haiku-4-5-20251001", 200, 100).await.unwrap();

    let usd = budget::today_spend_usd(&pool, project_id).await.unwrap();
    // haiku: $0.80/M in, $4.00/M out → 300*0.80/1e6 + 150*4.00/1e6 = 0.00024 + 0.0006 = 0.00084
    assert!((usd - 0.00084).abs() < 1e-9, "got {}", usd);
}

#[tokio::test]
async fn cap_check_blocks_when_over_limit() {
    let (_tmp, pool, project_id) = setup().await;
    // huge call to push spend up
    budget::record(&pool, project_id, "claude-opus-4-7", 1_000_000, 500_000).await.unwrap();
    // opus: $15/M in, $75/M out → $52.50

    let allowed = budget::check_cap(&pool, project_id, 10.0).await.unwrap();
    assert!(!allowed);

    let allowed = budget::check_cap(&pool, project_id, 100.0).await.unwrap();
    assert!(allowed);
}

#[tokio::test]
async fn spend_window_returns_only_recent_rows() {
    let (_tmp, pool, project_id) = setup().await;
    // 1M haiku input @ $0.80/M = $0.80
    budget::record(&pool, project_id, "claude-haiku-4-5-20251001", 1_000_000, 0).await.unwrap();
    let w = budget::spend_window(&pool, project_id, 1).await.unwrap();
    assert!((w - 0.80).abs() < 1e-9, "1h window got {w}");
}

#[tokio::test]
async fn month_spend_returns_calendar_month_total() {
    let (_tmp, pool, project_id) = setup().await;
    // 1M sonnet input @ $3/M = $3.00
    budget::record(&pool, project_id, "claude-sonnet-4-6", 1_000_000, 0).await.unwrap();
    let m = budget::month_spend_usd(&pool, project_id).await.unwrap();
    assert!((m - 3.00).abs() < 1e-9, "month got {m}");
}

#[test]
fn estimate_cost_is_monotonic_in_input_length() {
    let small = budget::estimate_cost("claude-sonnet-4-6", 100, 100);
    let big   = budget::estimate_cost("claude-sonnet-4-6", 10_000, 100);
    assert!(big > small, "expected monotonic in tokens_in");
}

#[tokio::test]
async fn enforce_caps_returns_hour_when_hourly_exceeded() {
    let (_tmp, pool, project_id) = setup().await;
    // 1M sonnet input = $3.00 — over an hourly cap of $1
    budget::record(&pool, project_id, "claude-sonnet-4-6", 1_000_000, 0).await.unwrap();
    let caps = budget::BudgetCaps { hourly_usd: 1.0, daily_usd: 100.0, monthly_usd: 1000.0 };
    let outcome = budget::enforce_caps(&pool, project_id, caps, 0.0).await.unwrap();
    match outcome {
        budget::CapOutcome::Capped { scope, .. } => {
            assert!(matches!(scope, agent_factory_lib::events::BudgetCapScope::Hour));
        }
        _ => panic!("expected Capped(Hour)"),
    }
}

#[tokio::test]
async fn enforce_caps_returns_ok_when_under_all_caps() {
    let (_tmp, pool, project_id) = setup().await;
    let caps = budget::BudgetCaps::defaults();
    let outcome = budget::enforce_caps(&pool, project_id, caps, 0.0).await.unwrap();
    assert!(matches!(outcome, budget::CapOutcome::Ok));
}

#[tokio::test]
async fn enforce_caps_preflight_blocks_when_estimate_pushes_over() {
    let (_tmp, pool, project_id) = setup().await;
    // current spend: $0.40 (just under $0.50 hourly default)
    budget::record(&pool, project_id, "claude-haiku-4-5-20251001", 500_000, 0).await.unwrap();
    let caps = budget::BudgetCaps { hourly_usd: 0.50, daily_usd: 100.0, monthly_usd: 1000.0 };
    // estimate of $0.20 pushes total to $0.60, over $0.50 hourly
    let outcome = budget::enforce_caps(&pool, project_id, caps, 0.20).await.unwrap();
    assert!(matches!(outcome, budget::CapOutcome::Capped { .. }));
}
