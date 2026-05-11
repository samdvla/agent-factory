# Cost containment, accurate metrics, Etsy smoke-test implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Anthropic API spend caps real (hour/day/month), make the in-app spend metrics reconcile with the budget ledger, and add a one-shot smoke-test cycle that exercises the full Etsy publish path with auto-pause for manual review.

**Architecture:** Single pricing source in `budget.rs`; supervisor adds pre-flight cap enforcement before every job claim; new `cmd_budget_status` powers a top-bar `BudgetPill` showing hourly/daily/monthly spend; `cmd_start_smoke_test` enqueues one cycle and sets a pause flag the cap-check honors until the user resumes.

**Tech Stack:** Rust (tauri 2, sqlx, tokio, anyhow), TypeScript/React (tauri-apps), Vitest, Python 3.11 (workers), sqlite.

**Spec:** `docs/superpowers/specs/2026-05-11-cost-metrics-etsy-verification-design.md`

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src-tauri/src/budget.rs` | Pricing + ledger + cap math; single source of truth | Modify |
| `src-tauri/src/events.rs` | `BudgetCapped.scope`, `BudgetUnreported`, `SmokeTestCycleComplete` | Modify |
| `src-tauri/src/supervisor.rs` | `enforce_caps()` + pre-flight estimate + smoke-pause flag | Modify |
| `src-tauri/src/pnl.rs` | Ledger reconciliation warning after cycle close | Modify |
| `src-tauri/src/commands.rs` | `cmd_budget_status`, `cmd_start_smoke_test`, `cmd_resume_from_smoke_test` | Modify |
| `src-tauri/src/lib.rs` | Read hourly/monthly cap secrets; register new commands | Modify |
| `src-tauri/tests/budget_test.rs` | Window + estimate + scope tests | Modify |
| `src-tauri/tests/supervisor_test.rs` | enforce_caps + smoke-pause tests | Modify |
| `src/api.ts` | TS wrappers for new commands + types | Modify |
| `src/factory/ui/BudgetPill.tsx` | New top-bar pill component | Create |
| `src/factory/ui/TopBar.tsx` | Mount BudgetPill | Modify |
| `src/factory/ui/EtsyPanel.tsx` | Smoke-test button + progress | Modify |
| `src/__tests__/budget-pill.test.ts` | Wrapper test for `apiBudgetStatus` | Create |

---

### Task 1: Single pricing source in `budget.rs`

**Files:**
- Modify: `src-tauri/src/budget.rs`
- Test: `src-tauri/src/budget.rs` (inline `#[cfg(test)]`)

The current file has two pricing tables that disagree on Haiku. Delete the stale one; make `cost_usd` a thin wrapper over `price_per_million` so the event display and the ledger compute identical values.

- [ ] **Step 1: Write the failing test (append to inline tests at bottom of `budget.rs`)**

```rust
    #[test]
    fn cost_usd_matches_record_pricing_for_haiku() {
        // Haiku: $0.80/M in, $4.00/M out → 1M in = $0.80, 1M out = $4.00
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
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd src-tauri && cargo test --lib budget::tests::cost_usd_matches`
Expected: FAIL — current `cost_usd` uses haiku $1/$5, so the haiku assertion gets 5.00 not 4.80.

- [ ] **Step 3: Rewrite `cost_usd` to use `price_per_million`**

Replace the old `cost_usd` body at the top of `budget.rs` (lines 3–17 in the current file) with:

```rust
/// Compute USD cost from token counts and model name.
/// Uses the same pricing table as `record()`. Single source of truth.
pub fn cost_usd(model: &str, tokens_in: u64, tokens_out: u64) -> f64 {
    let (pin, pout) = price_per_million(model);
    (tokens_in as f64 / 1_000_000.0) * pin + (tokens_out as f64 / 1_000_000.0) * pout
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd src-tauri && cargo test --lib budget::tests`
Expected: PASS — all three new tests plus the existing `check_cap_*` tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/budget.rs
git commit -m "$(cat <<'EOF'
fix(budget): unify pricing — cost_usd now uses price_per_million

The display function diverged from the ledger function on Haiku pricing
($1/$5 vs $0.80/$4.00 per M). UI showed ~25% too much spend per haiku
job while the ledger total stayed correct. Reconciled to one table.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Spend-window helpers (`spend_window`, `month_spend_usd`, `estimate_cost`)

**Files:**
- Modify: `src-tauri/src/budget.rs`
- Test: `src-tauri/tests/budget_test.rs`

Three new pure functions: rolling hourly window, calendar month, and a pre-flight estimate from char counts.

- [ ] **Step 1: Write the failing integration test (append to `src-tauri/tests/budget_test.rs`)**

