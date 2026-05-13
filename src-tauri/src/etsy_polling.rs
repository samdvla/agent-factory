//! Background pollers for real Etsy receipts + conversation messages.
//!
//! Two long-running tokio tasks, each waking on a 5-minute interval:
//! - `poll_receipts` — pulls paid receipts and appends outcomes.jsonl rows
//! - `poll_conversations` — pulls buyer messages and enqueues `cs` jobs
//!
//! Each iteration checks `etsy::load_status().connected` and the
//! `real_etsy_enabled` secret. If either is false the iteration becomes a
//! silent no-op — flipping the kill-switch secret instantly disables both
//! pollers without a process restart.

use crate::etsy;
use crate::etsy_ingest;
use crate::events::{EventBus, SupervisorEvent};
use crate::queue;
use crate::secrets;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::time::Duration;
use tokio::task::JoinHandle;

/// Default cadence for receipts + conversations — 5 minutes is well under
/// Etsy's 5K QPD per-app limit.
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(300);
/// Listing-stats poller cadence — every 15 minutes. Each tick can make N
/// requests (one per active draft) so we keep this slower than the others.
pub const STATS_INTERVAL: Duration = Duration::from_secs(900);
/// Max number of listings to refresh per stats tick. Caps the QPD impact
/// when we have hundreds of drafts in flight.
pub const STATS_BATCH: i64 = 30;

/// Spawn both polling tasks. They run forever (until the process exits) — the
/// kill-switch is the `real_etsy_enabled` secret which they recheck on every
/// tick.
pub fn spawn_pollers(
    pool: SqlitePool,
    project_id: i64,
    bus: EventBus,
    initial_delay: Duration,
) -> Vec<JoinHandle<()>> {
    let pool_a = pool.clone();
    let bus_a = bus.clone();
    let pool_b = pool.clone();
    let bus_b = bus.clone();
    let pool_c = pool;
    let bus_c = bus;
    let h1 = tokio::spawn(async move {
        tokio::time::sleep(initial_delay).await;
        let mut interval = tokio::time::interval(DEFAULT_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(e) = poll_receipts_once(&pool_a, project_id, &bus_a).await {
                tracing::warn!("etsy receipts poll failed: {:#}", e);
            }
        }
    });
    let h2 = tokio::spawn(async move {
        tokio::time::sleep(initial_delay).await;
        let mut interval = tokio::time::interval(DEFAULT_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(e) = poll_conversations_once(&pool_b, project_id, &bus_b).await {
                tracing::warn!("etsy conversations poll failed: {:#}", e);
            }
        }
    });

    // Listing stats poller — pulls views/favorites for each active draft on
    // a 15-min cadence. This closes the feedback loop: even without a sale
    // we can see whether listings are getting impressions, and feed that
    // signal back to the strategist.
    let h3 = tokio::spawn(async move {
        // Offset the first tick so we don't collide with the receipts/conv
        // pollers when initial_delay is short.
        tokio::time::sleep(initial_delay + Duration::from_secs(60)).await;
        let mut interval = tokio::time::interval(STATS_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(e) = poll_listing_stats_once(&pool_c, project_id, &bus_c).await {
                tracing::warn!("etsy listing-stats poll failed: {:#}", e);
            }
        }
    });
    vec![h1, h2, h3]
}

