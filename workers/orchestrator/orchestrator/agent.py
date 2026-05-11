import json
import os
import sys
import urllib.request
import urllib.error
import uuid
from collections import defaultdict

MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 400


def _retry_request(req: urllib.request.Request, timeout: int = 60, max_attempts: int = 3) -> str:
    """POST with exponential backoff. Retries on 5xx and URLError. Does NOT retry on 4xx.
    Returns the response body as utf-8 string. Raises on final failure.

    _retry_request: see workers/research/tests/test_research.py for behavior coverage.
    """
    import time as _time
    last_exc: Exception | None = None
    for attempt in range(max_attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            last_exc = e
            if 500 <= e.code < 600 and attempt < max_attempts - 1:
                delay = (2 ** attempt)
                print(f"[retry] HTTP {e.code} attempt {attempt+1}/{max_attempts}; sleeping {delay}s", file=sys.stderr, flush=True)
                _time.sleep(delay)
                continue
            raise
        except urllib.error.URLError as e:
            last_exc = e
            if attempt < max_attempts - 1:
                delay = (2 ** attempt)
                print(f"[retry] URLError {e} attempt {attempt+1}/{max_attempts}; sleeping {delay}s", file=sys.stderr, flush=True)
                _time.sleep(delay)
                continue
            raise
    if last_exc:
        raise last_exc
    raise RuntimeError("retry: unreachable")

OUTCOMES_TAIL_LIMIT = 30
NICHE_MIN_OUTCOMES = 5
NICHE_MIN_SAMPLES_PER_BUCKET = 2


def _data_dir() -> str:
    """Resolve the agent-factory data dir at call time so tests can monkey-patch HOME."""
    return os.path.expanduser("~/.agent-factory")


def _outcomes_path() -> str:
    return os.path.join(_data_dir(), "outcomes.jsonl")


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
    """Bucket outcomes by niche, compute avg revenue, render a niche-memory context string.

    Returns None when there are not enough outcomes to be meaningful, or when no
    niche has at least the minimum samples per bucket.
    """
    if not outcomes or len(outcomes) < NICHE_MIN_OUTCOMES:
        return None
    buckets: dict[str, dict] = defaultdict(lambda: {"revenue": 0.0, "count": 0})
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

    qualified = [
        (niche, b["revenue"] / b["count"], b["count"])
        for niche, b in buckets.items()
        if b["count"] >= NICHE_MIN_SAMPLES_PER_BUCKET
    ]
    if not qualified:
        return None

    qualified.sort(key=lambda t: t[1], reverse=True)
    top = qualified[:3]
    # Bottom = up to 3 worst niches, excluding any already shown as top.
    top_names = {n for n, _, _ in top}
    bottom_pool = [t for t in reversed(qualified) if t[0] not in top_names]
    if not bottom_pool and len(qualified) >= 2:
        # Fewer than 4 niches → bottom would otherwise be empty. Show the single worst.
        bottom_pool = [qualified[-1]]
    bottom = bottom_pool[:3]

    top_str = ", ".join(f"{n} (${avg:.2f} avg)" for n, avg, _ in top)
    lines = ["Recent shop performance:", f"Top performers: {top_str}"]
    if bottom:
        bottom_str = ", ".join(f"{n} (${avg:.2f} avg, {cnt} tries)" for n, avg, cnt in bottom)
        lines.append(f"Underperformers: {bottom_str} — avoid retrying these.")
    lines.append(
        "Pick a NEW niche, ideally borrowing patterns from the top performers, NOT in the underperformer list."
    )
    return "\n".join(lines)


def build_orchestrator_prompt(niche_context: str | None = None) -> tuple[str, str]:
    system = (
        "You are the Strategy Lead at an AI-run digital-products Etsy shop. "
        "Your job is to pick the next niche the shop should pursue. "
        "Pick something specific and currently in demand — printables, SVGs, "
        "digital templates, ebooks, or prompt packs. "
        "Return JSON only with this exact shape:\n"
        "{\n"
        '  "niche_seed": "<specific niche, 3-7 words>",\n'
        '  "rationale": "<one sentence on why this niche now>",\n'
        '  "target_audience": "<who buys this>"\n'
        "}"
    )
    user = "Pick the next niche to pursue. Be specific."
    if niche_context:
        user = f"{niche_context}\n\n{user}"
    return system, user


def call_anthropic(api_key: str, niche_context: str | None = None) -> tuple[dict, int, int]:
    system_prompt, user_prompt = build_orchestrator_prompt(niche_context=niche_context)

    body = json.dumps({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
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
    usage = response.get("usage", {})
    tokens_in = usage.get("input_tokens", 0)
    tokens_out = usage.get("output_tokens", 0)

    # Strip markdown code fences if present
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1]) if len(lines) > 2 else text

    data = json.loads(text)
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

    niche_context = _summarize_outcomes(_read_recent_outcomes())
    if niche_context:
        print(
            f"[orchestrator] job_id={job_id} threading niche memory ({len(niche_context)} chars)",
            file=sys.stderr,
            flush=True,
        )
    print(f"[orchestrator] job_id={job_id} calling Anthropic model={MODEL}", file=sys.stderr, flush=True)
    try:
        data, tokens_in, tokens_out = call_anthropic(api_key, niche_context=niche_context)
        niche_seed = data.get("niche_seed", "unknown niche")
        rationale = data.get("rationale", "")
        target_audience = data.get("target_audience", "")
        print(f"[orchestrator] job_id={job_id} done niche_seed={niche_seed!r} in={tokens_in} out={tokens_out}", file=sys.stderr, flush=True)
        return {
            "ok": True,
            "niche_seed": niche_seed,
            "rationale": rationale,
            "target_audience": target_audience,
            "ticker_text": f"orchestrator → research: {niche_seed}",
            "model": MODEL,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "cycle_id": cycle_id,
            "handoff": {
                "to_role": "research",
                "payload": {
                    "niche_seed": niche_seed,
                    "rationale": rationale,
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
