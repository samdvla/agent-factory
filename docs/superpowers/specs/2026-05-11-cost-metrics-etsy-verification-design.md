# Cost containment, accurate metrics, Etsy end-to-end smoke test

**Date:** 2026-05-11
**Status:** Design (pre-implementation)
**Motivation:** Anthropic API credits were exhausted unexpectedly fast; in-app spend/revenue metrics must be trustworthy before we flip real Etsy publishing on for SabiWabiGifts.

## Goals

1. Make daily/hourly/monthly spend caps real, multi-layered, and impossible to silently bypass.
2. Make in-app spend metrics reconcile with the ledger of record (one pricing source, one math path).
3. Provide a one-shot "smoke test cycle" that exercises the full pipeline (research → asset → listing → publish draft) with auto-pause for manual Etsy verification.

## Non-goals

- Per-listing P&L attribution beyond what `PnlCycleClosed` already provides.
- CSV exports or accounting reconciliation outside the app.
- Replacing the existing first-N listing review modal or kill switch.

## Architecture

Three layers of cost enforcement (hourly / daily / monthly), one pricing source of truth, a pre-flight estimator that blocks jobs before they spend, and a one-shot "smoke test" path through the existing supervised pipeline that exits cleanly after a single cycle.

```
┌──────────────────────────────────────────────────────────────────┐
│  Worker loop (supervisor.rs)                                     │
│    1. pre-flight: estimate(job) + today_spent + hour_spent       │
│       - any cap breached → emit BudgetCapped, skip claim         │
│    2. claim job → run worker → worker reports tokens/model       │
│    3. ledger insert via budget::record (SINGLE pricing source)   │
│    4. emit BudgetSpent using the SAME function for the UI        │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│  budget_ledger (sqlite)                                          │
│  - hourly view: sum(usd_cost) where ts >= now()-1h               │
│  - daily view : sum(usd_cost) where day = date('now')            │
│  - monthly    : sum(usd_cost) where day >= date('now','start of │
│                  month')                                         │
└──────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│  Top-bar BudgetPill (React)                                      │
│   "$0.41 today / $1.00 cap" + hover card: bars + burn rate       │
│   Queries the ledger directly via Tauri command                  │
└──────────────────────────────────────────────────────────────────┘
```

## Components

| File | Change |
|---|---|
| `src-tauri/src/budget.rs` | Delete `cost_usd` (the stale-haiku-price function at line 5). Make `price_per_million` the only source. Re-export `cost_usd(model, in, out)` that uses it. Add `spend_window(pool, project_id, hours)` and `month_spend_usd`. Add `estimate_cost(model, est_in, est_out)`. |
| `src-tauri/src/supervisor.rs` | Replace single-cap check at line 175 with `enforce_caps()` returning `Ok \| Capped { scope }`. Add pre-flight: estimate input tokens from `payload_json.len() / 4 + system_prompt_chars / 4`, compare `today_spent + estimate` to cap. On `Capped`, emit `BudgetCapped { spent, cap, scope }` and skip. Remove duplicate cost logic at line 220 — call `budget::cost_usd` instead. |
| `src-tauri/src/events.rs` | Extend `BudgetCapped` with `scope: "hour" \| "day" \| "month" \| "db_error" \| "smoke_pause"`. Add `BudgetUnreported { role, job_id }`. Add `SmokeTestCycleComplete { cycle_id, listing_id, spend_usd, duration_ms, status }`. |
| `src-tauri/src/commands.rs` | New `cmd_budget_status()` → `{today, hour, month, hourly_cap, daily_cap, monthly_cap, burn_per_hour}`. New `cmd_start_smoke_test()` — enqueues ONE research job tagged `smoke=true`. New `cmd_resume_from_smoke_test()` — clears the pause flag. |
| `workers/cs/cs/agent.py` | Sum tokens from BOTH Anthropic calls (line 70 + line 120) and return their sum. Add unit test asserting both call sites are summed. |
| `src-tauri/src/lib.rs` | Add defaults at startup: `hourly_budget_usd` = $0.50, `monthly_budget_usd` = $20.00. Keep `daily_budget_usd` default $1.00. Each readable from secrets with fallback to defaults. |
| `src-tauri/src/pnl.rs` | After cycle close, reconcile ledger-sum-for-cycle vs `PnlCycleClosed.total_cost_usd`. `tracing::warn!` on mismatch > $0.01. |
| `src/factory/ui/BudgetPill.tsx` (new) | Top-bar pill + hover card. Polls `cmd_budget_status` every 5s. Green < 60%, amber 60–90%, red > 90%. |
| `src/factory/ui/TopBar.tsx` | Mount `<BudgetPill />` next to `AnalyticsPanel`. |
| `src/factory/ui/EtsyPanel.tsx` | Add "Smoke test cycle" button → calls `cmd_start_smoke_test`. Disabled if Etsy not connected. Live progress: research ✓ → asset ✓ → listing ✓ → draft published ✓. Add "Resume" button after smoke test completes. |