```rust
use agent_factory_lib::{db, budget};

#[tokio::test]
async fn spend_window_returns_only_recent_rows() {
    let (_tmp, pool, project_id) = setup_helper().await;
    // record one job now
    budget::record(&pool, project_id, "claude-haiku-4-5-20251001", 1_000_000, 0).await.unwrap();
    // 1h window must include it
    let w = budget::spend_window(&pool, project_id, 1).await.unwrap();
    assert!((w - 0.80).abs() < 1e-9, "1h window got {w}");
}

#[tokio::test]
async fn month_spend_returns_calendar_month_total() {
    let (_tmp, pool, project_id) = setup_helper().await;
    budget::record(&pool, project_id, "claude-sonnet-4-6", 1_000_000, 0).await.unwrap();
    let m = budget::month_spend_usd(&pool, project_id).await.unwrap();
    assert!((m - 3.00).abs() < 1e-9, "month got {m}");
}

#[test]
fn estimate_cost_is_monotonic_in_input_length() {
    let small = budget::estimate_cost("claude-sonnet-4-6", 100, 100);
    let big   = budget::estimate_cost("claude-sonnet-4-6", 10_000, 100);
    assert!(big > small, "expected monotonic in tokens_in");
}

async fn setup_helper() -> (tempfile::TempDir, sqlx::SqlitePool, i64) {
    let tmp = tempfile::TempDir::new().unwrap();
    let pool = db::open(&tmp.path().join("b.sqlite")).await.unwrap();
    let project_id: i64 = sqlx::query_scalar(
        "INSERT INTO projects (name, goal, status) VALUES ('t','t','active') RETURNING id"
    ).fetch_one(&pool).await.unwrap();
    (tmp, pool, project_id)
}
```

If `setup_helper` collides with an existing `setup`, rename the existing one or call this `setup_helper2`.

- [ ] **Step 2: Run tests to verify failure**

Run: `cd src-tauri && cargo test --test budget_test`
Expected: FAIL — `spend_window`, `month_spend_usd`, `estimate_cost` not yet defined.

- [ ] **Step 3: Implement the three helpers in `budget.rs`**

Append after `today_spend_usd`:

```rust
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd src-tauri && cargo test --test budget_test`
Expected: PASS — all four tests including the existing ones.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/budget.rs src-tauri/tests/budget_test.rs
git commit -m "$(cat <<'EOF'
feat(budget): add spend_window, month_spend_usd, estimate_cost

Foundation for multi-tier (hour/day/month) cap enforcement and
pre-flight estimates. All three use the existing single pricing table.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Extend events (`scope`, `BudgetUnreported`, `SmokeTestCycleComplete`)

**Files:**
- Modify: `src-tauri/src/events.rs`

Adds the new event variants and an enum'd scope. After this commit, anything that constructs `BudgetCapped` will fail to compile — that's intentional; subsequent tasks add the scope at each call site.

- [ ] **Step 1: Replace the existing `BudgetCapped` variant**

In `src-tauri/src/events.rs`, find line 16:

```rust
    BudgetCapped { spent_usd: f64, cap_usd: f64 },
```

Replace with:

```rust
    BudgetCapped { spent_usd: f64, cap_usd: f64, scope: BudgetCapScope },
    BudgetUnreported { role: String, job_id: i64 },
    SmokeTestCycleComplete {
        cycle_id: String,
        listing_id: Option<i64>,
        spend_usd: f64,
        duration_ms: u64,
        status: SmokeTestStatus,
    },
```

- [ ] **Step 2: Add the enums above the `SupervisorEvent` enum**

Insert just above `pub enum SupervisorEvent` in `events.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetCapScope {
    Hour,
    Day,
    Month,
    DbError,
    SmokePause,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SmokeTestStatus {
    Success,
    TimedOut,
    Failed,
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd src-tauri && cargo check`
Expected: FAIL at `supervisor.rs:181` — the existing call site doesn't pass `scope`. This is intentional and fixed in Task 5.

- [ ] **Step 4: Patch the supervisor call site provisionally to unblock compile**

In `src-tauri/src/supervisor.rs` around line 178–183, replace:

```rust
                            bus.send(SupervisorEvent::BudgetCapped {
                                spent_usd: spent,
                                cap_usd: daily_cap_usd,
                            });
```

with:

```rust
                            bus.send(SupervisorEvent::BudgetCapped {
                                spent_usd: spent,
                                cap_usd: daily_cap_usd,
                                scope: crate::events::BudgetCapScope::Day,
                            });
```

- [ ] **Step 5: Verify compile**

Run: `cd src-tauri && cargo check`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/events.rs src-tauri/src/supervisor.rs
git commit -m "$(cat <<'EOF'
feat(events): add scope to BudgetCapped + BudgetUnreported, SmokeTestCycleComplete

Wider events surface to support multi-tier caps and the smoke-test
auto-pause flow. Existing daily-cap call site updated to scope=Day.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Read hourly/monthly cap secrets in `lib.rs`

**Files:**
- Modify: `src-tauri/src/lib.rs`

The supervisor already takes `daily_cap_usd`. We need to pass `hourly_cap_usd` and `monthly_cap_usd` too — but to minimize churn we'll pass a `BudgetCaps` struct.

- [ ] **Step 1: Add `BudgetCaps` to `budget.rs`**

Append to `src-tauri/src/budget.rs`:

```rust
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
```

- [ ] **Step 2: Update `lib.rs` to build `BudgetCaps`**

In `src-tauri/src/lib.rs`, replace the block at lines 71–76:

```rust
            // Read the daily USD budget cap from the secret store; default $1.00.
            let daily_cap_usd: f64 = secrets::get("daily_budget_usd")
                .ok()
                .flatten()
                .and_then(|v| v.parse::<f64>().ok())
                .unwrap_or(1.00);
```

with:

```rust
            // Read multi-tier USD budget caps from the secret store with defaults.
            let read_cap = |k: &str, default: f64| -> f64 {
                secrets::get(k)
                    .ok()
                    .flatten()
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(default)
            };
            let caps = budget::BudgetCaps {
                hourly_usd:  read_cap("hourly_budget_usd",  0.50),
                daily_usd:   read_cap("daily_budget_usd",   1.00),
                monthly_usd: read_cap("monthly_budget_usd", 20.00),
            };
            let daily_cap_usd: f64 = caps.daily_usd; // keep existing var alive for next tasks
```

