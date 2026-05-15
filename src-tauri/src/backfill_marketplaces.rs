//! One-shot marketplace backfill.
//!
//! Publishes every existing 3D model to Gumroad, MyMiniFactory and
//! Sketchfab so those marketplaces reach parity with Cults3D. It drives
//! the real production publish handlers (asset hosting, marketplace APIs,
//! image upload) against the live app database.
//!
//! Ignored by default — it creates real listings. Run with:
//!   cargo test --lib -- --ignored backfill_all_marketplaces --nocapture
//!
//! Resumable: a model already in a `published*` state for a marketplace is
//! skipped, so a re-run only retries what failed. Progress is also logged
//! to ~/.agent-factory/marketplace_backfill.jsonl.

use serde_json::Value;
use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").expect("HOME"))
}

/// The live app database path, as written by the app to db_path.txt.
fn app_db_path() -> PathBuf {
    let raw = std::fs::read_to_string(home().join(".agent-factory/db_path.txt"))
        .expect("read ~/.agent-factory/db_path.txt — start the app once first");
    PathBuf::from(raw.trim())
}

/// True if `<table>` already carries a published-state row for this model.
async fn already_published(pool: &sqlx::SqlitePool, table: &str, lid: i64) -> bool {
    let n: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM {table} WHERE local_listing_id = ? AND state LIKE 'published%'"
    ))
    .bind(lid)
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    n > 0
}

/// Most recent row state for a model in `<table>`.
async fn latest_state(pool: &sqlx::SqlitePool, table: &str, lid: i64) -> Option<String> {
    sqlx::query_scalar(&format!(
        "SELECT state FROM {table} WHERE local_listing_id = ? ORDER BY id DESC LIMIT 1"
    ))
    .bind(lid)
    .fetch_optional(pool)
    .await
    .unwrap_or(None)
}

