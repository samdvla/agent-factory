import json
import os
import sys
import urllib.request
import urllib.error
import uuid
from collections import defaultdict

MODEL = "claude-opus-4-7"
MAX_TOKENS = 400

ANTHROPIC_BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")


def _retry_request(req: urllib.request.Request, timeout: int = 60, max_attempts: int = 5) -> str:
    """POST with exponential backoff. Retries on 5xx and URLError. Does NOT retry on 4xx.
    Returns the response body as utf-8 string. Raises on final failure.

    HTTP 529 is Anthropic's load-shedding signal — typical overload events
    last 30s-2min, so the legacy 1s/2s/4s schedule (~7s total) blew right
    through them and failed real jobs. 529 gets its own longer schedule
    (8s/15s/30s/60s/60s). Other 5xx + URLError keep the fast schedule.

    _retry_request: see workers/research/tests/test_research.py for behavior coverage.
    """
    import time as _time
    overload_delays = (8, 15, 30, 60, 60)
    fast_delays = (1, 2, 4, 8, 16)
    last_exc: Exception | None = None
    for attempt in range(max_attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            last_exc = e
            # Capture the response body once; HTTPError\'s default
            # str() is just "HTTP Error N: Reason" and the actual
            # diagnostic lives in the body that Anthropic returns.
            try:
                _body = e.read().decode("utf-8", errors="replace")
                if _body:
                    e.msg = f"{e.msg}: {_body[:600]}"
            except Exception:
                pass
            if e.code == 529 and attempt < max_attempts - 1:
                delay = overload_delays[min(attempt, len(overload_delays) - 1)]
                print(
                    f"[retry] HTTP 529 (Anthropic overloaded) attempt "
                    f"{attempt+1}/{max_attempts}; sleeping {delay}s",
                    file=sys.stderr, flush=True,
                )
                _time.sleep(delay)
                continue
            if 500 <= e.code < 600 and attempt < max_attempts - 1:
                delay = fast_delays[min(attempt, len(fast_delays) - 1)]
                print(f"[retry] HTTP {e.code} attempt {attempt+1}/{max_attempts}; sleeping {delay}s", file=sys.stderr, flush=True)
                _time.sleep(delay)
                continue
            raise
        except urllib.error.URLError as e:
            last_exc = e
            if attempt < max_attempts - 1:
                delay = fast_delays[min(attempt, len(fast_delays) - 1)]
                print(f"[retry] URLError {e} attempt {attempt+1}/{max_attempts}; sleeping {delay}s", file=sys.stderr, flush=True)
                _time.sleep(delay)
                continue
            raise
    if last_exc:
        raise last_exc
    raise RuntimeError("retry: unreachable")

def _use_json_prefill() -> bool:
    """Anthropic's Messages API supports assistant prefill (seeding the
    assistant turn with "{" to force structured JSON output). Some bridge
    proxies normalize / strip the trailing assistant message and reject the
    request with HTTP 400. Default ON; flip OFF when ANTHROPIC_BASE_URL
    points at anything other than Anthropic's direct host."""
    import os as _os
    url = _os.environ.get("ANTHROPIC_BASE_URL", "").strip()
    if not url:
        return True
    return "api.anthropic.com" in url


def _messages_for_json_call(user_content) -> list[dict]:
    """Build the messages array for a JSON-emitting Anthropic call. Adds the
    assistant prefill only when the API supports it (direct Anthropic, not
    a bridge proxy).

    `user_content` may be a plain string (legacy) OR a list of content
    blocks (multimodal: image + text blocks). Anthropic's Messages API
    accepts both shapes on the same field.
    """
    msgs: list[dict] = [{"role": "user", "content": user_content}]
    if _use_json_prefill():
        msgs.append({"role": "assistant", "content": "{"})
    return msgs


OUTCOMES_TAIL_LIMIT = 30
NICHE_MIN_OUTCOMES = 5
NICHE_MIN_SAMPLES_PER_BUCKET = 2

# How many recent drafts to scan for anti-concentration. Even WITHOUT sales
# data, repeated drafts in one niche/product mean we're over-exploiting.
DRAFTS_TAIL_LIMIT = 20

# Product-type rotation: cycle across these so we sample market breadth
# instead of dumping 50 stickers nobody bought. Order = our preferred
# default order when none has been tried yet.
ROTATION_PRODUCT_TYPES = ["sticker", "digital_print", "poster", "mug", "tee"]

# Natural-language labels for product_type values — used in conversation
# messages so the floor reads like agents talking, not enum dumps.
_PRODUCT_TYPE_LABELS = {
    "stl_file": "STL file",
    "3d_model": "3D model",
    "sticker": "sticker design",
    "digital_print": "digital print",
    "poster": "poster design",
    "mug": "mug design",
    "tee": "tee design",
}


def _humanize_product_type(pt: str | None) -> str:
    if not pt:
        return "next product"
    return _PRODUCT_TYPE_LABELS.get(pt, pt.replace("_", " "))
# 3D types are only included in rotation when TRIPO_API_KEY/MESHY_API_KEY is
# set in the worker env. The designer would fail otherwise, wasting an
# orchestrator token spend on a niche we can't actually produce.
TRIPO_PRODUCT_TYPES = ["stl_file", "3d_model"]


def _shop_focus() -> str:
    """Current shop_focus mode: '3d_only' | '2d_only' | 'mixed'.
    Default '3d_only' — the user pivoted away from 2D printables after seeing
    Tripo/Meshy output quality and zero sales on 58 ADHD-planner drafts."""
    v = os.environ.get("SHOP_FOCUS", "").strip().lower()
    if v in {"3d_only", "2d_only", "mixed"}:
        return v
    return "3d_only"


def _parse_loose_json_object(text: str) -> dict:
    """Parse the first JSON object out of `text`, tolerating fences, trailing
    prose, and the most common Claude-emitted JSON breakage. Three layers:

      1. Strip leading markdown fences.
      2. raw_decode from the first '{' — handles trailing prose for free.
      3. On JSONDecodeError inside the JSON, attempt a small set of repairs
         (trailing-comma strip, newline-in-string normalization) and retry.

    Raises ValueError with a 240-char preview when no JSON exists at all, or
    when repair attempts still fail. Both the preview AND the failing
    parser-error location are logged to stderr so they show up in LiveLog.
    """
    s = text.strip()
    if s.startswith("```"):
        nl = s.find("\n")
        s = s[nl + 1 :] if nl != -1 else s
    start = s.find("{")
    if start == -1:
        preview = text.strip().replace("\n", " ")[:240]
        print(
            f"[parse] no JSON object found; first 240 chars of response: {preview!r}",
            file=sys.stderr, flush=True,
        )
        raise ValueError(
            f"no JSON object found in response (got prose). first 240 chars: {preview!r}"
        )
    body = s[start:]
    try:
        obj, _end = json.JSONDecoder().raw_decode(body)
    except json.JSONDecodeError as first_err:
        repaired = _repair_json_text(body)
        try:
            obj, _end = json.JSONDecoder().raw_decode(repaired)
            print(
                f"[parse] repaired JSON after initial error: {first_err}",
                file=sys.stderr, flush=True,
            )
        except json.JSONDecodeError as second_err:
            point = max(0, first_err.pos - 60)
            snippet = body[point : first_err.pos + 60].replace("\n", " ")
            print(
                f"[parse] JSON repair failed. first={first_err} second={second_err}; "
                f"body near pos {first_err.pos}: ...{snippet}...",
                file=sys.stderr, flush=True,
            )
            raise first_err
    if not isinstance(obj, dict):
        raise ValueError(f"expected JSON object, got {type(obj).__name__}")
    return obj


def _repair_json_text(text: str) -> str:
    """Best-effort repair of common Claude-emitted JSON breakage.

    Handles:
      • trailing commas before } or ]
      • CR/LF inside string values (replaced with single spaces)
      • lone backslashes that aren't starting a valid escape sequence
    Not a complete JSON5/json-repair; just covers the cases we've actually
    seen Haiku/Sonnet emit when the design_direction paragraph gets long.
    """
    import re as _re
    # 1. Strip trailing commas before } or ].
    out = _re.sub(r",(\s*[}\]])", r"\1", text)
    # 2. Normalize newlines inside string values: replace any \n that lives
    #    between an opening " and the next " on a different line with a space.
    #    Conservative — only triggers when we see a newline directly inside
    #    a string-typed value.
    def _collapse_newlines_in_strings(s: str) -> str:
        result = []
        i = 0
        in_string = False
        escape = False
        while i < len(s):
            c = s[i]
            if in_string:
                if escape:
                    result.append(c)
                    escape = False
                elif c == "\\":
                    result.append(c)
                    escape = True
                elif c == '"':
                    result.append(c)
                    in_string = False
                elif c in ("\n", "\r"):
                    result.append(" ")  # collapse newline inside string
                else:
                    result.append(c)
            else:
                result.append(c)
                if c == '"':
                    in_string = True
            i += 1
        return "".join(result)
    out = _collapse_newlines_in_strings(out)
    # 3. Fix lone backslashes that aren't starting a valid escape.
    out = _re.sub(r'\\(?!["\\/bfnrtu])', r"\\\\", out)
    return out


CHARACTER_POOLS_ALL = ("original_anime", "mythology", "own_universe", "popular_ip")
# "safe" rotates across only the zero-IP-risk tiers, useful while the
# publish-time IP gate (Phase 2) is still unbuilt. The publisher would
# otherwise auto-leak a popular-IP draft to Etsy.
CHARACTER_POOLS_SAFE = ("original_anime", "mythology", "own_universe")


def _character_pool() -> str:
    """Which character archetype tiers the orchestrator may mine.
    Returns one of CHARACTER_POOLS_ALL or 'all' / 'safe'. Default 'all'."""
    v = os.environ.get("CHARACTER_POOL", "").strip().lower()
    if v in CHARACTER_POOLS_ALL or v in {"all", "safe"}:
        return v
    return "all"


def _enabled_pools() -> tuple[str, ...]:
    pool = _character_pool()
    if pool == "all":
        return CHARACTER_POOLS_ALL
    if pool == "safe":
        return CHARACTER_POOLS_SAFE
    return (pool,)


def _data_dir() -> str:
    """Resolve the agent-factory data dir at call time so tests can monkey-patch HOME."""
    return os.path.expanduser("~/.agent-factory")


def _prompts_path() -> str:
    return os.path.join(_data_dir(), "prompts.json")


def _rejections_path() -> str:
    return os.path.join(_data_dir(), "rejections.json")


def _load_rejection_avoid_list(limit: int = 12) -> list[dict]:
    """Read the rejection learning file written by Rust on every operator
    Reject action. Returns up to `limit` recent entries — each `{title, niche}`.
    Best-effort: missing or malformed file returns []. Mirrors
    workers/research/research/agent.py::_load_rejection_avoid_list — the
    research worker already consumes this list, but research only ELABORATES
    on niches the orchestrator already picked. So if the orchestrator doesn't
    also read rejections, the operator keeps seeing nearby variants of the
    direction they just rejected."""
    try:
        with open(_rejections_path()) as f:
            data = json.load(f)
        arr = data.get("rejections")
        if not isinstance(arr, list):
            return []
        out: list[dict] = []
        for item in arr[:limit]:
            if not isinstance(item, dict):
                continue
            title = item.get("title")
            niche = item.get("niche")
            if isinstance(title, str) and title.strip():
                out.append({
                    "title": title.strip(),
                    "niche": niche if isinstance(niche, str) else None,
                })
        return out
    except Exception:
        return []


def _append_rejection_avoid_block(system_prompt: str) -> str:
    """Append an AVOID block listing recently rejected niches/titles so the
    orchestrator steers away from re-picking them. No-op when the file is
    empty or missing.

    Inserted into the system prompt BEFORE the operator-steer block — that
    way an explicit operator steer (e.g. 'try Lovecraftian again, but as
    jewelry instead of dice towers') can supersede a stale rejection."""
    entries = _load_rejection_avoid_list()
    if not entries:
        return system_prompt
    lines: list[str] = []
    for e in entries:
        niche = e.get("niche")
        title = e["title"]
        if niche:
            lines.append(f'- {niche} — "{title[:80]}"')
        else:
            lines.append(f'- "{title[:80]}"')
    block = (
        "AVOID — the operator already rejected these ideas. Pick a different "
        "niche AND a meaningfully different angle from each entry. Treat the "
        "list as forbidden territory, not a starting point:\n"
        + "\n".join(lines)
    )
    return system_prompt.rstrip() + "\n\n" + block


def _load_strategist_notes() -> str | None:
    """Read the orchestrator-tuning notes written by the meta-strategist
    (workers/strategist/strategist/agent.py:_process_orchestrator_tuning).
    Returns None when missing or malformed. Notes are advisory — appended
    as the last block of the user prompt, but never replace the dynamic
    system-prompt assembly."""
    try:
        with open(_prompts_path()) as f:
            data = json.load(f)
        notes = data.get("orchestrator", {}).get("strategist_notes")
        if isinstance(notes, str) and notes.strip():
            return notes.strip()
    except Exception:
        pass
    return None


def _load_operator_steers(role: str) -> list[dict]:
    """Read operator standing instructions for `role` from prompts.json.

    Returns a normalized list of `{"text": str, "image_paths": list[str]}`
    dicts. Two on-disk shapes are accepted for backward compatibility:
    plain strings (no images) and `{"text": ..., "image_paths": [...]}`
    objects (images attached via the ChatPanel paperclip). Returns [] when
    the file is missing or malformed.
    """
    try:
        with open(_prompts_path()) as f:
            data = json.load(f)
        arr = data.get(role, {}).get("operator_steers")
        if not isinstance(arr, list):
            return []
        out: list[dict] = []
        for entry in arr:
            if isinstance(entry, str):
                if entry.strip():
                    out.append({"text": entry.strip(), "image_paths": []})
            elif isinstance(entry, dict):
                text = entry.get("text")
                paths = entry.get("image_paths") or []
                if isinstance(text, str) and text.strip():
                    out.append({
                        "text": text.strip(),
                        "image_paths": [p for p in paths if isinstance(p, str)],
                    })
        return out
    except Exception:
        pass
    return []


def _append_operator_steers(system_prompt: str) -> str:
    """Append operator standing instructions as the final block of the
    orchestrator system prompt. The orchestrator is the agent that actually
    picks the niche (research/designer/listing only elaborate on what the
    orchestrator hands them), so the operator's intent MUST land here or it
    gets silently overridden by the orchestrator's hardcoded category list.

    Reads steers from both the "orchestrator" role (direct steers) AND the
    "research" role (because operators intuitively click Steer on Research
    when they want to inject a new niche idea, and that intent needs to
    propagate up to the agent doing the actual picking). De-duplicated;
    the orchestrator's own steers win when both contain the same text.

    Only the TEXT half of each steer lands in the system prompt — image
    references attach to the user message via _build_user_content_with_steer_images
    because Anthropic's `system` field is text-only.
    """
    own = _load_operator_steers("orchestrator")
    research = _load_operator_steers("research")
    seen: set[str] = set()
    merged: list[str] = []
    for entry in own + research:
        text = entry["text"]
        key = text.lower()
        if key in seen:
            continue
        seen.add(key)
        merged.append(text)
    if not merged:
        return system_prompt
    block = (
        "OPERATOR OVERRIDE — these standing instructions supersede every "
        "rule above, including any 'pick niches in these categories', "
        "'AVOID X', 'we DO NOT sell Y', or 'rotate across these pools' "
        "directives. The orchestrator is the boss of the pipeline; the "
        "operator is the boss of the orchestrator. If any rule above "
        "conflicts with the instructions below, ignore that rule for "
        "this job and follow the operator. Pick a niche_seed that "
        "directly satisfies the operator's intent:\n"
        + "\n".join(f"- {s}" for s in merged)
    )
    return system_prompt.rstrip() + "\n\n" + block


def _build_user_content_with_steer_images(
    user_prompt: str, roles: list[str]
) -> "str | list[dict]":
    """If any operator steer for the listed roles carries image references,
    upgrade the user-message content from a plain string to a list of
    multimodal content blocks: each image block is followed by a small
    text block citing the steer it belongs to, then the original user
    prompt lands as the final text block.

    Returns the user_prompt unchanged when no images are attached, so the
    common case (text-only steers) costs nothing extra at the wire.

    Best-effort on file reads: missing or unreadable images are skipped
    rather than crashing the job — the steer's text still applied via the
    system prompt's OPERATOR OVERRIDE block.
    """
    import base64
    import mimetypes
    # Anthropic caps each base64 image at 5 MB on the wire. base64 inflates
    # bytes by ~4/3, so the underlying raw file has to be ≤ ~3.75 MB. Use
    # 3.5 MB as the practical cap to leave headroom for the JSON wrapping
    # the bytes (key names, padding, multi-image batches). Above that we
    # skip the attachment with a loud log line — the steer's TEXT still
    # arrives via the system prompt's OPERATOR OVERRIDE block, so the
    # instruction isn't lost; only the visual reference is.
    MAX_RAW_BYTES = 3_500_000
    refs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for role in roles:
        for entry in _load_operator_steers(role):
            for path in entry.get("image_paths", []):
                if not isinstance(path, str) or path in seen:
                    continue
                seen.add(path)
                refs.append((entry.get("text", ""), path))
    if not refs:
        return user_prompt
    blocks: list[dict] = []
    for text, path in refs:
        try:
            size = os.path.getsize(path)
        except OSError as e:
            print(
                f"[orchestrator] skipping unreadable steer image {path!r}: {e}",
                file=sys.stderr, flush=True,
            )
            continue
        if size > MAX_RAW_BYTES:
            print(
                f"[orchestrator] skipping oversize steer image {path!r}: "
                f"{size} bytes > {MAX_RAW_BYTES} cap (Anthropic 5 MB/image "
                "after base64 inflation) — steer TEXT still applied via "
                "system prompt",
                file=sys.stderr, flush=True,
            )
            continue
        try:
            with open(path, "rb") as f:
                raw = f.read()
        except OSError as e:
            print(
                f"[orchestrator] skipping unreadable steer image {path!r}: {e}",
                file=sys.stderr, flush=True,
            )
            continue
        mime = mimetypes.guess_type(path)[0] or "image/png"
        if mime not in ("image/png", "image/jpeg", "image/webp", "image/gif"):
            mime = "image/png"
        blocks.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": mime,
                "data": base64.b64encode(raw).decode("ascii"),
            },
        })
        snippet = text[:200] + ("…" if len(text) > 200 else "")
        blocks.append({
            "type": "text",
            "text": f"^ Operator reference image for the steer: {snippet!r}",
        })
    if not any(b.get("type") == "image" for b in blocks):
        # Every image was skipped (oversize / unreadable). Fall back to the
        # plain text path so we don't ship a multimodal request with only
        # text blocks — that costs more JSON for no value.
        return user_prompt
    blocks.append({"type": "text", "text": user_prompt})
    return blocks


