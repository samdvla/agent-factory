import json
import os
import sys
import urllib.request
import urllib.error

MODEL = "claude-haiku-4-5-20251001"
MAX_TOKENS = 900


def build_listing_prompt(brief: dict, asset: dict) -> tuple[str, str]:
    system = (
        "You are the Listing Copywriter at an AI-run digital-products Etsy shop. "
        "Given a Demand Brief and an Asset Description, produce a complete Etsy listing draft. "
        "Title must be ≤140 chars. Exactly 13 tags. "
        "Description should be SEO-tuned and policy-compliant "
        "(digital download, no shipping, no custom work without explicit policy). "
        "Return JSON only:\n"
        "{\n"
        '  "title": "<≤140 chars>",\n'
        '  "tags": ["<exactly 13 tags>"],\n'
        '  "description": "<200-400 word listing description>",\n'
        '  "materials": ["digital download"],\n'
        '  "price_usd": <number>\n'
        "}"
    )
    user = json.dumps({"brief": brief, "asset": asset})
    return system, user


def call_anthropic(api_key: str, brief: dict, asset: dict) -> tuple[dict, int, int]:
    system_prompt, user_prompt = build_listing_prompt(brief, asset)

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


def validate_listing(listing: dict) -> list[str]:
    errors = []
    title = listing.get("title", "")
    if len(title) > 140:
        errors.append(f"title too long: {len(title)} chars (max 140)")
    tags = listing.get("tags", [])
    if len(tags) != 13:
        errors.append(f"tags count wrong: {len(tags)} (must be exactly 13)")
    return errors


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}

    job_id = params.get("job_id", 0)
    payload = params.get("payload", {})
    brief = payload.get("brief", {})
    asset = payload.get("asset", {})

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        msg = "ANTHROPIC_API_KEY not set"
        print(f"[listing] ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"listing failed: {msg}",
        }

    print(f"[listing] job_id={job_id} calling Anthropic model={MODEL}", file=sys.stderr, flush=True)
    try:
        listing, tokens_in, tokens_out = call_anthropic(api_key, brief, asset)
        errors = validate_listing(listing)
        if errors:
            msg = "; ".join(errors)
            print(f"[listing] job_id={job_id} validation error: {msg}", file=sys.stderr, flush=True)
            return {
                "ok": False,
                "error": msg,
                "ticker_text": f"listing validation failed: {msg}",
            }
        title = listing.get("title", "")
        price = listing.get("price_usd", 0)
        print(f"[listing] job_id={job_id} done title={title!r:.40} in={tokens_in} out={tokens_out}", file=sys.stderr, flush=True)
        return {
            "ok": True,
            "listing": listing,
            "ticker_text": f"listing → publisher: \"{title[:60]}\" ${price}",
            "model": MODEL,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "handoff": {
                "to_role": "publisher",
                "payload": {"listing": listing},
            },
        }
    except Exception as e:
        msg = str(e)
        print(f"[listing] job_id={job_id} ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"listing failed: {msg}",
        }
