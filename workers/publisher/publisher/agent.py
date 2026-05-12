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
    brief = payload.get("brief", {})
    asset = payload.get("asset", {})
    cycle_id = payload.get("cycle_id") if isinstance(payload, dict) else None
    niche = brief.get("niche") if isinstance(brief, dict) else None
    title = listing.get("title", "untitled")

    listing_id = int(hashlib.sha256(title.encode()).hexdigest()[:12], 16) % 10_000_000
    asset_path = asset.get("asset_path") if isinstance(asset, dict) else None
    record = {
        "listing_id": listing_id,
        "title": title,
        "description": listing.get("description", ""),
        "price_usd": listing.get("price_usd"),
        "tags": listing.get("tags"),
        "niche": niche,
        "published_at": datetime.now(timezone.utc).isoformat(),
        "status": "live",
        "asset_path": asset_path,
    }

    # Write a local audit record. The Rust supervisor handles real Etsy publishing.
    data_dir = os.environ.get("AGENT_FACTORY_DATA", os.path.expanduser("~/.agent-factory"))
    os.makedirs(data_dir, exist_ok=True)
    path = os.path.join(data_dir, "publisher_output.json")
    try:
        with open(path) as f:
            current = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        current = []
    current.append(record)
    with open(path, "w") as f:
        json.dump(current, f, indent=2)

    print(f"[publisher] job_id={job_id} published listing_id={listing_id} title={title!r:.40}", file=sys.stderr, flush=True)

    product_type = brief.get("product_type", "digital_print") if isinstance(brief, dict) else "digital_print"
    cfo_payload: dict = {
        "listing_id": listing_id,
        "price_usd": record["price_usd"],
        "niche": niche,
        "title": listing.get("title", ""),
        "description": listing.get("description", ""),
        "tags": listing.get("tags", []),
        "asset_brief": (
            asset.get("brief_for_image_gen", "")
            if isinstance(asset, dict)
            else ""
        ) or payload.get("asset_brief", ""),
        "asset_path": asset_path,
        "brief": brief if isinstance(brief, dict) else {},
    }
    if cycle_id:
        cfo_payload["cycle_id"] = cycle_id
    result: dict = {
        "ok": True,
        "listing_id": listing_id,
        "ticker_text": f"publisher → cfo: listing #{listing_id} prepared",
        # Etsy / POD publish hooks (Rust supervisor reads these). Flat top-level
        # fields so the supervisor doesn't have to reach into the cfo payload.
        "title": title,
        "description": listing.get("description", ""),
        "tags": listing.get("tags", []) or [],
        "price_usd": record["price_usd"],
        "niche": niche,
        "asset_path": asset_path,
        "product_type": product_type,  # supervisor uses this to route to POD or direct-Etsy
        "job_id": job_id,
        "handoff": {
            "to_role": "cfo",
            "payload": cfo_payload,
        },
    }
    if cycle_id:
        result["cycle_id"] = cycle_id
    return result
