import json
import os
import sys
import urllib.request
import urllib.error
from .protocol import Protocol

MODEL = "claude-haiku-4-5-20251001"
MAX_TOKENS = 600


def _retry_request(req: urllib.request.Request, timeout: int = 60, max_attempts: int = 3) -> str:
    """POST with exponential backoff. Retries on 5xx and URLError. Does NOT retry on 4xx.
    Returns the response body as utf-8 string. Raises on final failure."""
    import time as _time
    last_exc: Exception | None = None
    for attempt in range(max_attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            last_exc = e
            # Retry only 5xx; 4xx is persistent.
            if 500 <= e.code < 600 and attempt < max_attempts - 1:
                delay = (2 ** attempt)  # 1s, 2s, 4s
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


JSON_SHAPE = (
    "{\n"
    '  "niche": "<short specific niche, e.g. \'minimalist line art prints\'>",\n'
    '  "keywords": ["<10-15 SEO keywords>"],\n'
    '  "price_band_usd": [<low>, <high>],\n'
    '  "competition": "<low|medium|high>",\n'
    '  "rationale": "<one sentence reasoning>"\n'
    "}"
)


def build_demand_brief_prompt(niche_seed: str | None = None, rationale: str | None = None) -> tuple[str, str]:
    system = (
        "You are a Market Research Analyst at an AI-run digital products Etsy shop. "
        "Your job is to identify a profitable niche and return a structured JSON Demand Brief. "
        "Be concise and specific. Only return valid JSON, no prose, no markdown."
    )
    if niche_seed:
        seed_text = niche_seed
        rat_text = rationale or "no rationale provided"
        user = (
            f'The strategy lead picked this niche to pursue: "{seed_text}" — rationale: "{rat_text}". '
            f"Build a Demand Brief for it. Return JSON only with the shape {JSON_SHAPE}"
        )
    else:
        user = (
            "Generate a Demand Brief for a digital-product Etsy shop. "
            "Pick a niche that's currently in demand for printables, SVGs, or digital templates. "
            f"Return JSON only with this exact shape:\n{JSON_SHAPE}"
        )
    return system, user


def call_anthropic(api_key: str, niche_seed: str | None = None, rationale: str | None = None) -> dict:
    system_prompt, user_prompt = build_demand_brief_prompt(niche_seed=niche_seed, rationale=rationale)
    override = _load_system_override("research")
    if override:
        system_prompt = override

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

    brief = json.loads(text)
    return brief, tokens_in, tokens_out


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}

    job_id = params.get("job_id", 0)
    payload = params.get("payload", {})
    return process_job(job_id, payload)


def process_job(job_id: int, payload: dict) -> dict:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        msg = "ANTHROPIC_API_KEY not set — cannot call Anthropic"
        print(f"[research] ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"research failed: {msg}",
        }

    niche_seed: str | None = payload.get("niche_seed") or None
    rationale: str | None = payload.get("rationale") or None
    # cycle_id is the chain identifier the orchestrator generated at the head
    # of this pipeline run. We propagate it but never invent one — a missing
    # cycle_id means this job was kicked off outside the pipeline, and we want
    # the supervisor to skip P&L attribution for it.
    cycle_id = payload.get("cycle_id") if isinstance(payload, dict) else None
    if niche_seed:
        print(f"[research] job_id={job_id} seeded niche={niche_seed!r} calling Anthropic model={MODEL}", file=sys.stderr, flush=True)
    else:
        print(f"[research] job_id={job_id} calling Anthropic model={MODEL} (no seed)", file=sys.stderr, flush=True)
    try:
        brief, tokens_in, tokens_out = call_anthropic(api_key, niche_seed=niche_seed, rationale=rationale)
        ticker_text = (
            f"niche: {brief['niche']} · {brief['competition']} comp "
            f"· ${brief['price_band_usd'][0]}-{brief['price_band_usd'][1]}"
        )
        print(f"[research] job_id={job_id} done in={tokens_in} out={tokens_out}", file=sys.stderr, flush=True)
        handoff_payload: dict = {"brief": brief}
        if cycle_id:
            handoff_payload["cycle_id"] = cycle_id
        result: dict = {
            "ok": True,
            "brief": brief,
            "ticker_text": ticker_text,
            "model": MODEL,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "handoff": {
                "to_role": "designer",
                "payload": handoff_payload,
            },
        }
        if cycle_id:
            result["cycle_id"] = cycle_id
        return result
    except Exception as e:
        msg = str(e)
        print(f"[research] job_id={job_id} ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"research failed: {msg}",
        }


def run() -> None:
    p = Protocol()
    p.send_notification("event", {"kind": "started"})
    while True:
        msg = p.read_message()
        if msg is None:
            break
        rid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params", {})
        try:
            if method == "process_job":
                job_id = params.get("job_id", 0)
                payload = params.get("payload", {})
                result = process_job(job_id, payload)
                # Check for handoff before sending response
                handoff = result.pop("handoff", None) if isinstance(result, dict) else None
                if handoff:
                    p.send_notification("enqueue_handoff", {
                        "to_role": handoff["to_role"],
                        "payload": handoff["payload"],
                    })
                if rid is not None:
                    p.send_response(rid, result)
            elif method == "ping":
                if rid is not None:
                    p.send_response(rid, {"ok": True})
            else:
                if rid is not None:
                    p.send_error(rid, -32601, f"method not found: {method}")
        except Exception as e:
            if rid is not None:
                p.send_error(rid, -32000, str(e))