def _outcomes_path() -> str:
    return os.path.join(_data_dir(), "outcomes.jsonl")


def _publisher_output_path() -> str:
    return os.path.join(_data_dir(), "publisher_output.json")


def _read_recent_drafts(limit: int = DRAFTS_TAIL_LIMIT) -> list[dict]:
    """Read the last N publisher records (drafts we already published).
    We use this as our 'have we been exploring or just exploiting?' signal,
    because outcomes.jsonl only contains items that actually got sales —
    useless when the shop has zero sales but lots of drafts."""
    p = _publisher_output_path()
    if not os.path.exists(p):
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    return data[-limit:]


def _active_product_types() -> list[str]:
    """Rotation universe driven by SHOP_FOCUS:

      3d_only  → ONLY stl_file + 3d_model (assuming a 3D provider is wired).
                 If no provider key is present we fall back to 2D so the
                 pipeline doesn't deadlock.
      2d_only  → the original 2D set.
      mixed    → 2D + 3D when a provider is configured.

    Default 3d_only.
    """
    have_3d_provider = bool(
        os.environ.get("MESHY_API_KEY") or os.environ.get("TRIPO_API_KEY")
    )
    focus = _shop_focus()
    if focus == "3d_only" and have_3d_provider:
        return list(TRIPO_PRODUCT_TYPES)
    if focus == "2d_only":
        return list(ROTATION_PRODUCT_TYPES)
    # mixed (or 3d_only fallback when no provider): everything we can run.
    universe = list(ROTATION_PRODUCT_TYPES)
    if have_3d_provider:
        universe.extend(TRIPO_PRODUCT_TYPES)
    return universe


