import hashlib
import json
import os
import sys
from datetime import datetime, timezone

from . import pinterest_pin


# Operator-toggleable. Default ON: pin generation is local-only (no API auth)
# and adds <100ms per cycle, so the trade-off is in favour of always having
# the pin ready for an operator manual post. Flip to "0" to skip in tight
# perf / disk environments.
PINTEREST_PIN_ENABLED_DEFAULT = "1"


def _pinterest_pin_enabled() -> bool:
    return (
        os.environ.get("PINTEREST_PIN_ENABLED", PINTEREST_PIN_ENABLED_DEFAULT).strip()
        == "1"
    )


def _generate_pinterest_pin(
    asset: dict, listing: dict, job_id: int, data_dir: str
) -> str | None:
    """Render a 1000×1500 Pinterest pin from the designer's first preview
    image. Returns the pin path on success, None when there's no source
    image to seed from or any rendering step fails. Pinterest is the #1
    external traffic source to Etsy (~41% of clicks), so even when the
    rest of the cycle is unchanged, having a pin per listing lets the
    operator queue Pinterest posts without re-running anything."""
    if not _pinterest_pin_enabled():
        return None
    # Source = first preview PNG the designer produced. preview_pngs is the
    # multi-angle list; falls through to a singleton preview_png field for
    # legacy / bundle-degraded callers.
    source: str | None = None
    if isinstance(asset, dict):
        raw = asset.get("preview_pngs")
        if isinstance(raw, list):
            for p in raw:
                if isinstance(p, str) and p and os.path.exists(p):
                    source = p
                    break
        if not source:
            p = asset.get("preview_png")
            if isinstance(p, str) and p and os.path.exists(p):
                source = p
    if not source:
        return None
    title = listing.get("title") if isinstance(listing, dict) else ""
    if not isinstance(title, str):
        title = ""
    out_path = pinterest_pin.derive_pin_path(source, job_id, data_dir)
    return pinterest_pin.generate_pin(source, title, out_path)


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
    # Multi-angle PNGs from the designer (None for 2D briefs). When set,
    # the Rust supervisor uploads each one as a separate listing image so
    # the buyer sees the model from every side. Single-thumbnail mode is
    # the fallback when this list is empty / missing.
    preview_pngs: list[str] = []
    if isinstance(asset, dict):
        raw = asset.get("preview_pngs")
        if isinstance(raw, list):
            preview_pngs = [p for p in raw if isinstance(p, str) and p]
    # Bundle support: when the designer produced a multi-file listing it
    # populates asset.asset_paths with one STL per item. The Rust supervisor
    # reads this list to upload every file under the same Etsy listing.
    # Falls back to [asset_path] so non-bundle listings carry the same shape.
    asset_paths: list[str] = []
    if isinstance(asset, dict):
        raw_paths = asset.get("asset_paths")
        if isinstance(raw_paths, list):
            asset_paths = [p for p in raw_paths if isinstance(p, str) and p]
    if not asset_paths and isinstance(asset_path, str) and asset_path:
        asset_paths = [asset_path]
    # Bundle metadata passed through verbatim so the supervisor's listing
    # title / description templates can render it (e.g. "(3-Piece Set)").
    bundle_meta = (
        asset.get("bundle") if isinstance(asset, dict) and isinstance(asset.get("bundle"), dict)
        else None
    )
    record_product_type = (
        brief.get("product_type", "digital_print") if isinstance(brief, dict) else "digital_print"
    )

    # Pinterest pin generation needs the data_dir set up early so the pin
    # path can be embedded in the audit record. Local-only — no Pinterest
    # API call here.
    data_dir = os.environ.get("AGENT_FACTORY_DATA", os.path.expanduser("~/.agent-factory"))
    os.makedirs(data_dir, exist_ok=True)
    pin_path = _generate_pinterest_pin(asset, listing, job_id, data_dir)
    record_pin_path: str | None = pin_path if pin_path else None

    record = {
        "listing_id": listing_id,
        "title": title,
        "description": listing.get("description", ""),
        "price_usd": listing.get("price_usd"),
        "tags": listing.get("tags"),
        "niche": niche,
        "product_type": record_product_type,
        "published_at": datetime.now(timezone.utc).isoformat(),
        "status": "live",
        "asset_path": asset_path,
        "asset_paths": asset_paths,
        "bundle_size": len(asset_paths) if len(asset_paths) >= 2 else 1,
        "pinterest_pin_path": record_pin_path,
    }

    # Write a local audit record. The Rust supervisor handles real Etsy publishing.
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
        "asset_paths": asset_paths,
        "bundle_size": len(asset_paths) if len(asset_paths) >= 2 else 1,
        "brief": brief if isinstance(brief, dict) else {},
    }
    if bundle_meta:
        cfo_payload["bundle"] = bundle_meta
    if cycle_id:
        cfo_payload["cycle_id"] = cycle_id
    result: dict = {
        "ok": True,
        "listing_id": listing_id,
        "ticker_text": (
            f"publisher → cfo: listing #{listing_id} prepared"
            + (f" (bundle of {len(asset_paths)})" if len(asset_paths) >= 2 else "")
        ),
        # Etsy / POD publish hooks (Rust supervisor reads these). Flat top-level
        # fields so the supervisor doesn't have to reach into the cfo payload.
        "title": title,
        "description": listing.get("description", ""),
        "tags": listing.get("tags", []) or [],
        "price_usd": record["price_usd"],
        "niche": niche,
        "asset_path": asset_path,
        "asset_paths": asset_paths,
        "bundle_size": len(asset_paths) if len(asset_paths) >= 2 else 1,
        "preview_pngs": preview_pngs,
        "pinterest_pin_path": record_pin_path,
        "product_type": product_type,  # supervisor uses this to route to POD or direct-Etsy
        "job_id": job_id,
        "handoff": {
            "to_role": "cfo",
            "payload": cfo_payload,
        },
    }
    if bundle_meta:
        result["bundle"] = bundle_meta
    if cycle_id:
        result["cycle_id"] = cycle_id
    return result
