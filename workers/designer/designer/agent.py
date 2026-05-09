import json
import os
import sys
import urllib.request
import urllib.error

MODEL = "claude-haiku-4-5-20251001"
MAX_TOKENS = 600


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


def build_designer_prompt(brief: dict) -> tuple[str, str]:
    system = (
        "You are the Designer at an AI-run digital-products Etsy shop. "
        "Given a Demand Brief, produce an asset description that an image generator "
        "would render into the actual product. Be specific about style, palette, "
        "composition, and dimensions. Return JSON only:\n"
        "{\n"
        '  "asset_type": "<printable | svg | template | ebook>",\n'
        '  "style": "<descriptive style notes, 1 sentence>",\n'
        '  "palette": ["<hex>", "<hex>", "<hex>"],\n'
        '  "dimensions": "<e.g. \'8.5x11 inch printable, 300dpi\'>",\n'
        '  "mockup_count": <int 1-4>,\n'
        '  "brief_for_image_gen": "<single concise prompt suitable for SDXL>"\n'
        "}"
    )
    user = json.dumps(brief)
    return system, user


def call_anthropic(api_key: str, brief: dict) -> tuple[dict, int, int]:
    system_prompt, user_prompt = build_designer_prompt(brief)
    override = _load_system_override("designer")
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
    payload = params.get("payload", {})
    brief = payload.get("brief", payload)  # accept brief directly or nested

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        msg = "ANTHROPIC_API_KEY not set"
        print(f"[designer] ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"designer failed: {msg}",
        }

    print(f"[designer] job_id={job_id} calling Anthropic model={MODEL}", file=sys.stderr, flush=True)
    try:
        asset, tokens_in, tokens_out = call_anthropic(api_key, brief)
        asset_type = asset.get("asset_type", "printable")
        dimensions = asset.get("dimensions", "")
        print(f"[designer] job_id={job_id} done asset_type={asset_type!r} in={tokens_in} out={tokens_out}", file=sys.stderr, flush=True)
        return {
            "ok": True,
            "asset": asset,
            "ticker_text": f"designer → listing: {asset_type} · {dimensions}",
            "model": MODEL,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "handoff": {
                "to_role": "listing",
                "payload": {"brief": brief, "asset": asset},
            },
        }
    except Exception as e:
        msg = str(e)
        print(f"[designer] job_id={job_id} ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"designer failed: {msg}",
        }
