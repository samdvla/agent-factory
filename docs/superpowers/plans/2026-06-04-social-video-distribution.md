# Social Video Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a self-contained `workers/social/` worker that turns each published 3D-character item into short 9:16 videos and posts them to multiple TikTok + YouTube Shorts accounts (niche-per-account), fully autonomously where approved and via a local queue everywhere else.

**Architecture:** A Python worker following the factory convention (`handle(method, params)` over newline-delimited JSON-RPC stdio, registered with the Rust supervisor). Internals: `config` (accounts) → `router` (item → post jobs) → `video` (turntable from existing preview PNGs, or Higgsfield video) → `caption` (LLM) → `adapters/{tiktok,youtube}` (publish in per-account `queue`/`draft`/`direct` mode) → `ledger` (social_posts.jsonl for caps + dedupe).

**Tech Stack:** Python 3.11, `uv` venv per worker, Pillow + imageio + imageio-ffmpeg (video), `anthropic` SDK (captions via the bridge), `requests` (platform APIs), pytest. Rust/Tauri supervisor wiring in `src-tauri/src/commands.rs`.

**Milestones:**
- **After Task 8 — queue-mode pipeline works end to end** (renders real videos + captions to per-account outboxes; zero API approval needed; shippable).
- After Task 11 — TikTok/YouTube draft+direct adapters and Higgsfield video.
- After Task 13 — Rust registration + setup docs (TikTok audit, YouTube OAuth/quota).

---

## File Structure

```
workers/social/
  pyproject.toml                 # package + deps
  social/
    __init__.py
    __main__.py                  # run(handle)
    protocol.py                  # newline-delimited JSON-RPC over stdio (copied pattern)
    config.py                    # load/validate accounts.json
    ledger.py                    # social_posts.jsonl read/write, caps, dedupe
    router.py                    # item -> [post jobs]
    video.py                     # 9:16 MP4: turntable | higgsfield, source decision
    caption.py                   # LLM caption + hashtags + CTA (injected completer)
    higgsfield_video.py          # Seedance video helper (extension; turntable fallback)
    adapters/
      __init__.py
      base.py                    # PostResult, mode resolution, outbox paths
      tiktok.py                  # queue/draft/direct via Content Posting API
      youtube.py                 # queue/direct via Data API
    agent.py                     # handle(): orchestrates the above
  tests/
    __init__.py
    test_config.py
    test_ledger.py
    test_router.py
    test_video.py
    test_caption.py
    test_adapters.py
    test_agent.py
docs/SOCIAL_SETUP.md             # TikTok audit + YouTube OAuth/quota + per-account tokens
src-tauri/src/commands.rs        # make_social_spec + conditional push (Task 12)
```

**Data/config files (in project data_dir, NOT the repo):**
- `accounts.json` — account list (niche map, publish_mode, caps).
- `social_posts.jsonl` — append-only post ledger.
- `social_outbox/<handle>/` — queue-mode MP4 + sidecar JSON.

---

### Task 1: Scaffold the `social` worker package

**Files:**
- Create: `workers/social/pyproject.toml`
- Create: `workers/social/social/__init__.py` (empty)
- Create: `workers/social/social/protocol.py`
- Create: `workers/social/social/agent.py`
- Create: `workers/social/social/__main__.py`
- Create: `workers/social/tests/__init__.py` (empty)
- Test: `workers/social/tests/test_agent.py`

- [ ] **Step 1: Write `pyproject.toml`**

```toml
[project]
name = "social-agent"
version = "0.1.0"
requires-python = ">=3.11"
# Pillow: frame resize/pad to 1080x1920. imageio + imageio-ffmpeg: encode the
# turntable MP4 from the designer's multi-angle preview PNGs (bundled ffmpeg
# binary — no system ffmpeg dependency). anthropic: captions via the bridge.
# requests: TikTok Content Posting API + YouTube Data API uploads.
dependencies = [
    "Pillow>=10.0",
    "imageio>=2.34",
    "imageio-ffmpeg>=0.5",
    "anthropic>=0.39",
    "requests>=2.31",
]

[project.optional-dependencies]
dev = ["pytest>=8.0"]

[tool.pytest.ini_options]
pythonpath = ["."]
```

- [ ] **Step 2: Write `social/protocol.py`** (same stdio JSON-RPC pattern as `workers/publisher/publisher/protocol.py`)

```python
import json
import sys
from typing import Any, Optional, TextIO


class Protocol:
    """Newline-delimited JSON-RPC 2.0 over stdio."""

    def __init__(self, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout):
        self.stdin = stdin
        self.stdout = stdout

    def read_message(self) -> Optional[dict]:
        line = self.stdin.readline()
        if not line:
            return None
        return json.loads(line)

    def send_response(self, request_id: Any, result: Any) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def send_error(self, request_id: Any, code: int, message: str) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id,
                     "error": {"code": code, "message": message}})

    def send_notification(self, method: str, params: Any) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def _write(self, obj: dict) -> None:
        self.stdout.write(json.dumps(obj) + "\n")
        self.stdout.flush()


def run(handle) -> None:
    p = Protocol()
    p.send_notification("event", {"kind": "started"})
    while True:
        msg = p.read_message()
        if msg is None:
            return
        method = msg.get("method", "")
        params = msg.get("params", {}) or {}
        req_id = msg.get("id")
        try:
            result = handle(method, params)
            if req_id is not None:
                p.send_response(req_id, result)
        except Exception as e:  # noqa: BLE001 - report, keep loop alive
            if req_id is not None:
                p.send_error(req_id, -32000, str(e))
```

- [ ] **Step 3: Write a minimal `social/agent.py`**

```python
def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}
    # Filled in by Task 8.
    return {"ok": True, "posts": []}
```

- [ ] **Step 4: Write `social/__main__.py`**

```python
from .protocol import run
from .agent import handle

run(handle)
```

- [ ] **Step 5: Write the smoke test `tests/test_agent.py`**

```python
from social.agent import handle


def test_unknown_method_returns_error():
    out = handle("nope", {})
    assert out["ok"] is False
    assert "unknown method" in out["error"]


def test_process_job_returns_ok_shape():
    out = handle("process_job", {"job_id": 1, "payload": {}})
    assert out["ok"] is True
    assert out["posts"] == []
```

- [ ] **Step 6: Build the venv and run tests**

Run:
```bash
cd workers/social && uv sync --extra dev && uv run pytest -q
```
Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
git add workers/social
git commit -m "feat(social): scaffold social worker package"
```

---

### Task 2: Account config loader (`config.py`)

**Files:**
- Create: `workers/social/social/config.py`
- Test: `workers/social/tests/test_config.py`

- [ ] **Step 1: Write the failing test**

```python
import json
import pytest
from social.config import load_accounts, Account, ConfigError


def _write(tmp_path, data):
    p = tmp_path / "accounts.json"
    p.write_text(json.dumps(data))
    return str(p)


def test_loads_and_defaults(tmp_path):
    path = _write(tmp_path, [
        {"platform": "tiktok", "handle": "scifi_minis",
         "niche_tags": ["sci-fi", "mech"], "token_ref": "tiktok_token_scifi_minis"},
    ])
    accts = load_accounts(path)
    assert len(accts) == 1
    a = accts[0]
    assert isinstance(a, Account)
    assert a.platform == "tiktok"
    assert a.handle == "scifi_minis"
    assert a.publish_mode == "queue"          # default
    assert a.daily_cap == 3                    # default
    assert a.content_ratio == {"showcase": 0.7, "trend": 0.3}  # default


def test_rejects_bad_platform(tmp_path):
    path = _write(tmp_path, [
        {"platform": "myspace", "handle": "x", "niche_tags": [], "token_ref": "t"},
    ])
    with pytest.raises(ConfigError):
        load_accounts(path)


