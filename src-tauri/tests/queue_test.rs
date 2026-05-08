use agent_factory_lib::{db, queue};
use serde_json::json;
use tempfile::TempDir;

async fn setup() -> (TempDir, sqlx::SqlitePool, i64) {
    let tmp = TempDir::new().unwrap();
    let pool = db::open(&tmp.path().join("q.sqlite")).await.unwrap();
    let project_id: i64 = sqlx::query_scalar(
        "INSERT INTO projects (name, goal, status) VALUES ('test','t','active') RETURNING id"
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    (tmp, pool, project_id)
}

#[tokio::test]
async fn enqueue_then_claim_returns_the_job() {
    let (_tmp, pool, project_id) = setup().await;
    let job_id = queue::enqueue(&pool, project_id, "hello", json!({"msg":"hi"})).await.unwrap();

    let claimed = queue::claim(&pool, "hello").await.unwrap();
    assert!(claimed.is_some());
    let job = claimed.unwrap();
    assert_eq!(job.id, job_id);
    assert_eq!(job.status, "running");
}

#[tokio::test]
async fn second_claim_skips_running_job() {
    let (_tmp, pool, project_id) = setup().await;
    queue::enqueue(&pool, project_id, "hello", json!({"msg":"hi"})).await.unwrap();
    queue::claim(&pool, "hello").await.unwrap();

    let second = queue::claim(&pool, "hello").await.unwrap();
    assert!(second.is_none());
}

#[tokio::test]
async fn complete_marks_done_and_stores_result() {
    let (_tmp, pool, project_id) = setup().await;
    let job_id = queue::enqueue(&pool, project_id, "hello", json!({"msg":"hi"})).await.unwrap();
    queue::claim(&pool, "hello").await.unwrap();
    queue::complete(&pool, job_id, json!({"echo":"hi"})).await.unwrap();

    let row: (String, Option<String>) = sqlx::query_as("SELECT status, result_json FROM jobs WHERE id = ?")
        .bind(job_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, "done");
    assert!(row.1.unwrap().contains("hi"));
}

#[tokio::test]
async fn fail_increments_attempts_and_marks_errored() {
    let (_tmp, pool, project_id) = setup().await;
    let job_id = queue::enqueue(&pool, project_id, "hello", json!({"msg":"hi"})).await.unwrap();
    queue::claim(&pool, "hello").await.unwrap();
    queue::fail(&pool, job_id, "boom").await.unwrap();

    let row: (String, i64, Option<String>) =
        sqlx::query_as("SELECT status, attempts, error FROM jobs WHERE id = ?")
        .bind(job_id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(row.0, "errored");
    assert_eq!(row.1, 1);
    assert_eq!(row.2.unwrap(), "boom");
}
