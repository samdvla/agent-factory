import json
import os
import sys
import tempfile
import urllib.request
import urllib.error
from collections import defaultdict

MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 1500

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


def _messages_for_json_call(user_content: str) -> list[dict]:
    """Build the messages array for a JSON-emitting Anthropic call. Adds the
    assistant prefill only when the API supports it (direct Anthropic, not
    a bridge proxy)."""
    msgs: list[dict] = [{"role": "user", "content": user_content}]
    if _use_json_prefill():
        msgs.append({"role": "assistant", "content": "{"})
    return msgs

MIN_OUTCOMES = 5
TAIL_LIMIT = 30
VALID_ROLES = ("research", "designer", "listing", "cs")
SYSTEM_MIN_LEN = 80
SYSTEM_MAX_LEN = 2000

# Rollback safety: how many outcomes either side of a tweak ts to evaluate it,
# and the regression threshold (post must be >= pre * threshold to avoid revert).
ROLLBACK_WINDOW = 5
ROLLBACK_REGRESSION_RATIO = 0.6
HISTORY_CAP = 5

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


def _outcomes_split_by_ts(outcomes: list[dict], ts: int) -> tuple[list[dict], list[dict]]:
    """Split outcomes into (before, after) by ts. Outcomes with ts == tweak ts go in 'after'."""
    before: list[dict] = []
    after: list[dict] = []
    for o in outcomes:
        try:
            o_ts = int(o.get("ts") or 0)
        except (TypeError, ValueError):
            o_ts = 0
        if o_ts < ts:
            before.append(o)
        else:
            after.append(o)
    return before, after


def _avg_revenue(outcomes: list[dict]) -> float:
    """Average of revenue_usd over outcomes. Returns 0.0 if empty."""
    if not outcomes:
        return 0.0
    total = 0.0
    n = 0
    for o in outcomes:
        try:
            total += float(o.get("revenue_usd") or 0.0)
            n += 1
        except (TypeError, ValueError):
            continue
    return (total / n) if n else 0.0


def _should_rollback(history: list, outcomes: list[dict]) -> dict | None:
    """Decide whether the most recent history entry should be rolled back.

    Returns the entry to roll back (with computed pre_avg/post_avg attached under
    private keys '_pre_avg' / '_post_avg') or None.
    """
    if not isinstance(history, list) or not history:
        return None
    last = history[-1]
    if not isinstance(last, dict):
        return None
    try:
        tweak_ts = int(last.get("ts") or 0)
    except (TypeError, ValueError):
        return None
    if tweak_ts <= 0:
        return None
    before, after = _outcomes_split_by_ts(outcomes, tweak_ts)
    if len(before) < ROLLBACK_WINDOW or len(after) < ROLLBACK_WINDOW:
        return None
    # Use the 5 outcomes immediately before/after the tweak.
    pre_window = before[-ROLLBACK_WINDOW:]
    post_window = after[-ROLLBACK_WINDOW:]
    pre_avg = _avg_revenue(pre_window)
    post_avg = _avg_revenue(post_window)
    if pre_avg <= 0:
        return None
    if post_avg < pre_avg * ROLLBACK_REGRESSION_RATIO:
        last["_pre_avg"] = pre_avg
        last["_post_avg"] = post_avg
        return last
    return None


def _apply_rollback(prompts: dict, entry: dict) -> dict:
    """Restore prior_overrides from a history entry into prompts.

    For each role in prior_overrides:
      - if its value is a non-empty dict with a system_override string, restore it.
      - otherwise, delete that role's override key entirely.
    """
    prior = entry.get("prior_overrides") or {}
    if not isinstance(prior, dict):
        prior = {}
    for role, prior_val in prior.items():
        if (
            isinstance(prior_val, dict)
            and isinstance(prior_val.get("system_override"), str)
            and prior_val.get("system_override", "").strip()
        ):
            prompts[role] = {"system_override": prior_val["system_override"]}
        else:
            # Prior had no override → drop the current one.
            if role in prompts:
                del prompts[role]
    return prompts


def _snapshot_history(
    prompts: dict,
    role_tweaked: str,
    prior_overrides: dict,
    rationale: str,
    ts: int | None = None,
) -> None:
    """Append a history entry to prompts['_history'], capped at HISTORY_CAP entries."""
    import time as _time

    history = prompts.get("_history")
    if not isinstance(history, list):
        history = []
    entry = {
        "ts": int(ts if ts is not None else _time.time()),
        "role_tweaked": role_tweaked,
        "prior_overrides": prior_overrides,
        "rationale": rationale,
    }
    history.append(entry)
    if len(history) > HISTORY_CAP:
        history = history[-HISTORY_CAP:]
    prompts["_history"] = history


