//! Manual end-to-end marketplace listing smoke tests.
//!
//! Each test publishes ONE real listing to a live marketplace using the
//! operator's stored credentials. It exercises the actual production
//! publish handler — asset hosting, the marketplace API call, and the DB
//! record — against a fresh temporary database.
//!
//! These are `#[ignore]`d: they create REAL listings, need network access,
//! and read credentials from `~/.agent-factory/secrets.dev.json`. The test
//! asset (a ghost figurine) must exist under `~/.agent-factory/assets/`;
//! tests skip cleanly if it is absent.
//!
//! Run one:   cargo test --lib -- --ignored cults3d_publishes_real
//! Run all:   cargo test --lib -- --ignored marketplace --test-threads=1

use crate::events::{EventBus, SupervisorEvent};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use tokio::sync::broadcast;

/// On-disk asset used for every test listing — a cute ghost figurine with
/// a popsicle. STL + GLB + rendered previews must already be present.
const ASSET_ID: &str = "2255";

fn assets_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".agent-factory").join("assets")
}

/// Build a publisher_result for the test asset, or `None` if its files are
/// not on disk (so the test can skip instead of failing spuriously).
fn test_result(listing_id: i64) -> Option<Value> {
    let a = assets_dir();
    let stl = a.join(format!("{ASSET_ID}.stl"));
    let glb = a.join(format!("{ASSET_ID}.glb"));
    let hero = a.join(format!("{ASSET_ID}.png"));
    if !stl.exists() || !glb.exists() || !hero.exists() {
        return None;
    }
    let imgs: Vec<String> = ["tex-0", "clay-0", "clay-1", "clay-2", "clay-3"]
        .iter()
        .map(|s| a.join(format!("{ASSET_ID}-{s}.png")))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    Some(json!({
        "listing_id": listing_id,
        "job_id": listing_id,
        "title": "Cute Ghost Figurine with Popsicle - STL for 3D Printing",
        "description": "A cheerful little ghost character holding a popsicle and \
wearing a sun hat — a charming desk companion and collectible figurine. This \
listing is the digital STL and GLB file set for printing at home; no physical \
item ships. Designed with AI assistance. Prints cleanly at desk-toy scale.",
        "tags": ["ghost figurine", "3d print", "stl file", "cute", "desk decor",
                 "kawaii", "collectible", "printable"],
        "price_usd": 3.0,
        "niche": "cute character figurines",
        "asset_path": stl.to_string_lossy(),
        "glb_path": glb.to_string_lossy(),
        "preview_pngs": imgs,
        "product_type": "stl_file",
    }))
}

