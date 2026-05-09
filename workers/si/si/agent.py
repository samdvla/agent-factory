import json
import os
import sys
import tempfile
import urllib.request
import urllib.error
from collections import defaultdict

MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 1500
MIN_OUTCOMES = 5
TAIL_LIMIT = 30
VALID_ROLES = ("research", "designer", "listing")
SYSTEM_MIN_LEN = 80
SYSTEM_MAX_LEN = 2000

DATA_DIR = os.path.expanduser("~/.agent-factory")
OUTCOMES_PATH = os.path.join(DATA_DIR, "outcomes.jsonl")
PROMPTS_PATH = os.path.join(DATA_DIR, "prompts.json")


def _data_dir() -> str:
    """Resolve the agent-factory data dir at call time so tests can monkey-patch HOME."""
    return os.path.expanduser("~/.agent-factory")


def _outcomes_path() -> str:
    return os.path.join(_data_dir(), "outcomes.jsonl")


def _prompts_path() -> str:
    return os.path.join(_data_dir(), "prompts.json")


def read_outcomes(path: str | None = None, limit: int = TAIL_LIMIT) -> list[dict]:
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


def read_prompts(path: str | None = None) -> dict:
    """Read prompts.json. Returns empty dict on missing or malformed file."""
    p = path if path is not None else _prompts_path()
    if not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (OSError, json.JSONDecodeError):
        pass
    return {}


def write_prompts(path: str, data: dict) -> None:
    """Atomic write: write to a temp file in the same dir, then os.replace."""
    parent = os.path.dirname(path) or "."
    os.makedirs(parent, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".prompts.", suffix=".tmp", dir=parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def summarize_outcomes(outcomes: list[dict]) -> str:
    """Group outcomes by niche, compute total revenue and sales, render a bullet summary.

    Returns text containing each niche so the LLM can reason about which patterns work.
    """
    if not outcomes:
        return "(no outcomes yet)"
    by_niche: dict[str, dict] = defaultdict(lambda: {"revenue": 0.0, "sales": 0, "count": 0})
    for o in outcomes:
        niche = str(o.get("niche") or "unknown")
        try:
            rev = float(o.get("revenue_usd") or 0.0)
        except (TypeError, ValueError):
            rev = 0.0
        try:
            sales = int(o.get("sales") or 0)
        except (TypeError, ValueError):
            sales = 0
        entry = by_niche[niche]
        entry["revenue"] += rev
        entry["sales"] += sales
        entry["count"] += 1

    rows = sorted(
        by_niche.items(),
        key=lambda kv: kv[1]["revenue"],
        reverse=True,
    )
    top = rows[:3]
    bottom = rows[-3:] if len(rows) > 3 else []

    lines = [f"Total outcomes: {len(outcomes)} across {len(rows)} niche(s)."]
    lines.append("Top revenue niches:")
    for niche, entry in top:
        lines.append(
            f"  - {niche}: ${entry['revenue']:.2f} from {entry['sales']} sales over {entry['count']} listing(s)"
        )
    if bottom and len(rows) > 3:
        lines.append("Lowest revenue niches:")
        for niche, entry in bottom:
            lines.append(
                f"  - {niche}: ${entry['revenue']:.2f} from {entry['sales']} sales over {entry['count']} listing(s)"
            )
    return "\n".join(lines)


def build_si_prompt(outcomes_summary: str, current_prompts: dict) -> tuple[str, str]:
    system = (
        "You optimize prompts for an autonomous Etsy shop. "
        "Given recent outcomes by niche and the current system prompts for the research, "
        "designer, and listing roles, propose ONE small targeted edit to ONE role's "
        "system_override to push future listings toward higher-revenue patterns. "
        "Keep edits minimal and specific — the goal is gradual improvement, not rewrites. "
        "Output JSON only, no prose, no markdown:\n"
        '{"role": "research|designer|listing|null", '
        '"new_system": "<full replacement string for that role\'s system prompt>", '
        '"reasoning": "<one short sentence>"}\n'
        'Use role=null (and new_system="") if no change is warranted.'
    )
    prompts_view: dict = {}
    for r in VALID_ROLES:
        ov = current_prompts.get(r, {}) if isinstance(current_prompts.get(r), dict) else {}
        prompts_view[r] = ov.get("system_override") if isinstance(ov, dict) else None
    user = (
        f"Recent outcomes:\n{outcomes_summary}\n\n"
        f"Current system_overrides (null means using each worker's hardcoded default):\n"
        f"{json.dumps(prompts_view, indent=2)}\n\n"
        "Propose at most ONE edit. Return JSON only."
    )
    return system, user


def call_anthropic(api_key: str, outcomes_summary: str, current_prompts: dict) -> tuple[dict, int, int]:
    system_prompt, user_prompt = build_si_prompt(outcomes_summary, current_prompts)

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

    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode("utf-8")

    response = json.loads(raw)
    text = response["content"][0]["text"]
    usage = response.get("usage", {})
    tokens_in = usage.get("input_tokens", 0)
    tokens_out = usage.get("output_tokens", 0)

    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1]) if len(lines) > 2 else text

    parsed = json.loads(text)
    return parsed, tokens_in, tokens_out