#[tokio::test]
#[ignore]
async fn backfill_all_marketplaces() {
    let pool = crate::db::open(&app_db_path()).await.expect("open app db");
    let project_id: i64 =
        sqlx::query_scalar("SELECT id FROM projects WHERE name = 'default' LIMIT 1")
            .fetch_one(&pool)
            .await
            .expect("default project");
    let bus = crate::events::EventBus::new();

    // Enumerate models: the latest publisher 'done' result per listing_id,
    // restricted to 3D products.
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT result_json FROM jobs WHERE agent_role = 'publisher' AND status = 'done' \
         AND result_json LIKE '%listing_id%' ORDER BY id ASC",
    )
    .fetch_all(&pool)
    .await
    .expect("query publisher jobs");
    let mut models: HashMap<i64, Value> = HashMap::new();
    for (rj,) in rows {
        let Ok(v) = serde_json::from_str::<Value>(&rj) else { continue };
        let Some(lid) = v.get("listing_id").and_then(|x| x.as_i64()) else { continue };
        let pt = v.get("product_type").and_then(|x| x.as_str()).unwrap_or("");
        if pt == "stl_file" || pt == "3d_model" {
            models.insert(lid, v); // later job id wins
        }
    }
    let mut models: Vec<(i64, Value)> = models.into_iter().collect();
    models.sort_by_key(|(lid, _)| *lid);
    // AGENT_FACTORY_BACKFILL_LIMIT caps how many models get *published* this
    // run (a dry-run knob — unset = all). Skips don't count against it.
    let limit: usize = std::env::var("AGENT_FACTORY_BACKFILL_LIMIT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(usize::MAX);
    println!("backfill: {} distinct 3D models (publish limit: {})",
             models.len(),
             if limit == usize::MAX { "none".into() } else { limit.to_string() });
    let mut published_models = 0usize;

    let renderer = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../workers/designer/renderer/render_glb.js"
    );
    let assets = home().join(".agent-factory/assets");
    let log_path = home().join(".agent-factory/marketplace_backfill.jsonl");

    let markets: [(&str, &str); 3] = [
        ("gumroad", "gumroad_publishes"),
        ("mmf", "mmf_publishes"),
        ("sketchfab", "sketchfab_publishes"),
    ];

    let mut counts: HashMap<&str, (u32, u32, u32)> = HashMap::new(); // ok, fail, skip

    for (i, (lid, mut result)) in models.into_iter().enumerate() {
        // Already on every marketplace? Skip the whole model up front.
        let mut pending = Vec::new();
        for (mp, table) in &markets {
            if already_published(&pool, table, lid).await {
                counts.entry(mp).or_default().2 += 1;
            } else {
                pending.push((*mp, *table));
            }
        }
        if pending.is_empty() {
            continue;
        }

        // The printable STL must be on disk.
        let asset = result
            .get("asset_path")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if asset.is_empty() || !Path::new(&asset).exists() {
            println!("[{}/{}] {lid}: SKIP — no STL on disk", i + 1, "?");
            for (mp, _) in &pending {
                counts.entry(mp).or_default().1 += 1;
            }
            continue;
        }

        // Render textured hero + clay previews from the GLB (reuse if a
        // prior run already rendered them). No GLB → fall back to whatever
        // previews the publisher result already carried.
        let glb = result
            .get("glb_path")
            .and_then(|v| v.as_str())
            .map(String::from)
            .filter(|g| Path::new(g).exists());
        let mut preview_pngs: Vec<String> = Vec::new();
        if let Some(glb) = &glb {
            let tex0 = assets.join(format!("{lid}-tex-0.png"));
            if !tex0.exists() {
                let _ = Command::new("node")
                    .arg(renderer)
                    .arg(glb)
                    .arg(&assets)
                    .arg(lid.to_string())
                    .output();
            }
            for s in ["tex-0", "clay-0", "clay-1", "clay-2", "clay-3"] {
                let p = assets.join(format!("{lid}-{s}.png"));
                if p.exists() {
                    preview_pngs.push(p.to_string_lossy().into_owned());
                }
            }
            // Gumroad's cover is the PNG next to the STL — point it at the
            // textured hero.
            if tex0.exists() {
                let _ = std::fs::copy(&tex0, assets.join(format!("{lid}.png")));
            }
        }
        if preview_pngs.is_empty() {
            if let Some(arr) = result.get("preview_pngs").and_then(|v| v.as_array()) {
                for p in arr {
                    if let Some(s) = p.as_str() {
                        if Path::new(s).exists() {
                            preview_pngs.push(s.to_string());
                        }
                    }
                }
            }
        }

        // IP-sanitize the copy (the supervisor does this before dispatch;
        // calling handlers directly bypasses it, so do it here) and pin the
        // flat $3 price + the freshly-rendered previews.
        crate::ip_sanitize::sanitize_publisher_result(&mut result);
        result["price_usd"] = serde_json::json!(3.0);
        result["preview_pngs"] = Value::Array(
            preview_pngs.iter().map(|s| Value::String(s.clone())).collect(),
        );

        let title = result
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        println!(
            "[{}] {lid} {:.46} ({} previews)",
            i + 1,
            title,
            preview_pngs.len()
        );

        for (mp, table) in pending {
            match mp {
                "gumroad" => {
                    crate::gumroad_publish::handle_publisher_complete_gumroad(
                        &pool, project_id, &bus, &result,
                    )
                    .await
                }
                "mmf" => {
                    crate::myminifactory_publish::handle_publisher_complete_mmf(
                        &pool, project_id, &bus, &result,
                    )
                    .await
                }
                "sketchfab" => {
                    crate::sketchfab_publish::handle_publisher_complete_sketchfab(
                        &pool, project_id, &bus, &result,
                    )
                    .await
                }
                _ => unreachable!(),
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
            let state = latest_state(&pool, table, lid).await.unwrap_or_default();
            let ok = state.starts_with("published");
            counts.entry(mp).or_default().0 += if ok { 1 } else { 0 };
            counts.entry(mp).or_default().1 += if ok { 0 } else { 1 };
            println!("    {mp}: {}", if state.is_empty() { "no row".into() } else { state.clone() });
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log_path)
            {
                let _ = writeln!(
                    f,
                    "{}",
                    serde_json::json!({ "lid": lid, "mp": mp, "state": state, "ok": ok })
                );
            }
            // Gentle pacing between marketplace API calls.
            tokio::time::sleep(Duration::from_secs(1)).await;
        }

        published_models += 1;
        if published_models >= limit {
            println!("(reached publish limit of {limit} — stopping)");
            break;
        }
    }

    println!("\n=== backfill done ===");
    for (mp, _) in &markets {
        let (ok, fail, skip) = counts.get(mp).copied().unwrap_or((0, 0, 0));
        println!("  {mp}: {ok} published, {fail} failed, {skip} already had it");
    }
}