def _pick_rotation_product_type(recent_drafts: list[dict]) -> tuple[str, str]:
    """Choose the product_type with the FEWEST recent drafts so we expand
    market coverage. Returns (product_type, reason_string)."""
    universe = _active_product_types()
    counts: dict[str, int] = {pt: 0 for pt in universe}
    for d in recent_drafts:
        pt = d.get("product_type")
        if isinstance(pt, str) and pt in counts:
            counts[pt] += 1
    least = min(counts.values())
    candidates = [pt for pt in universe if counts[pt] == least]
    chosen = candidates[0]
    summary = ", ".join(f"{pt}={counts[pt]}" for pt in universe)
    return chosen, summary


def _summarize_recent_themes(recent_drafts: list[dict]) -> str | None:
    """Surface the dominant recent niche-words as a 'avoid repeating' list.
    Tokenize the recent niche strings and report any words that show up in
    ≥3 drafts — those are the themes we're stuck in."""
    if not recent_drafts:
        return None
    from collections import Counter
    word_counts: Counter[str] = Counter()
    niches: list[str] = []
    stop = {
        "for", "the", "and", "of", "in", "a", "to", "on", "with", "by",
        "printables", "printable", "templates", "template", "adults", "adult",
    }
    for d in recent_drafts:
        n = d.get("niche")
        if not isinstance(n, str) or not n.strip():
            continue
        niches.append(n.strip())
        for w in n.lower().split():
            w = w.strip(".,'\"()[]{}").lower()
            if len(w) >= 3 and w not in stop:
                word_counts[w] += 1
    if not niches:
        return None
    dominant = [w for w, c in word_counts.most_common(6) if c >= 3]
    last5 = niches[-5:]
    parts = [f"Last {len(niches)} drafts (no sales yet on any of these):"]
    parts.append(f"  Recent niches: {' | '.join(last5)}")
    if dominant:
        parts.append(
            f"  Over-concentrated themes: {', '.join(dominant)} — "
            "DO NOT pick another niche that contains these words."
        )
    if _shop_focus() == "3d_only":
        parts.append(
            "We need market BREADTH not depth right now. Pick a niche from a "
            "completely different 3D category (e.g. tabletop minis, jewelry, "
            "planters, cosplay props, keychains, ornaments, educational "
            "models, pet accessories) — anything but what's listed above."
        )
    else:
        parts.append(
            "We need market BREADTH not depth right now. Pick a niche in a "
            "completely different category (e.g. pets, weddings, plants, "
            "spirituality, fitness, kids, gaming, food, hobbies) — anything "
            "but what's listed above."
        )
    return "\n".join(parts)