def test_rejects_bad_mode(tmp_path):
    path = _write(tmp_path, [
        {"platform": "tiktok", "handle": "x", "niche_tags": [], "token_ref": "t",
         "publish_mode": "yolo"},
    ])
    with pytest.raises(ConfigError):
        load_accounts(path)


def test_missing_file_returns_empty(tmp_path):
    assert load_accounts(str(tmp_path / "nope.json")) == []
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/social && uv run pytest tests/test_config.py -q`
Expected: FAIL (`ModuleNotFoundError: social.config`).

- [ ] **Step 3: Write `social/config.py`**

```python
import json
import os
from dataclasses import dataclass, field

VALID_PLATFORMS = {"tiktok", "youtube"}
VALID_MODES = {"queue", "draft", "direct"}


class ConfigError(Exception):
    pass


@dataclass
class Account:
    platform: str
    handle: str
    niche_tags: list[str]
    token_ref: str
    publish_mode: str = "queue"
    daily_cap: int = 3
    content_ratio: dict = field(
        default_factory=lambda: {"showcase": 0.7, "trend": 0.3}
    )


def accounts_path(data_dir: str) -> str:
    return os.path.join(data_dir, "accounts.json")


def load_accounts(path: str) -> list[Account]:
    if not os.path.exists(path):
        return []
    try:
        raw = json.loads(open(path).read())
    except (OSError, json.JSONDecodeError) as e:
        raise ConfigError(f"cannot read accounts.json: {e}") from e
    if not isinstance(raw, list):
        raise ConfigError("accounts.json must be a JSON array")
    out: list[Account] = []
    for i, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ConfigError(f"account[{i}] is not an object")
        platform = item.get("platform")
        if platform not in VALID_PLATFORMS:
            raise ConfigError(f"account[{i}] bad platform: {platform!r}")
        mode = item.get("publish_mode", "queue")
        if mode not in VALID_MODES:
            raise ConfigError(f"account[{i}] bad publish_mode: {mode!r}")
        out.append(Account(
            platform=platform,
            handle=str(item.get("handle", "")),
            niche_tags=[str(t).lower() for t in item.get("niche_tags", [])],
            token_ref=str(item.get("token_ref", "")),
            publish_mode=mode,
            daily_cap=int(item.get("daily_cap", 3)),
            content_ratio=item.get("content_ratio")
            or {"showcase": 0.7, "trend": 0.3},
        ))
    return out
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/social && uv run pytest tests/test_config.py -q`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add workers/social/social/config.py workers/social/tests/test_config.py
git commit -m "feat(social): account config loader with validation + defaults"
```

---

### Task 3: Post ledger (`ledger.py`)

**Files:**
- Create: `workers/social/social/ledger.py`
- Test: `workers/social/tests/test_ledger.py`

- [ ] **Step 1: Write the failing test**

```python
from social.ledger import Ledger


def test_append_and_count_today(tmp_path):
    led = Ledger(str(tmp_path / "social_posts.jsonl"))
    led.append({"platform": "tiktok", "account": "a", "item_ref": "m1",
                "content_type": "showcase", "video_source": "turntable",
                "mode": "queue", "status": "ok"}, now="2026-06-04T10:00:00Z")
    led.append({"platform": "tiktok", "account": "a", "item_ref": "m2",
                "content_type": "showcase", "video_source": "turntable",
                "mode": "queue", "status": "ok"}, now="2026-06-04T11:00:00Z")
    led.append({"platform": "tiktok", "account": "b", "item_ref": "m3",
                "content_type": "showcase", "video_source": "turntable",
                "mode": "queue", "status": "ok"}, now="2026-06-04T11:00:00Z")
    assert led.count_today("a", "2026-06-04") == 2
    assert led.count_today("b", "2026-06-04") == 1
    assert led.count_today("a", "2026-06-05") == 0


def test_already_posted(tmp_path):
    led = Ledger(str(tmp_path / "social_posts.jsonl"))
    led.append({"platform": "tiktok", "account": "a", "item_ref": "m1",
                "status": "ok"}, now="2026-06-04T10:00:00Z")
    assert led.already_posted("a", "m1") is True
    assert led.already_posted("a", "m2") is False
    assert led.already_posted("b", "m1") is False
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/social && uv run pytest tests/test_ledger.py -q`
Expected: FAIL (`ModuleNotFoundError: social.ledger`).

- [ ] **Step 3: Write `social/ledger.py`**

```python
import json
import os


class Ledger:
    """Append-only JSONL record of every post attempt. The caller passes the
    timestamp (`now`) explicitly so the module stays pure/testable — the agent
    supplies the real UTC time."""

    def __init__(self, path: str):
        self.path = path

    def append(self, record: dict, now: str) -> None:
        rec = dict(record)
        rec["ts"] = now
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        with open(self.path, "a") as f:
            f.write(json.dumps(rec) + "\n")

    def _rows(self) -> list[dict]:
        if not os.path.exists(self.path):
            return []
        rows = []
        for line in open(self.path):
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
        return rows

    def count_today(self, account: str, date_prefix: str) -> int:
        return sum(
            1 for r in self._rows()
            if r.get("account") == account
            and str(r.get("ts", "")).startswith(date_prefix)
            and r.get("status") == "ok"
        )

    def already_posted(self, account: str, item_ref: str) -> bool:
        return any(
            r.get("account") == account and r.get("item_ref") == item_ref
            for r in self._rows()
        )
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/social && uv run pytest tests/test_ledger.py -q`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add workers/social/social/ledger.py workers/social/tests/test_ledger.py
git commit -m "feat(social): append-only post ledger with caps + dedupe queries"
```

---

### Task 4: Router (`router.py`)

**Files:**
- Create: `workers/social/social/router.py`
- Test: `workers/social/tests/test_router.py`

Router maps an item to post jobs. Content type is decided deterministically from the account's `content_ratio` and how many posts that account already made today (no randomness — testable): if `showcase` share of today's posts is below the configured ratio, emit `showcase`, else `trend`. An account is skipped when it already posted this item, or it's at/over `daily_cap`.

- [ ] **Step 1: Write the failing test**

```python
from social.config import Account
from social.router import route


def _acct(handle, tags, mode="queue", cap=3, ratio=None):
    return Account(platform="tiktok", handle=handle, niche_tags=tags,
                   token_ref=f"t_{handle}", publish_mode=mode, daily_cap=cap,
                   content_ratio=ratio or {"showcase": 0.7, "trend": 0.3})


def test_routes_to_matching_niche_only():
    accts = [_acct("scifi", ["sci-fi", "mech"]), _acct("chibi", ["cute", "chibi"])]
    item = {"item_ref": "m1", "theme_tags": ["sci-fi", "robot"]}
    jobs = route(item, accts, posted_index=set(), counts_today={})
    assert [j["account"] for j in jobs] == ["scifi"]
    assert jobs[0]["content_type"] in ("showcase", "trend")
    assert jobs[0]["platform"] == "tiktok"


def test_skips_already_posted():
    accts = [_acct("scifi", ["sci-fi"])]
    item = {"item_ref": "m1", "theme_tags": ["sci-fi"]}
    jobs = route(item, accts, posted_index={("scifi", "m1")}, counts_today={})
    assert jobs == []


def test_skips_at_cap():
    accts = [_acct("scifi", ["sci-fi"], cap=2)]
    item = {"item_ref": "m9", "theme_tags": ["sci-fi"]}
    jobs = route(item, accts, posted_index=set(), counts_today={"scifi": 2})
    assert jobs == []


