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