def _fetch_trend_signals_text() -> str:
    """Best-effort: pull live trend signals and format them for the prompt.
    Never raises — if every source fails we return '' and the orchestrator
    just runs without external signal.

    Disabled when ORCHESTRATOR_TREND_SIGNALS=0 (escape hatch for offline
    runs / rate limits). Default ON so the niche pick rides public-trend
    signal out of the box.
    """
    if os.environ.get("ORCHESTRATOR_TREND_SIGNALS", "1").strip().lower() in {"0", "false", "no", "off"}:
        return ""
    try:
        from .trends import fetch_all_signals, format_for_prompt
        signals = fetch_all_signals(top_n=20)
        return format_for_prompt(signals) if signals else ""
    except Exception as e:
        print(f"[orchestrator] trend fetch failed (non-fatal): {e}", file=sys.stderr, flush=True)
        return ""


def _read_recent_outcomes(limit: int = OUTCOMES_TAIL_LIMIT, path: str | None = None) -> list[dict]:
    """Read up to `limit` most recent outcomes from outcomes.jsonl. Skip malformed lines."""
    p = path if path is not None else _outcomes_path()
    if not os.path.exists(p):
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return []
    tail = lines[-limit:] if len(lines) > limit else lines
    out: list[dict] = []
    for line in tail:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    return out