/// A fresh temp DB (full schema via migrations), a project row, and a bus.
async fn setup() -> (sqlx::SqlitePool, i64, EventBus) {
    let stamp = chrono::Utc::now()
        .timestamp_nanos_opt()
        .unwrap_or_else(|| chrono::Utc::now().timestamp());
    let path = std::env::temp_dir().join(format!("af-mp-smoke-{stamp}.sqlite"));
    let pool = crate::db::open(&path).await.expect("open temp db");
    let project_id: i64 = sqlx::query_scalar(
        "INSERT INTO projects (name, goal, status) \
         VALUES ('mp-smoke', 'test', 'active') RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .expect("insert project");
    (pool, project_id, EventBus::new())
}

/// Distinct local listing id per test slot.
fn listing_id(slot: i64) -> i64 {
    chrono::Utc::now().timestamp() * 100 + slot
}

/// Drain every event the bus emitted (for failure diagnostics).
fn drain(rx: &mut broadcast::Receiver<SupervisorEvent>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(e) = rx.try_recv() {
        out.push(format!("{e:?}"));
    }
    out
}

/// `(state, error)` of a `<marketplace>_publishes` row, if one was written.
async fn publish_row(
    pool: &sqlx::SqlitePool,
    table: &str,
    lid: i64,
) -> Option<(String, Option<String>)> {
    sqlx::query_as(&format!(
        "SELECT state, error FROM {table} WHERE local_listing_id = ?"
    ))
    .bind(lid)
    .fetch_optional(pool)
    .await
    .unwrap_or(None)
}

#[tokio::test]
#[ignore]
async fn cults3d_publishes_real_listing() {
    let lid = listing_id(1);
    let Some(result) = test_result(lid) else {
        eprintln!("SKIP: test asset {ASSET_ID} not on disk");
        return;
    };
    let (pool, project_id, bus) = setup().await;
    let mut rx = bus.subscribe();
    crate::cults3d_publish::handle_publisher_complete_cults3d(&pool, project_id, &bus, &result)
        .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let events = drain(&mut rx);
    let row = publish_row(&pool, "cults3d_publishes", lid).await;
    assert!(
        matches!(&row, Some((s, _)) if s == "published"),
        "cults3d publish did not succeed: row={row:?}, events={events:?}"
    );
    println!("cults3d OK: {row:?}");
}

#[tokio::test]
#[ignore]
async fn etsy_publishes_real_draft() {
    let lid = listing_id(2);
    let Some(result) = test_result(lid) else {
        eprintln!("SKIP: test asset {ASSET_ID} not on disk");
        return;
    };
    let (pool, project_id, bus) = setup().await;
    let mut rx = bus.subscribe();
    crate::etsy_publish::handle_publisher_complete(&pool, project_id, &bus, &result).await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let events = drain(&mut rx);
    // etsy_publishes has no `error` column — a row at all means success.
    let state: Option<String> =
        sqlx::query_scalar("SELECT state FROM etsy_publishes WHERE local_listing_id = ?")
            .bind(lid)
            .fetch_optional(&pool)
            .await
            .unwrap();
    assert!(
        state.is_some(),
        "etsy publish did not create a listing: events={events:?}"
    );
    println!("etsy OK: state={state:?}");
}

#[tokio::test]
#[ignore]
async fn gumroad_publishes_real_product() {
    let lid = listing_id(3);
    let Some(result) = test_result(lid) else {
        eprintln!("SKIP: test asset {ASSET_ID} not on disk");
        return;
    };
    let (pool, project_id, bus) = setup().await;
    let mut rx = bus.subscribe();
    crate::gumroad_publish::handle_publisher_complete_gumroad(&pool, project_id, &bus, &result)
        .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let events = drain(&mut rx);
    let row = publish_row(&pool, "gumroad_publishes", lid).await;
    // `published` (with file) or `published_no_file` both mean the product
    // was created on Gumroad — only `errored` is a failure.
    assert!(
        matches!(&row, Some((s, _)) if s.starts_with("published")),
        "gumroad publish did not succeed: row={row:?}, events={events:?}"
    );
    println!("gumroad OK: {row:?}");
}

#[tokio::test]
#[ignore]
async fn mmf_publishes_real_object() {
    let lid = listing_id(4);
    let Some(result) = test_result(lid) else {
        eprintln!("SKIP: test asset {ASSET_ID} not on disk");
        return;
    };
    let (pool, project_id, bus) = setup().await;
    let mut rx = bus.subscribe();
    crate::myminifactory_publish::handle_publisher_complete_mmf(&pool, project_id, &bus, &result)
        .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let events = drain(&mut rx);
    let row = publish_row(&pool, "mmf_publishes", lid).await;
    assert!(
        matches!(&row, Some((s, _)) if s == "published"),
        "myminifactory publish did not succeed: row={row:?}, events={events:?}"
    );
    println!("myminifactory OK: {row:?}");
}

#[tokio::test]
#[ignore]
async fn sketchfab_publishes_real_model() {
    let lid = listing_id(5);
    let Some(result) = test_result(lid) else {
        eprintln!("SKIP: test asset {ASSET_ID} not on disk");
        return;
    };
    let (pool, project_id, bus) = setup().await;
    let mut rx = bus.subscribe();
    crate::sketchfab_publish::handle_publisher_complete_sketchfab(&pool, project_id, &bus, &result)
        .await;
    tokio::time::sleep(Duration::from_secs(3)).await;
    let events = drain(&mut rx);
    let row = publish_row(&pool, "sketchfab_publishes", lid).await;
    assert!(
        matches!(&row, Some((s, _)) if s == "published"),
        "sketchfab publish did not succeed: row={row:?}, events={events:?}"
    );
    println!("sketchfab OK: {row:?}");
}