def _validate_proposal(proposal: dict) -> tuple[str | None, str | None]:
    """Return (role, new_system) on valid proposal, else (None, None) for null/invalid.

    Raises ValueError on malformed structure that should trigger the 'skipped' path.
    """
    if not isinstance(proposal, dict):
        raise ValueError("proposal not an object")
    role = proposal.get("role")
    new_system = proposal.get("new_system", "")
    # Treat null / "null" string / missing as no-op
    if role is None or (isinstance(role, str) and role.lower() == "null"):
        return None, None
    if role not in VALID_ROLES:
        raise ValueError(f"invalid role: {role!r}")
    if not isinstance(new_system, str) or not new_system.strip():
        raise ValueError("new_system must be non-empty string")
    n = len(new_system)
    if n < SYSTEM_MIN_LEN or n > SYSTEM_MAX_LEN:
        raise ValueError(f"new_system length {n} out of bounds [{SYSTEM_MIN_LEN}, {SYSTEM_MAX_LEN}]")
    return role, new_system


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}
    job_id = params.get("job_id", 0)
    payload = params.get("payload", {})
    return process_job(job_id, payload)


def process_job(job_id: int, payload: dict) -> dict:
    outcomes = read_outcomes()
    if len(outcomes) < MIN_OUTCOMES:
        print(
            f"[si] job_id={job_id} only {len(outcomes)} outcomes — waiting (need ≥{MIN_OUTCOMES})",
            file=sys.stderr,
            flush=True,
        )
        return {
            "ok": True,
            "ticker_text": "si · waiting for outcomes",
            "role_tweaked": None,
            "model": MODEL,
            "tokens_in": 0,
            "tokens_out": 0,
        }

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        print("[si] ANTHROPIC_API_KEY not set — skipping", file=sys.stderr, flush=True)
        return {
            "ok": True,
            "ticker_text": "si · skipped",
            "role_tweaked": None,
            "model": MODEL,
            "tokens_in": 0,
            "tokens_out": 0,
        }

    try:
        current = read_prompts()
        summary = summarize_outcomes(outcomes)
        print(
            f"[si] job_id={job_id} {len(outcomes)} outcomes — calling Anthropic model={MODEL}",
            file=sys.stderr,
            flush=True,
        )
        proposal, tokens_in, tokens_out = call_anthropic(api_key, summary, current)
        role, new_system = _validate_proposal(proposal)
        if role is None:
            print(
                f"[si] job_id={job_id} no change proposed in={tokens_in} out={tokens_out}",
                file=sys.stderr,
                flush=True,
            )
            return {
                "ok": True,
                "ticker_text": "si · no change",
                "role_tweaked": None,
                "model": MODEL,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
            }
        # Persist override.
        current[role] = {"system_override": new_system}
        write_prompts(_prompts_path(), current)
        print(
            f"[si] job_id={job_id} tweaked role={role} in={tokens_in} out={tokens_out}",
            file=sys.stderr,
            flush=True,
        )
        return {
            "ok": True,
            "ticker_text": f"si · {role}.system · tweaked",
            "role_tweaked": role,
            "model": MODEL,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
        }
    except Exception as e:
        print(f"[si] job_id={job_id} ERROR: {e}", file=sys.stderr, flush=True)
        return {
            "ok": True,
            "ticker_text": "si · skipped",
            "role_tweaked": None,
            "model": MODEL,
            "tokens_in": 0,
            "tokens_out": 0,
        }