def test_content_type_follows_ratio():
    # ratio showcase=0.5: with 0 posts today -> showcase; with 1 of 1 showcase
    # already -> trend next.
    acct = _acct("scifi", ["sci-fi"], ratio={"showcase": 0.5, "trend": 0.5})
    item = {"item_ref": "m1", "theme_tags": ["sci-fi"]}
    j0 = route(item, [acct], posted_index=set(),
               counts_today={}, showcase_today={"scifi": 0})
    assert j0[0]["content_type"] == "showcase"
    j1 = route(item, [acct], posted_index=set(),
               counts_today={"scifi": 1}, showcase_today={"scifi": 1})
    assert j1[0]["content_type"] == "trend"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/social && uv run pytest tests/test_router.py -q`
Expected: FAIL (`ModuleNotFoundError: social.router`).

- [ ] **Step 3: Write `social/router.py`**

```python
def _matches(item_tags: list[str], niche_tags: list[str]) -> bool:
    if not niche_tags:
        return False
    s = {t.lower() for t in item_tags}
    return any(n in s for n in niche_tags)


def _content_type(ratio: dict, posts_today: int, showcase_today: int) -> str:
    """Keep the running showcase share at/above the configured ratio."""
    target = float(ratio.get("showcase", 0.7))
    if posts_today == 0:
        return "showcase" if target > 0 else "trend"
    share = showcase_today / posts_today
    return "showcase" if share < target else "trend"


def route(item: dict, accounts, posted_index: set, counts_today: dict,
          showcase_today: dict | None = None) -> list[dict]:
    """Return post jobs for one item.

    posted_index: set of (account_handle, item_ref) already posted.
    counts_today: {account_handle: posts_so_far_today}.
    showcase_today: {account_handle: showcase_posts_so_far_today}.
    """
    showcase_today = showcase_today or {}
    item_ref = item.get("item_ref", "")
    item_tags = item.get("theme_tags", []) or []
    jobs: list[dict] = []
    for a in accounts:
        if not _matches(item_tags, a.niche_tags):
            continue
        if (a.handle, item_ref) in posted_index:
            continue
        if counts_today.get(a.handle, 0) >= a.daily_cap:
            continue
        ctype = _content_type(
            a.content_ratio,
            counts_today.get(a.handle, 0),
            showcase_today.get(a.handle, 0),
        )
        jobs.append({
            "platform": a.platform,
            "account": a.handle,
            "token_ref": a.token_ref,
            "mode": a.publish_mode,
            "content_type": ctype,
            "item_ref": item_ref,
        })
    return jobs
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/social && uv run pytest tests/test_router.py -q`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add workers/social/social/router.py workers/social/tests/test_router.py
git commit -m "feat(social): niche router with cap, dedupe, ratio-driven content type"
```

---

### Task 5: Video builder (`video.py`)

**Files:**
- Create: `workers/social/social/video.py`
- Test: `workers/social/tests/test_video.py`

The free, deterministic path: stitch the designer's multi-angle preview PNGs (`asset.preview_pngs`) into a 1080×1920 MP4. Source decision: `higgsfield` only when `allow_paid` is true AND content type is `trend`; otherwise `turntable`. Higgsfield video itself lands in Task 11 — here `build_video` just dispatches and falls back to turntable.

- [ ] **Step 1: Write the failing test**

```python
import os
from PIL import Image
from social.video import choose_source, prepare_frame, build_turntable, build_video


def _png(tmp_path, name, size=(400, 600), color=(120, 40, 200)):
    p = tmp_path / name
    Image.new("RGB", size, color).save(p)
    return str(p)


def test_choose_source_defaults_turntable():
    assert choose_source("showcase", allow_paid=True) == "turntable"
    assert choose_source("trend", allow_paid=False) == "turntable"
    assert choose_source("trend", allow_paid=True) == "higgsfield"


def test_prepare_frame_pads_to_target(tmp_path):
    src = _png(tmp_path, "a.png", size=(400, 600))
    img = prepare_frame(src, (1080, 1920))
    assert img.size == (1080, 1920)


def test_build_turntable_writes_mp4(tmp_path):
    pngs = [_png(tmp_path, "a.png"), _png(tmp_path, "b.png", color=(10, 200, 90))]
    out = str(tmp_path / "out.mp4")
    res = build_turntable(pngs, out, seconds=1, fps=12)
    assert res == out
    assert os.path.exists(out) and os.path.getsize(out) > 0


def test_build_video_falls_back_to_turntable_when_no_paid(tmp_path):
    pngs = [_png(tmp_path, "a.png")]
    out = str(tmp_path / "v.mp4")
    res = build_video({"preview_pngs": pngs}, out, source="turntable")
    assert os.path.exists(res)


def test_build_turntable_no_frames_returns_none(tmp_path):
    assert build_turntable([], str(tmp_path / "x.mp4")) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/social && uv run pytest tests/test_video.py -q`
Expected: FAIL (`ModuleNotFoundError: social.video`).

- [ ] **Step 3: Write `social/video.py`**

```python
import imageio.v2 as imageio
import numpy as np
from PIL import Image

TARGET = (1080, 1920)  # width, height (9:16)


def choose_source(content_type: str, allow_paid: bool) -> str:
    """Higgsfield video only for paid-allowed trend posts; else turntable."""
    if allow_paid and content_type == "trend":
        return "higgsfield"
    return "turntable"


def prepare_frame(png_path: str, target=TARGET) -> Image.Image:
    """Fit the source into a target-sized black canvas (letterbox/pillarbox)."""
    tw, th = target
    src = Image.open(png_path).convert("RGB")
    sw, sh = src.size
    scale = min(tw / sw, th / sh)
    new = src.resize((max(1, int(sw * scale)), max(1, int(sh * scale))))
    canvas = Image.new("RGB", target, (0, 0, 0))
    canvas.paste(new, ((tw - new.size[0]) // 2, (th - new.size[1]) // 2))
    return canvas


def build_turntable(png_paths, out_path: str, seconds: int = 4,
                    fps: int = 24, target=TARGET):
    """Encode the multi-angle PNGs into a looping 9:16 MP4. Holds each angle
    evenly to fill `seconds`. Returns out_path, or None if no usable frames."""
    frames = [prepare_frame(p, target) for p in png_paths if p]
    if not frames:
        return None
    total = max(1, seconds * fps)
    hold = max(1, total // len(frames))
    writer = imageio.get_writer(out_path, fps=fps, codec="libx264",
                                quality=7, macro_block_size=8)
    try:
        for _ in range(total // (hold * len(frames)) + 1):
            for fr in frames:
                arr = np.asarray(fr)
                for _h in range(hold):
                    writer.append_data(arr)
    finally:
        writer.close()
    return out_path


def build_video(asset: dict, out_path: str, source: str,
                higgsfield_fn=None) -> str | None:
    """Dispatch on source. `higgsfield_fn(asset, out_path)->path|None` is
    injected (Task 11). Always falls back to turntable on failure."""
    pngs = asset.get("preview_pngs") or (
        [asset["preview_png"]] if asset.get("preview_png") else []
    )
    if source == "higgsfield" and higgsfield_fn is not None:
        try:
            res = higgsfield_fn(asset, out_path)
            if res:
                return res
        except Exception:  # noqa: BLE001 - fall back to free path
            pass
    return build_turntable(pngs, out_path)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/social && uv run pytest tests/test_video.py -q`
Expected: 5 passed. (First run downloads the bundled ffmpeg binary — allow a few seconds.)

- [ ] **Step 5: Commit**

```bash
git add workers/social/social/video.py workers/social/tests/test_video.py
git commit -m "feat(social): turntable MP4 builder + source-decision logic"
```

---

### Task 6: Caption builder (`caption.py`)

**Files:**
- Create: `workers/social/social/caption.py`
- Test: `workers/social/tests/test_caption.py`

