import json
import os
import sys
import urllib.request
import urllib.error

MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 400


def build_orchestrator_prompt() -> tuple[str, str]:
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
    return system, user


def call_anthropic(api_key: str) -> tuple[dict, int, int]:
    system_prompt, user_prompt = build_orchestrator_prompt()

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

    data = json.loads(text)
    return data, tokens_in, tokens_out


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}

    job_id = params.get("job_id", 0)
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        msg = "ANTHROPIC_API_KEY not set"
        print(f"[orchestrator] ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"orchestrator failed: {msg}",
        }

    print(f"[orchestrator] job_id={job_id} calling Anthropic model={MODEL}", file=sys.stderr, flush=True)
    try:
        data, tokens_in, tokens_out = call_anthropic(api_key)
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
            "handoff": {
                "to_role": "research",
                "payload": {"niche_seed": niche_seed, "rationale": rationale},
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
