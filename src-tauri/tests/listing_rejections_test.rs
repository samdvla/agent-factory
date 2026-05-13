//! Integration tests for the draft-review action backend.
//! Confirms migration 0012 applies cleanly and the reject / regenerate /
//! restore SQL transitions behave as the spec describes — covering the
//! actual queries the new Tauri commands run, without spinning up the
//! Tauri runtime.

use agent_factory_lib::db;
use sqlx::SqlitePool;
use tempfile::TempDir;

async fn setup() -> (TempDir, SqlitePool, i64) {
    let tmp = TempDir::new().unwrap();
    let pool = db::open(&tmp.path().join("test.sqlite")).await.unwrap();
    let project_id: i64 = sqlx::query_scalar(
        "INSERT INTO projects (name, goal, status) VALUES (?, ?, 'active') RETURNING id",
    )
    .bind("etsy")
    .bind("sell digital products")
    .fetch_one(&pool)
    .await
    .unwrap();
    (tmp, pool, project_id)
}

async fn insert_draft(
    pool: &SqlitePool,
    project_id: i64,
    local_listing_id: i64,
    title: &str,
) {
    sqlx::query(
        "INSERT INTO etsy_publishes \
         (project_id, local_listing_id, etsy_listing_id, state, title, url, published_at, day) \
         VALUES (?, ?, ?, 'draft', ?, NULL, ?, '2026-05-12')",
    )
    .bind(project_id)
    .bind(local_listing_id)
    .bind(100 + local_listing_id)
    .bind(title)
    .bind(1_715_000_000_i64)
    .execute(pool)
    .await
    .unwrap();
}

#[tokio::test]
async fn migration_creates_listing_rejections_and_parent_column() {
    let (_tmp, pool, _) = setup().await;

    // parent_listing_id is selectable (column exists).
    sqlx::query_scalar::<_, Option<i64>>("SELECT parent_listing_id FROM etsy_publishes LIMIT 1")
        .fetch_optional(&pool)
        .await
        .expect("parent_listing_id column exists");

    // listing_rejections is selectable (table exists).
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM listing_rejections")
        .fetch_one(&pool)
        .await
        .expect("listing_rejections table exists");
    assert_eq!(count, 0);
}

#[tokio::test]
async fn reject_transitions_state_and_persists_learning_row() {
    let (_tmp, pool, project_id) = setup().await;
    insert_draft(&pool, project_id, 42, "Ugly goblin warrior STL").await;

    // Mirror cmd_etsy_reject_draft's tx body.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query(
        "UPDATE etsy_publishes SET state = 'rejected' \
         WHERE project_id = ? AND local_listing_id = ?",
    )
    .bind(project_id)
    .bind(42_i64)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO listing_rejections \
         (project_id, local_listing_id, cycle_id, title, niche, tags_json, description, rejected_at, reason) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(project_id)
    .bind(42_i64)
    .bind(Option::<&str>::None)
    .bind("Ugly goblin warrior STL")
    .bind(Some("dnd minis"))
    .bind("[\"stl\",\"dnd\",\"miniature\"]")
    .bind("A goblin warrior in stylized cartoon form.")
    .bind(1_715_001_234_000_i64)
    .bind(Some("too generic"))
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let state: String = sqlx::query_scalar(
        "SELECT state FROM etsy_publishes WHERE project_id = ? AND local_listing_id = ?",
    )
    .bind(project_id)
    .bind(42_i64)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(state, "rejected");

    let (title, niche, reason): (String, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT title, niche, reason FROM listing_rejections WHERE local_listing_id = ?",
    )
    .bind(42_i64)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(title, "Ugly goblin warrior STL");
    assert_eq!(niche.as_deref(), Some("dnd minis"));
    assert_eq!(reason.as_deref(), Some("too generic"));
}

#[tokio::test]
async fn regenerate_moves_draft_to_queued() {
    let (_tmp, pool, project_id) = setup().await;
    insert_draft(&pool, project_id, 7, "Some draft").await;

    // Mirror cmd_etsy_regenerate_draft's UPDATE.
    sqlx::query(
        "UPDATE etsy_publishes SET state = 'queued' \
         WHERE project_id = ? AND local_listing_id = ? AND state = 'draft'",
    )
    .bind(project_id)
    .bind(7_i64)
    .execute(&pool)
    .await
    .unwrap();

    let state: String = sqlx::query_scalar(
        "SELECT state FROM etsy_publishes WHERE project_id = ? AND local_listing_id = ?",
    )
    .bind(project_id)
    .bind(7_i64)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(state, "queued");

    // Re-running on a queued row is a no-op (the WHERE clause requires draft).
    sqlx::query(
        "UPDATE etsy_publishes SET state = 'queued' \
         WHERE project_id = ? AND local_listing_id = ? AND state = 'draft'",
    )
    .bind(project_id)
    .bind(7_i64)
    .execute(&pool)
    .await
    .unwrap();
    let state2: String = sqlx::query_scalar(
        "SELECT state FROM etsy_publishes WHERE project_id = ? AND local_listing_id = ?",
    )
    .bind(project_id)
    .bind(7_i64)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(state2, "queued");
}

