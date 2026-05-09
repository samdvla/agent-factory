import json
import os
import sys
import urllib.request
import urllib.error
from .protocol import Protocol

MODEL = "claude-haiku-4-5-20251001"
MAX_TOKENS = 600


def build_demand_brief_prompt() -> tuple[str, str]:
    system = (
        "You are a Market Research Analyst at an AI-run digital products Etsy shop. "
        "Your job is to identify a profitable niche and return a structured JSON Demand Brief. "
        "Be concise and specific. Only return valid JSON, no prose, no markdown."
    )
    user = (
        "Generate a Demand Brief for a digital-product Etsy shop. "
        "Pick a niche that's currently in demand for printables, SVGs, or digital templates. "
        "Return JSON only with this exact shape:\n"
        "{\n"
        '  "niche": "<short specific niche, e.g. \'minimalist line art prints\'>",\n'
        '  "keywords": ["<10-15 SEO keywords>"],\n'
        '  "price_band_usd": [<low>, <high>],\n'
        '  "competition": "<low|medium|high>",\n'
        '  "rationale": "<one sentence reasoning>"\n'
        "}"
    )
    return system, user


def call_anthropic(api_key: str) -> dict:
    system_prompt, user_prompt = build_demand_brief_prompt()

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

    print(f"[research] job_id={job_id} calling Anthropic model={MODEL}", file=sys.stderr, flush=True)
    try:
        brief, tokens_in, tokens_out = call_anthropic(api_key)
        ticker_text = (
            f"niche: {brief['niche']} · {brief['competition']} comp "
            f"· ${brief['price_band_usd'][0]}-{brief['price_band_usd'][1]}"
        )
        print(f"[research] job_id={job_id} done in={tokens_in} out={tokens_out}", file=sys.stderr, flush=True)
        return {
            "ok": True,
            "brief": brief,
            "ticker_text": ticker_text,
            "model": MODEL,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "handoff": {
                "to_role": "designer",
                "payload": {"brief": brief},
            },
        }
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