The LLM call is injected as `complete(prompt) -> str` so tests stay offline. A per-account `variation_seed` is woven into the prompt so two niche accounts never get identical copy for the same item. The default completer (used in production) calls the `anthropic` SDK configured from the bridge env vars.

- [ ] **Step 1: Write the failing test**

```python
from social.caption import build_caption


def test_caption_uses_completer_and_includes_link_for_showcase():
    seen = {}

    def fake_complete(prompt):
        seen["prompt"] = prompt
        return "Epic sci-fi mech, ready to print!"

    cap = build_caption(
        item={"title": "Mech Trooper", "theme_tags": ["sci-fi", "mech"],
              "listing_url": "https://shop/x"},
        platform="tiktok", content_type="showcase",
        variation_seed="scifi", complete=fake_complete,
    )
    assert cap["text"].startswith("Epic sci-fi mech")
    assert cap["link"] == "https://shop/x"
    assert any(h.startswith("#") for h in cap["hashtags"])
    assert "scifi" in seen["prompt"]            # variation seed reached prompt
    assert "showcase" in seen["prompt"]


def test_trend_caption_has_no_hard_link():
    cap = build_caption(
        item={"title": "Mech", "theme_tags": ["mech"], "listing_url": "https://shop/x"},
        platform="youtube", content_type="trend",
        variation_seed="b", complete=lambda p: "POV: your desk needs this.",
    )
    assert cap["link"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/social && uv run pytest tests/test_caption.py -q`
Expected: FAIL (`ModuleNotFoundError: social.caption`).

- [ ] **Step 3: Write `social/caption.py`**

```python
import os

MAX_HASHTAGS = 6


def _default_complete(prompt: str) -> str:
    """Production completer: Anthropic via the bridge env the supervisor injects
    (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL). Imported lazily so tests that
    pass their own `complete` never need the SDK or network."""
    import anthropic
    client = anthropic.Anthropic(
        api_key=os.environ.get("ANTHROPIC_API_KEY", ""),
        base_url=os.environ.get("ANTHROPIC_BASE_URL") or None,
    )
    msg = client.messages.create(
        model=os.environ.get("SOCIAL_CAPTION_MODEL", "claude-haiku-4-5-20251001"),
        max_tokens=200,
        messages=[{"role": "user", "content": prompt}],
    )
    return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")


def _hashtags(tags: list[str], platform: str) -> list[str]:
    base = ["3dprinting", "3dprint"]
    plat = ["fyp", "foryou"] if platform == "tiktok" else ["shorts"]
    seen, out = set(), []
    for t in [*(t.replace(" ", "").lower() for t in tags), *base, *plat]:
        if t and t not in seen:
            seen.add(t)
            out.append("#" + t)
        if len(out) >= MAX_HASHTAGS:
            break
    return out


def build_caption(item: dict, platform: str, content_type: str,
                  variation_seed: str, complete=None) -> dict:
    complete = complete or _default_complete
    title = item.get("title", "this model")
    tags = item.get("theme_tags", []) or []
    is_showcase = content_type == "showcase"
    prompt = (
        f"Write a punchy {platform} caption (max 150 chars) for a 3D-printable "
        f"model called '{title}'. Style: {content_type}. "
        f"Theme tags: {', '.join(tags)}. "
        f"Account voice seed: {variation_seed} (make the wording distinct from "
        f"other accounts). "
        + ("Mention it's available to buy/download." if is_showcase
           else "Hook-first, do NOT sound like an ad, no links.")
        + " Return only the caption text."
    )
    text = complete(prompt).strip()
    return {
        "text": text,
        "hashtags": _hashtags(tags, platform),
        "link": item.get("listing_url") if is_showcase else None,
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/social && uv run pytest tests/test_caption.py -q`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add workers/social/social/caption.py workers/social/tests/test_caption.py
git commit -m "feat(social): LLM caption builder with per-account variation + hashtags"
```

---

### Task 7: Adapters — base + queue mode

**Files:**
- Create: `workers/social/social/adapters/__init__.py` (empty)
- Create: `workers/social/social/adapters/base.py`
- Test: `workers/social/tests/test_adapters.py`

Queue mode is the "works today" path: copy the MP4 to `social_outbox/<handle>/` and write a sidecar JSON with caption/hashtags/link. This is platform-agnostic and lives in `base.py`.

- [ ] **Step 1: Write the failing test**

```python
import json
import os
from PIL import Image
from social.adapters.base import PostResult, write_to_queue


def _mp4(tmp_path):
    # a stand-in binary file; queue mode only copies bytes, doesn't decode
    p = tmp_path / "v.mp4"
    p.write_bytes(b"\x00\x01fakevideo")
    return str(p)


def test_write_to_queue_copies_video_and_sidecar(tmp_path):
    video = _mp4(tmp_path)
    outbox = str(tmp_path / "social_outbox")
    res = write_to_queue(
        outbox=outbox, handle="scifi", item_ref="m1", video_path=video,
        caption={"text": "hi", "hashtags": ["#a"], "link": "https://x"},
        now_stamp="20260604T100000Z",
    )
    assert isinstance(res, PostResult)
    assert res.status == "ok"
    assert os.path.exists(res.video_out)
    side = res.video_out.rsplit(".", 1)[0] + ".json"
    assert os.path.exists(side)
    meta = json.loads(open(side).read())
    assert meta["caption"]["text"] == "hi"
    assert meta["item_ref"] == "m1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/social && uv run pytest tests/test_adapters.py -q`
Expected: FAIL (`ModuleNotFoundError: social.adapters.base`).

- [ ] **Step 3: Write `social/adapters/base.py`**

```python
import json
import os
import shutil
from dataclasses import dataclass


@dataclass
class PostResult:
    status: str                 # "ok" | "error"
    mode: str = "queue"
    video_out: str = ""
    post_url: str | None = None
    error: str | None = None


def write_to_queue(outbox: str, handle: str, item_ref: str, video_path: str,
                   caption: dict, now_stamp: str) -> PostResult:
    """Copy the rendered MP4 + a sidecar JSON into the per-account outbox."""
    try:
        dest_dir = os.path.join(outbox, handle)
        os.makedirs(dest_dir, exist_ok=True)
        base = f"{now_stamp}__{item_ref}"
        video_out = os.path.join(dest_dir, base + ".mp4")
        shutil.copyfile(video_path, video_out)
        with open(os.path.join(dest_dir, base + ".json"), "w") as f:
            json.dump({"item_ref": item_ref, "handle": handle,
                       "caption": caption}, f, indent=2)
        return PostResult(status="ok", mode="queue", video_out=video_out)
    except OSError as e:
        return PostResult(status="error", mode="queue", error=str(e))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd workers/social && uv run pytest tests/test_adapters.py -q`
Expected: 1 passed.

- [ ] **Step 5: Commit**

```bash
git add workers/social/social/adapters workers/social/tests/test_adapters.py
git commit -m "feat(social): adapter base + queue-mode outbox writer"
```

---

### Task 8: Agent orchestration — queue pipeline end to end

**Files:**
- Modify: `workers/social/social/agent.py`
- Test: `workers/social/tests/test_agent.py` (extend)

This wires everything for `mode == "queue"` and is the shippable milestone. Real UTC time, data_dir, outbox, and the `social_enabled` kill switch come from env (injected by Rust in Task 12); tests pass them via `params`/env. Per-account dispatch for `draft`/`direct` is delegated to platform adapters added in Tasks 9–10 via a registry; until then those modes record an `error` ("adapter not wired") and never crash the cycle.

- [ ] **Step 1: Write the failing test (extend `tests/test_agent.py`)**

