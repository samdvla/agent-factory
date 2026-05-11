import json
import os
import sys
import urllib.request
import urllib.error

ANTHROPIC_BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")


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


def _load_system_override(role: str) -> str | None:
    """Read ~/.agent-factory/prompts.json and return system_override for role, or None."""
    path = os.path.expanduser("~/.agent-factory/prompts.json")
    try:
        with open(path) as f:
            data = json.load(f)
        ov = data.get(role, {}).get("system_override")
        if isinstance(ov, str) and ov.strip():
            return ov
    except Exception:
        pass
    return None


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