def _load_operator_feedback_by_role(limit_per_role: int = 12) -> dict[str, list[dict]]:
    """Read the role-bucketed operator ratings + notes Rust snapshots on every
    Activity rating. SI is the single agent that consumes this — its job is
    to distill operator criticism into a small prompt edit and relay it to
    whichever role most needs the change. Other workers stay clean."""
    path = os.path.expanduser("~/.agent-factory/operator_feedback.json")
    try:
        with open(path) as f:
            data = json.load(f)
        by_role = data.get("by_role")
        if not isinstance(by_role, dict):
            return {}
        out: dict[str, list[dict]] = {}
        for role, arr in by_role.items():
            if role not in VALID_ROLES or not isinstance(arr, list):
                continue
            cleaned: list[dict] = []
            for item in arr[:limit_per_role]:
                if not isinstance(item, dict):
                    continue
                rating = item.get("rating")
                if rating not in ("up", "down"):
                    continue
                note = item.get("note")
                cleaned.append({
                    "rating": rating,
                    "note": note if isinstance(note, str) and note.strip() else None,
                })
            if cleaned:
                out[role] = cleaned
        return out
    except Exception:
        return {}


def summarize_operator_feedback(by_role: dict[str, list[dict]]) -> str:
    """Render operator feedback per role for the SI synthesis prompt."""
    if not by_role:
        return "(no operator ratings yet)"
    lines: list[str] = []
    for role in VALID_ROLES:
        entries = by_role.get(role) or []
        if not entries:
            continue
        lines.append(f"{role}:")
        for e in entries:
            rating = e["rating"].upper()
            note = e.get("note")
            if note:
                lines.append(f"  · [{rating}] \"{note[:160]}\"")
            else:
                lines.append(f"  · [{rating}] (no note)")
    return "\n".join(lines) if lines else "(no operator ratings yet)"


def has_operator_feedback(by_role: dict[str, list[dict]]) -> bool:
    return any(entries for entries in by_role.values())


def build_si_prompt(
    outcomes_summary: str,
    current_prompts: dict,
    feedback_by_role: dict[str, list[dict]] | None = None,
) -> tuple[str, str]:
    feedback_by_role = feedback_by_role or {}
    system = (
        "You are the Self-Improvement Lab — the central learning loop for an "
        "autonomous Etsy shop. Two signals reach you each cycle:\n"
        " 1. Sales/views outcomes by niche (slow, downstream).\n"
        " 2. Operator ratings + notes on specific agent outputs from the "
        "Activity tab (fast, direct human signal).\n\n"
        "Your job: distill those signals into ONE small, targeted edit to ONE "
        "role's system_override that relays the lesson to that worker. The "
        "edit must capture the operator's criticism (or praise) in language "
        "the worker will actually use next time. Keep edits minimal — "
        "gradual improvement, not rewrites.\n\n"
        "PRIORITIZATION:\n"
        " · Operator feedback outranks outcomes — a human looking at the "
        "output is the highest-fidelity signal. If the operator down-rated "
        "a role's output with a note, FIX that exact issue in that role's "
        "prompt this cycle.\n"
        " · UP ratings tell you what to lock in. If a pattern just got "
        "praised, bake the language into the prompt so the worker repeats it.\n"
        " · Use outcomes to break ties when feedback is silent or split.\n\n"
        "Output JSON only, no prose, no markdown:\n"
        '{"role": "research|designer|listing|cs|null", '
        '"new_system": "<full replacement string for that role\'s system prompt>", '
        '"reasoning": "<one short sentence — cite the operator note if you used it>"}\n'
        'Use role=null (and new_system="") if no change is warranted.'
    )
    prompts_view: dict = {}
    for r in VALID_ROLES:
        ov = current_prompts.get(r, {}) if isinstance(current_prompts.get(r), dict) else {}
        prompts_view[r] = ov.get("system_override") if isinstance(ov, dict) else None
    user = (
        "Recent operator ratings (HIGHEST PRIORITY — humans rating specific "
        "outputs in the Activity tab):\n"
        f"{summarize_operator_feedback(feedback_by_role)}\n\n"
        f"Recent outcomes (downstream sales signal):\n{outcomes_summary}\n\n"
        f"Current system_overrides (null means using each worker's hardcoded default):\n"
        f"{json.dumps(prompts_view, indent=2)}\n\n"
        "If operator feedback is present, the edit MUST address the most "
        "recent DOWN note (or amplify the most recent UP pattern). Propose "
        "at most ONE edit. Return JSON only."
    )
    return system, user