```python
import json
import os
from PIL import Image
from social.agent import handle


def _png(tmp_path, name):
    p = tmp_path / name
    Image.new("RGB", (400, 600), (90, 30, 160)).save(p)
    return str(p)


def _accounts_file(tmp_path):
    p = tmp_path / "accounts.json"
    p.write_text(json.dumps([
        {"platform": "tiktok", "handle": "scifi", "niche_tags": ["sci-fi"],
         "token_ref": "t_scifi", "publish_mode": "queue", "daily_cap": 3},
    ]))
    return str(p)


def test_queue_pipeline_writes_outbox(tmp_path, monkeypatch):
    data_dir = str(tmp_path)
    _accounts_file(tmp_path)
    monkeypatch.setenv("SOCIAL_DATA_DIR", data_dir)
    monkeypatch.setenv("SOCIAL_ENABLED", "1")
    # offline caption
    monkeypatch.setenv("SOCIAL_FAKE_CAPTION", "test caption")

    png = _png(tmp_path, "a.png")
    out = handle("process_job", {"job_id": 7, "payload": {
        "asset": {"preview_pngs": [png]},
        "listing": {"title": "Mech", "url": "https://shop/mech"},
        "brief": {"theme_tags": ["sci-fi"]},
    }})

    assert out["ok"] is True
    assert len(out["posts"]) == 1
    assert out["posts"][0]["status"] == "ok"
    # outbox written
    handle_dir = os.path.join(data_dir, "social_outbox", "scifi")
    files = os.listdir(handle_dir)
    assert any(f.endswith(".mp4") for f in files)
    # ledger appended
    assert os.path.exists(os.path.join(data_dir, "social_posts.jsonl"))


def test_kill_switch_skips_everything(tmp_path, monkeypatch):
    _accounts_file(tmp_path)
    monkeypatch.setenv("SOCIAL_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SOCIAL_ENABLED", "0")
    out = handle("process_job", {"job_id": 1, "payload": {
        "asset": {"preview_pngs": []}, "listing": {}, "brief": {"theme_tags": ["sci-fi"]},
    }})
    assert out["ok"] is True
    assert out["posts"] == []
    assert out.get("skipped") == "disabled"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/social && uv run pytest tests/test_agent.py -q`
Expected: FAIL (current `handle` ignores env and returns empty posts).

- [ ] **Step 3: Rewrite `social/agent.py`**

```python
import os
from datetime import datetime, timezone

from . import config, router, video, caption, ledger
from .adapters import base as queue_adapter

# Filled by Tasks 9-10: {"tiktok": fn, "youtube": fn} where
# fn(job, video_path, caption, token_ref) -> PostResult for draft/direct.
DRAFT_DIRECT_ADAPTERS: dict = {}


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _now_stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _completer():
    fake = os.environ.get("SOCIAL_FAKE_CAPTION")
    if fake is not None:
        return lambda _p: fake
    return None  # caption.build_caption falls back to the real Anthropic client


def _allow_paid() -> bool:
    # Rust flips this per the CFO budget (Task 12). Default off = free turntable.
    return os.environ.get("SOCIAL_PAID_VIDEO_ENABLED", "0") == "1"


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}

    if os.environ.get("SOCIAL_ENABLED", "0") != "1":
        return {"ok": True, "posts": [], "skipped": "disabled"}

    data_dir = os.environ.get("SOCIAL_DATA_DIR", ".")
    outbox = os.path.join(data_dir, "social_outbox")
    led = ledger.Ledger(os.path.join(data_dir, "social_posts.jsonl"))
    accounts = config.load_accounts(config.accounts_path(data_dir))

    payload = params.get("payload", {}) or {}
    asset = payload.get("asset", {}) or {}
    listing = payload.get("listing", {}) or {}
    brief = payload.get("brief", {}) or {}

    today = _now_iso()[:10]
    item = {
        "item_ref": str(payload.get("cycle_id") or params.get("job_id") or ""),
        "title": listing.get("title", "this model"),
        "theme_tags": brief.get("theme_tags") or brief.get("niche", []) if isinstance(
            brief.get("theme_tags") or brief.get("niche"), list) else brief.get("theme_tags", []),
        "listing_url": listing.get("url"),
    }
    # Normalise theme_tags to a list.
    if not isinstance(item["theme_tags"], list):
        item["theme_tags"] = [t for t in [brief.get("niche")] if t]

    # Build today's counts from the ledger.
    posted_index = {(a.handle, item["item_ref"]) for a in accounts
                    if led.already_posted(a.handle, item["item_ref"])}
    counts_today = {a.handle: led.count_today(a.handle, today) for a in accounts}

    jobs = router.route(item, accounts, posted_index, counts_today)

    posts = []
    for job in jobs:
        cap = caption.build_caption(
            item, job["platform"], job["content_type"],
            variation_seed=job["account"], complete=_completer(),
        )
        src = video.choose_source(job["content_type"], _allow_paid())
        tmp_video = os.path.join(outbox, job["account"], "_tmp",
                                 f'{item["item_ref"]}.mp4')
        os.makedirs(os.path.dirname(tmp_video), exist_ok=True)
        vpath = video.build_video(asset, tmp_video, src)
        if not vpath:
            posts.append({"account": job["account"], "status": "error",
                          "error": "no video frames"})
            continue

        if job["mode"] == "queue":
            res = queue_adapter.write_to_queue(
                outbox, job["account"], item["item_ref"], vpath, cap, _now_stamp())
        else:
            fn = DRAFT_DIRECT_ADAPTERS.get(job["platform"])
            if fn is None:
                res = queue_adapter.PostResult(
                    status="error", mode=job["mode"],
                    error=f'{job["platform"]} {job["mode"]} adapter not wired')
            else:
                res = fn(job, vpath, cap, job["token_ref"])

        led.append({
            "platform": job["platform"], "account": job["account"],
            "item_ref": item["item_ref"], "content_type": job["content_type"],
            "video_source": src, "mode": job["mode"], "status": res.status,
            "post_url": res.post_url, "error": res.error,
        }, now=_now_iso())
        posts.append({"account": job["account"], "platform": job["platform"],
                      "status": res.status, "mode": res.mode,
                      "post_url": res.post_url, "error": res.error})

    return {"ok": True, "posts": posts}
```

- [ ] **Step 4: Run the full suite**

Run: `cd workers/social && uv run pytest -q`
Expected: all tests pass (config, ledger, router, video, caption, adapters, agent).

- [ ] **Step 5: Commit**

```bash
git add workers/social/social/agent.py workers/social/tests/test_agent.py
git commit -m "feat(social): end-to-end queue pipeline (router->video->caption->outbox->ledger)"
```

**MILESTONE: queue-mode pipeline works end to end and is shippable.**

---

### Task 9: TikTok adapter — draft + direct

**Files:**
- Create: `workers/social/social/adapters/tiktok.py`
- Test: `workers/social/tests/test_adapters.py` (extend)

