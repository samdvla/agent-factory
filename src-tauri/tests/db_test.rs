use agent_factory_lib::db;
use tempfile::TempDir;

#[tokio::test]
async fn opens_db_runs_migrations_and_can_insert_project() {
    let tmp = TempDir::new().unwrap();
    let db_path = tmp.path().join("test.sqlite");

    let pool = db::open(&db_path).await.expect("open db");

    let project_id: i64 = sqlx::query_scalar(
        "INSERT INTO projects (name, goal, status) VALUES (?, ?, 'active') RETURNING id"
    )
    .bind("etsy")
    .bind("sell digital products")
    .fetch_one(&pool)
    .await
    .expect("insert project");

    assert!(project_id > 0);
}
