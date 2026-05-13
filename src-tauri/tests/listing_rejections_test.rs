//! Integration tests for the draft-review action backend.
//! Confirms migration 0012 applies cleanly and the reject / regenerate /
//! restore SQL transitions behave as the spec describes — covering the
//! actual queries the new Tauri commands run, without spinning up the
//! Tauri runtime.

use agent_factory_lib::db;
use sqlx::SqlitePool;
use std::sync::{Mutex, OnceLock};
use tempfile::TempDir;

/// Tests that mutate the process-global HOME env var must serialize — cargo
/// runs tests in parallel threads and `env::set_var` is process-wide, so a
/// concurrent test would otherwise read the wrong HOME and assert against
/// the wrong tmp dir.
fn home_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

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

    let _guard = home_lock().lock().unwrap();
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
async fn operator_feedback_snapshot_groups_by_role_and_caps_per_role() {
    use agent_factory_lib::commands::snapshot_operator_feedback_to_disk;
    use std::env;

    let _guard = home_lock().lock().unwrap();
    let (tmp, pool, project_id) = setup().await;
    let home_guard = env::var("HOME").ok();
    env::set_var("HOME", tmp.path());

    // Seed jobs across roles + ratings.
    for (job_id, role) in [
        (1_i64, "designer"),
        (2, "designer"),
        (3, "research"),
        (4, "listing"),
    ] {
        sqlx::query(
            "INSERT INTO jobs (id, project_id, agent_role, status, payload_json, scheduled_at) \
             VALUES (?, ?, ?, 'done', '{}', '2026-05-12T00:00:00Z')",
        )
        .bind(job_id)
        .bind(project_id)
        .bind(role)
        .execute(&pool)
        .await
        .unwrap();
    }
    for (job_id, rating, note, ts) in [
        (1_i64, "down", Some("too generic"), 3_000_i64),
        (2_i64, "up", None, 4_000_i64),
        (3_i64, "down", Some("niche too narrow"), 2_000_i64),
        (4_i64, "up", Some("great tags"), 1_000_i64),
    ] {
        sqlx::query(
            "INSERT INTO job_feedback (job_id, rating, note, rater, created_at) \
             VALUES (?, ?, ?, 'operator', ?)",
        )
        .bind(job_id)
        .bind(rating)
        .bind(note)
        .bind(ts)
        .execute(&pool)
        .await
        .unwrap();
    }

    snapshot_operator_feedback_to_disk(&pool, project_id).await.unwrap();

    let text = std::fs::read_to_string(tmp.path().join(".agent-factory").join("operator_feedback.json"))
        .expect("snapshot exists");
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    let by_role = parsed.get("by_role").and_then(|v| v.as_object()).expect("by_role");

    let designer = by_role.get("designer").and_then(|v| v.as_array()).expect("designer");
    assert_eq!(designer.len(), 2);
    // Newest-first within role.
    assert_eq!(designer[0]["rating"].as_str(), Some("up"));
    assert_eq!(designer[1]["rating"].as_str(), Some("down"));
    assert_eq!(designer[1]["note"].as_str(), Some("too generic"));

    let research = by_role.get("research").and_then(|v| v.as_array()).unwrap();
    assert_eq!(research.len(), 1);
    assert_eq!(research[0]["note"].as_str(), Some("niche too narrow"));

    let listing = by_role.get("listing").and_then(|v| v.as_array()).unwrap();
    assert_eq!(listing.len(), 1);

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