def _summarize_outcomes(outcomes: list[dict]) -> str | None:
    """Bucket outcomes by niche, compute avg revenue + traction (views/favorites),
    render a niche-memory context string.

    Returns None when there are not enough outcomes to be meaningful, or when no
    niche has at least the minimum samples per bucket.

    Views/favorites are the leading indicator for "the niche is alive but the
    listing/price is broken" — without them, a niche with 200 views and 0 sales
    looks identical to a dead niche, and the orchestrator wrongly kills both.
    Fields are best-effort: missing → not rendered, never crashes.
    """
    if not outcomes or len(outcomes) < NICHE_MIN_OUTCOMES:
        return None
    buckets: dict[str, dict] = defaultdict(
        lambda: {"revenue": 0.0, "count": 0, "views": 0.0, "favorites": 0.0,
                 "views_seen": 0, "favs_seen": 0}
    )
    for o in outcomes:
        niche = str(o.get("niche") or "").strip()
        if not niche:
            continue
        try:
            rev = float(o.get("revenue_usd") or 0.0)
        except (TypeError, ValueError):
            rev = 0.0
        b = buckets[niche]
        b["revenue"] += rev
        b["count"] += 1
        v = o.get("views")
        if isinstance(v, (int, float)):
            b["views"] += float(v)
            b["views_seen"] += 1
        f = o.get("favorites")
        if isinstance(f, (int, float)):
            b["favorites"] += float(f)
            b["favs_seen"] += 1

    def _avg_traction(b: dict) -> tuple[float | None, float | None]:
        v_avg = (b["views"] / b["views_seen"]) if b["views_seen"] else None
        f_avg = (b["favorites"] / b["favs_seen"]) if b["favs_seen"] else None
        return v_avg, f_avg

    qualified = [
        (niche, b["revenue"] / b["count"], b["count"], *_avg_traction(b))
        for niche, b in buckets.items()
        if b["count"] >= NICHE_MIN_SAMPLES_PER_BUCKET
    ]
    if not qualified:
        return None

    def _fmt_with_traction(name: str, avg_rev: float, cnt: int, v_avg, f_avg, with_count: bool) -> str:
        parts = [f"{name} (${avg_rev:.2f} avg"]
        if with_count:
            parts.append(f", {cnt} tries")
        traction_bits = []
        if v_avg is not None:
            traction_bits.append(f"{v_avg:.0f}v")
        if f_avg is not None:
            traction_bits.append(f"{f_avg:.0f}f")
        if traction_bits:
            parts.append(", " + " ".join(traction_bits))
        parts.append(")")
        return "".join(parts)

    # Three-way split:
    #  • Top / bottom — straight revenue ranking (unchanged semantics — keeps
    #    the existing top-N-by-avg-revenue intuition intact).
    #  • Promising — ANY niche (top OR bottom) whose views suggest interest
    #    but conversion is broken. Surfaces as its own bullet so the model
    #    treats it as "fix the listing", not "kill the niche".
    qualified.sort(key=lambda t: t[1], reverse=True)
    top = qualified[:3]
    top_names = {n for n, _, _, _, _ in top}
    bottom_pool = [t for t in reversed(qualified) if t[0] not in top_names]
    if not bottom_pool and len(qualified) >= 2:
        bottom_pool = [qualified[-1]]
    bottom = bottom_pool[:3]

    # Promising bucket: low/zero revenue but ≥5 avg views means buyers are
    # finding it. Pull from the FULL qualified set so a $1-avg niche with
    # heavy traffic still surfaces as promising.
    promising = [
        t for t in qualified
        if t[1] < 3.0 and t[3] is not None and t[3] >= 5
    ]
    promising.sort(key=lambda t: (t[3] or 0), reverse=True)
    promising = promising[:3]

    lines = ["Recent shop performance:"]
    if top:
        lines.append(
            "Top performers: "
            + ", ".join(_fmt_with_traction(*t, with_count=False) for t in top)
        )
    if promising:
        lines.append(
            "Promising — traction but weak revenue (listing/price problem, NOT niche death — retry with a different angle): "
            + ", ".join(_fmt_with_traction(*t, with_count=True) for t in promising)
        )
    if bottom:
        lines.append(
            "Underperformers: "
            + ", ".join(_fmt_with_traction(*t, with_count=True) for t in bottom)
            + " — avoid retrying these."
        )
    lines.append(
        "Pick a NEW niche, ideally borrowing patterns from the top performers, NOT in the underperformer list."
    )
    return "\n".join(lines)


# ---------- operator ratings (Telegram rater bot) ----------
#
# Operator-supplied star ratings (+ optional notes) live in
# ~/.agent-factory/ratings.jsonl, written by workers/rater_bot when the
# operator taps a star in Telegram. This is THE feedback channel for the
# first ~100 drafts: outcomes.jsonl only carries actual sales, so before
# the shop has revenue the orchestrator has no signal to learn from. A
# 5-star note like "love the chunky silhouette" tells the model what to
# imitate; a 1-star "looks like every AI dragon" tells it what to avoid.


