import json
import os
import sys
import urllib.request
import urllib.error

MODEL = "claude-haiku-4-5-20251001"
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
            raise
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


def _load_operator_steers(role: str) -> list[str]:
    """Read operator standing instructions written from the ChatPanel Steer
    action. Returns [] when missing or malformed."""
    path = os.path.expanduser("~/.agent-factory/prompts.json")
    try:
        with open(path) as f:
            data = json.load(f)
        arr = data.get(role, {}).get("operator_steers")
        if isinstance(arr, list):
            return [s for s in arr if isinstance(s, str) and s.strip()]
    except Exception:
        pass
    return []


def _append_operator_steers(system_prompt: str, role: str) -> str:
    """Append operator standing instructions as the final block. Operator
    steers compose with and take precedence over the strategist-tuned
    override, because the last block in the system prompt gets the model's
    strongest attention."""
    steers = _load_operator_steers(role)
    if not steers:
        return system_prompt
    block = (
        "OPERATOR STANDING INSTRUCTIONS (operator-set, highest priority — "
        "apply to this job):\n"
        + "\n".join(f"- {s}" for s in steers)
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

# 3D-printable assets typically sell higher than 2D digital prints on Etsy.
# Adjust per product_type so the listing worker doesn't clamp a fair $15
# tabletop mini down to $12 just because the 2D ceiling existed.
PRICE_CEILING_BY_TYPE = {
    "sticker": 12.0,
    "digital_print": 12.0,
    "mug": 22.0,
    "tee": 28.0,
    "poster": 22.0,
    "stl_file": 25.0,
    "3d_model": 30.0,
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
                "minimum": 1.50,
                "description": (
                    "Listing price in USD. Must respect brief.price_band_usd "
                    "if provided. Worker also enforces ceilings post-hoc."
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
        "PRICING — Etsy 3D-printable digital downloads typically sell $4–$20. "
        "Use brief.price_band_usd as your guide. For mini-figures aim $5–$10; "
        "jewelry $4–$8; decor $8–$15; cosplay/props $10–$25. Never exceed "
        "brief.price_band_usd[1]. Pick a price that converts."
    ) if is_3d else (
        "PRICING — the shop is brand new and has no reviews. Pick a price that "
        "real buyers would impulse-purchase. Use brief.price_band_usd as your "
        "guide; lean toward the LOWER end of that band, not the middle. Never "
        "exceed brief.price_band_usd[1]. If no band is provided, price in the "
        "$3–$8 range. Sub-$10 wins on a fresh shop."
    )

    shop_persona = (
        "an AI-run shop selling 3D-printable digital files (STL + GLB) on Etsy + Cults3D"
        if is_3d else
        f"an AI-run Etsy shop selling {product_type.replace('_', ' ')}s"
    )

    system = (
        f"You are the Listing Copywriter at {shop_persona}. "
        "Given a Demand Brief and an Asset Description, produce a complete "
        "listing draft. Title must be ≤140 chars. Exactly 13 tags. "
        "Description should be SEO-tuned and policy-compliant. "
        f"PRODUCT — {product_guide} "
        f"{pricing_guidance} "
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


# Hard ceiling used to clamp the model's price choice on a brand-new shop.
# Until the SI loop learns from real Etsy sales (see project_north_star), the
# safest policy is "cheap enough to actually impulse-buy from an unknown shop."
NEW_SHOP_PRICE_CEILING_USD = 12.0


def _clamp_price(price: float, brief: dict) -> float:
    """Force the model's price into a sane band for a new, no-review shop.

    Constraints, in order:
      1. price <= brief.price_band_usd[1] when provided
      2. price <= per-product-type ceiling (3D printables can go higher
         than 2D stickers — see PRICE_CEILING_BY_TYPE)
      3. price >= brief.price_band_usd[0] when provided (no loss leaders)
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
    product_type = brief.get("product_type", "") if isinstance(brief, dict) else ""
    type_ceiling = PRICE_CEILING_BY_TYPE.get(product_type, NEW_SHOP_PRICE_CEILING_USD)
    capped = float(price)
    if hi is not None:
        capped = min(capped, hi)
    capped = min(capped, type_ceiling)
    if lo is not None:
        capped = max(capped, lo)
    capped = max(capped, 1.50)
    return round(capped, 2)


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
    elif inp.get("price_usd") < 1.50:
        errors.append(f"price_usd {inp['price_usd']} below floor 1.50")
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
