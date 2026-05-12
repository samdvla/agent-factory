use agent_factory_lib::{db, queue};
use serde_json::json;
use tempfile::TempDir;

async fn setup() -> (TempDir, sqlx::SqlitePool, i64) {
    let tmp = TempDir::new().unwrap();
    let pool = db::open(&tmp.path().join("fb.sqlite")).await.unwrap();
    let project_id: i64 = sqlx::query_scalar(
        "INSERT INTO projects (name, goal, status) VALUES ('t','g','active') RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    (tmp, pool, project_id)
}

#[tokio::test]
async fn upsert_rating_replaces_existing() {
    let (_tmp, pool, project_id) = setup().await;
    let job_id = queue::enqueue(&pool, project_id, "research", json!({"smoke": true}))
        .await
        .unwrap();
    queue::complete(&pool, job_id, json!({"ok": true, "brief": {"niche": "x"}}))
        .await
        .unwrap();

    let now = chrono::Utc::now().timestamp();
    // First rating: up
    sqlx::query(
        "INSERT INTO job_feedback (job_id, rating, note, rater, created_at) \
         VALUES (?, 'up', 'first note', 'operator', ?) \
         ON CONFLICT(job_id, rater) DO UPDATE SET \
           rating = excluded.rating, note = excluded.note, created_at = excluded.created_at",
    )
    .bind(job_id)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    // Replace with down + different note
    sqlx::query(
        "INSERT INTO job_feedback (job_id, rating, note, rater, created_at) \
         VALUES (?, 'down', 'changed my mind', 'operator', ?) \
         ON CONFLICT(job_id, rater) DO UPDATE SET \
           rating = excluded.rating, note = excluded.note, created_at = excluded.created_at",
    )
    .bind(job_id)
    .bind(now + 1)
    .execute(&pool)
    .await
    .unwrap();

    let row: (String, Option<String>) = sqlx::query_as(
        "SELECT rating, note FROM job_feedback WHERE job_id = ? AND rater = 'operator'",
    )
    .bind(job_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "down");
    assert_eq!(row.1.as_deref(), Some("changed my mind"));

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM job_feedback WHERE job_id = ?",
    )
    .bind(job_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1, "upsert must not duplicate");
}

#[tokio::test]
async fn list_jobs_join_returns_rating_when_present() {
    let (_tmp, pool, project_id) = setup().await;
    let j1 = queue::enqueue(&pool, project_id, "research", json!({})).await.unwrap();
    let j2 = queue::enqueue(&pool, project_id, "designer", json!({})).await.unwrap();
    queue::complete(&pool, j1, json!({"ok": true})).await.unwrap();
    queue::complete(&pool, j2, json!({"ok": true})).await.unwrap();
    let now = chrono::Utc::now().timestamp();
    sqlx::query(
        "INSERT INTO job_feedback (job_id, rating, note, rater, created_at) \
         VALUES (?, 'up', NULL, 'operator', ?)",
    )
    .bind(j2)
    .bind(now)
    .execute(&pool)
    .await
    .unwrap();

    let rows: Vec<(i64, String, Option<String>)> = sqlx::query_as(
        "SELECT j.id, j.agent_role, f.rating \
         FROM jobs j \
         LEFT JOIN job_feedback f ON f.job_id = j.id AND f.rater = 'operator' \
         WHERE j.project_id = ? ORDER BY j.id ASC",
    )
    .bind(project_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0], (j1, "research".to_string(), None));
    assert_eq!(rows[1], (j2, "designer".to_string(), Some("up".to_string())));
}