RATINGS_TAIL_LIMIT = 60


def _ratings_path() -> str:
    return os.path.join(_data_dir(), "ratings.jsonl")


def _read_recent_ratings(limit: int = RATINGS_TAIL_LIMIT, path: str | None = None) -> list[dict]:
    """Read up to `limit` most recent rating events. Returns NEWEST-FIRST so
    the summarizer's de-dup-by-listing-id keeps the latest re-rating."""
    p = path if path is not None else _ratings_path()
    if not os.path.exists(p):
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return []
    tail = lines[-limit:] if len(lines) > limit else lines
    out: list[dict] = []
    for line in tail:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(obj, dict):
            out.append(obj)
    out.reverse()  # newest first
    return out


def _summarize_ratings(ratings: list[dict]) -> str | None:
    """Render top-rated + low-rated examples as a few-shot block. We pick
    EXEMPLARS (specific titles + notes), not bucketed averages, because the
    qualitative note is the high-bandwidth signal — "love the chunky
    silhouette" teaches the model more than "niche X averages 4.2".

    De-dup by listing_id so re-rating doesn't double-count the same draft.
    """
    if not ratings:
        return None

    seen: set[int] = set()
    dedup: list[dict] = []
    for r in ratings:
        lid = r.get("listing_id")
        if not isinstance(lid, int) or lid in seen:
            continue
        seen.add(lid)
        try:
            stars = int(r.get("stars") or 0)
        except (TypeError, ValueError):
            stars = 0
        if stars < 1 or stars > 5:
            continue
        dedup.append({
            "stars": stars,
            "title": str(r.get("title") or "").strip(),
            "niche": str(r.get("niche") or "").strip(),
            "note": str(r.get("note") or "").strip(),
        })

    if not dedup:
        return None

    # Sort high-rated first, low-rated last; cap each side at 4 so the
    # block stays under ~600 tokens.
    high = sorted([r for r in dedup if r["stars"] >= 4], key=lambda r: -r["stars"])[:4]
    low = sorted([r for r in dedup if r["stars"] <= 2], key=lambda r: r["stars"])[:4]

    if not high and not low:
        return None

    def _line(r: dict) -> str:
        stars = "★" * r["stars"]
        bits = [f"{stars} \"{r['title'] or '(untitled)'}\""]
        if r["niche"]:
            bits.append(f"[{r['niche']}]")
        if r["note"]:
            bits.append(f"— note: {r['note']}")
        return " ".join(bits)

    lines = [
        "OPERATOR RATINGS (rate-it-yourself feedback from the human in the "
        "loop — trust these MORE than sales for first-100-listing learning):"
    ]
    if high:
        lines.append("Loved:")
        lines.extend(f"  • {_line(r)}" for r in high)
    if low:
        lines.append("Disliked:")
        lines.extend(f"  • {_line(r)}" for r in low)
    lines.append(
        "Pick a NEW niche that resembles the LOVED examples in style + "
        "silhouette; avoid patterns from the DISLIKED list."
    )
    return "\n".join(lines)


