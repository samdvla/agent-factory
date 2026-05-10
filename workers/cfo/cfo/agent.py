import json
import os
import random
import sys
import time
import urllib.request

MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 200


def _append_outcome(outcome: dict) -> None:
    """Append one JSON line to ~/.agent-factory/outcomes.jsonl. Failures are non-fatal."""
    try:
        data_dir = os.environ.get("AGENT_FACTORY_DATA", os.path.expanduser("~/.agent-factory"))
        os.makedirs(data_dir, exist_ok=True)
        path = os.path.join(data_dir, "outcomes.jsonl")
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(outcome) + "\n")
    except Exception as e:
        print(f"[cfo] WARN failed to append outcomes.jsonl: {e}", file=sys.stderr, flush=True)


def _build_buyer_prompt(
    brief: dict,
    asset_brief: str,
    title: str,
    description: str,
    tags: list,
    price_usd: float,
    asset_path: str | None = None,
) -> tuple[str, str]:
    system = (
        "You simulate a panel of typical Etsy shoppers browsing digital downloads. "
        "Given a product, estimate how many week-1 sales it would realistically get. "
        "Typical fresh listings: 0-3 sales/week. Strong listings (great niche fit, "
        "polished title, accurate tags, fair price): 3-7. Exceptional: 7-10. Be honest — "
        "weak products should get 0. Output JSON only with shape: "
        '{"sales": <int 0-10>, "rationale": "<one sentence>"}.'
    )
    if asset_path:
        asset_line = f"<svg saved at {asset_path}>"
    else:
        asset_line = "(no asset attached — text-only)"
    user = (
        f"Niche: {brief.get('niche', 'unknown')}\n"
        f"Competition: {brief.get('competition', 'unknown')}\n"
        f"Asset description: {asset_brief or '(none)'}\n"
        f"Asset: {asset_line}\n"
        f"Listing title: {title}\n"
        f"Tags: {', '.join(tags or [])}\n"
        f"Price: ${price_usd}\n"
        f"Description: {description[:600]}\n\n"
        "Estimate week-1 sales. JSON only."
    )
    return system, user


def _call_buyer_panel(
    api_key: str,
    brief: dict,
    asset_brief: str,
    title: str,
    description: str,
    tags: list,
    price_usd: float,
    asset_path: str | None = None,
) -> tuple[int, str, int, int] | None:
    """Returns (sales, rationale, tokens_in, tokens_out) on success, None on any failure."""
    try:
        system, user = _build_buyer_prompt(
            brief, asset_brief, title, description, tags, price_usd, asset_path
        )
        body = json.dumps({
            "model": MODEL,
            "max_tokens": MAX_TOKENS,
            "system": system,
            "messages": [{"role": "user", "content": user}],
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
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
        response = json.loads(raw)
        text = response["content"][0]["text"].strip()
        if text.startswith("```"):
            lines = text.split("\n")
            text = "\n".join(lines[1:-1]) if len(lines) > 2 else text
        result = json.loads(text)
        sales = int(result.get("sales", 0))
        sales = max(0, min(10, sales))  # clamp 0-10
        rationale = str(result.get("rationale", ""))[:200]
        usage = response.get("usage", {})
        return sales, rationale, usage.get("input_tokens", 0), usage.get("output_tokens", 0)
    except Exception as e:
        print(f"[cfo] buyer panel call failed, falling back to gaussian: {e}", file=sys.stderr, flush=True)
        return None


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}

    job_id = params.get("job_id", 0)
    payload = params.get("payload", {})
    listing_id = payload.get("listing_id")
    price = payload.get("price_usd", 4.0)
    if price is None:
        price = 4.0
    niche = payload.get("niche")
    title = payload.get("title", "") or ""
    description = payload.get("description", "") or ""
    tags = payload.get("tags") or []
    asset_brief = payload.get("asset_brief", "") or ""
    asset_path = payload.get("asset_path")
    if not isinstance(asset_path, str) or not asset_path:
        asset_path = None
    brief = payload.get("brief") or {}
    if not isinstance(brief, dict):
        brief = {}

    # Try Sonnet-rated buyer panel; fall back to gaussian on any failure or missing key.
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    panel_result = None
    if api_key:
        panel_result = _call_buyer_panel(
            api_key, brief, asset_brief, title, description, tags, price, asset_path
        )

    rationale = ""
    tokens_in = 0
    tokens_out = 0
    used_sonnet = False

    if panel_result is not None:
        sales, rationale, tokens_in, tokens_out = panel_result
        used_sonnet = True
    else:
        # Fallback: simulate week-1 sales as before (0-3 typical).
        sales = max(0, int(random.gauss(1.2, 1.0)))

    gross = round(sales * price, 2)
    fees = round(gross * 0.065 + sales * 0.20, 2)  # 6.5% + $0.20/listing
    net = round(gross - fees, 2)

    print(
        f"[cfo] job_id={job_id} listing_id={listing_id} sales={sales} gross=${gross} net=${net} sonnet={used_sonnet}",
        file=sys.stderr,
        flush=True,
    )

    # Record outcome for the SI loop. Failures must not crash cfo.
    outcome = {
        "ts": int(time.time()),
        "listing_id": listing_id,
        "niche": niche,
        "sales": sales,
        "revenue_usd": gross,
    }
    if used_sonnet and rationale:
        outcome["rationale"] = rationale
    _append_outcome(outcome)

    if used_sonnet:
        ticker_text = (
            f"cfo · listing #{listing_id}: {sales} sales · gross ${gross} · net ${net}"
            f" · {rationale[:60]}"
        )
    else:
        ticker_text = f"cfo · listing #{listing_id}: {sales} sales · gross ${gross} · net ${net}"

    result: dict = {
        "ok": True,
        "listing_id": listing_id,
        "sales_w1": sales,
        "gross_usd": gross,
        "fees_usd": fees,
        "net_usd": net,
        "ticker_text": ticker_text,
        # Kick off the next product cycle after a 60 s cooldown.
        "handoff": {
            "to_role": "orchestrator",
            "payload": {
                "trigger": "cfo_close",
                "prev_listing_id": listing_id,
                "prev_net_usd": net,
            },
            "delay_ms": 60_000,
        },
    }

    # Only include model/token fields when Sonnet was actually used — supervisor
    # gates BudgetSpent emission on all three being present.
    if used_sonnet:
        result["model"] = MODEL
        result["tokens_in"] = tokens_in
        result["tokens_out"] = tokens_out
        result["rationale"] = rationale

    return result
