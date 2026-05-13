import json
import os
import sys
import urllib.request
import urllib.error

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


def _override_compatible_with_focus(override: str | None) -> bool:
    """Reject overrides that drifted back to the pre-3D-pivot world. Same
    rationale as the designer/research/listing copies — kept per-worker so
    each loads its own override safely without a shared module dependency."""
    if not override:
        return True
    focus = os.environ.get("SHOP_FOCUS", "3d_only").strip().lower()
    if focus != "3d_only":
        return True
    s = override.lower()
    stale_markers = (
        "kiss-cut", "kiss cut", "sticker shop", "sticker-first", "kiss-cut vinyl",
        "viewbox", "svg markup",
        "adhd routine", "adhd planner", "planner bundle", "printable wall art",
    )
    return not any(m in s for m in stale_markers)


def _load_system_override(role: str) -> str | None:
    """Read ~/.agent-factory/prompts.json and return system_override for role, or None.

    Rejects overrides that fail _override_compatible_with_focus.
    """
    path = os.path.expanduser("~/.agent-factory/prompts.json")
    try:
        with open(path) as f:
            data = json.load(f)
        ov = data.get(role, {}).get("system_override")
        if isinstance(ov, str) and ov.strip():
            if not _override_compatible_with_focus(ov):
                print(
                    f"[cs] rejecting stale {role}.system_override "
                    f"({len(ov)} chars, contains pre-3D-pivot markers); "
                    "falling back to built-in baseline",
                    file=sys.stderr, flush=True,
                )
                return None
            return ov
    except Exception:
        pass
    return None


def _load_operator_steers(role: str) -> list[str]:
    """Read operator standing instructions written from the ChatPanel Steer
    action. Returns [] when missing or malformed."""
    path = os.path.expanduser("~/.agent-factory/prompts.json")
    try:
        with open(path) as f:
            data = json.load(f)
        arr = data.get(role, {}).get("operator_steers")
        if isinstance(arr, list):
            return [s for s in arr if isinstance(s, str) and s.strip()]
    except Exception:
        pass
    return []


def _append_operator_steers(system_prompt: str, role: str) -> str:
    """Append operator standing instructions as the final block. Operator
    steers compose with and take precedence over the strategist-tuned
    override, because the last block in the system prompt gets the model's
    strongest attention."""
    steers = _load_operator_steers(role)
    if not steers:
        return system_prompt
    block = (
        "OPERATOR STANDING INSTRUCTIONS (operator-set, highest priority — "
        "apply to this job):\n"
        + "\n".join(f"- {s}" for s in steers)
    )
    return system_prompt.rstrip() + "\n\n" + block


def build_reply_prompt(buyer_message: str, listing_title: str | None = None) -> tuple[str, str]:
    system = (
        "You are the Customer Service agent at an AI-run digital-products Etsy shop. "
        "All products are digital downloads — no shipping, no physical inventory, no custom work. "
        "Respond to the buyer's message with a polite, policy-compliant reply. "
        "If the buyer requests a refund, asks for custom work, or raises a dispute, "
        "do NOT promise anything — say you'll escalate to the shop owner. "
        "Keep replies under 60 words. Return JSON only:\n"
        '{"reply": "<your reply>", "escalate": <true|false>, "category": "<file_format|refund_request|custom_request|policy_question|thank_you|other>"}'
    )
    listing_ref = f' (re: listing "{listing_title}")' if listing_title else ""
    user = f'A buyer messaged{listing_ref}: "{buyer_message}". Draft a reply.'
    return system, user


def call_claude(system: str, user: str, max_tokens: int = 400) -> dict:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise RuntimeError("ANTHROPIC_API_KEY not set")
    body = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": max_tokens,
        "system": system,
        "messages": [{"role": "user", "content": user}],
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{ANTHROPIC_BASE_URL}/v1/messages",
        data=body,
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    raw = _retry_request(req, timeout=110)
    return json.loads(raw)


def handle(method, params):
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}
    payload = params.get("payload", {})
    buyer_message = payload.get("buyer_message", "Hi! How do I download my purchase?")
    listing_title = payload.get("listing_title")
    # `conversation_id` is set when the message came from real Etsy ingest; the
    # supervisor reads it back from the result and POSTs the reply to that
    # conversation. Echo it through verbatim (default None).
    conversation_id = payload.get("conversation_id")
    try:
        system, user = build_reply_prompt(buyer_message, listing_title)
        override = _load_system_override("cs")
        if override:
            system = override
        system = _append_operator_steers(system, "cs")
        resp = call_claude(system, user)
        text = resp["content"][0]["text"]
        parsed = json.loads(text)
        return {
            "ok": True,
            "reply": parsed.get("reply", ""),
            "escalate": parsed.get("escalate", False),
            "category": parsed.get("category", "other"),
            "conversation_id": conversation_id,
            "ticker_text": f"cs · {parsed.get('category','other')} · {'escalated' if parsed.get('escalate') else 'replied'}",
            "tokens_in": resp.get("usage", {}).get("input_tokens", 0),
            "tokens_out": resp.get("usage", {}).get("output_tokens", 0),
            "model": "claude-haiku-4-5-20251001",
        }
    except Exception as e:
        return {
            "ok": False,
            "error": str(e),
            "conversation_id": conversation_id,
            "ticker_text": f"cs failed: {e}",
        }
