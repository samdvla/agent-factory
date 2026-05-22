import json
import os
import sys
import urllib.request
import urllib.error

MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 900

ANTHROPIC_BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")


def _retry_request(req: urllib.request.Request, timeout: int = 60, max_attempts: int = 5) -> str:
    """POST with exponential backoff. Retries on 5xx and URLError. Does NOT retry on 4xx.
    Returns the response body as utf-8 string. Raises on final failure.

    HTTP 529 is Anthropic's load-shedding signal — typical overload events
    last 30s-2min, so the legacy 1s/2s/4s schedule (~7s total) blew right
    through them and failed real jobs. 529 gets its own longer schedule
    (8s/15s/30s/60s/60s). Other 5xx + URLError keep the fast schedule.

    _retry_request: see workers/research/tests/test_research.py for behavior coverage.
    """
    import time as _time
    overload_delays = (8, 15, 30, 60, 60)
    fast_delays = (1, 2, 4, 8, 16)
    last_exc: Exception | None = None
    for attempt in range(max_attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            last_exc = e
            # Capture the response body once; HTTPError\'s default
            # str() is just "HTTP Error N: Reason" and the actual
            # diagnostic lives in the body that Anthropic returns.
            try:
                _body = e.read().decode("utf-8", errors="replace")
                if _body:
                    e.msg = f"{e.msg}: {_body[:600]}"
            except Exception:
                pass
            if e.code == 529 and attempt < max_attempts - 1:
                delay = overload_delays[min(attempt, len(overload_delays) - 1)]
                print(
                    f"[retry] HTTP 529 (Anthropic overloaded) attempt "
                    f"{attempt+1}/{max_attempts}; sleeping {delay}s",
                    file=sys.stderr, flush=True,
                )
                _time.sleep(delay)
                continue
            if 500 <= e.code < 600 and attempt < max_attempts - 1:
                delay = fast_delays[min(attempt, len(fast_delays) - 1)]
                print(f"[retry] HTTP {e.code} attempt {attempt+1}/{max_attempts}; sleeping {delay}s", file=sys.stderr, flush=True)
                _time.sleep(delay)
                continue
            raise
        except urllib.error.URLError as e:
            last_exc = e
            if attempt < max_attempts - 1:
                delay = fast_delays[min(attempt, len(fast_delays) - 1)]
                print(f"[retry] URLError {e} attempt {attempt+1}/{max_attempts}; sleeping {delay}s", file=sys.stderr, flush=True)
                _time.sleep(delay)
                continue
            # Final attempt failed at the network layer (timeout, refused,
            # DNS). The raw URLError str() — "<urlopen error [Errno 60]
            # ...>" — means nothing to a user, so raise something actionable.
            _host = getattr(req, "host", "") or "the Claude API"
            raise ConnectionError(
                f"couldn't reach the Claude API at {_host} after "
                f"{max_attempts} tries ({e.reason}). Check your Anthropic API "
                f"key and internet connection — and if you set an Anthropic "
                f"bridge in Settings, make sure that bridge host is online."
            ) from e
    if last_exc:
        raise last_exc
    raise RuntimeError("retry: unreachable")

def _use_json_prefill() -> bool:
    """Anthropic's Messages API supports assistant prefill (seeding the
    assistant turn with "{" to force structured JSON output). Some bridge
    proxies normalize / strip the trailing assistant message and reject the
    request with HTTP 400. Default ON; flip OFF when ANTHROPIC_BASE_URL
    points at anything other than Anthropic's direct host."""
    import os as _os
    url = _os.environ.get("ANTHROPIC_BASE_URL", "").strip()
    if not url:
        return True
    return "api.anthropic.com" in url


def _messages_for_json_call(user_content: str) -> list[dict]:
    """Build the messages array for a JSON-emitting Anthropic call. Adds the
    assistant prefill only when the API supports it (direct Anthropic, not
    a bridge proxy)."""
    msgs: list[dict] = [{"role": "user", "content": user_content}]
    if _use_json_prefill():
        msgs.append({"role": "assistant", "content": "{"})
    return msgs



def _override_compatible_with_focus(override: str | None) -> bool:
    """Reject overrides that drifted back to the pre-3D-pivot world. See the
    designer worker's copy for the full rationale — mirrored here so each
    worker enforces it at load time, not just once via a hand-clean.

    For listing specifically, an override that pushes prices outside [$3, $15]
    is also stale (operator policy locks digital sales to that band; anything
    higher gets silently clamped by the publisher and the listing copy ends
    up mis-anchored to the displayed price)."""
    if not override:
        return True
    focus = os.environ.get("SHOP_FOCUS", "3d_only").strip().lower()
    if focus != "3d_only":
        return True
    s = override.lower()
    stale_markers = (
        "kiss-cut", "kiss cut", "sticker shop", "sticker-first",
        "kiss-cut vinyl",
        "viewbox", "svg markup",
        "adhd routine", "adhd planner", "planner bundle", "planner printable",
        "printable wall art",
        # Price drift — operator policy is $3-$15. Anything anchored above
        # $15 will get clamped and the copy will read wrong.
        "$20-$30", "$20–$30", "$20 to $30",
        "price-anchor toward the $20", "price-anchor toward the $25",
    )
    return not any(m in s for m in stale_markers)


def _load_system_override(role: str) -> str | None:
    """Read ~/.agent-factory/prompts.json and return system_override for role, or None.

    Rejects overrides that fail _override_compatible_with_focus.
    """
    path = os.path.expanduser("~/.agent-factory/prompts.json")
    try:
        with open(path) as f:
            data = json.load(f)
        ov = data.get(role, {}).get("system_override")
        if isinstance(ov, str) and ov.strip():
            if not _override_compatible_with_focus(ov):
                print(
                    f"[listing] rejecting stale {role}.system_override "
                    f"({len(ov)} chars, contains pre-3D-pivot markers); "
                    "falling back to built-in baseline",
                    file=sys.stderr, flush=True,
                )
                return None
            return ov
    except Exception:
        pass
    return None


def _load_operator_steers(role: str) -> list[dict]:
    """Read operator standing instructions written from the ChatPanel Steer
    action. Returns a normalized list of `{"text": str, "image_paths":
    list[str]}` dicts. Both plain-string entries (legacy) and object
    entries (new schema with image_paths) are accepted. Returns [] when
    the file is missing or malformed."""
    path = os.path.expanduser("~/.agent-factory/prompts.json")
    try:
        with open(path) as f:
            data = json.load(f)
        arr = data.get(role, {}).get("operator_steers")
        if not isinstance(arr, list):
            return []
        out: list[dict] = []
        for entry in arr:
            if isinstance(entry, str):
                if entry.strip():
                    out.append({"text": entry.strip(), "image_paths": []})
            elif isinstance(entry, dict):
                text = entry.get("text")
                paths = entry.get("image_paths") or []
                if isinstance(text, str) and text.strip():
                    out.append({
                        "text": text.strip(),
                        "image_paths": [p for p in paths if isinstance(p, str)],
                    })
        return out
    except Exception:
        pass
    return []


def _append_operator_steers(system_prompt: str, role: str) -> str:
    """Append operator standing instructions as the final block. Listing
    is text-output (Etsy title + tags + description) so image references
    aren't piped through to the model — only the TEXT half of each steer
    lands in the system prompt."""
    steers = _load_operator_steers(role)
    if not steers:
        return system_prompt
    block = (
        "OPERATOR OVERRIDE — these standing instructions supersede every "
        "rule above, including any 'always pick X', 'never recommend Y', "
        "or 'prioritize Z category' directives in the strategist-tuned "
        "system prompt. If any rule above conflicts with the instructions "
        "below, ignore that rule for this job and follow the operator:\n"
        + "\n".join(f"- {s['text']}" for s in steers)
    )
    return system_prompt.rstrip() + "\n\n" + block


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
    "stl_file": ["STL file", "GLB file", "digital download", "3D printable"],
    "3d_model": ["GLB file", "STL file", "digital download", "3D asset"],
}