Add `use crate::budget;` at the top of `lib.rs` if not already present.

- [ ] **Step 3: Apply same pattern in `commands.rs`**

In `src-tauri/src/commands.rs` at line 52 onward (look for `daily_cap_usd`), replace the single-cap read with the same `read_cap` + `BudgetCaps` block.

- [ ] **Step 4: Verify compile**

Run: `cd src-tauri && cargo check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/budget.rs src-tauri/src/lib.rs src-tauri/src/commands.rs
git commit -m "$(cat <<'EOF'
feat(budget): add BudgetCaps struct + hourly/monthly secret reads

Defaults: $0.50/hour, $1.00/day, $20.00/month. Overridable via secrets
hourly_budget_usd / daily_budget_usd / monthly_budget_usd.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `enforce_caps()` in supervisor — multi-tier + pre-flight + fail-closed

**Files:**
- Modify: `src-tauri/src/supervisor.rs`
- Modify: `src-tauri/src/budget.rs` (add `enforce_caps`)
- Test: `src-tauri/tests/budget_test.rs`

Replace the existing single-cap check with a function that checks hour, day, month, and pre-flight estimate, and fails closed on DB error.

- [ ] **Step 1: Write the failing test in `src-tauri/tests/budget_test.rs`**

```rust
#[tokio::test]
async fn enforce_caps_returns_hour_when_hourly_exceeded() {
    let (_tmp, pool, project_id) = setup_helper().await;
    // 1M sonnet input = $3.00 — over an hourly cap of $1
    budget::record(&pool, project_id, "claude-sonnet-4-6", 1_000_000, 0).await.unwrap();
    let caps = budget::BudgetCaps { hourly_usd: 1.0, daily_usd: 100.0, monthly_usd: 1000.0 };
    let outcome = budget::enforce_caps(&pool, project_id, caps, 0.0).await.unwrap();
    assert!(matches!(outcome, budget::CapOutcome::Capped { scope, .. } if matches!(scope, agent_factory_lib::events::BudgetCapScope::Hour)));
}

#[tokio::test]
async fn enforce_caps_returns_ok_when_under_all_caps() {
    let (_tmp, pool, project_id) = setup_helper().await;
    let caps = budget::BudgetCaps::defaults();
    let outcome = budget::enforce_caps(&pool, project_id, caps, 0.0).await.unwrap();
    assert!(matches!(outcome, budget::CapOutcome::Ok));
}

#[tokio::test]
async fn enforce_caps_preflight_blocks_when_estimate_pushes_over() {
    let (_tmp, pool, project_id) = setup_helper().await;
    // current spend: $0.40 (just under $0.50 hourly default)
    budget::record(&pool, project_id, "claude-haiku-4-5-20251001", 500_000, 0).await.unwrap();
    let caps = budget::BudgetCaps { hourly_usd: 0.50, daily_usd: 100.0, monthly_usd: 1000.0 };
    // estimate of $0.20 pushes total to $0.60, over $0.50 hourly
    let outcome = budget::enforce_caps(&pool, project_id, caps, 0.20).await.unwrap();
    assert!(matches!(outcome, budget::CapOutcome::Capped { .. }));
}
```

- [ ] **Step 2: Run test to verify failure**

Run: `cd src-tauri && cargo test --test budget_test enforce_caps`
Expected: FAIL — `enforce_caps` and `CapOutcome` not yet defined.

- [ ] **Step 3: Implement `enforce_caps` in `budget.rs`**

Append to `src-tauri/src/budget.rs`:

```rust
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd src-tauri && cargo test --test budget_test enforce_caps`
Expected: PASS — all three new tests.

- [ ] **Step 5: Wire `enforce_caps` into the supervisor**

In `src-tauri/src/supervisor.rs`, change the signature of `run_worker_loop` from accepting `daily_cap_usd: f64` to accepting `caps: budget::BudgetCaps`. Update the caller in the same file. Then replace the cap-check block around lines 173–192 with:

```rust
                // Enforce multi-tier caps BEFORE claiming the next job.
                // Pre-flight estimate: assume up to 1500 input tokens + 800 output for
                // an average job (conservative for haiku, low for sonnet/opus).
                let est = budget::estimate_cost("claude-sonnet-4-6", 1500, 800);
                match budget::enforce_caps(pool, project_id, caps, est).await {
                    Ok(budget::CapOutcome::Capped { scope, spent_usd, cap_usd }) => {
                        let today_utc = chrono::Utc::now().date_naive();
                        if last_capped_day != Some(today_utc) {
                            bus.send(SupervisorEvent::BudgetCapped {
                                spent_usd, cap_usd, scope,
                            });
                            last_capped_day = Some(today_utc);
                        }
                        continue;
                    }
                    Ok(budget::CapOutcome::Ok) => {}
                    Err(e) => {
                        tracing::error!("enforce_caps errored: {e}");
                        continue;
                    }
                }