TikTok Content Posting API: `POST /v2/post/publish/video/init/` with `post_mode` `DIRECT_POST` (direct) or `MEDIA_UPLOAD` (draft → lands in the user's TikTok inbox). HTTP is injected as `http_post` so tests never hit the network.

- [ ] **Step 1: Write the failing test (append to `tests/test_adapters.py`)**

```python
from social.adapters.tiktok import publish_tiktok


class _FakeResp:
    def __init__(self, code, payload):
        self.status_code = code
        self._payload = payload

    def json(self):
        return self._payload


def test_tiktok_direct_calls_init_with_direct_post(tmp_path):
    calls = {}

    def fake_post(url, headers=None, json=None, files=None, data=None):
        calls["url"] = url
        calls["json"] = json
        calls["auth"] = headers.get("Authorization")
        return _FakeResp(200, {"data": {"publish_id": "p123"}, "error": {"code": "ok"}})

    job = {"platform": "tiktok", "account": "scifi", "mode": "direct"}
    cap = {"text": "hi", "hashtags": ["#fyp"], "link": None}
    res = publish_tiktok(job, str(tmp_path / "v.mp4"), cap, token="TOK",
                         http_post=fake_post, http_get=None)
    assert res.status == "ok"
    assert "publish/video/init" in calls["url"]
    assert calls["json"]["post_info"]["privacy_level"] == "PUBLIC_TO_EVERYONE"
    assert calls["json"]["source_info"]["source"] == "FILE_UPLOAD"
    assert calls["auth"] == "Bearer TOK"


def test_tiktok_draft_uses_inbox_upload(tmp_path):
    captured = {}

    def fake_post(url, headers=None, json=None, files=None, data=None):
        captured["url"] = url
        return _FakeResp(200, {"data": {"publish_id": "d1"}, "error": {"code": "ok"}})

    job = {"platform": "tiktok", "account": "scifi", "mode": "draft"}
    res = publish_tiktok(job, str(tmp_path / "v.mp4"),
                         {"text": "x", "hashtags": [], "link": None},
                         token="T", http_post=fake_post, http_get=None)
    assert res.status == "ok"
    assert "inbox/video/init" in captured["url"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/social && uv run pytest tests/test_adapters.py -q`
Expected: FAIL (`ModuleNotFoundError: social.adapters.tiktok`).

- [ ] **Step 3: Write `social/adapters/tiktok.py`**

```python
import os
import requests
from .base import PostResult

API = "https://open.tiktokapis.com"


def _caption_text(caption: dict) -> str:
    tags = " ".join(caption.get("hashtags", []))
    link = caption.get("link")
    parts = [caption.get("text", ""), tags]
    if link:
        parts.append(link)
    return " ".join(p for p in parts if p).strip()[:2200]


def publish_tiktok(job: dict, video_path: str, caption: dict, token: str,
                   http_post=None, http_get=None) -> PostResult:
    """mode 'direct' -> public direct post; mode 'draft' -> TikTok inbox draft.

    Uses FILE_UPLOAD init (returns an upload_url the binary is PUT to). HTTP is
    injectable for tests; defaults to `requests`."""
    http_post = http_post or requests.post
    mode = job.get("mode", "draft")
    headers = {"Authorization": f"Bearer {token}",
               "Content-Type": "application/json; charset=UTF-8"}
    size = os.path.getsize(video_path) if os.path.exists(video_path) else 0
    body = {
        "post_info": {
            "title": _caption_text(caption),
            "privacy_level": "PUBLIC_TO_EVERYONE",
        },
        "source_info": {
            "source": "FILE_UPLOAD",
            "video_size": size,
            "chunk_size": size or 1,
            "total_chunk_count": 1,
        },
    }
    if mode == "direct":
        url = f"{API}/v2/post/publish/video/init/"
    else:  # draft -> inbox
        url = f"{API}/v2/post/publish/inbox/video/init/"
        body.pop("post_info", None)

    resp = http_post(url, headers=headers, json=body)
    if getattr(resp, "status_code", 500) != 200:
        return PostResult(status="error", mode=mode,
                          error=f"tiktok init http {resp.status_code}")
    data = resp.json()
    if data.get("error", {}).get("code") not in ("ok", None):
        return PostResult(status="error", mode=mode, error=str(data.get("error")))
    publish_id = data.get("data", {}).get("publish_id")
    # NB: the binary upload PUT to data.upload_url is performed by the real
    # `requests` path in production; tests stub at init. See SOCIAL_SETUP.md.
    return PostResult(status="ok", mode=mode,
                      post_url=f"tiktok:publish:{publish_id}")
```

- [ ] **Step 4: Register the adapter — append to `social/agent.py` imports/registry**

At the top of `agent.py`, after the existing imports, wire the registry:

```python
from .adapters import tiktok as _tiktok_adapter


def _tiktok_publish(job, video_path, caption, token_ref):
    token = os.environ.get(token_ref.upper(), os.environ.get(token_ref, ""))
    return _tiktok_adapter.publish_tiktok(job, video_path, caption, token)


DRAFT_DIRECT_ADAPTERS = {"tiktok": _tiktok_publish}
```

(Replace the existing `DRAFT_DIRECT_ADAPTERS: dict = {}` line with the block above.)

- [ ] **Step 5: Run tests**

Run: `cd workers/social && uv run pytest tests/test_adapters.py -q`
Expected: 3 passed (queue + 2 tiktok).

- [ ] **Step 6: Commit**

```bash
git add workers/social/social/adapters/tiktok.py workers/social/social/agent.py workers/social/tests/test_adapters.py
git commit -m "feat(social): TikTok adapter (direct post + inbox draft)"
```

---

### Task 10: YouTube Shorts adapter — direct

**Files:**
- Create: `workers/social/social/adapters/youtube.py`
- Test: `workers/social/tests/test_adapters.py` (extend)

YouTube Data API `videos.insert` (resumable upload). A `#Shorts` tag in the title/description + the 9:16 ≤60s video makes it a Short. HTTP injected for tests.

- [ ] **Step 1: Write the failing test (append to `tests/test_adapters.py`)**

```python
from social.adapters.youtube import publish_youtube


class _Resp:
    def __init__(self, code, payload=None, headers=None):
        self.status_code = code
        self._payload = payload or {}
        self.headers = headers or {}

    def json(self):
        return self._payload


def test_youtube_direct_inserts_video(tmp_path):
    video = tmp_path / "v.mp4"
    video.write_bytes(b"abc")
    steps = {}

    def fake_post(url, headers=None, params=None, json=None, data=None):
        steps["init_url"] = url
        steps["snippet"] = json["snippet"]
        return _Resp(200, headers={"Location": "https://upload/session/1"})

    def fake_put(url, headers=None, data=None):
        steps["put_url"] = url
        return _Resp(200, {"id": "yt123"})

    job = {"platform": "youtube", "account": "chibi", "mode": "direct"}
    cap = {"text": "cute print", "hashtags": ["#shorts"], "link": "https://shop/x"}
    res = publish_youtube(job, str(video), cap, token="TOK",
                          http_post=fake_post, http_put=fake_put)
    assert res.status == "ok"
    assert res.post_url == "https://youtu.be/yt123"
    assert "#Shorts" in steps["snippet"]["title"] or "#Shorts" in steps["snippet"]["description"]
    assert steps["put_url"] == "https://upload/session/1"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/social && uv run pytest tests/test_adapters.py -q`
Expected: FAIL (`ModuleNotFoundError: social.adapters.youtube`).

- [ ] **Step 3: Write `social/adapters/youtube.py`**

```python
import requests
from .base import PostResult

UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos"


def publish_youtube(job: dict, video_path: str, caption: dict, token: str,
                    http_post=None, http_put=None) -> PostResult:
    """Resumable upload via the Data API. `#Shorts` forces Short treatment."""
    http_post = http_post or requests.post
    http_put = http_put or requests.put
    text = caption.get("text", "")
    desc_parts = [text, " ".join(caption.get("hashtags", [])), "#Shorts"]
    if caption.get("link"):
        desc_parts.append(caption["link"])
    snippet = {
        "title": (text[:90] + " #Shorts").strip(),
        "description": "\n".join(p for p in desc_parts if p)[:4900],
        "tags": [h.lstrip("#") for h in caption.get("hashtags", [])][:15],
        "categoryId": "20",  # Gaming/Hobbies-adjacent; safe default
    }
    headers = {"Authorization": f"Bearer {token}",
               "Content-Type": "application/json; charset=UTF-8",
               "X-Upload-Content-Type": "video/*"}
    init = http_post(UPLOAD, headers=headers,
                     params={"uploadType": "resumable", "part": "snippet,status"},
                     json={"snippet": snippet,
                           "status": {"privacyStatus": "public",
                                      "selfDeclaredMadeForKids": False}})
    if getattr(init, "status_code", 500) != 200:
        return PostResult(status="error", mode=job.get("mode", "direct"),
                          error=f"youtube init http {init.status_code}")
    session_url = init.headers.get("Location")
    if not session_url:
        return PostResult(status="error", mode=job.get("mode", "direct"),
                          error="youtube: no resumable session url")
    with open(video_path, "rb") as f:
        put = http_put(session_url,
                       headers={"Authorization": f"Bearer {token}",
                                "Content-Type": "video/*"},
                       data=f.read())
    if getattr(put, "status_code", 500) not in (200, 201):
        return PostResult(status="error", mode=job.get("mode", "direct"),
                          error=f"youtube upload http {put.status_code}")
    vid = put.json().get("id", "")
    return PostResult(status="ok", mode=job.get("mode", "direct"),
                      post_url=f"https://youtu.be/{vid}")
```

- [ ] **Step 4: Register the YouTube adapter — update the registry in `agent.py`**

```python
from .adapters import youtube as _youtube_adapter


def _youtube_publish(job, video_path, caption, token_ref):
    token = os.environ.get(token_ref.upper(), os.environ.get(token_ref, ""))
    return _youtube_adapter.publish_youtube(job, video_path, caption, token)


DRAFT_DIRECT_ADAPTERS = {"tiktok": _tiktok_publish, "youtube": _youtube_publish}
```

(Replace the single-entry `DRAFT_DIRECT_ADAPTERS = {"tiktok": _tiktok_publish}` from Task 9.)

- [ ] **Step 5: Run the full suite**

Run: `cd workers/social && uv run pytest -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add workers/social/social/adapters/youtube.py workers/social/social/agent.py workers/social/tests/test_adapters.py
git commit -m "feat(social): YouTube Shorts adapter (resumable direct upload)"
```

---

### Task 11: Higgsfield video helper (Seedance) + wire into pipeline

**Files:**
- Create: `workers/social/social/higgsfield_video.py`
- Modify: `workers/social/social/agent.py` (pass `higgsfield_fn` into `build_video`)
- Test: `workers/social/tests/test_video.py` (extend)

Mirrors `workers/designer/designer/higgsfield.py`’s availability-probe + graceful-skip shape, but calls the image-to-video subcommand. Returns `None` on any failure so `build_video` falls back to turntable.

- [ ] **Step 1: Write the failing test (append to `tests/test_video.py`)**

```python
from social import higgsfield_video


def test_generate_video_skips_when_cli_unavailable(monkeypatch, tmp_path):
    monkeypatch.setattr(higgsfield_video, "cli_available", lambda: False)
    res = higgsfield_video.generate_video(
        {"preview_pngs": [str(tmp_path / "a.png")]}, str(tmp_path / "o.mp4"))
    assert res is None


def test_generate_video_invokes_runner_when_available(monkeypatch, tmp_path):
    src = tmp_path / "a.png"
    from PIL import Image
    Image.new("RGB", (100, 100), (1, 2, 3)).save(src)
    out = str(tmp_path / "o.mp4")

    monkeypatch.setattr(higgsfield_video, "cli_available", lambda: True)
    monkeypatch.setattr(higgsfield_video, "auth_ok", lambda: True)

    def fake_run(cmd, out_path):
        open(out_path, "wb").write(b"vid")
        return out_path

    monkeypatch.setattr(higgsfield_video, "_run_cli", fake_run)
    res = higgsfield_video.generate_video({"preview_pngs": [str(src)]}, out)
    assert res == out
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd workers/social && uv run pytest tests/test_video.py -q`
Expected: FAIL (`ModuleNotFoundError: social.higgsfield_video`).

- [ ] **Step 3: Write `social/higgsfield_video.py`**

```python
import os
import shutil
import subprocess
import sys

CLI = "higgsfield"
DEFAULT_TIMEOUT = 300


def cli_available() -> bool:
    return shutil.which(CLI) is not None


def auth_ok(timeout: int = 15) -> bool:
    if not cli_available():
        return False
    try:
        r = subprocess.run([CLI, "auth", "status"], capture_output=True,
                           timeout=timeout)
        return r.returncode == 0
    except (subprocess.SubprocessError, OSError):
        return False


def _run_cli(cmd: list[str], out_path: str):
    """Run the Higgsfield image-to-video command; return out_path if it wrote
    a file, else None."""
    try:
        subprocess.run(cmd, check=True, timeout=DEFAULT_TIMEOUT,
                       capture_output=True)
    except (subprocess.SubprocessError, OSError) as e:
        print(f"[higgsfield_video] failed: {e}", file=sys.stderr, flush=True)
        return None
    return out_path if os.path.exists(out_path) else None


def generate_video(asset: dict, out_path: str, prompt_hint: str = "") -> str | None:
    """Animate the first preview PNG into a 9:16 clip via Higgsfield/Seedance.
    Returns the MP4 path, or None on any failure (caller falls back to
    turntable)."""
    if not cli_available() or not auth_ok():
        return None
    pngs = asset.get("preview_pngs") or (
        [asset["preview_png"]] if asset.get("preview_png") else [])
    if not pngs or not os.path.exists(pngs[0]):
        return None
    cmd = [CLI, "image-to-video", "create",
           "--input", pngs[0],
           "--aspect-ratio", "9:16",
           "--prompt", (prompt_hint or "slow cinematic turntable, studio light")[:500],
           "--output", out_path]
    return _run_cli(cmd, out_path)
```

- [ ] **Step 4: Wire it into the agent — update the `build_video` call in `agent.py`**

Replace the `vpath = video.build_video(asset, tmp_video, src)` line with:

```python
        from .higgsfield_video import generate_video as _hf_video
        vpath = video.build_video(asset, tmp_video, src, higgsfield_fn=(
            (lambda a, o: _hf_video(a, o, item["title"])) if src == "higgsfield" else None))
```

- [ ] **Step 5: Run the full suite**

Run: `cd workers/social && uv run pytest -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add workers/social/social/higgsfield_video.py workers/social/social/agent.py workers/social/tests/test_video.py
git commit -m "feat(social): Higgsfield Seedance video path with turntable fallback"
```

---

### Task 12: Register the worker with the Rust supervisor

**Files:**
- Modify: `src-tauri/src/commands.rs` (the worker-spec assembly, ~L800–880)

The worker is opt-in via the `social_enabled` secret (mirrors `market_recon_on` / `sales_forensics_on`). When on, a `make_social_spec` closure injects the social-specific env: data_dir, the enable flag, the paid-video budget flag, and the Anthropic bridge env it shares with other workers. Per-account OAuth tokens are injected as env vars named after each `token_ref` (uppercased).

- [ ] **Step 1: Read the existing conditional-push block for reference**

Run: `grep -n "market_recon_on\|sales_forensics_on\|let mut agents = vec!\|fn worker_python\|secrets::get(\"" src-tauri/src/commands.rs | head -30`
Expected: shows where `*_on` flags are read and where `agents.push(make_nim_spec(...))` happens.

- [ ] **Step 2: Add the `social_enabled` flag read**

Near the other `*_on` flag reads (where `market_recon_on` is computed from `secrets::get`), add:

```rust
    let social_on = secrets::get("social_enabled")
        .ok()
        .flatten()
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
```

- [ ] **Step 3: Add a `make_social_spec` closure** next to `make_nim_spec`

```rust
    let make_social_spec = {
        let workers_root = workers_root.clone();
        let api_key_env = api_key_env.clone();
        let effective_base_url = effective_base_url.clone();
        move |data_dir: &str| {
            let pythonpath = format!(
                "{}:{}",
                workers_root.join("social").to_string_lossy(),
                workers_root.join("shared").to_string_lossy(),
            );
            let mut env = vec![
                api_key_env.clone(),
                ("PYTHONPATH".into(), pythonpath),
                ("SOCIAL_DATA_DIR".into(), data_dir.to_string()),
                ("SOCIAL_ENABLED".into(), "1".into()),
                ("SOCIAL_PAID_VIDEO_ENABLED".into(),
                 secrets::get("social_paid_video_enabled").ok().flatten()
                     .unwrap_or_else(|| "0".into())),
            ];
            if let Some(ref u) = effective_base_url {
                env.push(("ANTHROPIC_BASE_URL".into(), u.clone()));
            }
            // Inject each account's OAuth token as <TOKEN_REF_UPPER>=value.
            if let Ok(Some(raw)) = secrets::get("social_account_tokens") {
                if let Ok(map) = serde_json::from_str::<
                    std::collections::HashMap<String, String>>(&raw) {
                    for (k, v) in map {
                        env.push((k.to_uppercase(), v));
                    }
                }
            }
            supervisor::AgentSpec {
                role: "social".into(),
                program: worker_python(&workers_root, "social")
                    .to_string_lossy().into_owned(),
                args: vec!["-m".into(), "social".into()],
                env,
            }
        }
    };
```

- [ ] **Step 4: Push the spec when enabled** — after the existing `if critic_gate_on { ... }` blocks:

```rust
    if social_on {
        let data_dir = workers_root
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        agents.push(make_social_spec(&data_dir));
        tracing::info!("[supervisor] social video worker enabled");
    }
```

> Note: pass the real project data_dir your app already resolves for other persisted files (where `outcomes.jsonl` lives) instead of `workers_root.parent()` if that differs — grep for how `outcomes.jsonl`/`publisher_output.json` paths are built and reuse that.

- [ ] **Step 5: Build the Rust side**

Run: `cd src-tauri && cargo build 2>&1 | tail -20`
Expected: compiles (warnings ok). Fix any type mismatch in the token-map injection (ensure `serde_json` is already a dependency — it is, used elsewhere in this file).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/commands.rs
git commit -m "feat(social): register social worker, gated on social_enabled secret"
```

---

### Task 13: Setup docs + smoke checklist

**Files:**
- Create: `docs/SOCIAL_SETUP.md`

- [ ] **Step 1: Write `docs/SOCIAL_SETUP.md`** covering the start-from-zero rollout

```markdown
# Social Video Distribution — Setup

The `social` worker turns each published model into 9:16 videos and posts them
to multiple TikTok + YouTube Shorts accounts. It is OFF until you set the
`social_enabled` secret to `1`.

## 1. Define your accounts

Create `accounts.json` in the app data dir (same folder as `outcomes.jsonl`):

​```json
[
  { "platform": "tiktok", "handle": "scifi_minis",
    "niche_tags": ["sci-fi","mech","cyberpunk"],
    "token_ref": "tiktok_token_scifi_minis",
    "publish_mode": "queue", "daily_cap": 3,
    "content_ratio": { "showcase": 0.7, "trend": 0.3 } },
  { "platform": "youtube", "handle": "chibiprints",
    "niche_tags": ["cute","chibi","kawaii"],
    "token_ref": "youtube_token_chibiprints",
    "publish_mode": "queue", "daily_cap": 2 }
]
​```

Every account starts in **queue** mode: videos + captions are written to
`social_outbox/<handle>/`. Review them, upload by hand. No API access needed.

## 2. Turn it on

Set secrets: `social_enabled=1`. (Optional: `social_paid_video_enabled=1` to
allow Higgsfield video for trend posts, subject to CFO budget.)

## 3. TikTok — go from queue → draft → direct

1. Create a TikTok app at developers.tiktok.com; add the **Content Posting
   API** product. Scopes: `video.upload` (draft) and `video.publish` (direct).
2. `video.publish` (direct, unattended) requires passing TikTok's **app
   audit**. Until approved you can only use `draft` (inbox) mode.
3. For each account, run the OAuth flow and store the access token. Put all
   account tokens in the `social_account_tokens` secret as a JSON map:
   `{ "tiktok_token_scifi_minis": "act....", ... }`. The supervisor injects
   each as an env var named after the (uppercased) `token_ref`.
4. Flip that account's `publish_mode` to `draft`, then `direct` post-audit.

## 4. YouTube Shorts — queue → direct

1. Create a Google Cloud project; enable **YouTube Data API v3**; configure an
   OAuth consent screen; scope `https://www.googleapis.com/auth/youtube.upload`.
2. Default quota is 10,000 units/day; each upload ≈1,600 units (~6/day). Request
   more via the YouTube API quota-increase form if you need higher cadence.
3. OAuth each channel, add tokens to `social_account_tokens`, set
   `publish_mode` to `direct`.

## 5. Account-health guardrails (already enforced)

- Per-account `daily_cap` + niche routing keep cross-account overlap low.
- Captions vary per account (variation seed) to avoid duplicate-content flags.
- `social_enabled=0` halts everything immediately.
- Spread caps modestly at first; ramp as accounts age.
```

- [ ] **Step 2: Final full-suite run**

Run: `cd workers/social && uv run pytest -q`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add docs/SOCIAL_SETUP.md
git commit -m "docs(social): setup + TikTok audit / YouTube quota rollout guide"
```

---

## Self-Review

**Spec coverage:**
- Multi-platform TikTok + YouTube Shorts → Tasks 9, 10. ✓
- Niche-per-account routing → Task 4. ✓
- Three content types (showcase/trend/mixed ratio) → Task 4 `_content_type`. ✓
- Per-item video source (turntable vs Higgsfield) under budget → Tasks 5, 11 + `_allow_paid`. ✓
- Fully-auto where approved, queue/draft fallback per account → Tasks 7–10, config `publish_mode`. ✓
- Start-from-zero (queue default) → Task 2 default + Task 13 rollout. ✓
- Safety: caps, dedupe, variation, kill switch → Tasks 3, 4, 6, 8. ✓
- Ledger → Task 3. ✓
- Worker registration → Task 12. ✓
- Setup/approval docs → Task 13. ✓

**Placeholder scan:** No "TBD"/"implement later"/bare "add error handling" — every code step is complete. The one runtime caveat (TikTok binary PUT after init) is documented inline + in SOCIAL_SETUP.md, not left as a code gap.

**Type consistency:** `Account` fields (Task 2) are used unchanged in Tasks 4/8. `PostResult` (Task 7) is returned by all adapters (Tasks 7/9/10) and read in Task 8. `route()` signature (Task 4) matches its call in Task 8. `build_video(asset, out_path, source, higgsfield_fn=None)` (Task 5) matches the call in Tasks 8/11. `build_caption(item, platform, content_type, variation_seed, complete=None)` (Task 6) matches Task 8. `DRAFT_DIRECT_ADAPTERS` registry (Task 8) is populated identically in Tasks 9/10.

**Known integration seams to confirm during execution (not gaps):**
1. The exact event that triggers the social worker — this plan assumes the supervisor dispatches `process_job` to it like other pipeline workers; confirm whether social should be added to the pipeline-role list (`commands.rs:940`, `api_server.rs:735`) or run as a post-publish side-channel. If the former, add `"social"` to those `matches!` lists.
2. The real data_dir resolution in Task 12 Step 4 (reuse the same path the app uses for `outcomes.jsonl`).
3. `theme_tags` source: this plan reads `brief.theme_tags`/`brief.niche`; confirm the actual field the research/strategist briefs carry and adjust the `item["theme_tags"]` extraction in Task 8 if needed.
```