/// Read the real_etsy_enabled flag from the keychain. Default false.
fn real_etsy_enabled() -> bool {
    secrets::get("real_etsy_enabled")
        .ok()
        .flatten()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

/// True iff we have a connected Etsy session AND the real-publish toggle is on.
/// We verify the keystring is present (api_key_header() will pull it on every
/// request) but don't return it — that simplifies the call sites.
fn should_poll() -> Option<i64> {
    if !real_etsy_enabled() {
        return None;
    }
    let status = etsy::load_status();
    if !status.connected {
        return None;
    }
    let shop_id = status.shop_id?;
    let keystring = secrets::get("etsy_api_keystring").ok().flatten()?;
    if keystring.is_empty() {
        return None;
    }
    Some(shop_id)
}

/// One iteration of the receipts poller. Idempotent — safe to call directly
/// from tests.
pub async fn poll_receipts_once(
    pool: &SqlitePool,
    project_id: i64,
    bus: &EventBus,
) -> anyhow::Result<()> {
    let shop_id = match should_poll() {
        Some(v) => v,
        None => return Ok(()),
    };

    let last_seen: i64 = secrets::get("etsy_last_receipt_id")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);

    let listing_id_to_niche = load_listing_niche_map(pool, project_id).await;

    let client = reqwest::Client::new();
    let access = etsy::ensure_fresh_token(&client).await?;
    let receipts = etsy_ingest::fetch_new_receipts(
        &client,
        etsy::API_BASE,
        &access,
        shop_id,
        last_seen,
    )
    .await?;

    let mut max_id = last_seen;
    for r in &receipts {
        let revenue = match etsy_ingest::append_outcome_for_receipt(r, &listing_id_to_niche) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("append_outcome_for_receipt failed for {}: {:#}", r.receipt_id, e);
                continue;
            }
        };
        bus.send(SupervisorEvent::EtsyReceiptIngested {
            receipt_id: r.receipt_id,
            transactions_count: r.transactions.len(),
            revenue_usd: revenue,
        });
        if r.receipt_id > max_id {
            max_id = r.receipt_id;
        }
    }
    if max_id > last_seen {
        if let Err(e) = secrets::set("etsy_last_receipt_id", &max_id.to_string()) {
            tracing::warn!("persist etsy_last_receipt_id failed: {:#}", e);
        }
    }
    Ok(())
}

/// One iteration of the conversations poller.
pub async fn poll_conversations_once(
    pool: &SqlitePool,
    project_id: i64,
    bus: &EventBus,
) -> anyhow::Result<()> {
    let shop_id = match should_poll() {
        Some(v) => v,
        None => return Ok(()),
    };

    let last_seen: i64 = secrets::get("etsy_last_message_id")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0);

    let client = reqwest::Client::new();
    let access = etsy::ensure_fresh_token(&client).await?;
    let messages = etsy_ingest::fetch_new_messages(
        &client,
        etsy::API_BASE,
        &access,
        shop_id,
        last_seen,
    )
    .await?;

    let mut max_id = last_seen;
    for m in &messages {
        let conversation_id = m.conversation_id.unwrap_or(0);
        let snippet: String = m.text.chars().take(80).collect();
        let payload = serde_json::json!({
            "trigger": "etsy_message",
            "buyer_message": m.text,
            "conversation_id": conversation_id,
        });
        if let Err(e) = queue::enqueue(pool, project_id, "cs", payload).await {
            tracing::warn!("enqueue cs for etsy msg {} failed: {:#}", m.message_id, e);
            continue;
        }
        bus.send(SupervisorEvent::EtsyMessageIngested {
            conversation_id,
            snippet,
        });
        if m.message_id > max_id {
            max_id = m.message_id;
        }
    }
    if max_id > last_seen {
        if let Err(e) = secrets::set("etsy_last_message_id", &max_id.to_string()) {
            tracing::warn!("persist etsy_last_message_id failed: {:#}", e);
        }
    }
    Ok(())
}