```

Also change `start()` and `run_worker_loop()` parameter passing to take `caps` everywhere `daily_cap_usd` was passed. Update `lib.rs` and `commands.rs` callers to pass `caps` from Task 4.

- [ ] **Step 6: Verify compile + tests**

Run: `cd src-tauri && cargo test`
Expected: PASS — all tests including supervisor_test.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/budget.rs src-tauri/src/supervisor.rs src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/tests/budget_test.rs
git commit -m "$(cat <<'EOF'
feat(supervisor): multi-tier cap enforcement with pre-flight estimate

enforce_caps checks hour → day → month in order, with a pre-flight
estimate folded into each check. Fail-closed on DB error. Supervisor
now stops claiming jobs as soon as any scope would be breached,
not just the daily total.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Remove duplicate cost math in supervisor; emit `BudgetUnreported`

**Files:**
- Modify: `src-tauri/src/supervisor.rs`

The supervisor at line 220 calls `budget::cost_usd` for the event AND `budget::record` separately. Now that `cost_usd` and `record` share a pricing table (Task 1), drop any local cost math and emit `BudgetUnreported` when a worker returns success but no tokens.

- [ ] **Step 1: Locate and rewrite the post-completion block**

In `src-tauri/src/supervisor.rs`, find the `Ok(result) => {` arm after `worker.request("process_job", req)` (around line 210–235). Replace the contents (lines from `if let (Some(tin)…)` down through the `BudgetSpent` send) with:

```rust
                                // Persist + emit spend; emit Unreported if the worker
                                // succeeded but didn't return token usage.
                                let tin = result.get("tokens_in").and_then(|v| v.as_u64());
                                let tout = result.get("tokens_out").and_then(|v| v.as_u64());
                                let model = result.get("model").and_then(|v| v.as_str());
                                match (tin, tout, model) {
                                    (Some(tin), Some(tout), Some(model)) => {
                                        let cost = budget::cost_usd(model, tin, tout);
                                        if cost > 0.0 {
                                            if let Err(e) = budget::record(pool, project_id, model, tin, tout).await {
                                                tracing::error!("budget::record failed: {e}");
                                            }
                                            bus.send(SupervisorEvent::BudgetSpent {
                                                role: role.into(),
                                                cost_usd: cost,
                                                tokens_in: tin,
                                                tokens_out: tout,
                                                model: model.to_string(),
                                            });
                                            // (existing per-cycle P&L block continues below — leave as is)
                                        }
                                    }
                                    _ => {
                                        bus.send(SupervisorEvent::BudgetUnreported {
                                            role: role.into(),
                                            job_id,
                                        });
                                    }
                                }
```

Keep the per-cycle P&L `tokio::spawn` block that follows (only the BudgetSpent emit was inside the old if-let; the spawn block uses `cost`/`model` locals — make sure they're still in scope or move the spawn into the `Some` arm).

- [ ] **Step 2: Verify compile + tests**

Run: `cd src-tauri && cargo test --test supervisor_test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/supervisor.rs
git commit -m "$(cat <<'EOF'
fix(supervisor): single pricing path + BudgetUnreported for silent jobs

cost_usd and record now share a table (Task 1), so dropping the local
math removes the last source of drift between events and ledger.
Workers that succeed without reporting tokens now surface as
BudgetUnreported instead of silently free.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: PnL reconciliation warning

**Files:**
- Modify: `src-tauri/src/pnl.rs`

After `PnlCycleClosed` is computed, query the ledger for the cycle's actual sum and `tracing::warn!` if they disagree by more than $0.01.

- [ ] **Step 1: Locate cycle-close emission in `pnl.rs`**

Run: `grep -n "PnlCycleClosed\|cycle_close\|close_cycle" src-tauri/src/pnl.rs` to find where the event is built.

- [ ] **Step 2: Add reconciliation just before the event is sent**

Add this block before `bus.send(SupervisorEvent::PnlCycleClosed { ... })`:

```rust
    // Reconcile: ledger-sum for this cycle should match total_cost_usd.
    let ledger_sum: Option<f64> = sqlx::query_scalar(
        "SELECT COALESCE(SUM(b.usd_cost), 0.0) \
         FROM budget_ledger b \
         JOIN cycle_jobs cj ON cj.job_id = b.job_id \
         WHERE cj.cycle_id = ?"
    )
    .bind(&cycle_id)
    .fetch_one(pool)
    .await
    .ok()
    .flatten();
    if let Some(sum) = ledger_sum {
        if (sum - total_cost_usd).abs() > 0.01 {
            tracing::warn!(
                cycle_id = %cycle_id,
                ledger_sum = sum,
                pnl_sum = total_cost_usd,
                "pnl/ledger reconciliation mismatch > $0.01"
            );
        }
    }
```

If `budget_ledger` doesn't currently have a `job_id` column joined to `cycle_jobs`, use the existing per-cycle cost path. Run: `grep -n "job_id\|cycle_jobs\|cycle_costs" src-tauri/src/pnl.rs` first and adapt the JOIN to match the actual schema. If the cost-by-cycle is already aggregated via a `cycle_costs` table, query that instead.

- [ ] **Step 3: Verify compile + tests**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/pnl.rs
git commit -m "$(cat <<'EOF'
feat(pnl): warn when cycle-close cost disagrees with budget ledger

Catches silent drift between PnlCycleClosed.total_cost_usd and the
budget_ledger sum for the same cycle. Warning only — does not fail
the cycle close.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: `cmd_budget_status` Tauri command + TS wrapper

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register the command)
- Modify: `src/api.ts`

Single command returns everything the UI needs.

- [ ] **Step 1: Add `cmd_budget_status` to `commands.rs`**

Append:

