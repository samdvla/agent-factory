# Social Video Distribution — Design Spec

**Date:** 2026-06-04
**Status:** Approved (design) — pending implementation plan
**Owner:** Sam

## Summary

Add a new self-contained worker, `workers/social/`, that turns each
published 3D-character item into short vertical videos and posts them to
**multiple TikTok accounts and YouTube Shorts channels**, fully
autonomously. Each account owns a niche; the worker routes items to the
matching account, generates a 9:16 clip (cheap turntable spin *or*
Higgsfield/Seedance animation, chosen per item under budget), writes a
platform-tuned caption, and publishes.

Because the account starts with **no approved platform API access**, every
account begins in `queue` mode (renders to a local outbox for manual
upload) and is flipped to `draft` then `direct` (auto-publish) per account
as approvals clear — **config only, no code change**.

This mirrors the existing worker convention (`research`, `designer`,
`publisher`, `strategist`, `cfo`, …): a Python package speaking
newline-delimited JSON-RPC 2.0 over stdio (`workers/shared`’s
`Protocol`), registered with the Rust supervisor and launched per project.

## Goals

- One cohesive worker that distributes published items as short-form video.
- Multi-platform: TikTok + YouTube Shorts (extensible to more).
- Multi-account with **niche-per-account** routing.
- Three content types: product **showcase**, **trend/faceless**, and a
  **mixed** ratio.
- Per-item video-source decision (turntable vs Higgsfield) under CFO budget.
- Fully autonomous publish where approved; safe `queue`/`draft` fallback
  everywhere else — selectable per account.
- Account-health safety: per-account caps, jittered spacing, cross-account
  content variation, master kill switch.

## Non-Goals (v1 — YAGNI)

- Analytics/engagement dashboard (we write a ledger; reading it is later).
- Comment/DM automation or community management.
- Multi-language captions.
- A/B testing / thumbnail-optimization engine.
- Platforms beyond TikTok + YouTube Shorts (adapter layer leaves the door
  open).

## Context / Existing Patterns Reused

- **Worker convention.** Each worker is a `uv`-managed Python package under
  `workers/<name>/` with `<name>/protocol.py` (or shared), `<name>/agent.py`,
  `<name>/__main__.py`, and `tests/`. Registered via `make_spec("social",
  "social")` in `src-tauri/src/commands.rs` (~L867) and supervised by
  `src-tauri/src/supervisor.rs`.
- **Video generation already exists.** `workers/designer/designer/higgsfield.py`
  drives Higgsfield (Seedance) generation. The social worker reuses this via
  a small shared helper rather than re-implementing the client.
- **Social precedent.** `workers/publisher/publisher/pinterest_pin.py` already
  does single-image social promotion; this worker generalizes that idea to
  *video* and *continuous multi-account* posting, but lives separately
  because its lifecycle (continuous, scheduled, multi-account) differs from
  publisher’s once-per-listing flow.
- **Secrets / flags.** Per the secure store pattern (`*_enabled`,
  `*_api_key`, OAuth token sets) used by Etsy/Gumroad/MMF/etc.
- **Budget.** CFO worker’s budget controls gate any paid generation.

## Architecture

```
published item event
        │
        ▼
   router.py ──────────────► [ post jobs: {platform, account, content_type} ]
        │                         (one item may fan out to several accounts)
        ▼
   video.py  ── decides turntable | higgsfield (budget + content_type)
        │       → 9:16 MP4 path
        ▼
   caption.py ── LLM caption + hashtags + CTA/link (per platform & type)
        │
        ▼
   adapters/{tiktok,youtube}.py ── publish in per-account mode:
        │         direct | draft | queue
        ▼
   ledger: social_posts.jsonl  (caps, dedupe, future analytics)
```

### Worker entry — `social/agent.py`

Handles JSON-RPC requests from the supervisor. Primary method: process a
published item into post jobs and execute them. Honors `social_enabled`
(master kill switch) and per-account caps before doing any work. Emits
progress/outcome notifications like other workers.

### `social/router.py`

Pure function of item metadata → list of post jobs. Inputs: item theme/tags,
recent ledger history. Logic:

- **Content type:** showcase / trend-faceless / mixed-by-ratio. Ratio is a
  config knob per account (e.g. 70/30 showcase/trend).
- **Account routing:** match item `theme_tags[]` against each account’s
  `niche_tags[]` in `accounts.json`; route to all matching accounts (capped).
- **Dedupe:** never route the same item to the same account twice (ledger
  check).

Output: `[{platform, account_handle, content_type, item_ref}]`.

### `social/video.py`

Given a post job + item assets, returns a path to a 9:16 MP4. Decides source:

- **Turntable** — deterministic 360° spin of the existing model/render.
  Free, no external API. Default for showcase when budget is tight.
- **Higgsfield (Seedance)** — animated vertical clip via the shared
  Higgsfield helper. Costs credits; **gated by a CFO budget check**.
  Preferred for trend/faceless and when budget allows.

