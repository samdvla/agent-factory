import json
import os
import random
import sys
import time


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

    # Simulate week 1 sales: 0-3 units typical for a fresh listing.
    sales = max(0, int(random.gauss(1.2, 1.0)))
    gross = round(sales * price, 2)
    fees = round(gross * 0.065 + sales * 0.20, 2)  # 6.5% + $0.20/listing
    net = round(gross - fees, 2)

    print(
        f"[cfo] job_id={job_id} listing_id={listing_id} sales={sales} gross=${gross} net=${net}",
        file=sys.stderr,
        flush=True,
    )

    # Record outcome for the SI loop. Failures must not crash cfo.
    _append_outcome({
        "ts": int(time.time()),
        "listing_id": listing_id,
        "niche": niche,
        "sales": sales,
        "revenue_usd": gross,
    })

    return {
        "ok": True,
        "listing_id": listing_id,
        "sales_w1": sales,
        "gross_usd": gross,
        "fees_usd": fees,
        "net_usd": net,
        "ticker_text": f"cfo · listing #{listing_id}: {sales} sales · gross ${gross} · net ${net}",
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