```rust
#[derive(serde::Serialize)]
pub struct BudgetStatus {
    pub today_usd: f64,
    pub hour_usd: f64,
    pub month_usd: f64,
    pub hourly_cap_usd: f64,
    pub daily_cap_usd: f64,
    pub monthly_cap_usd: f64,
    pub burn_per_hour_usd: f64,
}

#[tauri::command]
pub async fn cmd_budget_status(state: tauri::State<'_, crate::state::AppState>) -> Result<BudgetStatus, String> {
    let pool = &state.pool;
    let pid = state.project_id;
    let today_usd = crate::budget::today_spend_usd(pool, pid).await.map_err(|e| e.to_string())?;
    let hour_usd  = crate::budget::spend_window(pool, pid, 1).await.map_err(|e| e.to_string())?;
    let month_usd = crate::budget::month_spend_usd(pool, pid).await.map_err(|e| e.to_string())?;
    // Burn rate over last 1h equals hour_usd (per-hour by definition).
    let burn = hour_usd;
    let read = |k: &str, default: f64| -> f64 {
        crate::secrets::get(k).ok().flatten().and_then(|v| v.parse().ok()).unwrap_or(default)
    };
    Ok(BudgetStatus {
        today_usd, hour_usd, month_usd,
        hourly_cap_usd: read("hourly_budget_usd", 0.50),
        daily_cap_usd:  read("daily_budget_usd",  1.00),
        monthly_cap_usd: read("monthly_budget_usd", 20.00),
        burn_per_hour_usd: burn,
    })
}
```

