//! Pinterest publish orchestration.
//!
//! Fired by `etsy_publish::handle_publisher_complete` after a successful
//! Etsy publish — Pinterest's whole value is driving traffic TO Etsy, so
//! pinning before we have the Etsy URL is pointless. The caller passes
//! the Etsy URL in via `pin_for_listing`.
//!
//! Stores every attempt (published + errored) in `pinterest_pins` so the
//! UI can show what's live and operators can audit failures.

use crate::events::{EventBus, SupervisorEvent};
use crate::pinterest;
use crate::secrets;
use anyhow::Result;
use sqlx::SqlitePool;
use std::path::PathBuf;

/// Default daily cap. Pinterest is aggressive about spam-flagging new
/// accounts — 5 pins/day from a brand-new account stays comfortably below
/// the heuristics that have nuked accounts in our research. Operators can
/// raise it via the Settings panel once the account is established.
pub const DEFAULT_DAILY_CAP: i64 = 5;

/// Read the operator's daily cap from the keychain, falling back to
/// DEFAULT_DAILY_CAP. Public so the settings UI status query can use the
/// same source of truth as the publish path.
pub fn daily_cap() -> i64 {
    secrets::get("pinterest_daily_cap")
        .ok()
        .flatten()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_DAILY_CAP)
}

/// Pin a listing. Called from `etsy_publish::handle_publisher_complete`
/// once the Etsy listing exists (so we have a real URL to point the pin
/// at). All failures are non-fatal — emits Failed event + records to DB,
/// then returns.
pub async fn pin_for_listing(
    pool: &SqlitePool,
    project_id: i64,
    bus: &EventBus,
    local_listing_id: i64,
    title: &str,
    description: &str,
    pin_path: &PathBuf,
    etsy_url: Option<&str>,
) {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let now = chrono::Utc::now().timestamp();

    let record_failure = |reason: String| -> tokio::task::JoinHandle<()> {
        let pool = pool.clone();
        let bus = bus.clone();
        let title = title.to_string();
        let today = today.clone();
        tokio::spawn(async move {
            tracing::warn!("pinterest pin skipped: {reason}");
            let _ = sqlx::query(
                "INSERT INTO pinterest_pins \
                 (project_id, local_listing_id, title, state, error, published_at, day) \
                 VALUES (?, ?, ?, 'errored', ?, ?, ?)",
            )
            .bind(project_id)
            .bind(local_listing_id)
            .bind(&title)
            .bind(&reason)
            .bind(now)
            .bind(&today)
            .execute(&pool)
            .await;
            bus.send(SupervisorEvent::PinterestPinFailed {
                local_listing_id,
                reason,
            });
        })
    };

    // Enable check. The Etsy publish path doesn't know about Pinterest,
    // so we gate inside the handler — keeps the call site clean.
    let enabled = secrets::get("pinterest_enabled")
        .ok()
        .flatten()
        .map(|v| v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if !enabled {
        return;
    }

    let Some(creds) = pinterest::creds_from_secrets() else {
        let _ = record_failure(
            "pinterest_access_token or pinterest_board_id missing — paste them in Settings".into(),
        );
        return;
    };

    if !pin_path.exists() {
        let _ = record_failure(format!("pin image missing at {}", pin_path.display()));
        return;
    }

    let cap = daily_cap();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pinterest_pins WHERE project_id = ? AND day = ? AND state = 'published'",
    )
    .bind(project_id)
    .bind(&today)
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    if count >= cap {
        bus.send(SupervisorEvent::PinterestCapped { count, cap });
        return;
    }

    let client = reqwest::Client::new();
    match pinterest::create_pin_from_file(
        &client,
        &creds,
        pin_path,
        title,
        description,
        etsy_url,
    )
    .await
    {
        Ok(res) => {
            let pin_url = res.url.clone().or_else(|| res.link.clone());
            if let Err(e) = sqlx::query(
                "INSERT INTO pinterest_pins \
                 (project_id, local_listing_id, pinterest_pin_id, title, url, etsy_url, state, published_at, day) \
                 VALUES (?, ?, ?, ?, ?, ?, 'published', ?, ?)",
            )
            .bind(project_id)
            .bind(local_listing_id)
            .bind(&res.id)
            .bind(title)
            .bind(pin_url.as_deref())
            .bind(etsy_url)
            .bind(now)
            .bind(&today)
            .execute(pool)
            .await
            {
                tracing::warn!("pinterest_pins insert failed: {e}");
            }
            bus.send(SupervisorEvent::PinterestPinned {
                local_listing_id,
                pin_id: res.id.clone(),
                url: pin_url.unwrap_or_default(),
            });
        }
        Err(e) => {
            let reason = format!("pinterest create-pin failed: {e:#}");
            let _ = record_failure(reason.clone());
        }
    }
}

/// Today's published count + the configured cap. Used by the Settings UI
/// to show "{count}/{cap} pinned today" the same way Cults3D does.
pub async fn today_status(pool: &SqlitePool, project_id: i64) -> Result<(i64, i64)> {
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM pinterest_pins WHERE project_id = ? AND day = ? AND state = 'published'",
    )
    .bind(project_id)
    .bind(&today)
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    Ok((count, daily_cap()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daily_cap_falls_back_to_default_when_unset() {
        // We can't unset secrets in unit tests without mocking the keychain.
        // The default-path branch is exercised by integration runs where
        // `pinterest_daily_cap` isn't in the chain.
        let cap = daily_cap();
        // Must be a positive integer regardless of env.
        assert!(cap >= 1, "daily_cap returned {cap}");
    }
}