def build_orchestrator_prompt(
    niche_context: str | None = None,
    drafts_context: str | None = None,
    target_product_type: str | None = None,
    trend_signals_text: str | None = None,
    strategist_notes: str | None = None,
) -> tuple[str, str]:
    focus = _shop_focus()
    is_3d = focus == "3d_only" or target_product_type in {"stl_file", "3d_model"}

    pt_hint = ""
    if target_product_type:
        pt_hint = (
            f"\n\nThe next draft MUST be designed as a '{target_product_type}' "
            "(this is the product format the shop has explored least)."
        )

    if is_3d:
        # 3D-only mode: completely different niche universe. Stop picking
        # planners / printables / mugs / stickers; aim at the high-margin
        # 3D-printable + game-asset markets where AI-generated meshes
        # actually look professional.
        pools = _enabled_pools()
        pool_lines: list[str] = []
        if "original_anime" in pools:
            pool_lines.append(
                " • ORIGINAL ANIME ARCHETYPES — generic shonen swordsman, mecha "
                "pilot, magical-girl, gunslinger samurai. No specific franchise. "
                "Zero IP risk. Default-safe."
            )
        if "mythology" in pools:
            pool_lines.append(
                " • PUBLIC-DOMAIN + MYTHOLOGY — Greek/Norse/Egyptian gods, yokai, "
                "Cthulhu/Lovecraftian, Arthurian, Alice in Wonderland, Brothers "
                "Grimm. Strong Etsy + Cults3D demand, no IP risk."
            )
        if "own_universe" in pools:
            pool_lines.append(
                " • OWN-UNIVERSE CHARACTERS — fresh original IP we coin ourselves "
                "(name, faction, lore). Highest long-term franchise value. "
                "No IP risk."
            )
        if "popular_ip" in pools:
            pool_lines.append(
                " • POPULAR-IP FAN ART — Naruto, Genshin, Marvel, Star Wars, "
                "Game of Thrones, etc. HIGH IP RISK — these get held for "
                "manual approval before publish; do NOT over-stack these."
            )
        pool_block = ""
        if pool_lines:
            pool_block = (
                "\n\nCHARACTER POOLS YOU MAY PICK FROM (rotate across them, do "
                "NOT pile up one tier):\n" + "\n".join(pool_lines) + "\n"
            )

        system = (
            "You are the Strategy Lead at an AI-run 3D-asset shop. We sell "
            "AI-generated 3D models (STL + GLB) on Etsy and Cults3D. We DO "
            "NOT sell 2D printables, stickers, mugs, or planners — those got "
            "zero sales after 58 drafts and we pivoted. Pick niches in the "
            "3D market where our Tripo/Meshy generation quality genuinely "
            "competes:\n\n"
            " • TABLETOP MINIATURES — D&D minis, Warhammer-compat, NPCs, "
            "monsters, terrain tiles, dice towers, dice trays. Highest-"
            "margin 3D niche on Etsy + huge Cults3D demand.\n"
            " • 3D-PRINTABLE JEWELRY — pendants, earrings, rings, charms. "
            "Stylized organic forms (botanical, animal, geometric). Small "
            "files, fast prints, low filament cost = perfect for AI-gen.\n"
            " • DESK + HOME DECOR — face planters, animal planters, lamp "
            "shades, sculptural vases, wall-mounted busts, organizers, "
            "geometric mathematical art.\n"
            " • COSPLAY + PROPS — fantasy weapons, masks, helmets, jewelry "
            "props, anime accessories. High willingness-to-pay.\n"
            " • SEASONAL + GIFT — Christmas ornaments, Halloween figures, "
            "wedding cake toppers, birthday party props, themed keychains.\n"
            " • EVERYDAY-CARRY — phone stands, cable organizers, headphone "
            "hooks, key holders, sunglass stands. Saturated but high "
            "search volume on Etsy.\n"
            " • EDUCATIONAL — anatomical models, molecular structures, "
            "planets, fossils, historical artifacts. Schools + parents buy.\n"
            " • PET ACCESSORIES — name tags, food bowl stands, custom toys, "
            "memorial figurines. Underserved niche.\n\n"
            "AVOID: anything 2D (planners, stickers, printables, posters, "
            "wall art that's an image not a 3D bas-relief), commodity prints "
            "(generic 'low-poly dragon'), and concepts that need detailed "
            "rigging/PBR-texturing — our pipeline ships untextured printable "
            "meshes, not game-ready textured assets."
            f"{pool_block}\n"
            f"{pt_hint}\n\n"
            "Return JSON only with this exact shape:\n"
            "{\n"
            '  "niche_seed": "<specific niche, 3-7 words, e.g. \'D&D goblin warrior mini\' or \'botanical leaf earring STL\'>",\n'
            '  "rationale": "<one sentence on WHY this niche sells on Etsy/Cults3D now AND why it differs from recent drafts>",\n'
            '  "target_audience": "<who buys: tabletop gamers / jewelry makers / cosplayers / home decorators / etc.>"\n'
            "}"
        )
    else:
        system = (
            "You are the Strategy Lead at an AI-run multi-niche Etsy shop. "
            "Your single most important job: pick niches that EXPAND market "
            "coverage. The shop has zero sales so far, so over-investing in "
            "one category is wasteful — we want broad sampling first, "
            "exploitation later. Vary by audience (pets, weddings, kids, "
            "fitness, plants, spirituality, gaming, food, hobbies, holidays, "
            "professions) AND by product format (sticker, digital_print, "
            "poster, mug, tee).\n\n"
            f"{pt_hint}\n\n"
            "Return JSON only with this exact shape:\n"
            "{\n"
            '  "niche_seed": "<specific niche, 3-7 words>",\n'
            '  "rationale": "<one sentence on why this niche now AND why it differs from recent drafts>",\n'
            '  "target_audience": "<who buys this>"\n'
            "}"
        )
    user_parts: list[str] = []
    if drafts_context:
        user_parts.append(drafts_context)
    if niche_context:
        user_parts.append(niche_context)
    if trend_signals_text and trend_signals_text.strip():
        # Live trend signals from Reddit / Google Trends / YouTube. Mine for
        # niche categories the average Etsy seller hasn't reacted to yet;
        # filter ruthlessly. The signal is in the CATEGORIES (mythology,
        # dinosaurs, dnd, anime archetype, holiday) — not in surface terms.
        user_parts.append(
            "LIVE TREND SIGNALS (Reddit hot posts, Google Trends, YouTube — "
            "raw scrape, score is normalized 0-100 within source):\n"
            f"{trend_signals_text}\n"
            "Mine these for niche ideas the average Etsy/Cults3D seller "
            "hasn't reacted to yet — but filter ruthlessly: skip celebrity "
            "gossip, current events, brand/IP names (HIGH legal risk), and "
            "anything that doesn't translate to a printable/displayable 3D "
            "object. The signal is in the underlying CATEGORIES (mythology, "
            "dinosaurs, Halloween, dnd, anime archetype, hobby). DO NOT just "
            "regurgitate a trending term as the niche."
        )
    if strategist_notes and strategist_notes.strip():
        # Meta-strategist's cross-niche guidance — distilled from outcomes
        # the orchestrator can't infer from a single row (e.g. scale biases,
        # adjacency suggestions, listing/price diagnoses). Placed LAST so
        # it gets the model's strongest attention before the final pick.
        user_parts.append(
            "STRATEGIST NOTES — your tuner reviewed recent outcomes and "
            "wrote this guidance for THIS cycle. Treat it as advisory, not "
            "as a hard rule (operator steers above still trump it), but "
            "lean into the patterns it surfaces:\n"
            f"{strategist_notes}"
        )
    user_parts.append(
        "Pick the next niche to pursue. Be specific, and make sure it's in "
        "a category we haven't already over-covered."
    )
    user = "\n\n".join(user_parts)
    return system, user