(If `state::AppState` doesn't expose `pool` / `project_id` exactly like that, match the existing pattern from other commands in the same file.)

- [ ] **Step 2: Register in `lib.rs`**

In the `tauri::generate_handler!` macro invocation in `lib.rs`, add `commands::cmd_budget_status`.

- [ ] **Step 3: Add the TS wrapper to `src/api.ts`**

Append after existing wrappers:

```ts
export interface BudgetStatus {
  today_usd: number;
  hour_usd: number;
  month_usd: number;
  hourly_cap_usd: number;
  daily_cap_usd: number;
  monthly_cap_usd: number;
  burn_per_hour_usd: number;
}

export const api = {
  // ... existing entries
  budgetStatus: (): Promise<BudgetStatus> => invoke("cmd_budget_status"),
};
```

(If `api` is already an object literal, add the entry inside its braces — don't rewrite the whole object.)

- [ ] **Step 4: Write the wrapper test**

Create `src/__tests__/budget-pill.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { api } from "../api";

describe("api.budgetStatus", () => {
  beforeEach(() => invokeMock.mockReset());
  it("routes to cmd_budget_status", async () => {
    invokeMock.mockResolvedValueOnce({
      today_usd: 0.4, hour_usd: 0.1, month_usd: 0.4,
      hourly_cap_usd: 0.5, daily_cap_usd: 1, monthly_cap_usd: 20,
      burn_per_hour_usd: 0.1,
    });
    const s = await api.budgetStatus();
    expect(invokeMock).toHaveBeenCalledWith("cmd_budget_status");
    expect(s.today_usd).toBe(0.4);
  });
});
```

- [ ] **Step 5: Run tests + build**

Run: `cd src-tauri && cargo test && cd .. && npm test -- src/__tests__/budget-pill.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/lib.rs src/api.ts src/__tests__/budget-pill.test.ts
git commit -m "$(cat <<'EOF'
feat(commands): cmd_budget_status returns hour/day/month spend + caps

Single source for the BudgetPill UI. Reads caps from secrets each call
so a user-edited secrets file is reflected immediately.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: `BudgetPill` UI component + TopBar mount

**Files:**
- Create: `src/factory/ui/BudgetPill.tsx`
- Modify: `src/factory/ui/TopBar.tsx`
- Modify: `src/factory/ui/factory-floor.css` (optional, can inline styles initially)

Pill shows `$today / $cap` colored by ratio. Hover card shows hour/day/month bars + burn/hr.

- [ ] **Step 1: Create `src/factory/ui/BudgetPill.tsx`**

```tsx
import { useEffect, useState } from "react";
import { api, type BudgetStatus } from "../../api";

function fmt(v: number) {
  return `$${v.toFixed(2)}`;
}

function pct(num: number, den: number) {
  if (den <= 0) return 0;
  return Math.min(100, (num / den) * 100);
}

function tone(num: number, den: number): "ok" | "warn" | "danger" {
  const p = pct(num, den);
  if (p < 60) return "ok";
  if (p < 90) return "warn";
  return "danger";
}

export default function BudgetPill() {
  const [s, setS] = useState<BudgetStatus | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => api.budgetStatus().then((v) => { if (!cancelled) setS(v); }).catch(() => {});
    load();
    const id = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (!s) return <div className="budget-pill loading">…</div>;

  const t = tone(s.today_usd, s.daily_cap_usd);

  return (
    <div className="budget-pill-wrap" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button className={`budget-pill ${t}`} type="button">
        <span className="budget-pill-label">Today</span>
        <span className="budget-pill-value">{fmt(s.today_usd)}</span>
        <span className="budget-pill-sep">/</span>
        <span className="budget-pill-cap">{fmt(s.daily_cap_usd)}</span>
      </button>
      {open && (
        <div className="budget-pill-card" role="dialog">
          <Row label="Hour"   v={s.hour_usd}  cap={s.hourly_cap_usd} />
          <Row label="Day"    v={s.today_usd} cap={s.daily_cap_usd} />
          <Row label="Month"  v={s.month_usd} cap={s.monthly_cap_usd} />
          <div className="budget-pill-burn">Burn: {fmt(s.burn_per_hour_usd)}/hr</div>
        </div>
      )}
    </div>
  );
}

function Row({ label, v, cap }: { label: string; v: number; cap: number }) {
  const t = tone(v, cap);
  return (
    <div className={`budget-pill-row ${t}`}>
      <span className="budget-pill-row-label">{label}</span>
      <div className="budget-pill-row-bar"><div className="budget-pill-row-fill" style={{ width: `${pct(v, cap)}%` }} /></div>
      <span className="budget-pill-row-num">{fmt(v)} / {fmt(cap)}</span>
    </div>
  );
}
```

- [ ] **Step 2: Mount in `TopBar.tsx`**

In `src/factory/ui/TopBar.tsx`, add at the top with other imports:

```tsx
import BudgetPill from "./BudgetPill";
```

Then mount it next to `<AnalyticsPanel />` — look for that JSX (around line 121) and place `<BudgetPill />` before or after it depending on layout preference.

- [ ] **Step 3: Add minimum styles**

Append to `src/factory/ui/factory-floor.css`:

```css
.budget-pill-wrap { position: relative; display: inline-block; }
.budget-pill { display:inline-flex; gap:6px; align-items:center; padding:4px 10px; border-radius:999px;
  background:#1a1c20; color:#dfe; border:1px solid #2a2d33; cursor:default; font:600 12px/1 system-ui; }
.budget-pill.ok     { border-color:#244a30; color:#9be0b3; }
.budget-pill.warn   { border-color:#5a4f1a; color:#e8d77b; }
.budget-pill.danger { border-color:#5a1f23; color:#ff8a93; }
.budget-pill-label  { opacity:.7; }
.budget-pill-card   { position:absolute; right:0; top:calc(100% + 6px); width:280px; background:#13151a;
  border:1px solid #2a2d33; border-radius:10px; padding:10px 12px; z-index:50; }
.budget-pill-row    { display:grid; grid-template-columns:48px 1fr 110px; gap:8px; align-items:center; padding:4px 0; }
.budget-pill-row-bar { background:#222428; height:6px; border-radius:3px; overflow:hidden; }
.budget-pill-row-fill { height:100%; background:#9be0b3; }
.budget-pill-row.warn   .budget-pill-row-fill { background:#e8d77b; }
.budget-pill-row.danger .budget-pill-row-fill { background:#ff8a93; }
.budget-pill-burn { opacity:.6; font-size:11px; margin-top:6px; }
```

- [ ] **Step 4: Run typecheck + tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Manual visual verify**

Run: `npm run tauri dev` and confirm the pill appears in the top bar showing the current spend. Hover to see the card.

- [ ] **Step 6: Commit**

```bash
git add src/factory/ui/BudgetPill.tsx src/factory/ui/TopBar.tsx src/factory/ui/factory-floor.css
git commit -m "$(cat <<'EOF'
feat(ui): BudgetPill — top-bar spend display + hover breakdown

Polls cmd_budget_status every 5s. Pill shows today vs daily cap;
hover card shows hour/day/month bars plus burn rate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Smoke-test pause flag + `cmd_start_smoke_test` / `cmd_resume_from_smoke_test`

**Files:**
- Modify: `src-tauri/src/budget.rs` (smoke-pause persisted flag)
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs` (register commands)
- Modify: `src/api.ts`

The pause flag is just a secret key (`smoke_pause_until`) — the cap-check honors it. The smoke-start command enqueues one research job with `smoke=true`.

- [ ] **Step 1: Honor the pause flag in `enforce_caps`**

In `src-tauri/src/budget.rs`, modify `enforce_caps` to check the flag first:

```rust
    if crate::secrets::get("smoke_pause_until").ok().flatten().is_some() {
        return Ok(CapOutcome::Capped {
            scope: BudgetCapScope::SmokePause, spent_usd: 0.0, cap_usd: 0.0,
        });
    }
```

Place this at the very top of `enforce_caps` before the hour-window query.

- [ ] **Step 2: Add the two commands to `commands.rs`**

```rust
#[tauri::command]
pub async fn cmd_start_smoke_test(state: tauri::State<'_, crate::state::AppState>) -> Result<String, String> {
    use chrono::Utc;
    let cycle_id = format!("smoke-{}", Utc::now().format("%Y%m%d%H%M%S"));
    crate::secrets::set("smoke_cycle_id", &cycle_id).map_err(|e| e.to_string())?;
    // Enqueue one research job; downstream listing/publisher follow normal pipeline.
    let payload = serde_json::json!({ "smoke": true, "cycle_id": cycle_id });
    crate::queue::enqueue(&state.pool, state.project_id, "research", &payload.to_string())
        .await.map_err(|e| e.to_string())?;
    Ok(cycle_id)
}

#[tauri::command]
pub async fn cmd_resume_from_smoke_test() -> Result<(), String> {
    crate::secrets::clear("smoke_pause_until").map_err(|e| e.to_string())?;
    Ok(())
}
```

(If `crate::secrets::clear` doesn't exist, write the secret to empty string; check the existing pattern in the file.)

- [ ] **Step 3: Register both in `lib.rs`**

Add `commands::cmd_start_smoke_test, commands::cmd_resume_from_smoke_test` to the `generate_handler!` list.

- [ ] **Step 4: Add TS wrappers to `src/api.ts`**

```ts
  startSmokeTest: (): Promise<string> => invoke("cmd_start_smoke_test"),
  resumeFromSmokeTest: (): Promise<void> => invoke("cmd_resume_from_smoke_test"),
```

- [ ] **Step 5: Write an integration test**

In `src-tauri/tests/budget_test.rs`:

```rust
#[tokio::test]
async fn enforce_caps_returns_smoke_pause_when_flag_set() {
    let (_tmp, pool, project_id) = setup_helper().await;
    // Best-effort: set the secret if the test environment supports it.
    let _ = agent_factory_lib::secrets::set("smoke_pause_until", "1");
    let outcome = budget::enforce_caps(&pool, project_id, budget::BudgetCaps::defaults(), 0.0).await.unwrap();
    let _ = agent_factory_lib::secrets::clear("smoke_pause_until");
    assert!(matches!(outcome, budget::CapOutcome::Capped { scope, .. } if matches!(scope, agent_factory_lib::events::BudgetCapScope::SmokePause)));
}
```

If `secrets::set/clear` is keychain-backed and not test-friendly, skip the integration test and add an inline `#[cfg(test)]` test in `budget.rs` that abstracts the flag lookup behind a trait or env-var fallback. Prefer not to rewrite secrets; the dev-build local-file path makes set/clear in tests viable.

- [ ] **Step 6: Run tests**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/budget.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/api.ts src-tauri/tests/budget_test.rs
git commit -m "$(cat <<'EOF'
feat(smoke-test): pause flag + start/resume commands

enforce_caps now short-circuits to Capped{scope=SmokePause} when the
smoke_pause_until secret is set. cmd_start_smoke_test enqueues one
research job tagged with a cycle id; cmd_resume_from_smoke_test
lifts the pause.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Smoke-test completion + 10-minute timeout

**Files:**
- Modify: `src-tauri/src/supervisor.rs` (or wherever `handle_publisher_complete` is called)
- Modify: `src-tauri/src/etsy_publish.rs`

When the publisher completes a draft tagged with the smoke cycle id, emit `SmokeTestCycleComplete` and set `smoke_pause_until`. Also: enforce a 10-minute timeout from cycle start.

- [ ] **Step 1: Track smoke cycle start time**

When `cmd_start_smoke_test` runs (Task 10), also write `smoke_started_at` as a UNIX timestamp:

```rust
let now = chrono::Utc::now().timestamp().to_string();
crate::secrets::set("smoke_started_at", &now).ok();
```

- [ ] **Step 2: Emit `SmokeTestCycleComplete` from the publisher hook**

In `src-tauri/src/etsy_publish.rs::handle_publisher_complete`, at the end of the success path (after the existing `EtsyListingPublished` send), add:

```rust
    // If this listing belongs to a smoke cycle, end it.
    let smoke_cycle = crate::secrets::get("smoke_cycle_id").ok().flatten();
    let smoke_started = crate::secrets::get("smoke_started_at")
        .ok().flatten().and_then(|s| s.parse::<i64>().ok());
    if let (Some(cycle_id), Some(started)) = (smoke_cycle.as_ref(), smoke_started) {
        let duration_ms = (chrono::Utc::now().timestamp() - started).max(0) as u64 * 1000;
        // pull this cycle's spend
        let pool = pool.clone();
        let pid = project_id;
        let cid = cycle_id.clone();
        let bus2 = bus.clone();
        tokio::spawn(async move {
            let ledger_sum: f64 = sqlx::query_scalar::<_, f64>(
                "SELECT COALESCE(SUM(b.usd_cost), 0.0) FROM budget_ledger b \
                 JOIN cycle_jobs cj ON cj.job_id = b.job_id WHERE cj.cycle_id = ?"
            ).bind(&cid).fetch_one(&pool).await.unwrap_or(0.0);
            let _ = crate::secrets::set("smoke_pause_until", "1");
            let _ = crate::secrets::clear("smoke_cycle_id");
            let _ = crate::secrets::clear("smoke_started_at");
            bus2.send(crate::events::SupervisorEvent::SmokeTestCycleComplete {
                cycle_id: cid,
                listing_id: Some(created_listing_id),
                spend_usd: ledger_sum,
                duration_ms,
                status: crate::events::SmokeTestStatus::Success,
            });
        });
    }
```

Adapt `created_listing_id` to the local variable name actually used in `handle_publisher_complete` after the publish succeeds.

- [ ] **Step 3: 10-minute timeout in the supervisor loop**

In `src-tauri/src/supervisor.rs`, alongside the existing `last_capped_day` tracking, add a periodic check (every poll tick):

```rust
                if let (Some(started), Some(cycle_id)) = (
                    crate::secrets::get("smoke_started_at").ok().flatten().and_then(|s| s.parse::<i64>().ok()),
                    crate::secrets::get("smoke_cycle_id").ok().flatten(),
                ) {
                    if chrono::Utc::now().timestamp() - started > 600 {
                        bus.send(SupervisorEvent::SmokeTestCycleComplete {
                            cycle_id: cycle_id.clone(),
                            listing_id: None,
                            spend_usd: 0.0,
                            duration_ms: 600_000,
                            status: crate::events::SmokeTestStatus::TimedOut,
                        });
                        let _ = crate::secrets::set("smoke_pause_until", "1");
                        let _ = crate::secrets::clear("smoke_cycle_id");
                        let _ = crate::secrets::clear("smoke_started_at");
                    }
                }
```

- [ ] **Step 4: Verify compile + tests**

Run: `cd src-tauri && cargo test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/etsy_publish.rs src-tauri/src/supervisor.rs src-tauri/src/commands.rs
git commit -m "$(cat <<'EOF'
feat(smoke-test): emit SmokeTestCycleComplete on draft publish + 10m timeout

Publisher hook detects smoke-cycle drafts, computes cycle spend from
the ledger, sets the pause flag, and emits Success. Supervisor checks
every tick for a > 10-minute smoke cycle and emits TimedOut.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: EtsyPanel smoke-test button + progress UI

**Files:**
- Modify: `src/factory/ui/EtsyPanel.tsx`

Add a button that calls `api.startSmokeTest()` and shows live progress: research ✓ → asset ✓ → listing ✓ → draft published ✓. Show "Resume" once complete.

- [ ] **Step 1: Read existing EtsyPanel structure**

Run: `wc -l src/factory/ui/EtsyPanel.tsx` and review the file to find the right insertion point (near other Etsy-status UI).

- [ ] **Step 2: Add smoke-test state + UI**

Inside the EtsyPanel component, add:

```tsx
const [smokeRunning, setSmokeRunning] = useState(false);
const [smokeSteps, setSmokeSteps] = useState({
  research: false, asset: false, listing: false, draft: false,
});
const [smokeListingId, setSmokeListingId] = useState<number | null>(null);

// Subscribe to supervisor events to update step ticks.
useEffect(() => {
  // Existing event subscription pattern in this app uses a Tauri
  // listen() for "supervisor_event". Match that pattern here:
  // listen("supervisor_event", (e: any) => { ... }) and update steps.
  // (No-op placeholder if no event subscription exists yet.)
}, []);

const startSmoke = async () => {
  setSmokeRunning(true);
  setSmokeSteps({ research: false, asset: false, listing: false, draft: false });
  try {
    await api.startSmokeTest();
  } catch (e) {
    setSmokeRunning(false);
  }
};
const resumeSmoke = async () => {
  await api.resumeFromSmokeTest();
  setSmokeRunning(false);
};
```

JSX (place near existing connection UI):

```tsx
<div className="smoke-test">
  <button className="modal-btn approve" disabled={smokeRunning || !etsyConnected} onClick={startSmoke}>
    {smokeRunning ? "Smoke test running…" : "Run smoke-test cycle"}
  </button>
  {smokeRunning && (
    <ul className="smoke-steps">
      <li className={smokeSteps.research ? "ok" : ""}>Research</li>
      <li className={smokeSteps.asset    ? "ok" : ""}>Asset</li>
      <li className={smokeSteps.listing  ? "ok" : ""}>Listing</li>
      <li className={smokeSteps.draft    ? "ok" : ""}>Draft published</li>
    </ul>
  )}
  {smokeSteps.draft && smokeListingId && (
    <>
      <div className="ck ok">Draft posted (listing id {smokeListingId}). Review on Etsy, then resume.</div>
      <button className="modal-btn" onClick={resumeSmoke}>Resume loops</button>
    </>
  )}
</div>
```

For the event listener, check the existing pattern in `App.tsx` or elsewhere — search for `listen("supervisor_event"` or similar — and wire `EtsyListingPublished` and `SmokeTestCycleComplete` events into `setSmokeSteps`/`setSmokeListingId`.

- [ ] **Step 3: Minimal styles**

Append to `src/factory/ui/factory-floor.css`:

```css
.smoke-test { margin-top: 12px; }
.smoke-steps { list-style: none; padding: 0; margin: 8px 0; }
.smoke-steps li { padding: 4px 0; opacity: .5; }
.smoke-steps li.ok { opacity: 1; color: #9be0b3; }
.smoke-steps li.ok::before { content: "✓ "; }
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Manual smoke**

Run: `npm run tauri dev`. Connect Etsy if not already. Click "Run smoke-test cycle". Watch progress and check Etsy for the draft. Click "Resume loops" after manual review.

- [ ] **Step 6: Commit**

```bash
git add src/factory/ui/EtsyPanel.tsx src/factory/ui/factory-floor.css
git commit -m "$(cat <<'EOF'
feat(ui): smoke-test cycle button + progress in EtsyPanel

One-click full-pipeline run with auto-pause for manual draft review.
Progress reflects research → asset → listing → draft from supervisor
events; Resume clears the pause flag.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**Spec coverage check:**

| Spec item | Task |
|---|---|
| Delete `cost_usd`, single pricing source | Task 1 |
| `spend_window`, `month_spend_usd`, `estimate_cost` | Task 2 |
| `BudgetCapScope` enum, `BudgetUnreported`, `SmokeTestCycleComplete` | Task 3 |
| Hourly/monthly cap secret reads with defaults | Task 4 |
| `enforce_caps` with pre-flight + fail-closed | Task 5 |
| Remove duplicate cost math at supervisor.rs:220 | Task 6 |
| Emit `BudgetUnreported` | Task 6 |
| PnL reconciliation warning | Task 7 |
| `cmd_budget_status` | Task 8 |
| `BudgetPill` UI + TopBar mount | Task 9 |
| `cmd_start_smoke_test`, `cmd_resume_from_smoke_test`, pause flag | Task 10 |
| `SmokeTestCycleComplete` emission + 10-min timeout | Task 11 |
| EtsyPanel smoke-test button + progress | Task 12 |

**No placeholders:** Each step contains exact code, exact paths, exact commands. The only "adapt to existing pattern" notes are in Tasks 7, 10, 11, 12 where the precise variable names or event-listener style are codebase-specific — those notes point to the exact grep to run.

**Type consistency:** `BudgetCapScope`, `CapOutcome`, `BudgetCaps`, `BudgetStatus`, `SmokeTestStatus` are defined once in their introducing task and referenced verbatim afterward.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-11-cost-metrics-etsy-verification.md`.

Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