/// One iteration of the listing-stats poller. For each recently-published
/// active listing, fetch its current views/favorites/orders and write a
/// snapshot row to `listing_stats`. When the snapshot changes (vs. the
/// previous one for that listing), also append an "impression-only" row
/// to outcomes.jsonl so strategist + orchestrator pick up the signal.
pub async fn poll_listing_stats_once(
    pool: &SqlitePool,
    project_id: i64,
    bus: &EventBus,
) -> anyhow::Result<()> {
    let shop_id = match should_poll() {
        Some(v) => v,
        None => return Ok(()),
    };

    // Pull the most recent active drafts. We cap at STATS_BATCH so a shop
    // with hundreds of listings doesn't blow through the daily quota.
    let rows: Vec<(i64, Option<i64>, String)> = sqlx::query_as(
        "SELECT etsy_listing_id, local_listing_id, title FROM etsy_publishes \
         WHERE project_id = ? AND state IN ('draft','active') \
         ORDER BY id DESC LIMIT ?",
    )
    .bind(project_id)
    .bind(STATS_BATCH)
    .fetch_all(pool)
    .await?;
    if rows.is_empty() {
        return Ok(());
    }

    let client = reqwest::Client::new();
    let access = etsy::ensure_fresh_token(&client).await?;
    let now = chrono::Utc::now().timestamp();

    for (etsy_listing_id, local_listing_id, title) in rows {
        let stats = match etsy_ingest::fetch_listing_stats(
            &client,
            etsy::API_BASE,
            &access,
            shop_id,
            etsy_listing_id,
        )
        .await
        {
            Ok(s) => s,
            Err(e) => {
                tracing::warn!(
                    "fetch_listing_stats failed for listing {}: {:#}",
                    etsy_listing_id, e
                );
                continue;
            }
        };

        // Read the previous snapshot so we can compute deltas.
        let prev: Option<(i64, i64, i64)> = sqlx::query_as(
            "SELECT views, favorites, total_orders FROM listing_stats \
             WHERE etsy_listing_id = ? ORDER BY id DESC LIMIT 1",
        )
        .bind(etsy_listing_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();

        if let Err(e) = sqlx::query(
            "INSERT INTO listing_stats \
             (project_id, etsy_listing_id, local_listing_id, views, favorites, total_orders, ts) \
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(project_id)
        .bind(etsy_listing_id)
        .bind(local_listing_id)
        .bind(stats.views)
        .bind(stats.favorites)
        .bind(stats.total_orders)
        .bind(now)
        .execute(pool)
        .await
        {
            tracing::warn!("insert listing_stats failed for {}: {:#}", etsy_listing_id, e);
            continue;
        }

        let (pv, pf, _po) = prev.unwrap_or((0, 0, 0));
        let dv = stats.views - pv;
        let df = stats.favorites - pf;
        // Only append to outcomes.jsonl when something actually changed. Avoids
        // flooding the file with no-op rows the orchestrator would have to
        // filter back out.
        if dv != 0 || df != 0 || prev.is_none() {
            let niche = title_to_niche_slug(&title);
            if let Err(e) = etsy_ingest::append_impression_outcome(
                etsy_listing_id,
                &niche,
                stats.views,
                stats.favorites,
                dv,
                df,
            ) {
                tracing::warn!("append_impression_outcome failed: {:#}", e);
            }
            bus.send(SupervisorEvent::EtsyListingStats {
                etsy_listing_id,
                views: stats.views,
                favorites: stats.favorites,
                delta_views: dv,
                delta_favorites: df,
            });
        }
    }
    Ok(())
}

/// Build a map of `etsy_listing_id -> niche` from rows we've previously
/// published. Returns an empty map on any DB error (we'll fall back to
/// `"unknown"` for any listing we can't resolve).
async fn load_listing_niche_map(pool: &SqlitePool, project_id: i64) -> HashMap<i64, String> {
    let rows: Vec<(i64, Option<String>)> = match sqlx::query_as(
        "SELECT etsy_listing_id, title FROM etsy_publishes WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("load etsy_publishes for niche map failed: {:#}", e);
            return HashMap::new();
        }
    };
    // The current etsy_publishes schema has `title` but no `niche` column. We
    // synthesize a niche from the title slug as a best-effort: lowercase ASCII
    // words joined with hyphens, capped to 24 chars. This matches the
    // free-form niche slugs the orchestrator already uses. If the title is
    // empty we fall back to "unknown".
    let mut out = HashMap::with_capacity(rows.len());
    for (id, title) in rows {
        let title = title.unwrap_or_default();
        let slug = title_to_niche_slug(&title);
        out.insert(id, slug);
    }
    out
}

fn title_to_niche_slug(title: &str) -> String {
    let lower = title.to_lowercase();
    let mut parts: Vec<String> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    parts.truncate(3);
    let joined = parts.join("-");
    if joined.is_empty() {
        return "unknown".into();
    }
    if joined.len() > 24 {
        joined.chars().take(24).collect()
    } else {
        joined
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_title_to_niche_slug_basic() {
        assert_eq!(title_to_niche_slug("Boho Wall Art Print"), "boho-wall-art");
        assert_eq!(title_to_niche_slug(""), "unknown");
        assert_eq!(title_to_niche_slug("   "), "unknown");
        // Truncation at 24 chars.
        let long = "Very Long Title With Many Words";
        let s = title_to_niche_slug(long);
        assert!(s.len() <= 24);
    }
}