_LISTING_TOOL = {
    "name": "submit_listing",
    "description": (
        "Submit the final Etsy listing draft for the given Demand Brief + "
        "Asset Description. Call this exactly once with the complete listing."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "title": {
                "type": "string",
                "maxLength": 140,
                "description": (
                    "Etsy listing title, ≤140 chars. SEO-tuned, leads with "
                    "the core benefit + audience. No emoji. No ALL-CAPS spam."
                ),
            },
            "tags": {
                "type": "array",
                "items": {"type": "string", "maxLength": 20},
                "minItems": 13,
                "maxItems": 13,
                "description": (
                    "Exactly 13 Etsy tags. Each ≤20 chars. Mix of broad + "
                    "long-tail. No duplicates."
                ),
            },
            "description": {
                "type": "string",
                "minLength": 200,
                "description": (
                    "200-400 word SEO-tuned listing description, policy-"
                    "compliant. Include what's included, use cases, format/"
                    "specs, and any license terms. No AI-disclosure text — "
                    "that gets appended programmatically afterward."
                ),
            },
            "materials": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Materials list. For digital products use ['digital "
                    "download']. The worker post-processes this for known "
                    "product_types (stickers, STL, GLB, etc.), so a "
                    "reasonable default is fine."
                ),
            },
            "price_usd": {
                "type": "number",
                "minimum": 3.0,
                "maximum": 15.0,
                "description": (
                    "Listing price in USD. Operator policy: digital sales "
                    "must fall in [$3, $15]. Use brief.price_band_usd as a "
                    "hint within that range. Worker silently clamps anything "
                    "outside [$3, $15] post-hoc."
                ),
            },
        },
        "required": ["title", "tags", "description", "materials", "price_usd"],
    },
}


