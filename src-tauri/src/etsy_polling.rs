//! Background poller for real Etsy receipts.
//!
//! One long-running tokio task wakes on a 5-minute interval:
//! - `poll_receipts` — pulls paid receipts and appends outcomes.jsonl rows
//!
//! Each iteration checks `etsy::load_status().connected` and the
//! `real_etsy_enabled` secret. If either is false the iteration becomes a
//! silent no-op — flipping the kill-switch secret instantly disables the
//! poller without a process restart.
//!
//! Why receipts only: Etsy Open API v3 exposes neither the listing-stats
//! endpoint nor the conversations / messages endpoints that v2 had. Pollers
//! for those paths were ripped out (2026-05-13) because every tick produced
//! a permanent 404 — see git history if you ever want the dead code back.

use crate::etsy;
use crate::etsy_ingest;
use crate::events::{EventBus, SupervisorEvent};
use crate::secrets;
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::time::Duration;
use tokio::task::JoinHandle;

/// Default cadence for receipts — 5 minutes is well under Etsy's 5K QPD
/// per-app limit.
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(300);

/// Spawn the receipts polling task. Runs forever (until the process exits) —
/// the kill-switch is the `real_etsy_enabled` secret which it rechecks on
/// every tick.
pub fn spawn_pollers(
    pool: SqlitePool,
    project_id: i64,
    bus: EventBus,
    initial_delay: Duration,
) -> Vec<JoinHandle<()>> {
    let h1 = tokio::spawn(async move {
        tokio::time::sleep(initial_delay).await;
        let mut interval = tokio::time::interval(DEFAULT_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if let Err(e) = poll_receipts_once(&pool, project_id, &bus).await {
                tracing::warn!("etsy receipts poll failed: {:#}", e);
            }
        }
    });
    vec![h1]
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

    // Build an etsy_listing_id → local_listing_id map for the cycle-revenue
    // attribution below. Same source table the niche map uses; one query.
    let local_id_map = load_listing_local_id_map(pool, project_id).await;

    let mut max_id = last_seen;
    for r in &receipts {
        let revenue = match etsy_ingest::append_outcome_for_receipt(r, &listing_id_to_niche) {
            Ok(v) => v,
            Err(e) => {
                tracing::warn!("append_outcome_for_receipt failed for {}: {:#}", r.receipt_id, e);
                continue;
            }
        };

        // Persist actual revenue against the pipeline cycle that owns each
        // transaction's listing. This is what makes today's Revenue/Net
        // pill survive a restart — without it, restarting the app right
        // after a sale would zero the topbar even though the buyer paid.
        //
        // Also append to revenue_ledger so the lifetime Net rollup sums
        // every marketplace through one query. The (project, source,
        // marketplace_id) unique index keeps poller re-runs idempotent:
        // the same Etsy receipt only counts once even if we hit the
        // same window twice.
        //
        // Fee math: Etsy charges a transaction fee (~6.5% of gross) +
        // payment-processing (~3% + $0.25). We approximate as 9.5% +
        // $0.25 per transaction; exact fees from the Etsy v3 payments
        // endpoint would be ideal but require a separate authed call
        // per receipt — until then this gets net within ~$0.05 of
        // actual on typical $5-$15 STL prices.
        for txn in &r.transactions {
            let gross = txn.price.usd() * (txn.quantity.max(1) as f64);
            if gross <= 0.0 { continue; }
            let local_id = local_id_map.get(&txn.listing_id).copied();
            let fees = (gross * 0.095) + 0.25;
            let net = (gross - fees).max(0.0);
            if let Some(lid) = local_id {
                if let Err(e) = crate::pnl::apply_actual_revenue(pool, project_id, lid, net).await {
                    tracing::warn!(
                        "apply_actual_revenue failed for receipt={} listing={}: {:#}",
                        r.receipt_id, txn.listing_id, e,
                    );
                }
            }
            // The transaction-level marketplace_id keeps the dedupe
            // unique even when a single receipt has multiple line items.
            let mid = format!("{}:{}", r.receipt_id, txn.listing_id);
            if let Err(e) = crate::revenue::record(
                pool,
                project_id,
                crate::revenue::RevenueSource::Etsy,
                Some(&mid),
                gross,
                fees,
                net,
                local_id,
            ).await {
                tracing::warn!(
                    "revenue::record etsy failed for receipt={} listing={}: {:#}",
                    r.receipt_id, txn.listing_id, e,
                );
            }
        }

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

/// Build a map of `etsy_listing_id -> local_listing_id`. Used by the
/// receipts poller to attribute real revenue back to the pipeline cycle
/// that produced the listing. Returns an empty map on any DB error;
/// receipts for unmapped listings still bump the in-memory revenue
/// counter via the event bus, they just don't update the cycle row.
async fn load_listing_local_id_map(
    pool: &SqlitePool,
    project_id: i64,
) -> HashMap<i64, i64> {
    let rows: Vec<(i64, i64)> = match sqlx::query_as(
        "SELECT etsy_listing_id, local_listing_id FROM etsy_publishes WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("load etsy_publishes for local_id map failed: {:#}", e);
            return HashMap::new();
        }
    };
    rows.into_iter().collect()
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
