use sqlx::SqlitePool;

/// Compute USD cost from token counts and model name. Single source of truth
/// for both the budget cap check and the ledger rows.
///
/// Two pricing modes:
///   1. Per-call flat fee — for non-token providers (3D mesh generation,
///      image generation, Etsy listing fees). Tokens are ignored.
///   2. Per-million-token rate — for Anthropic Claude models and any
///      provider with a token-based meter. Standard input + output split.
pub fn cost_usd(model: &str, tokens_in: u64, tokens_out: u64) -> f64 {
    if let Some(per_call) = per_call_usd(model) {
        return per_call;
    }
    let (pin, pout) = price_per_million(model);
    (tokens_in as f64 / 1_000_000.0) * pin + (tokens_out as f64 / 1_000_000.0) * pout
}

/// Per-call flat-fee rates for providers that bill per task rather than
/// per token. Returns None when the model isn't a known flat-fee model
/// (caller falls through to token-based pricing).
///
/// Rates are sourced from provider pricing pages as of 2026-05. They are
/// approximate published rates; for exact spend we'd subscribe to each
/// provider's balance-delta API after every task (tripo_last_balance /
/// meshy_last_balance hooks already exist for that future enhancement).
/// Until then these are within ~10% of actual on standard plans.
fn per_call_usd(model: &str) -> Option<f64> {
    match model {
        // --- Tripo 3D (v2.5+, image-to-3d / text-to-model with PBR textures)
        // Public rate: ~30-40 credits per call × $0.013-$0.020/credit on
        // pay-as-you-go plans. Image-to-3D is slightly more expensive
        // because it includes the ref-image upload + processing step.
        "tripo-image-to-3d" => Some(0.40),
        "tripo-text-to-model" => Some(0.35),

        // --- Meshy 6 (current default — see workers/designer/designer/meshy.py)
        //   text-to-3d (preview 20 + refine 10)         = 30 credits
        //   image-to-3d (with PBR)                       = 30 credits
        //   auto-rigging                                 =  5 credits
        //   animation (1 preset action via Animation API)=  3 credits
        // At $0.02/credit on the Pro/Max monthly plans:
        //   30 credits ≈ $0.60   |   5 credits ≈ $0.10   |   3 credits ≈ $0.06
        // (Pay-as-you-go credits run a few cents higher; we use the
        // monthly-plan rate since that's the operator's default.)
        "meshy-text-to-3d" => Some(0.60),
        "meshy-image-to-3d" => Some(0.60),
        "meshy-rigging" => Some(0.10),
        "meshy-animation" => Some(0.06),

        // --- Google AI Studio (direct Gemini image)
        // Gemini 3.1 Flash Image (Nano Banana 2): $0.067 per 1024px image
        // on the standard API. Pro variant is $0.134.
        "gemini-3.1-flash-image-preview" => Some(0.067),
        "gemini-3-pro-image-preview" => Some(0.134),

        // --- Nano Banana via Higgsfield CLI
        // Bundle plans vary; use a midpoint estimate for the ledger when
        // the Higgsfield path is active instead of direct Gemini.
        "nano_banana_2" | "nano_banana_pro" => Some(0.10),

        // --- Etsy fees (paid out of pocket on listing creation; transaction
        // and payment-processing fees are surfaced separately by the
        // receipt poller when sales come in, applied as a multiplier on
        // revenue rather than a flat line item).
        "etsy-listing-fee" => Some(0.20),

        _ => None,
    }
}

fn price_per_million(model: &str) -> (f64, f64) {
    // (input_usd_per_million, output_usd_per_million)
    // Source: Anthropic public pricing as of 2026-05; update if pricing changes.
    if model.starts_with("claude-haiku-4-5") {
        (0.80, 4.00)
    } else if model.starts_with("claude-sonnet-4") {
        (3.00, 15.00)
    } else if model.starts_with("claude-opus-4") {
        (15.00, 75.00)
    } else {
        (3.00, 15.00) // sane default
    }
}