def call_anthropic(
    api_key: str,
    outcomes_summary: str,
    current_prompts: dict,
    feedback_by_role: dict[str, list[dict]] | None = None,
) -> tuple[dict, int, int]:
    system_prompt, user_prompt = build_si_prompt(
        outcomes_summary, current_prompts, feedback_by_role
    )

    body = json.dumps({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system_prompt,
                "messages": _messages_for_json_call(user_prompt),
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

    parsed = _parse_loose_json_object(text)
    return parsed, tokens_in, tokens_out


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
    feedback_by_role = _load_operator_feedback_by_role()
    has_feedback = has_operator_feedback(feedback_by_role)
    # Skip the outcomes-only gate when there's operator feedback: humans
    # rating outputs is a strong enough signal to relay immediately, no
    # need to wait for downstream sales.
    if len(outcomes) < MIN_OUTCOMES and not has_feedback:
        print(
            f"[si] job_id={job_id} only {len(outcomes)} outcomes and no operator feedback — waiting (need ≥{MIN_OUTCOMES} or any rating)",
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

    # Rollback check (no Anthropic call): if the most recent history entry's
    # post-tweak revenue regressed enough vs pre-tweak, revert it.
    current = read_prompts()
    history = current.get("_history") if isinstance(current.get("_history"), list) else []
    rollback_entry = _should_rollback(history, outcomes)
    if rollback_entry is not None:
        rolled_role = rollback_entry.get("role_tweaked", "?")
        pre_avg = float(rollback_entry.get("_pre_avg") or 0.0)
        post_avg = float(rollback_entry.get("_post_avg") or 0.0)
        # Snapshot what we are about to restore so subsequent rollbacks have provenance.
        prior_overrides = rollback_entry.get("prior_overrides") or {}
        if not isinstance(prior_overrides, dict):
            prior_overrides = {}
        # Apply the rollback to the prompts dict.
        _apply_rollback(current, rollback_entry)
        # Pop the rolled-back entry, then append a rollback record.
        current["_history"] = history[:-1]
        _snapshot_history(
            current,
            role_tweaked="rollback",
            prior_overrides=dict(prior_overrides),
            rationale=f"post-tweak avg ${post_avg:.2f} vs pre ${pre_avg:.2f}",
        )
        try:
            write_prompts(_prompts_path(), current)
        except Exception as e:
            print(f"[si] job_id={job_id} ROLLBACK WRITE ERROR: {e}", file=sys.stderr, flush=True)
            return {
                "ok": True,
                "ticker_text": "si · skipped",
                "role_tweaked": None,
                "model": MODEL,
                "tokens_in": 0,
                "tokens_out": 0,
            }
        print(
            f"[si] job_id={job_id} rollback role={rolled_role} pre=${pre_avg:.2f} post=${post_avg:.2f}",
            file=sys.stderr,
            flush=True,
        )
        return {
            "ok": True,
            "ticker_text": f"si · rollback · {rolled_role} reverted",
            "role_tweaked": "rollback",
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
        summary = summarize_outcomes(outcomes)
        print(
            f"[si] job_id={job_id} {len(outcomes)} outcomes — calling Anthropic model={MODEL}",
            file=sys.stderr,
            flush=True,
        )
        proposal, tokens_in, tokens_out = call_anthropic(
            api_key, summary, current, feedback_by_role
        )
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
        # Snapshot prior overrides for this role into history BEFORE mutating,
        # so a future rollback can restore exactly what was here.
        prior_for_role: dict
        existing = current.get(role)
        if isinstance(existing, dict) and isinstance(existing.get("system_override"), str) and existing.get("system_override", "").strip():
            prior_for_role = {role: {"system_override": existing["system_override"]}}
        else:
            prior_for_role = {role: {}}
        rationale = ""
        if isinstance(proposal, dict):
            r = proposal.get("reasoning")
            if isinstance(r, str):
                rationale = r
        # Tag the history entry so the team can see this tweak was operator-driven.
        # `_history` is what surfaces in the Prompts panel — operators can audit
        # exactly which note caused which prompt change.
        role_feedback = feedback_by_role.get(role) or []
        if role_feedback:
            rationale = (rationale + " [relayed from operator feedback]").strip()
        # Persist override.
        current[role] = {"system_override": new_system}
        _snapshot_history(current, role_tweaked=role, prior_overrides=prior_for_role, rationale=rationale)
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
