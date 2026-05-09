import hashlib
import json
import os
import sys
from datetime import datetime, timezone


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}

    job_id = params.get("job_id", 0)
    payload = params.get("payload", {})
    listing = payload.get("listing", {})
    title = listing.get("title", "untitled")

    listing_id = int(hashlib.sha256(title.encode()).hexdigest()[:12], 16) % 10_000_000
    record = {
        "listing_id": listing_id,
        "title": title,
        "price_usd": listing.get("price_usd"),
        "tags": listing.get("tags"),
        "published_at": datetime.now(timezone.utc).isoformat(),
        "status": "live",
    }

    # Store in a JSON file (sandbox mode — no real Etsy).
    data_dir = os.environ.get("AGENT_FACTORY_DATA", os.path.expanduser("~/.agent-factory"))
    os.makedirs(data_dir, exist_ok=True)
    path = os.path.join(data_dir, "mock_etsy.json")
    try:
        with open(path) as f:
            current = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        current = []
    current.append(record)
    with open(path, "w") as f:
        json.dump(current, f, indent=2)

    print(f"[publisher] job_id={job_id} published listing_id={listing_id} title={title!r:.40}", file=sys.stderr, flush=True)

    return {
        "ok": True,
        "listing_id": listing_id,
        "ticker_text": f"publisher → cfo: listing #{listing_id} LIVE (sandbox)",
        "handoff": {
            "to_role": "cfo",
            "payload": {"listing_id": listing_id, "price_usd": record["price_usd"]},
        },
    }