/// True when `model` is billed per call (flat fee). Callers use this to
/// decide whether to pass tokens=0 when recording.
pub fn is_per_call_model(model: &str) -> bool {
    per_call_usd(model).is_some()
}

pub async fn record(
    pool: &SqlitePool,
    project_id: i64,
    model: &str,
    tokens_in: u64,
    tokens_out: u64,
) -> anyhow::Result<()> {
    let usd = cost_usd(model, tokens_in, tokens_out);
    sqlx::query(
        "INSERT INTO budget_ledger (project_id, day, model, tokens_in, tokens_out, usd_cost) VALUES (?, date('now'), ?, ?, ?, ?)"
    )
    .bind(project_id)
    .bind(model)
    .bind(tokens_in as i64)
    .bind(tokens_out as i64)
    .bind(usd)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn today_spend_usd(pool: &SqlitePool, project_id: i64) -> anyhow::Result<f64> {
    let usd: Option<f64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(usd_cost), 0.0) FROM budget_ledger WHERE project_id = ? AND day = date('now')"
    )
    .bind(project_id)
    .fetch_one(pool)
    .await?;
    Ok(usd.unwrap_or(0.0))
}

/// Sum of every dollar this project has burned — Claude, Tripo, Meshy,
/// Gemini, Etsy listing fees, the lot. Single number the TopBar pill
/// subtracts from lifetime revenue to compute Net.
pub async fn lifetime_spend_usd(pool: &SqlitePool, project_id: i64) -> anyhow::Result<f64> {
    let usd: Option<f64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(usd_cost), 0.0) FROM budget_ledger WHERE project_id = ?",
    )
    .bind(project_id)
    .fetch_one(pool)
    .await?;
    Ok(usd.unwrap_or(0.0))
}

/// Lifetime spend broken out by ledger model. Used by the analytics
/// panel to show where money is going.
pub async fn lifetime_spend_by_model(
    pool: &SqlitePool,
    project_id: i64,
) -> anyhow::Result<Vec<(String, f64, i64)>> {
    let rows: Vec<(String, f64, i64)> = sqlx::query_as(
        "SELECT model, COALESCE(SUM(usd_cost), 0.0) AS usd, COUNT(*) AS calls \
         FROM budget_ledger \
         WHERE project_id = ? \
         GROUP BY model \
         ORDER BY usd DESC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn check_cap(pool: &SqlitePool, project_id: i64, daily_cap_usd: f64) -> anyhow::Result<bool> {
    let spent = today_spend_usd(pool, project_id).await?;
    Ok(spent < daily_cap_usd)
}

/// Sum of usd_cost for ledger rows with `ts >= now() - <hours> hours`.
/// Note: ledger rows store ts via `datetime('now')` default — UTC by sqlite convention.
pub async fn spend_window(
    pool: &SqlitePool,
    project_id: i64,
    hours: i64,
) -> anyhow::Result<f64> {
    let usd: Option<f64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(usd_cost), 0.0) FROM budget_ledger \
         WHERE project_id = ? AND ts >= datetime('now', ?)"
    )
    .bind(project_id)
    .bind(format!("-{hours} hours"))
    .fetch_one(pool)
    .await?;
    Ok(usd.unwrap_or(0.0))
}

/// Sum of usd_cost for ledger rows in the current calendar month (UTC).
pub async fn month_spend_usd(
    pool: &SqlitePool,
    project_id: i64,
) -> anyhow::Result<f64> {
    let usd: Option<f64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(usd_cost), 0.0) FROM budget_ledger \
         WHERE project_id = ? AND day >= date('now', 'start of month')"
    )
    .bind(project_id)
    .fetch_one(pool)
    .await?;
    Ok(usd.unwrap_or(0.0))
}

/// Pure cost estimate for pre-flight cap checks. No DB access.
/// Use this with conservative input counts (e.g. char/4 heuristic).
pub fn estimate_cost(model: &str, est_tokens_in: u64, est_tokens_out: u64) -> f64 {
    cost_usd(model, est_tokens_in, est_tokens_out)
}