#[tokio::test]
async fn restore_pulls_rejected_back_and_deletes_learning_row() {
    let (_tmp, pool, project_id) = setup().await;
    insert_draft(&pool, project_id, 99, "Reversible reject").await;

    // Reject.
    sqlx::query(
        "UPDATE etsy_publishes SET state = 'rejected' \
         WHERE project_id = ? AND local_listing_id = ?",
    )
    .bind(project_id)
    .bind(99_i64)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO listing_rejections \
         (project_id, local_listing_id, cycle_id, title, niche, tags_json, description, rejected_at, reason) \
         VALUES (?, ?, NULL, ?, NULL, '[]', '', ?, NULL)",
    )
    .bind(project_id)
    .bind(99_i64)
    .bind("Reversible reject")
    .bind(1_715_001_234_000_i64)
    .execute(&pool)
    .await
    .unwrap();

    // Restore.
    let mut tx = pool.begin().await.unwrap();
    sqlx::query(
        "UPDATE etsy_publishes SET state = 'draft' \
         WHERE project_id = ? AND local_listing_id = ? AND state = 'rejected'",
    )
    .bind(project_id)
    .bind(99_i64)
    .execute(&mut *tx)
    .await
    .unwrap();
    sqlx::query(
        "DELETE FROM listing_rejections \
         WHERE project_id = ? AND local_listing_id = ?",
    )
    .bind(project_id)
    .bind(99_i64)
    .execute(&mut *tx)
    .await
    .unwrap();
    tx.commit().await.unwrap();

    let state: String = sqlx::query_scalar(
        "SELECT state FROM etsy_publishes WHERE project_id = ? AND local_listing_id = ?",
    )
    .bind(project_id)
    .bind(99_i64)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(state, "draft");

    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM listing_rejections WHERE local_listing_id = ?",
    )
    .bind(99_i64)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(remaining, 0);
}

#[tokio::test]
async fn snapshot_writes_json_python_can_parse() {
    use agent_factory_lib::commands::snapshot_rejections_to_disk;
    use std::env;

    let (tmp, pool, project_id) = setup().await;
    // Isolate HOME so the snapshot doesn't touch the real ~/.agent-factory.
    let home_guard = env::var("HOME").ok();
    env::set_var("HOME", tmp.path());

    sqlx::query(
        "INSERT INTO listing_rejections \
         (project_id, local_listing_id, cycle_id, title, niche, tags_json, description, rejected_at, reason) \
         VALUES (?, ?, NULL, ?, ?, '[]', '', ?, NULL)",
    )
    .bind(project_id)
    .bind(1_i64)
    .bind("Ugly goblin warrior STL")
    .bind(Some("dnd minis"))
    .bind(2_000_i64)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO listing_rejections \
         (project_id, local_listing_id, cycle_id, title, niche, tags_json, description, rejected_at, reason) \
         VALUES (?, ?, NULL, ?, ?, '[]', '', ?, NULL)",
    )
    .bind(project_id)
    .bind(2_i64)
    .bind("Generic dragon bust")
    .bind(Option::<&str>::None)
    .bind(3_000_i64)
    .execute(&pool)
    .await
    .unwrap();

    snapshot_rejections_to_disk(&pool, project_id).await.unwrap();

    let path = tmp.path().join(".agent-factory").join("rejections.json");
    let text = std::fs::read_to_string(&path).expect("snapshot file written");
    let parsed: serde_json::Value = serde_json::from_str(&text).expect("valid JSON");
    let arr = parsed.get("rejections").and_then(|v| v.as_array()).expect("array");
    assert_eq!(arr.len(), 2);
    // Newest-first ordering matches what Python's _load_rejection_avoid_list expects.
    assert_eq!(arr[0]["title"].as_str(), Some("Generic dragon bust"));
    assert!(arr[0]["niche"].is_null());
    assert_eq!(arr[1]["title"].as_str(), Some("Ugly goblin warrior STL"));
    assert_eq!(arr[1]["niche"].as_str(), Some("dnd minis"));

    // Restore HOME for any later tests.
    match home_guard {
        Some(h) => env::set_var("HOME", h),
        None => env::remove_var("HOME"),
    }
}

#[tokio::test]
async fn list_rejections_returns_newest_first() {
    let (_tmp, pool, project_id) = setup().await;

    for (id, ts) in [(1_i64, 1_000_i64), (2, 3_000), (3, 2_000)] {
        sqlx::query(
            "INSERT INTO listing_rejections \
             (project_id, local_listing_id, cycle_id, title, niche, tags_json, description, rejected_at, reason) \
             VALUES (?, ?, NULL, ?, NULL, '[]', '', ?, NULL)",
        )
        .bind(project_id)
        .bind(id)
        .bind(format!("title-{id}"))
        .bind(ts)
        .execute(&pool)
        .await
        .unwrap();
    }

    // Mirror cmd_etsy_list_rejections's ORDER BY.
    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT local_listing_id FROM listing_rejections \
         WHERE project_id = ? ORDER BY rejected_at DESC LIMIT ?",
    )
    .bind(project_id)
    .bind(100_i64)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(ids, vec![2, 3, 1]);
}
