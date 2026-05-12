import json
import os
import sys
import urllib.request
import urllib.error

MODEL = "claude-haiku-4-5-20251001"
MAX_TOKENS = 900

ANTHROPIC_BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")


def _retry_request(req: urllib.request.Request, timeout: int = 60, max_attempts: int = 3) -> str:
    """POST with exponential backoff. Retries on 5xx and URLError. Does NOT retry on 4xx.
    Returns the response body as utf-8 string. Raises on final failure.

    _retry_request: see workers/research/tests/test_research.py for behavior coverage.
    """
    import time as _time
    last_exc: Exception | None = None
    for attempt in range(max_attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            last_exc = e
            if 500 <= e.code < 600 and attempt < max_attempts - 1:
                delay = (2 ** attempt)
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


# Mandatory disclosure language for Etsy's 2025 Creativity Standards: every
# AI-generated listing must surface it. Listing worker appends this to the
# model's description verbatim so it can't be paraphrased away. Keep it short
# and friendly — buyers see it.
AI_DISCLOSURE_TEXT = (
    "\n\n— About this design —\n"
    "This artwork was created in our AI-assisted design studio. We curate, "
    "review, and select every design before publishing. Custom requests welcome."
)

# Materials list per product_type. Used to override the generic
# ["digital download"] default when the brief targets a physical product.
PRODUCT_MATERIALS = {
    "sticker": ["vinyl", "kiss-cut sticker", "made to order"],
    "digital_print": ["digital download"],
    "mug": ["ceramic", "made to order"],
    "tee": ["cotton", "made to order"],
    "poster": ["paper", "made to order"],
}


def build_listing_prompt(brief: dict, asset: dict) -> tuple[str, str]:
    product_type = brief.get("product_type", "digital_print")
    product_guide = {
        "sticker": "Kiss-cut vinyl sticker, made-to-order, ships from a US print partner. "
                   "Mention durability + indoor/outdoor use in description.",
        "digital_print": "Instant digital download — buyer prints at home. Mention file "
                         "formats and recommended print sizes.",
        "mug": "11oz ceramic mug, made-to-order, dishwasher safe. Mention gift-giving angle.",
        "tee": "Unisex cotton tee, made-to-order, multiple sizes. Mention fabric and fit.",
        "poster": "Matte paper poster, made-to-order, multiple sizes. Mention frame-ready.",
    }.get(product_type, "Digital download.")

    system = (
        "You are the Listing Copywriter at an AI-run Etsy shop selling "
        f"{product_type.replace('_', ' ')}s. "
        "Given a Demand Brief and an Asset Description, produce a complete Etsy listing draft. "
        "Title must be ≤140 chars. Exactly 13 tags. "
        "Description should be SEO-tuned and policy-compliant. "
        f"PRODUCT — {product_guide} "
        "PRICING — the shop is brand new and has no reviews. Pick a price that "
        "real buyers would impulse-purchase. Use brief.price_band_usd as your "
        "guide; lean toward the LOWER end of that band, not the middle. Never "
        "exceed brief.price_band_usd[1]. If no band is provided, price in the "
        "$3–$8 range. Sub-$10 wins on a fresh shop. "
        "Return JSON only:\n"
        "{\n"
        '  "title": "<≤140 chars>",\n'
        '  "tags": ["<exactly 13 tags>"],\n'
        '  "description": "<200-400 word listing description>",\n'
        '  "materials": [<list of materials>],\n'
        '  "price_usd": <number>\n'
        "}"
    )
    user = json.dumps({"brief": brief, "asset": asset})
    return system, user


def _augment_listing(listing: dict, brief: dict) -> dict:
    """Apply post-model adjustments that policy requires, regardless of what
    the model returned: AI disclosure paragraph and product-aware materials."""
    desc = listing.get("description", "") or ""
    if AI_DISCLOSURE_TEXT.strip() not in desc:
        listing["description"] = desc + AI_DISCLOSURE_TEXT
    product_type = brief.get("product_type")
    if product_type in PRODUCT_MATERIALS:
        listing["materials"] = PRODUCT_MATERIALS[product_type]
    return listing


# Hard ceiling used to clamp the model's price choice on a brand-new shop.
# Until the SI loop learns from real Etsy sales (see project_north_star), the
# safest policy is "cheap enough to actually impulse-buy from an unknown shop."
NEW_SHOP_PRICE_CEILING_USD = 12.0


def _clamp_price(price: float, brief: dict) -> float:
    """Force the model's price into a sane band for a new, no-review shop.

    Constraints, in order:
      1. price <= brief.price_band_usd[1] when provided
      2. price <= NEW_SHOP_PRICE_CEILING_USD always
      3. price >= brief.price_band_usd[0] when provided (avoid free / loss leaders)
      4. price >= 1.50 (Etsy floor for impulse digital)
    """
    band = brief.get("price_band_usd") if isinstance(brief, dict) else None
    lo, hi = None, None
    if isinstance(band, list) and len(band) >= 2:
        try:
            lo = float(band[0])
            hi = float(band[1])
        except (TypeError, ValueError):
            lo, hi = None, None
    capped = float(price)
    if hi is not None:
        capped = min(capped, hi)
    capped = min(capped, NEW_SHOP_PRICE_CEILING_USD)
    if lo is not None:
        capped = max(capped, lo)
    capped = max(capped, 1.50)
    return round(capped, 2)


def call_anthropic(api_key: str, brief: dict, asset: dict) -> tuple[dict, int, int]:
    system_prompt, user_prompt = build_listing_prompt(brief, asset)
    override = _load_system_override("listing")
    if override:
        system_prompt = override

    body = json.dumps({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system_prompt,
        "messages": [{"role": "user", "content": user_prompt}],
    }).encode("utf-8")

    req = urllib.request.Request(
        f"{ANTHROPIC_BASE_URL}/v1/messages",
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
    cycle_id = payload.get("cycle_id") if isinstance(payload, dict) else None

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
        raw_price = listing.get("price_usd", 0)
        price = _clamp_price(raw_price, brief)
        if price != raw_price:
            print(
                f"[listing] job_id={job_id} price clamped {raw_price} -> {price} (band={brief.get('price_band_usd')})",
                file=sys.stderr, flush=True,
            )
            listing["price_usd"] = price
        # Etsy 2025 Creativity Standards require AI-disclosure in every
        # listing; we also override materials per product_type. Apply
        # AFTER the model + clamp so neither can drop these.
        _augment_listing(listing, brief)
        print(f"[listing] job_id={job_id} done title={title!r:.40} in={tokens_in} out={tokens_out}", file=sys.stderr, flush=True)
        handoff_payload: dict = {"listing": listing, "brief": brief, "asset": asset}
        if cycle_id:
            handoff_payload["cycle_id"] = cycle_id
        result: dict = {
            "ok": True,
            "listing": listing,
            "ticker_text": f"listing → publisher: \"{title[:60]}\" ${price}",
            "model": MODEL,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "handoff": {
                "to_role": "publisher",
                "payload": handoff_payload,
            },
        }
        if cycle_id:
            result["cycle_id"] = cycle_id
        return result
    except Exception as e:
        msg = str(e)
        print(f"[listing] job_id={job_id} ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"listing failed: {msg}",
        }