def build_listing_prompt(brief: dict, asset: dict) -> tuple[str, str]:
    """Build the (system, user) pair for the listing call.

    Schema/structure is enforced by the `submit_listing` Anthropic tool —
    this prompt only encodes PHILOSOPHY (audience, pricing intuition, voice).
    A strategist override may replace this entirely; the tool keeps the
    output structure intact regardless.
    """
    product_type = brief.get("product_type", "digital_print")
    is_3d = product_type in {"stl_file", "3d_model"}
    product_guide = {
        "sticker": "Kiss-cut vinyl sticker, made-to-order, ships from a US print partner. "
                   "Mention durability + indoor/outdoor use in description.",
        "digital_print": "Instant digital download — buyer prints at home. Mention file "
                         "formats and recommended print sizes.",
        "mug": "11oz ceramic mug, made-to-order, dishwasher safe. Mention gift-giving angle.",
        "tee": "Unisex cotton tee, made-to-order, multiple sizes. Mention fabric and fit.",
        "poster": "Matte paper poster, made-to-order, multiple sizes. Mention frame-ready.",
        "stl_file": (
            "Instant digital download — STL + GLB files for 3D printing. "
            "Mention: (1) what's included (STL for slicers, GLB as bonus for "
            "viewers/AR), (2) recommended print settings (0.2mm layer, 15% "
            "infill, no supports needed if applicable), (3) target print "
            "scale (e.g. 28mm tabletop, 8cm desk piece, wearable size), "
            "(4) license terms (personal use; commercial use case-by-case), "
            "(5) printer compatibility (FDM + resin). NO PHYSICAL ITEM ships."
        ),
        "3d_model": (
            "Instant digital download — GLB + STL files for use in games / "
            "AR / 3D printing. Mention polycount range, untextured PBR-ready "
            "topology, single static mesh (no rig), and license terms."
        ),
    }.get(product_type, "Digital download.")

    pricing_guidance = (
        "PRICING — operator policy locks every digital sale to $3–$15. "
        "For 3D-printable downloads: mini-figures $4–$9, jewelry $3–$7, "
        "decor $7–$12, cosplay/props $10–$15. Use brief.price_band_usd as "
        "a hint, but the absolute cap is $15 and absolute floor is $3 — "
        "anything outside [$3, $15] will be silently clamped by the "
        "publisher. Pick a price that converts."
    ) if is_3d else (
        "PRICING — operator policy locks every digital sale to $3–$15. "
        "The shop is brand new and has no reviews — lean toward the LOWER "
        "end of that range, not the middle. Use brief.price_band_usd as a "
        "hint. Anything outside [$3, $15] is silently clamped. Sub-$10 "
        "wins on a fresh shop."
    )

    shop_persona = (
        "an AI-run shop selling 3D-printable digital files (STL + GLB) on Etsy + Cults3D"
        if is_3d else
        f"an AI-run Etsy shop selling {product_type.replace('_', ' ')}s"
    )

    # 3D-specific copy guidance — Etsy 3D digital-download buyers read very
    # differently than sticker buyers. Architecture: Identity → Format rules
    # → Title formula → Description structure → Tag strategy → Anti-patterns.
    if is_3d:
        copy_guidance = (
            "TITLE FORMULA (140 char hard cap, lead with the highest-value "
            "search phrase — Etsy weights first 60 chars):\n"
            "  [Specific Subject] [Niche/Mythology] [Format Tag] | [Buyer "
            "Use Case] [Scale]\n"
            "Examples:\n"
            "  ✓ \"Lovecraftian Deep One Altar Figurine STL | Cthulhu "
            "Cosmic Horror 3D Print | 28mm Tabletop Mini\"\n"
            "  ✓ \"Norse Runic Wolf Pendant STL | Viking Mythology 3D "
            "Print | Wearable Jewelry File\"\n"
            "  ✓ \"D&D Mushroom Forest Terrain Tiles STL | Modular "
            "Fantasy Dungeon | 28mm Tabletop\"\n\n"

            "DESCRIPTION STRUCTURE (5 blocks, in order):\n"
            "  1. Hook sentence (1 line) — the buyer use case, not "
            "the product. \"Anchor your Cthulhu altar with a "
            "sculptural Deep One figurine you can print at home.\"\n"
            "  2. What's included — bullet-style: 'STL file (for "
            "slicers)', 'GLB file (for viewers / AR)', 'Recommended "
            "scale: 28mm tabletop'.\n"
            "  3. Print settings — concrete numbers: layer height "
            "(0.1mm resin / 0.2mm FDM), infill (15-20%), supports "
            "(needed / not needed), recommended printer types (FDM + "
            "resin compatible).\n"
            "  4. License — \"Personal print use included. Commercial "
            "/ resale licensing available on request.\"\n"
            "  5. Closing — single sentence reinforcing the niche / "
            "mood. No emoji. No CTAs like 'click here'.\n\n"

            "TAG STRATEGY (exactly 13 — Etsy hard cap):\n"
            "  • 1-2 format tags: 'STL file', '3D print' (always).\n"
            "  • 3-5 niche-specific tags: 'cthulhu', 'deep one', "
            "'altar figurine', 'cosmic horror', 'lovecraftian'.\n"
            "  • 2-3 audience tags: 'dnd', 'tabletop', 'collector', "
            "'cosplay'.\n"
            "  • 2-3 use-case tags: 'altar decor', 'desk decor', "
            "'gift', 'home decor'.\n"
            "  • 1-2 specificity tags: '28mm', 'fdm printable', "
            "'resin printable'.\n"
            "  • NO generic filler ('art', 'design', 'unique', "
            "'cute') — those are wasted slots.\n"
            "  • Tags must be ≤20 chars each.\n\n"

            "ANTI-PATTERNS — Etsy buyers bounce on these:\n"
            "  ✗ Copying the title into the description verbatim.\n"
            "  ✗ Pretending a physical item ships (we sell digital "
            "downloads — always say so explicitly).\n"
            "  ✗ ALL-CAPS sections or excessive emoji.\n"
            "  ✗ Promising commercial license without the operator's "
            "approval — default to personal-use-only.\n"
            "  ✗ Omitting the AI-generation disclosure — Etsy policy "
            "requires it (added automatically by the worker, but "
            "don't fight it in the copy).\n"
            "  ✗ Generic openers (\"You'll love this\", \"Perfect "
            "for...\") — the hook must be specific to the niche.\n\n"
        )
    else:
        copy_guidance = ""

    persona_block = (
        "PERSONA — You are an Etsy + Cults3D Listing Copywriter who has "
        "written hundreds of high-converting 3D digital-download listings. "
        "You know that 3D buyers are technical and skeptical: they scan "
        "for print settings, scale, file format, and license terms before "
        "they read marketing copy. You write titles that load the highest-"
        "value keyword in the first 60 chars (Etsy weights early tokens "
        "heavily) and descriptions that read like a TTRPG product page — "
        "specific, practical, no marketing slop, no exclamation marks, "
        "no emoji.\n\n"
    ) if is_3d else (
        f"You are the Listing Copywriter at {shop_persona}.\n\n"
    )

    system = (
        persona_block +
        "Given a Demand Brief and an Asset Description, produce a complete "
        "listing draft. Title must be ≤140 chars. Exactly 13 tags. "
        "Description should be SEO-tuned and policy-compliant.\n\n"
        f"PRODUCT — {product_guide}\n\n"
        f"{pricing_guidance}\n\n"
        f"{copy_guidance}"
        "When the draft is ready, call the submit_listing tool with all five "
        "fields populated. Do not write JSON in a text reply — the tool is "
        "the only sanctioned output channel."
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


# Operator pricing policy: fixed tiers, not an LLM guess. Every single
# model ships at SINGLE_PRICE_USD; bundles price by item count via
# BUNDLE_PRICE_TABLE. This replaced the old LLM-chosen-then-band-clamped
# scheme so prices are deterministic and predictable across the catalog.
SINGLE_PRICE_USD = 3.99

# Bundle price by item count. Research caps bundles at 2-6 items
# (see research._normalize_bundle); _fixed_price falls back to the nearest
# defined tier for any out-of-range size so a job never ships unpriced.
BUNDLE_PRICE_TABLE = {
    2: 5.99,
    3: 7.99,
    4: 9.99,
    5: 12.99,
    6: 14.99,
}

# Validation floor — the listing is rejected below this. Every fixed tier
# above sits comfortably over it; kept as a guard against a future tier or
# manual edit dropping below an unprofitable price.
GLOBAL_PRICE_FLOOR_USD = 3.0


def _bundle_size(asset: dict) -> int:
    """Read the bundle size off the designer's asset dict. Returns 1 when
    the asset is a single-file listing (no bundle metadata). The size is
    bounded by what the designer actually produced (`asset_paths` length),
    NOT by what research requested — partial-failure bundles ship at the
    smaller size."""
    if not isinstance(asset, dict):
        return 1
    paths = asset.get("asset_paths")
    if isinstance(paths, list) and len(paths) >= 2:
        return len(paths)
    bundle = asset.get("bundle")
    if isinstance(bundle, dict):
        items = bundle.get("items")
        if isinstance(items, list) and len(items) >= 2:
            return len(items)
    return 1


def _bundle_item_names(asset: dict) -> list[str]:
    """Pull the descriptive item names off the bundle metadata. Used by the
    description-augmentation step. Empty list when the listing isn't a bundle."""
    if not isinstance(asset, dict):
        return []
    bundle = asset.get("bundle")
    if not isinstance(bundle, dict):
        return []
    items = bundle.get("items")
    if not isinstance(items, list):
        return []
    names: list[str] = []
    for it in items:
        if isinstance(it, dict):
            n = it.get("name")
            if isinstance(n, str) and n.strip():
                names.append(n.strip())
    return names


def _augment_bundle_copy(listing: dict, asset: dict) -> dict:
    """Append a bundle-specific block to the description so buyers see the
    full item list. The model already wrote a description for the brief's
    primary subject; we add the explicit per-item enumeration so Etsy's
    search indexes it and so the buyer knows exactly what's in the pack."""
    names = _bundle_item_names(asset)
    if len(names) < 2:
        return listing
    desc = listing.get("description", "") or ""
    bundle_block = (
        f"\n\n— What's in this {len(names)}-piece bundle —\n"
        + "\n".join(f"• {n}" for n in names)
    )
    # Only append if we haven't already (idempotent under handler retries).
    if bundle_block.strip() not in desc:
        listing["description"] = desc + bundle_block
    return listing


def _fixed_price(asset: dict | None) -> float:
    """Operator pricing policy: deterministic fixed tiers by bundle size.

    Single model (no bundle) → SINGLE_PRICE_USD. Bundle of N items →
    BUNDLE_PRICE_TABLE[N]. This intentionally ignores any price the LLM
    proposed and the brief's price band — pricing is operator policy, not
    a model decision. Research caps bundles at 2-6 items, but for any
    out-of-range size we fall back to the nearest defined tier so the job
    never ships unpriced.
    """
    n = _bundle_size(asset) if asset else 1
    if n < 2:
        return SINGLE_PRICE_USD
    if n in BUNDLE_PRICE_TABLE:
        return BUNDLE_PRICE_TABLE[n]
    nearest = min(BUNDLE_PRICE_TABLE, key=lambda s: abs(s - n))
    return BUNDLE_PRICE_TABLE[nearest]


MAX_TOOL_RETRIES = 2  # Initial attempt + 2 corrections = 3 attempts max.


class ListingCallError(Exception):
    """Raised when call_anthropic exhausts its retry budget. Carries the
    tokens consumed across all attempts so the supervisor's budget
    tracker counts the spend even on a failed job — otherwise a stuck
    listing loop could burn through tokens without registering against
    the hourly / daily / monthly caps."""
    def __init__(self, msg: str, tokens_in: int = 0, tokens_out: int = 0):
        super().__init__(msg)
        self.tokens_in = tokens_in
        self.tokens_out = tokens_out


def _validate_tool_input(inp: dict) -> list[str]:
    """Hard-validate the submit_listing tool's input for STRUCTURE
    issues the model can fix on feedback (missing fields, wrong tag
    count, short description). Per-tag length is intentionally NOT
    checked here — Haiku struggles to consistently emit short tags
    under retry pressure, so that's handled by silent truncation in
    `_clamp_tags_to_etsy()` instead. Strong-hint schema still tells
    the model the 20-char limit; this layer just guarantees we never
    fail a whole job over a single tag being 22 chars long."""
    errors: list[str] = []
    title = inp.get("title")
    if not isinstance(title, str) or not title.strip():
        errors.append("missing or empty 'title'")
    elif len(title) > 140:
        errors.append(f"title is {len(title)} chars but must be ≤140")
    tags = inp.get("tags")
    if not isinstance(tags, list):
        errors.append("missing 'tags' (must be array of 13 strings)")
    elif len(tags) != 13:
        errors.append(f"tags has {len(tags)} items but must be exactly 13")
    elif any(not isinstance(t, str) for t in tags):
        errors.append("tags must all be strings")
    desc = inp.get("description")
    if not isinstance(desc, str) or len(desc) < 200:
        errors.append(
            f"description must be a string of ≥200 chars (got "
            f"{type(desc).__name__} len={len(desc) if isinstance(desc, str) else 'n/a'})"
        )
    if not isinstance(inp.get("materials"), list):
        errors.append("missing 'materials' (must be array of strings)")
    if not isinstance(inp.get("price_usd"), (int, float)):
        errors.append("missing or non-numeric 'price_usd'")
    elif inp.get("price_usd") < GLOBAL_PRICE_FLOOR_USD:
        errors.append(
            f"price_usd {inp['price_usd']} below operator floor "
            f"${GLOBAL_PRICE_FLOOR_USD:.2f}"
        )
    return errors


def _clamp_tags_to_etsy(tags: list[str]) -> list[str]:
    """Etsy enforces ≤20 chars per tag at the API level. The model sees
    this constraint in the tool schema description but doesn't always
    honor it under retry pressure. Truncate at word boundaries when we
    can to preserve readability, then hard-cap at 20 chars. Silent
    safeguard: never fail a job over a stubborn formatting detail Etsy
    polices anyway."""
    out: list[str] = []
    for t in tags:
        if not isinstance(t, str):
            t = str(t)
        if len(t) <= 20:
            out.append(t.rstrip())
            continue
        # If the 21st character is a space, t[:20] already ends on a clean
        # word boundary — keep it. Otherwise walk back to the last space.
        if t[20] == " ":
            out.append(t[:20].rstrip())
            continue
        head = t[:20]
        last_space = head.rfind(" ")
        if last_space >= 8:  # require some minimum meaningful length
            head = head[:last_space]
        out.append(head.rstrip())
    return out


def _post_messages(api_key: str, system_prompt: str, messages: list[dict]) -> dict:
    """Single Anthropic call. Caller owns retry semantics for tool
    correction; this just sends and parses the envelope."""
    body = json.dumps({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system_prompt,
        "tools": [_LISTING_TOOL],
        "tool_choice": {"type": "tool", "name": "submit_listing"},
        "messages": messages,
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
    return json.loads(raw)


def call_anthropic(api_key: str, brief: dict, asset: dict) -> tuple[dict, int, int]:
    """Call Anthropic with forced tool use. Anthropic exposes the schema
    to the model as a strong hint, then we hard-validate the returned
    tool input and ask the model to correct itself via a tool_result
    turn if anything's off. After up to MAX_TOOL_RETRIES corrections,
    raise — never publish a broken listing.

    Background: this used to parse free-form JSON out of a text response,
    which intermittently failed with `Expecting property name enclosed in
    double quotes: line 1 column 2 (char 1)` when the model emitted
    Python-style single quotes or markdown fences. Tool calling
    + corrective retry eliminates the entire class.
    """
    system_prompt, user_prompt = build_listing_prompt(brief, asset)
    override = _load_system_override("listing")
    if override:
        # Strategist tunes the philosophy layer. The tool schema + the
        # hard validator below are non-overridable.
        system_prompt = override
    system_prompt = _append_operator_steers(system_prompt, "listing")

    messages: list[dict] = [{"role": "user", "content": user_prompt}]
    total_in = total_out = 0
    last_errors: list[str] = []

    for attempt in range(MAX_TOOL_RETRIES + 1):
        response = _post_messages(api_key, system_prompt, messages)
        usage = response.get("usage", {}) or {}
        total_in += usage.get("input_tokens", 0)
        total_out += usage.get("output_tokens", 0)

        tool_block: dict | None = None
        for block in response.get("content", []):
            if block.get("type") == "tool_use" and block.get("name") == "submit_listing":
                tool_block = block
                break

        if tool_block is None:
            raise ListingCallError(
                "listing call: no submit_listing tool_use block in response "
                f"(stop_reason={response.get('stop_reason')!r}, "
                f"content_types={[b.get('type') for b in response.get('content', [])]})",
                tokens_in=total_in,
                tokens_out=total_out,
            )

        inp = tool_block.get("input") if isinstance(tool_block.get("input"), dict) else {}
        errors = _validate_tool_input(inp)
        if not errors:
            return inp, total_in, total_out

        last_errors = errors
        print(
            f"[listing] tool-validation attempt {attempt+1}/{MAX_TOOL_RETRIES+1} "
            f"rejected: {'; '.join(errors)}",
            file=sys.stderr, flush=True,
        )

        if attempt >= MAX_TOOL_RETRIES:
            break

        # Append the model's tool_use turn and a corrective tool_result
        # turn. The model will emit a new tool_use addressing the errors.
        messages.append({"role": "assistant", "content": response.get("content", [])})
        messages.append({
            "role": "user",
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": tool_block.get("id"),
                    "is_error": True,
                    "content": (
                        "The submit_listing input had these issues — please "
                        "call submit_listing again with the same listing but "
                        "fixed:\n- " + "\n- ".join(errors)
                    ),
                }
            ],
        })

    raise ListingCallError(
        f"listing call: model failed schema validation after "
        f"{MAX_TOOL_RETRIES+1} attempts. Last errors: {'; '.join(last_errors)}",
        tokens_in=total_in,
        tokens_out=total_out,
    )


def _parse_loose_json_object(text: str) -> dict:
    """Parse the first JSON object out of `text`, tolerating fences, trailing
    prose, and the most common Claude-emitted JSON breakage. Three layers:

      1. Strip leading markdown fences.
      2. raw_decode from the first '{' — handles trailing prose for free.
      3. On JSONDecodeError inside the JSON, attempt a small set of repairs
         (trailing-comma strip, newline-in-string normalization) and retry.

    Raises ValueError with a 240-char preview when no JSON exists at all, or
    when repair attempts still fail. Both the preview AND the failing
    parser-error location are logged to stderr so they show up in LiveLog.
    """
    s = text.strip()
    if s.startswith("```"):
        nl = s.find("\n")
        s = s[nl + 1 :] if nl != -1 else s
    start = s.find("{")
    if start == -1:
        preview = text.strip().replace("\n", " ")[:240]
        print(
            f"[parse] no JSON object found; first 240 chars of response: {preview!r}",
            file=sys.stderr, flush=True,
        )
        raise ValueError(
            f"no JSON object found in response (got prose). first 240 chars: {preview!r}"
        )
    body = s[start:]
    try:
        obj, _end = json.JSONDecoder().raw_decode(body)
    except json.JSONDecodeError as first_err:
        repaired = _repair_json_text(body)
        try:
            obj, _end = json.JSONDecoder().raw_decode(repaired)
            print(
                f"[parse] repaired JSON after initial error: {first_err}",
                file=sys.stderr, flush=True,
            )
        except json.JSONDecodeError as second_err:
            point = max(0, first_err.pos - 60)
            snippet = body[point : first_err.pos + 60].replace("\n", " ")
            print(
                f"[parse] JSON repair failed. first={first_err} second={second_err}; "
                f"body near pos {first_err.pos}: ...{snippet}...",
                file=sys.stderr, flush=True,
            )
            raise first_err
    if not isinstance(obj, dict):
        raise ValueError(f"expected JSON object, got {type(obj).__name__}")
    return obj


def _repair_json_text(text: str) -> str:
    """Best-effort repair of common Claude-emitted JSON breakage.

    Handles:
      • trailing commas before } or ]
      • CR/LF inside string values (replaced with single spaces)
      • lone backslashes that aren't starting a valid escape sequence
    Not a complete JSON5/json-repair; just covers the cases we've actually
    seen Haiku/Sonnet emit when the design_direction paragraph gets long.
    """
    import re as _re
    # 1. Strip trailing commas before } or ].
    out = _re.sub(r",(\s*[}\]])", r"\1", text)
    # 2. Normalize newlines inside string values: replace any \n that lives
    #    between an opening " and the next " on a different line with a space.
    #    Conservative — only triggers when we see a newline directly inside
    #    a string-typed value.
    def _collapse_newlines_in_strings(s: str) -> str:
        result = []
        i = 0
        in_string = False
        escape = False
        while i < len(s):
            c = s[i]
            if in_string:
                if escape:
                    result.append(c)
                    escape = False
                elif c == "\\":
                    result.append(c)
                    escape = True
                elif c == '"':
                    result.append(c)
                    in_string = False
                elif c in ("\n", "\r"):
                    result.append(" ")  # collapse newline inside string
                else:
                    result.append(c)
            else:
                result.append(c)
                if c == '"':
                    in_string = True
            i += 1
        return "".join(result)
    out = _collapse_newlines_in_strings(out)
    # 3. Fix lone backslashes that aren't starting a valid escape.
    out = _re.sub(r'\\(?!["\\/bfnrtu])', r"\\\\", out)
    return out


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
        # Operator pricing policy: overwrite whatever price the model
        # proposed with the deterministic fixed tier. Done BEFORE validation
        # so a stray model price can neither fail the job nor reach the
        # listing — the price is always the operator's, never the LLM's.
        listing["price_usd"] = _fixed_price(asset)
        errors = validate_listing(listing)
        if errors:
            msg = "; ".join(errors)
            print(f"[listing] job_id={job_id} validation error: {msg}", file=sys.stderr, flush=True)
            return {
                "ok": False,
                "error": msg,
                "ticker_text": f"listing validation failed: {msg}",
            }
        # Silent safeguard: Etsy hard-caps tags at 20 chars; the model
        # sometimes ignores that under retry pressure. Truncate at word
        # boundaries so the listing publishes cleanly instead of crashing.
        if isinstance(listing.get("tags"), list):
            listing["tags"] = _clamp_tags_to_etsy(listing["tags"])
        title = listing.get("title", "")
        print(
            f"[listing] job_id={job_id} price=${listing['price_usd']} "
            f"(fixed tier, bundle_size={_bundle_size(asset)})",
            file=sys.stderr, flush=True,
        )
        # Etsy 2025 Creativity Standards require AI-disclosure in every
        # listing; we also override materials per product_type. Apply
        # AFTER the model + clamp so neither can drop these.
        _augment_listing(listing, brief)
        # Bundle-specific copy: appends a 'What's in this N-piece bundle'
        # block enumerating each item by name. No-op for single-file listings.
        _augment_bundle_copy(listing, asset)
        print(f"[listing] job_id={job_id} done title={title!r:.40} in={tokens_in} out={tokens_out}", file=sys.stderr, flush=True)
        handoff_payload: dict = {"listing": listing, "brief": brief, "asset": asset}
        if cycle_id:
            handoff_payload["cycle_id"] = cycle_id
        result: dict = {
            "ok": True,
            "listing": listing,
            "ticker_text": f"listing → publisher: \"{title[:60]}\" ${listing['price_usd']}",
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
    except ListingCallError as e:
        # Anthropic call failed (e.g., retries exhausted). Surface tokens so
        # the supervisor's budget tracker records the spend — otherwise a
        # repeating failure could silently bypass the hourly/daily cap.
        msg = str(e)
        print(f"[listing] job_id={job_id} ERROR: {msg} (burned in={e.tokens_in} out={e.tokens_out})", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"listing failed: {msg}",
            "model": MODEL,
            "tokens_in": e.tokens_in,
            "tokens_out": e.tokens_out,
        }
    except Exception as e:
        msg = str(e)
        print(f"[listing] job_id={job_id} ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"listing failed: {msg}",
        }