## Data flow

### Normal job

1. Worker loop ticks (250ms).
2. `enforce_caps()` queries ledger for hour/day/month sums.
3. If any cap would be breached by `today_spent + estimate(next_job)`, emit `BudgetCapped` and skip the claim.
4. Claim job, run worker, receive `{tokens_in, tokens_out, model}` in the result.
5. `budget::record` writes the ledger (the only path that touches the table).
6. `budget::cost_usd` (single function) computes USD; emit `BudgetSpent`.
7. UI pill refreshes on next 5s poll. Numbers reconcile because the event display and the ledger now share one pricing function.

### Smoke test

1. User clicks "Smoke test cycle" in EtsyPanel.
2. `cmd_start_smoke_test` enqueues one research job with `smoke=true` and stores `smoke_cycle_id` in secrets.
3. Normal pipeline runs: research → asset → listing → publisher → `handle_publisher_complete` → draft posted to Etsy.
4. Supervisor sees the publisher's `EtsyListingPublished` event with the smoke cycle id → emits `SmokeTestCycleComplete` and sets a `paused_by_smoke_test` flag. `enforce_caps()` treats the flag as a cap breach and returns `Capped { scope: "smoke_pause" }` until cleared.
5. User reviews draft at `etsy.com/your/shops/SabiWabiGifts/listings`. If happy, activates manually via existing `cmd_etsy_activate_listing`.
6. User clicks "Resume" → `cmd_resume_from_smoke_test` lifts the pause flag.

## Error handling

- **Pre-flight estimate is wrong** → ledger records actuals; next pre-flight uses real history. Worst case: one job exceeds cap by its delta. Tolerable because the next claim will see the new total.
- **Worker fails to report tokens** → ledger row not written (today's behavior). New behavior: emit `BudgetUnreported { role, job_id }` warning event so we notice silent leaks.
- **Pricing changes upstream** → single pricing table in `budget.rs` is the only place to update. Comment documents "last verified" date.
- **DB write fails** → `tracing::error!` and continue, same as today. Next cap check under-counts by at most one job.
- **Smoke test stalls** → 10-minute timeout, emit `SmokeTestCycleComplete { status: "timed_out" }`, lift the pause flag.
- **Cap-check DB query fails** → fail closed: treat as capped, emit `BudgetCapped { scope: "db_error" }`. Better to stall than to spend blindly.

## Testing

### Unit

- `budget::cost_usd` matches `budget::record`'s computation for haiku/sonnet/opus models.
- `enforce_caps` returns Capped for each scope (hour/day/month) independently.
- `estimate_cost` is monotonic in input length.
- `cs/agent.py` sums tokens from both call sites.

### Integration

- Insert N ledger rows totalling > daily cap → supervisor must skip the next claim and emit `BudgetCapped { scope: "day" }`.
- Same test for `scope: "hour"` and `scope: "month"`.
- `PnlCycleClosed` reconciliation: insert ledger rows for cycle X, fire cycle close, assert no warning logged when sums match; assert warning logged when sums differ by > $0.01.

### Manual smoke (the real Etsy end-to-end check)

1. Etsy connected; `mock_etsy.json` disabled.
2. Click "Smoke test cycle".
3. Watch BudgetPill: total spend should be < $0.05 for one cycle (all haiku).
4. One draft listing appears in SabiWabiGifts. Title/tags/price reasonable.
5. Activate manually via `cmd_etsy_activate_listing`. Listing goes live.
6. Loop stays paused until "Resume" is clicked.

## Open questions

None blocking. Default caps ($0.50/hr, $1/day, $20/mo) are starting points; user can override in secrets without code changes.

## Out of scope

- Streaming / progressive token reporting from workers (current snapshot-on-completion is good enough).
- Anthropic prompt-caching configuration changes (separate spec).
- Etsy taxonomy auto-selection (orthogonal).