def call_anthropic(
    api_key: str,
    niche_context: str | None = None,
    drafts_context: str | None = None,
    target_product_type: str | None = None,
    trend_signals_text: str | None = None,
    strategist_notes: str | None = None,
) -> tuple[dict, int, int]:
    system_prompt, user_prompt = build_orchestrator_prompt(
        niche_context=niche_context,
        drafts_context=drafts_context,
        target_product_type=target_product_type,
        trend_signals_text=trend_signals_text,
        strategist_notes=strategist_notes,
    )
    # AVOID block first (rejected niches), then OPERATOR OVERRIDE (steers).
    # Steers come last so a fresh "try Lovecraftian jewelry" can override an
    # older "Lovecraftian dice tower" rejection. Last tokens carry strongest
    # model attention.
    system_prompt = _append_rejection_avoid_block(system_prompt)
    system_prompt = _append_operator_steers(system_prompt)
    # Image-bearing steers attach to the user message as multimodal blocks
    # because Anthropic's `system` field is text-only. No-op when no steer
    # carries images (returns user_prompt as a plain string).
    user_content = _build_user_content_with_steer_images(
        user_prompt, ["orchestrator", "research"]
    )

    body = json.dumps({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system_prompt,
                "messages": _messages_for_json_call(user_content),
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{ANTHROPIC_BASE_URL}/v1/messages",
        data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        method="POST",
    )

    raw = _retry_request(req, timeout=60)

    response = json.loads(raw)
    text = response["content"][0]["text"]
    # Restore the prefilled "{" assistant.content so the JSON parser
    # sees a complete object. We only prepend when the response
    # contains no "{" at all — fenced or wrapped mock responses
    # already carry their own brace and pass through untouched.
    if "{" not in text:
        text = "{" + text
    usage = response.get("usage", {})
    tokens_in = usage.get("input_tokens", 0)
    tokens_out = usage.get("output_tokens", 0)

    data = _parse_loose_json_object(text)
    return data, tokens_in, tokens_out


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}

    job_id = params.get("job_id", 0)
    payload = params.get("payload", {}) if isinstance(params, dict) else {}
    if not isinstance(payload, dict):
        payload = {}
    # Orchestrator is the head of the pipeline — it always generates a fresh
    # cycle_id. Any cycle_id arriving in the payload (e.g. from cfo's loop-back
    # handoff) is intentionally discarded so each run is its own cycle.
    cycle_id = uuid.uuid4().hex
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        msg = "ANTHROPIC_API_KEY not set"
        print(f"[orchestrator] ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"orchestrator failed: {msg}",
        }

    outcomes_summary = _summarize_outcomes(_read_recent_outcomes())
    ratings_summary = _summarize_ratings(_read_recent_ratings())
    # Concatenate so the prompt sees BOTH sales-derived patterns and
    # operator ratings. Either may be None; we drop blanks.
    niche_context = "\n\n".join(s for s in (outcomes_summary, ratings_summary) if s) or None
    recent_drafts = _read_recent_drafts()
    drafts_context = _summarize_recent_themes(recent_drafts)
    target_product_type, rotation_summary = _pick_rotation_product_type(recent_drafts)
    if drafts_context:
        print(
            f"[orchestrator] job_id={job_id} draft-history context "
            f"({len(recent_drafts)} drafts, {len(drafts_context)} chars)",
            file=sys.stderr, flush=True,
        )
    print(
        f"[orchestrator] job_id={job_id} product rotation: pick={target_product_type} | counts: {rotation_summary}",
        file=sys.stderr, flush=True,
    )
    # Live trend signals — best-effort, opt out via ORCHESTRATOR_TREND_SIGNALS=0.
    # Fetched here (not lazily inside call_anthropic) so test mocks of the
    # Anthropic call don't accidentally trigger live HTTP to Reddit/Google/YT.
    trend_signals_text = _fetch_trend_signals_text()
    if trend_signals_text:
        print(
            f"[orchestrator] job_id={job_id} trend signals: {len(trend_signals_text)} chars",
            file=sys.stderr, flush=True,
        )
    # Meta-strategist notes — written by the strategist's orchestrator-tuning
    # tick. Advisory cross-niche guidance, distinct from operator steers
    # (which are imperative).
    strategist_notes = _load_strategist_notes()
    if strategist_notes:
        print(
            f"[orchestrator] job_id={job_id} strategist notes: {len(strategist_notes)} chars",
            file=sys.stderr, flush=True,
        )
    print(f"[orchestrator] job_id={job_id} calling Anthropic model={MODEL}", file=sys.stderr, flush=True)
    try:
        data, tokens_in, tokens_out = call_anthropic(
            api_key,
            niche_context=niche_context,
            drafts_context=drafts_context,
            target_product_type=target_product_type,
            trend_signals_text=trend_signals_text,
            strategist_notes=strategist_notes,
        )
        niche_seed = data.get("niche_seed", "unknown niche")
        rationale = data.get("rationale", "")
        target_audience = data.get("target_audience", "")
        print(f"[orchestrator] job_id={job_id} done niche_seed={niche_seed!r} pt={target_product_type} in={tokens_in} out={tokens_out}", file=sys.stderr, flush=True)
        # Conversation log: tell the floor what we picked AND why we rotated.
        # These render in the Conversations panel as agent-to-agent chatter, so
        # phrase them like Slack messages between colleagues — not log lines.
        pt_label = _humanize_product_type(target_product_type)
        niche_msg_parts = [
            f"Iris — picking **{niche_seed}** as a {pt_label} for this cycle."
        ]
        if rationale and rationale.strip():
            niche_msg_parts.append(f"Why: {rationale.strip()}")
        if target_audience and target_audience.strip():
            niche_msg_parts.append(f"Target buyer: {target_audience.strip()}.")

        messages = [
            {
                "from": "orchestrator",
                "to": "research",
                "topic": "niche_pick",
                "importance": "heads_up",
                "content": "\n\n".join(niche_msg_parts),
            },
            {
                "from": "orchestrator",
                "to": "*",
                "topic": "rotation",
                "importance": "info",
                "content": (
                    f"Rotating into **{pt_label}** for this cycle — "
                    f"lowest-volume format in recent drafts ({rotation_summary})."
                ),
            },
        ]
        return {
            "ok": True,
            "niche_seed": niche_seed,
            "rationale": rationale,
            "target_audience": target_audience,
            "ticker_text": f"orchestrator → research: {niche_seed} [{target_product_type}]",
            "model": MODEL,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "cycle_id": cycle_id,
            "messages": messages,
            "handoff": {
                "to_role": "research",
                "payload": {
                    "niche_seed": niche_seed,
                    "rationale": rationale,
                    "product_type_preference": target_product_type,
                    "cycle_id": cycle_id,
                },
            },
        }
    except Exception as e:
        msg = str(e)
        print(f"[orchestrator] job_id={job_id} ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"orchestrator failed: {msg}",
        }