Decision is explicit and logged so it’s auditable. Falls back to turntable
if Higgsfield is unavailable or over budget.

### `social/caption.py`

LLM-generated caption + hashtags + CTA, via the same Anthropic bridge the
other workers use. Tuned by `(platform, content_type)`:

- **showcase:** product framing + marketplace link/CTA.
- **trend/faceless:** hook-first, minimal product mention.
- Per-account **variation seed** so two niche accounts never emit
  near-identical captions for the same item.

### `social/adapters/`

One module per platform. Each exposes `publish(job, video_path, caption,
mode)` and resolves `mode` from the account config:

- `direct` — auto-publish via the platform’s official API.
  - TikTok: Content Posting API `video.publish` (direct-post) scope.
  - YouTube: Data API `videos.insert` (counts ~1600 quota units/upload).
- `draft` — push a **private draft** (TikTok inbox) via API for one-tap
  manual publish. Used pre-audit.
- `queue` — write `<outbox>/<account>/<timestamp>__<item>.mp4` plus a
  sidecar `.json` (caption, hashtags, link). Zero API dependency; works
  today.

Adapters read per-account OAuth tokens from the secure store. Each adapter
owns its platform rate/cadence limits.

### Ledger — `social_posts.jsonl`

Append-only, mirroring `outcomes.jsonl`. One record per post attempt:
`{ts, platform, account, item_ref, content_type, video_source, mode,
status, post_url?, cost_usd}`. Enforces caps + dedupe; feeds future
analytics.

## Configuration

### `accounts.json` (new; lives with worker config / project data)

```json
[
  {
    "platform": "tiktok",
    "handle": "scifi_minis",
    "niche_tags": ["sci-fi", "mech", "cyberpunk"],
    "token_ref": "tiktok_token_scifi_minis",
    "publish_mode": "queue",
    "daily_cap": 3,
    "content_ratio": { "showcase": 0.7, "trend": 0.3 }
  },
  {
    "platform": "youtube",
    "handle": "ChibiPrints",
    "niche_tags": ["cute", "chibi", "kawaii"],
    "token_ref": "youtube_token_chibiprints",
    "publish_mode": "queue",
    "daily_cap": 2,
    "content_ratio": { "showcase": 0.6, "trend": 0.4 }
  }
]
```

**Every account ships with `publish_mode: "queue"`.** Flip to `draft` then
`direct` per account as approvals clear — no code change.

### Secure store keys (new)

- `social_enabled` — master kill switch.
- `social_daily_cap` — global ceiling across accounts.
- `tiktok_client_key`, `tiktok_client_secret`.
- `tiktok_token_<handle>` — per account (OAuth result).
- `youtube_client_id`, `youtube_client_secret`.
- `youtube_token_<handle>` — per account (OAuth result).

## Autonomy & Safety

Fully-auto multi-account posting is the ban-risk surface, so:

- **Per-account daily cap** + **jittered minimum spacing** between posts.
- **Cross-account variation:** caption variation seed + per-account video
  choice so niche accounts never post near-duplicates (the top
  cross-account flag trigger). Niche-per-account routing already reduces
  overlap.
- **Budget gate:** no Higgsfield spend without a CFO budget OK.
- **Kill switch:** `social_enabled=false` halts all posting immediately.
- **Mode containment:** an account can never post above its configured
  `publish_mode` — a misconfigured token degrades to `queue`, never
  surprises you with a live post.

## Rollout (start-from-zero)

1. **Today — `queue`:** worker renders video + caption to per-account
   outbox folders. Manual upload. Proves content quality with no API gate.
2. **TikTok app created — `draft`:** flip TikTok accounts to push private
   inbox drafts via API.
3. **TikTok audit passes / YouTube OAuth + quota — `direct`:** flip to
   full auto-publish per account.

Each step is a per-account config flip. The implementation plan will include
the exact TikTok app-audit and YouTube OAuth/quota request steps as
documented setup tasks.

## Testing

Each module is unit-tested in isolation, mirroring existing workers’
`tests/`:

- `router` — tag→account mapping, content-type ratio, dedupe.
- `video` — source decision under budget on/off, Higgsfield-unavailable
  fallback (Higgsfield client mocked).
- `caption` — per-(platform,type) shaping, variation seed differs per
  account (LLM mocked).
- `adapters` — mode resolution; `queue` writes correct files; `direct`/
  `draft` call a fake API client with correct payloads; rate-limit guard.
- `agent` — kill switch + cap enforcement; ledger writes.

## Open Items for the Plan

- Exact event source: subscribe to publisher success, or poll
  `publisher_output.json` / outcomes? (Lean: same queue/event mechanism the
  other pipeline workers use via the supervisor.)
- Turntable render path: reuse `agent-factory-3d-preview` / existing render,
  or a headless render step inside `video.py`.
- Where `accounts.json` is surfaced in the Settings UI vs. file-only for v1.
```