#[derive(Debug, Clone, Copy)]
pub struct BudgetCaps {
    pub hourly_usd: f64,
    pub daily_usd: f64,
    pub monthly_usd: f64,
}

impl BudgetCaps {
    pub fn defaults() -> Self {
        Self { hourly_usd: 0.50, daily_usd: 1.00, monthly_usd: 20.00 }
    }
}

use crate::events::BudgetCapScope;

#[derive(Debug)]
pub enum CapOutcome {
    Ok,
    Capped { scope: BudgetCapScope, spent_usd: f64, cap_usd: f64 },
}

/// Multi-tier cap check. Returns Capped on the FIRST scope that would be
/// breached by `today_spent + estimate`. Order: hour, day, month.
/// On DB error returns Capped { scope: DbError, .. } (fail closed).
pub async fn enforce_caps(
    pool: &SqlitePool,
    project_id: i64,
    caps: BudgetCaps,
    estimate_usd: f64,
) -> anyhow::Result<CapOutcome> {
    if crate::secrets::get("smoke_pause_until")
        .ok()
        .flatten()
        .filter(|v| !v.is_empty())
        .is_some()
    {
        return Ok(CapOutcome::Capped {
            scope: BudgetCapScope::SmokePause,
            spent_usd: 0.0,
            cap_usd: 0.0,
        });
    }
    let hour = match spend_window(pool, project_id, 1).await {
        Ok(v) => v,
        Err(_) => return Ok(CapOutcome::Capped {
            scope: BudgetCapScope::DbError, spent_usd: 0.0, cap_usd: caps.hourly_usd,
        }),
    };
    if hour + estimate_usd >= caps.hourly_usd {
        return Ok(CapOutcome::Capped { scope: BudgetCapScope::Hour, spent_usd: hour, cap_usd: caps.hourly_usd });
    }
    let day = match today_spend_usd(pool, project_id).await {
        Ok(v) => v,
        Err(_) => return Ok(CapOutcome::Capped {
            scope: BudgetCapScope::DbError, spent_usd: 0.0, cap_usd: caps.daily_usd,
        }),
    };
    if day + estimate_usd >= caps.daily_usd {
        return Ok(CapOutcome::Capped { scope: BudgetCapScope::Day, spent_usd: day, cap_usd: caps.daily_usd });
    }
    let month = match month_spend_usd(pool, project_id).await {
        Ok(v) => v,
        Err(_) => return Ok(CapOutcome::Capped {
            scope: BudgetCapScope::DbError, spent_usd: 0.0, cap_usd: caps.monthly_usd,
        }),
    };
    if month + estimate_usd >= caps.monthly_usd {
        return Ok(CapOutcome::Capped { scope: BudgetCapScope::Month, spent_usd: month, cap_usd: caps.monthly_usd });
    }
    Ok(CapOutcome::Ok)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
    use std::str::FromStr;

    /// Build an in-memory sqlite pool with the bare-minimum schema this module
    /// touches. Avoids running the full migrations against ":memory:".
    async fn setup_pool() -> SqlitePool {
        let opts = SqliteConnectOptions::from_str("sqlite::memory:")
            .unwrap()
            .create_if_missing(true);
        let pool = SqlitePoolOptions::new()
            .max_connections(1) // a shared :memory: db must use a single conn
            .connect_with(opts)
            .await
            .expect("open in-memory sqlite");
        sqlx::query(
            "CREATE TABLE budget_ledger (\
                id INTEGER PRIMARY KEY AUTOINCREMENT,\
                project_id INTEGER NOT NULL,\
                day TEXT NOT NULL,\
                model TEXT NOT NULL,\
                tokens_in INTEGER NOT NULL DEFAULT 0,\
                tokens_out INTEGER NOT NULL DEFAULT 0,\
                usd_cost REAL NOT NULL DEFAULT 0.0,\
                ts TEXT NOT NULL DEFAULT (datetime('now'))\
            )",
        )
        .execute(&pool)
        .await
        .expect("create budget_ledger");
        pool
    }

    #[tokio::test]
    async fn check_cap_returns_false_when_spend_exceeds_cap() {
        let pool = setup_pool().await;
        // Sonnet at $3/M in + $15/M out. 1M in = $3.00, 0 out → $3.00.
        record(&pool, 1, "claude-sonnet-4-6", 1_000_000, 0).await.unwrap();
        // Cap of $1 → over.
        let under_cap = check_cap(&pool, 1, 1.00).await.unwrap();
        assert!(!under_cap, "expected check_cap=false when spend ($3) > cap ($1)");
        let spent = today_spend_usd(&pool, 1).await.unwrap();
        assert!(spent > 1.00, "today spend should exceed cap, got {spent}");
    }

    #[tokio::test]
    async fn check_cap_returns_true_when_spend_below_cap() {
        let pool = setup_pool().await;
        // 1k tokens in @ $3/M → $0.003
        record(&pool, 1, "claude-sonnet-4-6", 1_000, 0).await.unwrap();
        let under_cap = check_cap(&pool, 1, 1.00).await.unwrap();
        assert!(under_cap, "expected check_cap=true when spend < cap");
    }

    #[test]
    fn cost_usd_matches_record_pricing_for_haiku() {
        // Haiku: $0.80/M in, $4.00/M out → 1M in + 1M out = $0.80 + $4.00 = $4.80
        let usd = cost_usd("claude-haiku-4-5-20251001", 1_000_000, 1_000_000);
        assert!((usd - 4.80).abs() < 1e-9, "expected 4.80, got {usd}");
    }

    #[test]
    fn cost_usd_matches_record_pricing_for_sonnet() {
        let usd = cost_usd("claude-sonnet-4-6", 1_000_000, 0);
        assert!((usd - 3.00).abs() < 1e-9, "expected 3.00, got {usd}");
    }

    #[test]
    fn cost_usd_matches_record_pricing_for_opus() {
        let usd = cost_usd("claude-opus-4-7", 0, 1_000_000);
        assert!((usd - 75.00).abs() < 1e-9, "expected 75.00, got {usd}");
    }

    #[test]
    fn cost_usd_uses_per_call_rate_for_tripo_image_to_3d() {
        // Per-call providers ignore tokens entirely — the flat rate is the
        // ground truth. Before this fix, the supervisor was calling
        // cost_usd("tripo-image-to-3d", 800, 300) and getting Claude
        // default pricing (~$0.011/call), drastically under-counting the
        // real ~$0.40 charge per Tripo task.
        let usd = cost_usd("tripo-image-to-3d", 800, 300);
        assert!((usd - 0.40).abs() < 1e-9, "expected 0.40, got {usd}");
        let usd_zero_tokens = cost_usd("tripo-image-to-3d", 0, 0);
        assert!(
            (usd_zero_tokens - 0.40).abs() < 1e-9,
            "per-call rate must not depend on tokens, got {usd_zero_tokens}",
        );
    }

    #[test]
    fn cost_usd_uses_per_call_rate_for_gemini_flash() {
        let usd = cost_usd("gemini-3.1-flash-image-preview", 0, 0);
        assert!((usd - 0.067).abs() < 1e-9, "expected 0.067, got {usd}");
    }

    #[test]
    fn cost_usd_uses_per_call_rate_for_gemini_pro() {
        let usd = cost_usd("gemini-3-pro-image-preview", 0, 0);
        assert!((usd - 0.134).abs() < 1e-9, "expected 0.134, got {usd}");
    }

    #[test]
    fn cost_usd_uses_per_call_rate_for_etsy_listing_fee() {
        let usd = cost_usd("etsy-listing-fee", 0, 0);
        assert!((usd - 0.20).abs() < 1e-9, "expected 0.20, got {usd}");
    }

    #[test]
    fn cost_usd_uses_per_call_rate_for_meshy_text_to_3d() {
        // Meshy 6 = preview 20 + refine 10 = 30 credits ≈ $0.60.
        let usd = cost_usd("meshy-text-to-3d", 0, 0);
        assert!((usd - 0.60).abs() < 1e-9, "expected 0.60, got {usd}");
    }

    #[test]
    fn cost_usd_uses_per_call_rate_for_meshy_image_to_3d() {
        // Meshy 6 image-to-3D with PBR = 30 credits ≈ $0.60.
        let usd = cost_usd("meshy-image-to-3d", 0, 0);
        assert!((usd - 0.60).abs() < 1e-9, "expected 0.60, got {usd}");
    }

    #[test]
    fn cost_usd_uses_per_call_rate_for_meshy_rigging_and_animation() {
        // Auto-rig = 5 credits ≈ $0.10; animation = 3 credits ≈ $0.06.
        let rig = cost_usd("meshy-rigging", 0, 0);
        let anim = cost_usd("meshy-animation", 0, 0);
        assert!((rig - 0.10).abs() < 1e-9, "expected 0.10, got {rig}");
        assert!((anim - 0.06).abs() < 1e-9, "expected 0.06, got {anim}");
    }

    #[test]
    fn is_per_call_model_classifies_correctly() {
        assert!(is_per_call_model("tripo-image-to-3d"));
        assert!(is_per_call_model("gemini-3.1-flash-image-preview"));
        assert!(is_per_call_model("etsy-listing-fee"));
        assert!(!is_per_call_model("claude-sonnet-4-6"));
        assert!(!is_per_call_model("unknown-future-model"));
    }

    #[tokio::test]
    async fn lifetime_spend_aggregates_every_provider() {
        let pool = setup_pool().await;
        // Mixed providers across multiple days.
        record(&pool, 1, "claude-sonnet-4-6", 1_000, 0).await.unwrap(); // $0.003
        record(&pool, 1, "tripo-image-to-3d", 0, 0).await.unwrap();   // $0.40
        record(&pool, 1, "gemini-3.1-flash-image-preview", 0, 0).await.unwrap(); // $0.067
        record(&pool, 1, "etsy-listing-fee", 0, 0).await.unwrap();   // $0.20

        let total = lifetime_spend_usd(&pool, 1).await.unwrap();
        let expected = 0.003 + 0.40 + 0.067 + 0.20;
        assert!(
            (total - expected).abs() < 1e-9,
            "lifetime spend must sum every provider, got {total} expected {expected}",
        );

        let by_model = lifetime_spend_by_model(&pool, 1).await.unwrap();
        let map: std::collections::HashMap<_, _> = by_model
            .iter()
            .map(|(m, usd, n)| (m.as_str(), (*usd, *n)))
            .collect();
        assert!((map["tripo-image-to-3d"].0 - 0.40).abs() < 1e-9);
        assert!((map["etsy-listing-fee"].0 - 0.20).abs() < 1e-9);
        assert_eq!(map["claude-sonnet-4-6"].1, 1);
    }

    /// Verify that enforce_caps short-circuits to Capped{SmokePause} when the
    /// smoke_pause_until secret is non-empty. Uses set_cache_for_test so we
    /// never touch the on-disk secrets file or the keychain.
    #[tokio::test]
    async fn enforce_caps_returns_smoke_pause_when_flag_set() {
        let pool = setup_pool().await;
        // Seed the in-memory secrets cache — avoids touching disk / keychain.
        crate::secrets::set_cache_for_test("smoke_pause_until", Some("1"));
        let caps = BudgetCaps::defaults();
        let outcome = enforce_caps(&pool, 1, caps, 0.0).await.unwrap();
        // Clear the cache entry so other tests are not affected.
        crate::secrets::set_cache_for_test("smoke_pause_until", None);
        match outcome {
            CapOutcome::Capped { scope, .. } => {
                assert!(
                    matches!(scope, BudgetCapScope::SmokePause),
                    "expected SmokePause scope, got {scope:?}"
                );
            }
            _ => panic!("expected Capped(SmokePause), got Ok"),
        }
    }
}
