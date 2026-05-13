import json
import os
import sys
import urllib.request
import urllib.error

MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 600

SVG_MODEL = "claude-sonnet-4-6"
SVG_MAX_TOKENS = 16000

ANTHROPIC_BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")

# Wall-clock budget guard for the Higgsfield product-photoshoot enhance
# step. Supervisor outer-cap is 750s; the enhance can take up to ~150s;
# the angle-renderer pass after it takes 20-40s. If `handle()` is already
# past this threshold, skip the enhance and ship the un-enhanced Tripo
# preview (still a usable listing thumbnail) — better than blowing the
# whole job. Math: 220 (Anthropic worst) + 120 (nano) + 240 (Tripo) = 580s
# absolute worst entry, so threshold 500 means skip kicks in only when at
# least two earlier stages went long.
HIGGSFIELD_SKIP_AFTER_SEC = 500


def _retry_request(req: urllib.request.Request, timeout: int = 60, max_attempts: int = 3) -> str:
    """POST with exponential backoff. Retries on 5xx and URLError. Does NOT retry on 4xx.
    Returns the response body as utf-8 string. Raises on final failure.

    HTTP 529 is Anthropic's load-shedding signal — typical overload events
    last 30s-2min. The retry budget is intentionally tight for the designer:
    this worker has a 900s supervisor outer-cap and 4 more external stages
    after this call (nanobanana → Tripo poll → Higgsfield enhance → raster).
    Worst case for THIS call: 3 × 60s urlopen + 10s + 30s sleep = ~220s.
    Going wider (5 attempts at 60s + 8/15/30/60/60 sleeps = 413s) was eating
    the budget on overload days and tripping the outer timeout. If
    Anthropic is genuinely overloaded for 3+ minutes, the next cycle gets
    a fresh slot — better than wedging this one.

    _retry_request: see workers/research/tests/test_research.py for behavior coverage.
    """
    import time as _time
    overload_delays = (10, 30)
    fast_delays = (1, 4)
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


def _messages_for_json_call(user_content) -> list[dict]:
    """Build the messages array for a JSON-emitting Anthropic call. Adds the
    assistant prefill only when the API supports it (direct Anthropic, not
    a bridge proxy)."""
    msgs: list[dict] = [{"role": "user", "content": user_content}]
    if _use_json_prefill():
        msgs.append({"role": "assistant", "content": "{"})
    return msgs



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


def _override_compatible_with_focus(override: str | None) -> bool:
    """Reject overrides that drifted back to the pre-3D-pivot world.

    The strategist + SI workers periodically rewrite overrides from operator
    feedback and outcomes. If either runs with stale context — or a pre-pivot
    snapshot resurfaces — it can write a sticker/SVG-era override that makes
    the Designer's Haiku call emit markup instead of a JSON brief, blowing
    the parser and (when the cascade fires) the supervisor's outer timeout.

    Returns False when SHOP_FOCUS=3d_only AND the override carries unambiguous
    2D-era markers (viewBox, kiss-cut, 'output SVG only', planner bundle).
    Caller skips the override and falls back to the built-in 3D-aware baseline.
    """
    if not override:
        return True
    focus = os.environ.get("SHOP_FOCUS", "3d_only").strip().lower()
    if focus != "3d_only":
        return True
    s = override.lower()
    stale_markers = (
        "viewbox",
        "kiss-cut", "kiss cut",
        "output valid svg", "output only the svg", "output svg only",
        "svg markup",
        "planner bundle", "adhd planner", "printable wall art",
        "sticker shop", "sticker-first", "kiss-cut vinyl",
    )
    return not any(m in s for m in stale_markers)


def _load_system_override(role: str) -> str | None:
    """Read ~/.agent-factory/prompts.json and return system_override for role, or None.

    Rejects overrides that fail the SHOP_FOCUS compatibility check — see
    _override_compatible_with_focus for the rationale.
    """
    path = os.path.expanduser("~/.agent-factory/prompts.json")
    try:
        with open(path) as f:
            data = json.load(f)
        ov = data.get(role, {}).get("system_override")
        if isinstance(ov, str) and ov.strip():
            if not _override_compatible_with_focus(ov):
                print(
                    f"[designer] rejecting stale {role}.system_override "
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
    """Read operator standing instructions from the ChatPanel Steer action.
    Returns a normalized list of `{"text": str, "image_paths": list[str]}`
    dicts. Two on-disk shapes are accepted: plain strings (legacy / no
    images) and `{"text": ..., "image_paths": [...]}` (new shape when
    the operator attached reference images via the ChatPanel paperclip).
    """
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
    """Append operator standing instructions as the final block of the system
    prompt. Operator steers compose with — and take precedence over — both the
    default prompt and any strategist-tuned override, because the last block
    in the system prompt gets the model's strongest attention.

    Only the TEXT half of each steer lands in the system prompt — image
    refs attach to the user message via _build_user_content_with_steer_images
    because Anthropic's `system` field is text-only.
    """
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


def _build_user_content_with_steer_images(
    user_prompt: str, role: str
) -> "str | list[dict]":
    """If any operator steer for `role` carries image references, upgrade
    the user-message content from a plain string to a list of multimodal
    blocks. No-op when no images are attached. The designer benefits most
    from image refs (style / color / silhouette references) — they feed
    directly into the brief_for_image_gen the model produces."""
    import base64
    import mimetypes
    refs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for entry in _load_operator_steers(role):
        for path in entry.get("image_paths", []):
            if not isinstance(path, str) or path in seen:
                continue
            seen.add(path)
            refs.append((entry.get("text", ""), path))
    if not refs:
        return user_prompt
    blocks: list[dict] = []
    for text, path in refs:
        try:
            with open(path, "rb") as f:
                raw = f.read()
        except OSError as e:
            print(
                f"[designer] skipping unreadable steer image {path!r}: {e}",
                file=sys.stderr, flush=True,
            )
            continue
        mime = mimetypes.guess_type(path)[0] or "image/png"
        if mime not in ("image/png", "image/jpeg", "image/webp", "image/gif"):
            mime = "image/png"
        blocks.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": mime,
                "data": base64.b64encode(raw).decode("ascii"),
            },
        })
        snippet = text[:200] + ("…" if len(text) > 200 else "")
        blocks.append({
            "type": "text",
            "text": f"^ Operator reference image for the steer: {snippet!r}",
        })
    blocks.append({"type": "text", "text": user_prompt})
    return blocks


def _designer_schema_block(brief: dict) -> str:
    """The non-negotiable protocol contract for the Designer's JSON output.

    Always appended to the system prompt — including when a strategist
    override is active — so that tuning the design philosophy can never
    silently drop the schema directive and break the parser downstream.
    """
    product_type = brief.get("product_type", "") if isinstance(brief, dict) else ""
    is_3d = product_type in ("stl_file", "3d_model")
    if is_3d:
        return (
            "OUTPUT FORMAT — return JSON only, no prose, no markdown fences. "
            "All keys and string values MUST use double quotes (not single "
            "quotes, not unquoted JS-style keys). Exact schema:\n"
            "{\n"
            '  "asset_type": "<stl_file | 3d_model>",\n'
            '  "style": "<one sentence: stylized vs realistic, organic vs '
            "geometric, smooth vs faceted, stylization anchors>\",\n"
            '  "palette": ["<hex>"],\n'
            '  "dimensions": "<scale hint, e.g. \'28mm tabletop mini\', '
            "'8cm desk decor', 'wearable pendant'>\",\n"
            '  "mockup_count": 1,\n'
            '  "brief_for_image_gen": "<the actual generator prompt: '
            "subject + pose + stylization + printability constraints (no thin "
            "overhangs, support-friendly, single static mesh, untextured "
            "single-color). 1-3 sentences max.>\"\n"
            "}"
        )
    return (
        "OUTPUT FORMAT — return JSON only, no prose, no markdown fences. "
        "All keys and string values MUST use double quotes (not single "
        "quotes, not unquoted JS-style keys). Exact schema:\n"
        "{\n"
        '  "asset_type": "<printable | svg | template | ebook>",\n'
        '  "style": "<descriptive style notes, 1 sentence>",\n'
        '  "palette": ["<hex>", "<hex>", "<hex>"],\n'
        '  "dimensions": "<e.g. \'8.5x11 inch printable, 300dpi\'>",\n'
        '  "mockup_count": <int 1-4>,\n'
        '  "brief_for_image_gen": "<single concise prompt suitable for SDXL>"\n'
        "}"
    )


def build_designer_prompt(brief: dict) -> tuple[str, str]:
    product_type = brief.get("product_type", "") if isinstance(brief, dict) else ""
    is_3d = product_type in ("stl_file", "3d_model")
    if is_3d:
        # 3D-aware philosophy layer. The schema layer is appended below via
        # _designer_schema_block so the strategist's override path and the
        # built-in path stay schema-equivalent.
        #
        # Architecture: Identity → Pipeline-aware rules → Examples → Anti-
        # patterns. The string `brief_for_image_gen` is sent verbatim to
        # Nano Banana Pro (image render) and then the resulting PNG is fed
        # into Tripo/Meshy image-to-3D. So the brief must satisfy BOTH
        # stages — front-loaded subject + adjectives (early-token weighting),
        # explicit pose, single stylization anchor, real-unit scale,
        # printability constraints, and a negative clause.
        philosophy = (
            "PERSONA — You are the Designer at an AI-run 3D-asset shop "
            "selling STL + GLB digital downloads on Etsy and Cults3D. You "
            "think like a sculptor with a decade of experience prototyping "
            "for tabletop game studios and collector-figurine shops: you "
            "obsess over silhouette readability at thumb-size, base "
            "stability, and support-friendly geometry. Your one job is to "
            "write a brief that produces a single, printable, sellable "
            "mesh on the first Tripo / Meshy run — no second pass. Buyers: "
            "hobbyist 3D printers, tabletop gamers, jewelry makers, "
            "collectors, cosplayers, desk-decor shoppers.\n\n"

            "INPUT: a Demand Brief (niche + design_direction + product_type "
            "from research).\n"
            "OUTPUT: structured JSON (schema below) describing one printable "
            "3D asset. The single most important field is `brief_for_image_gen` "
            "— that string is sent verbatim to Nano Banana Pro to produce one "
            "front-facing reference render, which Tripo/Meshy then reconstruct "
            "into a 3D mesh. Bad image = bad mesh. Compose with discipline.\n\n"

            "PROMPT FORMULA for `brief_for_image_gen` — front-load subject + "
            "key adjectives (early tokens carry more weight in both Nano "
            "Banana Pro and Tripo/Meshy):\n"
            "  [Subject + pose] · [Single stylization anchor] · [Material / "
            "surface] · [Scale anchor in real units] · [Printability "
            "constraints] · (negative: 3-5 explicit excludes)\n\n"

            "EXAMPLES — copy this shape, swap the subject:\n"
            "  Example 1 (character figurine): \"Standing goblin warrior, "
            "three-quarter stance, sword raised overhead. Stylized cartoon "
            "with hard-surface armor. Matte single-color render, no PBR "
            "textures. 28mm tabletop mini scale, support-friendly silhouette "
            "with circular base, single static mesh. (negative: no thin "
            "spear blade, no floating cloak, no second figure, no "
            "background)\"\n"
            "  Example 2 (deity statue): \"Seated Bastet figurine, upright "
            "posture, paws forward, head tilted slightly. Stylized Egyptian "
            "Art Deco — sharp geometric forms, smooth surfaces. Matte "
            "single-color, no painted detail. 15cm desk display scale, "
            "hollow-printable, support-friendly. (negative: no jewelry "
            "details, no offering bowl, no thin appendages, no hieroglyphs "
            "floating in space)\"\n"
            "  Example 3 (terrain tile): \"Single modular mushroom-forest "
            "terrain tile, top-down view, 5cm hex base with central "
            "mushroom cluster. Stylized D&D fantasy, low-poly. Solid base, "
            "watertight geometry, no overhangs. 28mm tabletop scale. "
            "(negative: no characters, no thin grass blades, no animal "
            "figures, no separate components)\"\n\n"

            "HARD RULES for `brief_for_image_gen`:\n"
            "  • Exactly ONE subject (a 'modular tile set' counts as one "
            "assembled tile).\n"
            "  • Explicit pose / orientation: standing / seated / kneeling "
            "/ three-quarter / top-down / side profile.\n"
            "  • Single stylization anchor (pick one): stylized cartoon | "
            "semi-realistic | low-poly | organic flowing | hard-surface "
            "geometric | sculptural realism.\n"
            "  • Scale anchor in real units (28mm tabletop / 8cm desk / "
            "15cm display / wearable pendant size).\n"
            "  • Printability clause — minimum: 'support-friendly "
            "silhouette' + 'single static mesh' + 'matte single-color'.\n"
            "  • Negative clause `(negative: ...)` with 3-5 explicit "
            "excludes. Almost always include: 'no PBR textures, no "
            "background, no second figure'.\n"
            "  • Length: 30-70 words. Tighter is better — Meshy explicitly "
            "warns that adjective overload buries the core object.\n\n"

            "ANTI-PATTERNS — these wreck the downstream pipeline:\n"
            "  ✗ Vague adjectives (\"beautiful\", \"amazing\", \"stunning\", "
            "\"high-quality\") — burn tokens, add no geometry signal.\n"
            "  ✗ Non-physical elements (smoke, glitter, magic energy, glow "
            "effects, particle systems) — Tripo/Meshy cannot model these; "
            "they show up as noise on the mesh.\n"
            "  ✗ Named copyrighted IP (Naruto, Pikachu, Mickey, Spider-Man, "
            "Yoda) — IP risk + the geometry never matches canon. Use "
            "generic descriptions of the archetype instead.\n"
            "  ✗ Adjective stacking (>6 stylization terms in a row).\n"
            "  ✗ Multiple subjects (\"a goblin AND his pet wolf\") — Tripo "
            "fuses them into a malformed blob.\n"
            "  ✗ Thin overhangs or long thin appendages (long swords, "
            "thin hair strands, butterfly antennae) — won't print without "
            "supports and Tripo often drops them.\n\n"

            "OTHER FIELDS — keep concise; the listing worker uses them as "
            "metadata:\n"
            "  • asset_type — 'stl_file' for printable buyer audiences "
            "(default), '3d_model' only when the niche is explicitly "
            "game-asset / AR.\n"
            "  • style — one-sentence summary of stylization + form "
            "language (e.g. \"low-poly stylized cartoon with rounded "
            "forms\").\n"
            "  • palette — one hex value. We render untextured single-"
            "color; pick the color that reads best as a listing preview.\n"
            "  • dimensions — real-world scale string (e.g. \"28mm "
            "tabletop mini\", \"8cm desk decor\", \"wearable pendant\").\n"
            "  • mockup_count — always 1 (the worker renders 5 angles "
            "automatically off the GLB)."
        )
    else:
        philosophy = (
            "You are the Designer at an AI-run digital-products Etsy shop. "
            "Given a Demand Brief, produce an asset description that an image "
            "generator would render into the actual product. Be specific "
            "about style, palette, composition, and dimensions."
        )
    system = philosophy + "\n\n" + _designer_schema_block(brief)
    user = json.dumps(brief)
    return system, user


def call_anthropic(api_key: str, brief: dict) -> tuple[dict, int, int]:
    system_prompt, user_prompt = build_designer_prompt(brief)
    override = _load_system_override("designer")
    if override:
        # The strategist may tune design philosophy, but the JSON-schema
        # contract is non-negotiable — always re-append it so an override
        # that forgets to mention the schema can't break the parser.
        system_prompt = override.rstrip() + "\n\n" + _designer_schema_block(brief)
    system_prompt = _append_operator_steers(system_prompt, "designer")
    # Image-bearing steers attach to the user message as multimodal blocks
    # (Anthropic's `system` is text-only). Designer benefits most from these
    # — style / palette / silhouette refs feed the brief_for_image_gen.
    user_content = _build_user_content_with_steer_images(user_prompt, "designer")

    body = json.dumps({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system_prompt,
                "messages": _messages_for_json_call(user_content),
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
    # Restore the prefilled "{" assistant.content so the JSON parser
    # sees a complete object. We only prepend when the response
    # contains no "{" at all — fenced or wrapped mock responses
    # already carry their own brace and pass through untouched.
    if "{" not in text:
        text = "{" + text
    usage = response.get("usage", {})
    tokens_in = usage.get("input_tokens", 0)
    tokens_out = usage.get("output_tokens", 0)

    data = _parse_loose_json_object(text)
    return data, tokens_in, tokens_out


def _build_svg_prompt(brief: dict, asset: dict) -> tuple[str, str]:
    """Build the (system, user) prompt pair for the SVG-generation Sonnet call.

    The system prompt encodes hard-won design psychology + sticker-specific
    market knowledge so that the model produces art that real Etsy buyers
    actually click on. Updated periodically by the Design Strategist agent
    via prompts.json system_override; that override (when present) replaces
    this baseline entirely. See workers/research/research/agent.py for the
    parallel pattern.
    """
    product_type = brief.get("product_type", "sticker") if isinstance(brief, dict) else "sticker"
    product_block = {
        "sticker": (
            "PRODUCT — kiss-cut vinyl sticker, viewed at 3–5 inches in a buyer's "
            "feed thumbnail. Must read instantly at thumbnail size. The sticker "
            "is what they peel and stick on a laptop / water bottle / car — design "
            "for that physical context, not a poster."
        ),
        "digital_print": (
            "PRODUCT — instant download printable wall art. Buyer prints at home. "
            "Composition must look intentional at 11×14 or larger on a wall."
        ),
        "mug": "PRODUCT — wraps around an 11oz ceramic mug. Design for ~3.5\" wide visible area.",
        "tee": "PRODUCT — printed on a unisex tee front. Bold center motif, no edge bleed.",
        "poster": "PRODUCT — matte wall poster, sized 11×14 to 18×24. Strong focal point.",
    }.get(product_type, "PRODUCT — digital design.")

    system = (
        "You are the lead designer at a high-converting AI Etsy shop. Every "
        "design you produce competes against thousands of human-made products "
        "in a buyer's search feed — it must stop the scroll, communicate a "
        "feeling in under one second, and feel premium enough to impulse-buy.\n\n"

        f"{product_block}\n\n"

        "DESIGN PSYCHOLOGY — the rules that drive clicks + sales:\n"
        " • ONE clear focal point. The eye must land somewhere obvious within "
        "100ms. Multiple competing subjects = no purchase.\n"
        " • Bold silhouette. The design should be recognizable even as a tiny "
        "black-on-white silhouette. If you can't tell what it is at 80×80px, "
        "rework the composition.\n"
        " • 3–5 colors max from the brief's palette. Repetition + restraint > "
        "rainbow. Use one accent that pops against the rest.\n"
        " • Whitespace is the design. Negative space is what makes a sticker "
        "feel premium vs. amateur. Don't fill every pixel.\n"
        " • Asymmetry feels alive. Perfect center compositions feel static. "
        "Off-center the subject slightly, or layer overlap for depth.\n"
        " • Emotional anchor — the buyer should feel something specific: "
        "cozy / empowered / amused / nostalgic / calm / motivated. Pick ONE "
        "emotion and design to it.\n\n"

        "COMPOSITION RULES:\n"
        " • Build the silhouette FIRST with 2–3 large shapes, then add "
        "small accent details. Never start with details.\n"
        " • Use overlap to create depth — let shapes intersect rather than "
        "sit side by side.\n"
        " • Rule of thirds: place the focal point on a 1/3 or 2/3 line, not "
        "dead center, unless the design is intentionally symmetric.\n"
        " • Edge breathing room — leave ~8% margin on all sides so the kiss "
        "cut never clips the design.\n\n"

        "COLOR THEORY:\n"
        " • Warm palettes (oranges/peaches/coral) for friendly, cozy, gift items.\n"
        " • Cool palettes (blues/teals/sage) for calm, wellness, professional vibes.\n"
        " • Earth tones (clay/terracotta/sand) for boho, nature, mindfulness.\n"
        " • High-contrast (one dark + one light + one bright) for impulse / humor.\n"
        " • Avoid muddy colors — saturate accents, desaturate backgrounds.\n\n"

        "TEXT RULES — be careful with text:\n"
        " • Most bestselling stickers have NO text or one short phrase (≤ 3 words).\n"
        " • If using text: pick ONE chunky sans-serif weight, integrate it into "
        "the composition, never just slap it on top.\n"
        " • font-family must be a system family our rasterizer can find: "
        "\"sans-serif\", \"serif\", or \"monospace\" (resolved to Helvetica / "
        "Times / Menlo). Never invent a font name.\n\n"

        "OUTPUT — STRICT:\n"
        " • Output ONLY the SVG markup. No preamble, no prose, no markdown fences.\n"
        " • viewBox 0 0 800 800. Either a palette-aligned background rect filling "
        "the canvas OR transparent — never a stark white background for non-text designs.\n"
        " • Use simple primitives: path, rect, circle, polygon, line, g, text.\n"
        " • HARD LIMITS: ≤ 40 shape elements, < 6000 chars total, must close </svg>.\n"
        " • Prefer 3–8 large bold shapes over 30 small ones — every shape should "
        "earn its place.\n"
    )
    niche = ""
    design_direction = ""
    if isinstance(brief, dict):
        niche = brief.get("niche", "") or ""
        design_direction = brief.get("design_direction", "") or ""
    style = asset.get("style", "") if isinstance(asset, dict) else ""
    palette = asset.get("palette", []) if isinstance(asset, dict) else []
    if isinstance(palette, list):
        palette_str = ", ".join(str(p) for p in palette)
    else:
        palette_str = str(palette)
    image_brief = asset.get("brief_for_image_gen", "") if isinstance(asset, dict) else ""

    parts = [f"Niche: {niche}"]
    if design_direction:
        # The Research agent already did the aesthetic homework — surface it
        # prominently so this overrides any generic palette hint below.
        parts.append(f"Design direction (from Research): {design_direction}")
    parts.extend([
        f"Style: {style}",
        f"Palette: {palette_str}",
        f"Image brief: {image_brief}",
        "Generate the complete SVG markup now.",
    ])
    user = "\n".join(parts)
    return system, user


def _strip_svg_fences(text: str) -> str:
    """Strip markdown code fences from a possibly-fenced SVG response.

    Handles ```svg, ```xml, ``` (plain), and trailing ```.
    """
    text = text.strip()
    if not text.startswith("```"):
        return text
    lines = text.split("\n")
    # First line is the opening fence (e.g. ``` or ```svg or ```xml). Drop it.
    lines = lines[1:]
    # If the last non-empty line is a closing fence, drop it.
    while lines and lines[-1].strip() == "":
        lines.pop()
    if lines and lines[-1].strip().startswith("```"):
        lines.pop()
    return "\n".join(lines).strip()


def _validate_svg(text: str) -> bool:
    """Cheap structural check: starts with <svg, ends with </svg>, has a drawing element."""
    if not text:
        return False
    lower = text.lower().strip()
    if not lower.startswith("<svg"):
        return False
    if not lower.rstrip().endswith("</svg>"):
        return False
    drawing_tokens = ("<path", "<rect", "<circle", "<polygon", "<line", "<g ", "<g>", "<text")
    return any(tok in lower for tok in drawing_tokens)


def _call_svg(api_key: str, brief: dict, asset: dict) -> tuple[str, int, int] | None:
    """Call Sonnet to produce SVG markup matching the asset brief.

    Returns (svg_text, tokens_in, tokens_out) on success. Returns None on any
    failure — Anthropic error, parse error, validation failure. The pipeline
    must continue without an asset path on None.
    """
    try:
        system, user = _build_svg_prompt(brief, asset)
        body = json.dumps({
            "model": SVG_MODEL,
            "max_tokens": SVG_MAX_TOKENS,
            "system": system,
            "messages": [{"role": "user", "content": user}],
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
        raw = _retry_request(req, timeout=120)
        response = json.loads(raw)
        text = response["content"][0]["text"]
        usage = response.get("usage", {})
        tokens_in = usage.get("input_tokens", 0)
        tokens_out = usage.get("output_tokens", 0)

        stripped = _strip_svg_fences(text)
        if not _validate_svg(stripped):
            print(
                f"[designer] svg validation failed; first 80 chars={stripped[:80]!r}",
                file=sys.stderr,
                flush=True,
            )
            return None
        return stripped, tokens_in, tokens_out
    except Exception as e:
        print(f"[designer] svg call failed: {e}", file=sys.stderr, flush=True)
        return None


def _save_svg(job_id: int, svg: str) -> str | None:
    """Atomic write to ~/.agent-factory/assets/{job_id}.svg. Returns path or None."""
    try:
        data_dir = os.environ.get("AGENT_FACTORY_DATA", os.path.expanduser("~/.agent-factory"))
        assets_dir = os.path.join(data_dir, "assets")
        os.makedirs(assets_dir, exist_ok=True)
        path = os.path.join(assets_dir, f"{job_id}.svg")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(svg)
        os.replace(tmp, path)
        return path
    except Exception as e:
        print(f"[designer] svg save failed: {e}", file=sys.stderr, flush=True)
        return None


def _image_to_3d_provider() -> str:
    """tripo (default) | meshy. Validated; unknown values fall through to
    tripo to avoid surprising provider swaps from a typo."""
    v = os.environ.get("IMAGE_TO_3D_PROVIDER", "").strip().lower()
    if v in {"tripo", "meshy"}:
        return v
    return "tripo"


def _classify_3d_provider_failure(err_str: str) -> str | None:
    """Map a raw 3D-provider error string (e.g. 'Meshy POST ... HTTP 402:
    {"code":"insufficient_credits",...}') to a short, human-readable reason
    that fits in the ticker + alert sub-text. Returns None when the cause
    isn't recognisable — the caller should fall back to the raw error.

    The provider tag at the start of the error string tells us which
    service to name; the HTTP code + body text narrows down the cause.
    """
    if not err_str:
        return None
    s = err_str.lower()
    if "tripo" in s:
        provider = "Tripo"
    elif "meshy" in s:
        provider = "Meshy"
    else:
        provider = "3D provider"
    # Body-text signals first — they win over status codes because Tripo and
    # Meshy both use 200-with-error-payload for some failure modes.
    if ("insufficient_credit" in s or "insufficient credit" in s
            or "out of credit" in s or "no credit" in s
            or "credit_exhaust" in s or "balance is" in s
            or "enough credit" in s or "purchase more credit" in s
            or '"code":2010' in s or "'code': 2010" in s):
        return f"{provider}: out of credits — top up your account"
    if "payment required" in s or "http 402" in s:
        return f"{provider}: out of credits (HTTP 402)"
    if ("rate_limit" in s or "rate limit" in s or "too many requests" in s
            or "http 429" in s):
        return f"{provider}: rate-limited (HTTP 429) — slow down or upgrade plan"
    if ("unauthorized" in s or "invalid_api_key" in s or "invalid api key" in s
            or "http 401" in s):
        return f"{provider}: API key invalid or revoked (HTTP 401)"
    if "http 403" in s or "forbidden" in s:
        return f"{provider}: access forbidden (HTTP 403)"
    if "http 5" in s:
        return f"{provider}: server error — try again later"
    if "network error" in s or "name resolution" in s:
        return f"{provider}: network unreachable"
    # ensure_stl_under_cap raises StlTooLargeError when its decimation loop
    # can't get the mesh under Etsy's 19 MB cap. Surface a clean operator
    # message so the alert reads as "shrink upstream" not as a raw stacktrace.
    if "stl still" in s and "decimation rounds" in s:
        return (
            f"{provider}: mesh too dense for Etsy's 19 MB cap even after "
            "decimation — try a lower-detail preset or a simpler subject"
        )
    if "stl is" in s and "decimation failed" in s:
        return (
            f"{provider}: STL decimation unavailable (trimesh missing or "
            "broken) — install trimesh in the designer venv"
        )
    return None


class _Image3dTimedOut(Exception):
    """Raised by _run_image_to_3d when the chosen provider hit its internal
    poll timeout. Signals the caller to skip the text-to-3D cascade — the
    provider is queued, and burning another 240s on it will likely hit the
    same wait and trip the supervisor's outer timeout."""


def _looks_like_timeout(err: Exception) -> bool:
    """MeshyError / TripoError use the message 'timed out after Ns' on poll
    timeouts (see meshy.py:120/212, tripo.py:204). Sniff for that so we can
    treat a queued-provider timeout differently from auth/quota failures."""
    return "timed out after" in str(err).lower()


def _run_image_to_3d(
    *,
    brief: dict,
    asset: dict,
    job_id: int,
    assets_dir: str,
    meshy_key: str,
    tripo_key: str,
) -> tuple[str, str, str, str, str] | None:
    """Run a reference image render → chosen image-to-3D provider. Returns
    (glb_path, stl_path, preview_png, mesh_model, image_gen_model) on
    success, or None to signal the caller to fall through to text-to-3D.
    Raises _Image3dTimedOut when the provider was queued and exhausted
    its poll budget — the caller should NOT cascade in that case (a
    second 240s wait would likely repeat the same queue stall and trip
    the supervisor's outer 900s timeout).

    `mesh_model` is the 3D-provider identifier (e.g. tripo-image-to-3d)
    and `image_gen_model` is the image-generator identifier (e.g.
    gemini-3.1-flash-image-preview). Both feed budget_ledger as
    separate per-call charges.
    """
    try:
        from . import nanobanana
    except ImportError as e:
        print(f"[designer] nanobanana import failed: {e}", file=sys.stderr, flush=True)
        return None
    prompt = (
        asset.get("brief_for_image_gen")
        or brief.get("design_direction")
        or brief.get("niche")
        or ""
    )
    if not isinstance(prompt, str) or not prompt.strip():
        return None
    try:
        # api_key arg is a back-compat shim; the Higgsfield CLI handles
        # auth internally so the value is ignored. We pass None to keep
        # the signature explicit at the call site.
        ref_path, image_gen_model = nanobanana.generate_reference_image(
            None, prompt, job_id=job_id, assets_dir=assets_dir
        )
    except Exception as e:
        print(
            f"[designer] nanobanana failed: {e} — falling back to text-to-3D",
            file=sys.stderr, flush=True,
        )
        return None

    provider = _image_to_3d_provider()
    # Provider selection is EXCLUSIVE: the settings choice picks one of
    # tripo/meshy and we never silently use the other. If the selected
    # provider's key isn't configured, hard-fail the job so the operator
    # sees the actual misconfiguration — burning a nanobanana credit on a
    # job that can't finish is worse than admitting the credential gap.
    try:
        if provider == "tripo":
            if not tripo_key:
                raise RuntimeError("TRIPO_API_KEY not set for image-to-3d")
            from . import tripo as t3d
            glb, stl, png = t3d.generate_3d_from_image(
                tripo_key, ref_path, job_id=job_id, assets_dir=assets_dir
            )
            return glb, stl, png, "tripo-image-to-3d", image_gen_model
        else:
            if not meshy_key:
                raise RuntimeError("MESHY_API_KEY not set for image-to-3d")
            from . import meshy as m3d
            glb, stl, png = m3d.generate_3d_from_image(
                meshy_key, ref_path, job_id=job_id, assets_dir=assets_dir
            )
            return glb, stl, png, "meshy-image-to-3d", image_gen_model
    except Exception as e:
        if _looks_like_timeout(e):
            print(
                f"[designer] image-to-3d ({provider}) TIMED OUT: {e} — "
                "skipping text-to-3D cascade (provider queued)",
                file=sys.stderr, flush=True,
            )
            raise _Image3dTimedOut(str(e)) from e
        print(
            f"[designer] image-to-3d ({provider}) failed: {e} — "
            "falling back to text-to-3D",
            file=sys.stderr, flush=True,
        )
        return None


def _maybe_higgsfield_enhance(
    preview_png: str | None,
    brief: dict,
    job_id: int,
    assets_dir: str,
    elapsed_sec: float = 0.0,
) -> str | None:
    """If Higgsfield is enabled + authenticated AND the wall-clock budget
    still has headroom, run the preview through a product-photoshoot
    enhancement and return the new path. On any failure (or budget
    exhaustion) returns the original preview_png. Best-effort, never raises.

    Budget guard: Higgsfield enhance can take up to 240s. The supervisor's
    outer cap is 900s. If we're already past ~650s by the time we reach
    this step, skipping the enhance is the difference between shipping the
    listing with an un-enhanced thumbnail and the whole job getting killed
    mid-render and re-queued. The un-enhanced Tripo preview is already a
    usable listing thumbnail; the enhance is pure polish.
    """
    if not preview_png:
        return preview_png
    # Budget guard — leave at least 250s for the Higgsfield call to
    # complete + 40s for the angle-renderer pass that follows it. If we've
    # already burned past 650s, the enhance has to wait for next cycle.
    if elapsed_sec >= HIGGSFIELD_SKIP_AFTER_SEC:
        print(
            f"[designer] job_id={job_id} skipping Higgsfield enhance "
            f"(elapsed={elapsed_sec:.0f}s ≥ {HIGGSFIELD_SKIP_AFTER_SEC}s "
            "budget); using un-enhanced Tripo preview as listing thumbnail",
            file=sys.stderr, flush=True,
        )
        return preview_png
    try:
        from . import higgsfield as _hf
    except Exception as e:
        print(f"[designer] higgsfield import failed: {e}", file=sys.stderr, flush=True)
        return preview_png
    if not _hf.is_enabled():
        return preview_png
    prompt_hint = (
        brief.get("design_direction")
        or brief.get("niche")
        or "studio product shot, soft lighting, clean background"
    )
    enhanced = _hf.enhance_thumbnail(
        preview_png,
        prompt_hint,
        job_id=job_id,
        assets_dir=assets_dir,
    )
    return enhanced or preview_png


# Bundle generation. Each bundle item is another full Tripo/Meshy generation
# (~$0.20-$0.40 of provider credit + ~60-120s), so the cap matters. 4 is the
# point where buyer attention plateaus on an Etsy gallery (Etsy shows 5 image
# tiles before scroll) and where our per-cycle wall-clock leaves headroom for
# listing + publish before the supervisor's 900s outer timeout. Override per
# operator policy via BUNDLE_MAX_ITEMS; 0 disables bundles entirely.
BUNDLE_MAX_ITEMS_DEFAULT = 4


def _bundle_enabled() -> bool:
    """Bundle generation fans out 3-4 Tripo tasks per listing — a 2-3×
    cost multiplier with the image-first pipeline. Default OFF so each
    listing is one product = one Tripo call. Set BUNDLE_GENERATION_ENABLED=1
    when intentionally exploring bundle SKUs and you've decided the extra
    spend is worth it."""
    return os.environ.get("BUNDLE_GENERATION_ENABLED", "0").strip() == "1"


def _bundle_max_items() -> int:
    try:
        n = int(os.environ.get("BUNDLE_MAX_ITEMS", str(BUNDLE_MAX_ITEMS_DEFAULT)))
    except ValueError:
        return BUNDLE_MAX_ITEMS_DEFAULT
    return max(0, n)


def _generate_bundle_items(
    brief: dict,
    asset: dict,
    job_id: int,
    assets_dir: str,
    tripo_key: str,
    meshy_key: str,
) -> list[dict]:
    """Generate each bundle item via Nano Banana → image-to-3D, falling back
    to text-to-3D per-item if the reference render fails. Returns the list
    of successful items as `{name, asset_path, glb_path, preview_png, model}`.

    Skipped silently when:
      • bundle field missing / malformed (research-side normalizer guarantees
        a well-formed list of 2-6 strings when bundles are enabled)
      • no 3D provider key available

    On a partial failure (some items succeed, some fail) the caller decides:
      • ≥ 2 items → bundle listing
      • 1 item     → degraded single listing
      • 0 items    → fall through to existing single-item path

    Image-first per item produces dramatically better silhouettes than blind
    text-to-3D — the ref PNG locks pose, proportions, and stylization before
    the mesh reconstructor sees it. Falls back to text-to-3D per-item when
    Higgsfield is unauthed or the ref render fails, so a missing CLI never
    aborts the bundle.
    """
    if not _bundle_enabled():
        return []
    bundle = brief.get("bundle") if isinstance(brief, dict) else None
    if not isinstance(bundle, dict):
        return []
    items_raw = bundle.get("items")
    if not isinstance(items_raw, list) or len(items_raw) < 2:
        return []
    max_n = _bundle_max_items()
    if max_n <= 1:
        return []
    items_named = [s for s in items_raw[:max_n] if isinstance(s, str) and s.strip()]
    if len(items_named) < 2:
        return []

    # Provider selection is EXCLUSIVE — settings pick exactly one of
    # tripo/meshy and we never silently use the other. If the selected
    # provider's key is missing, skip the bundle and surface the
    # misconfiguration in the log.
    provider = _image_to_3d_provider()
    if provider == "tripo" and not tripo_key:
        print(
            "[designer] bundle skipped — IMAGE_TO_3D_PROVIDER=tripo but "
            "TRIPO_API_KEY not set",
            file=sys.stderr, flush=True,
        )
        return []
    if provider == "meshy" and not meshy_key:
        print(
            "[designer] bundle skipped — IMAGE_TO_3D_PROVIDER=meshy but "
            "MESHY_API_KEY not set",
            file=sys.stderr, flush=True,
        )
        return []

    try:
        from . import nanobanana as _nb
        nb_available = _nb.is_configured()
    except Exception as e:
        print(
            f"[designer] bundle nanobanana check failed: {e} — "
            "items will use text-to-3D",
            file=sys.stderr, flush=True,
        )
        nb_available = False

    shared_theme = bundle.get("shared_theme")
    if not isinstance(shared_theme, str) or not shared_theme.strip():
        shared_theme = brief.get("niche", "") or "bundle"
    base_direction = (
        asset.get("brief_for_image_gen")
        or brief.get("design_direction")
        or shared_theme
    )

    successful: list[dict] = []
    for idx, item_name in enumerate(items_named):
        # Sub-job id keeps every bundle item's asset files on disk-unique. Files
        # are written to {assets_dir}/{sub_job_id}.{glb,stl,png}; the renderer
        # uses these for thumbnails so collisions would silently swap models.
        sub_job_id = job_id * 100 + idx
        per_item_prompt = (
            f"{item_name}. {base_direction}. Shared theme: {shared_theme}. "
            f"Single static mesh, printable, consistent style with the rest of "
            f"the {shared_theme} set."
        ).strip()

        ref_path: str | None = None
        image_gen_model: str | None = None
        if nb_available:
            try:
                ref_path, image_gen_model = _nb.generate_reference_image(
                    None, per_item_prompt,
                    job_id=sub_job_id, assets_dir=assets_dir,
                )
            except Exception as e:
                print(
                    f"[designer] bundle item {idx+1}/{len(items_named)} "
                    f"'{item_name}' nanobanana failed: {e} — falling back "
                    "to text-to-3D for this item",
                    file=sys.stderr, flush=True,
                )
                ref_path = None
                image_gen_model = None

        try:
            if provider == "tripo":
                from . import tripo as t3d
                if ref_path:
                    glb, stl, png = t3d.generate_3d_from_image(
                        tripo_key, ref_path,
                        job_id=sub_job_id, assets_dir=assets_dir,
                    )
                    model = "tripo-image-to-3d"
                else:
                    glb, stl, png = t3d.generate_3d(
                        tripo_key, per_item_prompt,
                        job_id=sub_job_id, assets_dir=assets_dir,
                    )
                    model = "tripo-text-to-model"
            else:
                from . import meshy as m3d
                if ref_path:
                    glb, stl, png = m3d.generate_3d_from_image(
                        meshy_key, ref_path,
                        job_id=sub_job_id, assets_dir=assets_dir,
                    )
                    model = "meshy-image-to-3d"
                else:
                    glb, stl, png = m3d.generate_3d(
                        meshy_key, per_item_prompt,
                        job_id=sub_job_id, assets_dir=assets_dir,
                    )
                    model = "meshy-text-to-3d"
        except Exception as e:
            # One item failing must NOT abort the bundle. Log + continue —
            # the caller decides whether to ship as a smaller bundle, a
            # single-item degraded listing, or hard-fail.
            print(
                f"[designer] bundle item {idx+1}/{len(items_named)} "
                f"'{item_name}' failed: {e}",
                file=sys.stderr, flush=True,
            )
            continue
        successful.append({
            "name": item_name,
            "asset_path": stl,
            "glb_path": glb,
            "preview_png": png,
            "model": model,
            # The image-gen model is bundle-item-specific (one render per
            # item) — keep it on the item so the caller can fan it out
            # into provider_calls without re-counting refs that failed.
            "image_gen_model": image_gen_model,
        })

    return successful


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}

    import time as _time_handle
    _handle_t0 = _time_handle.time()

    job_id = params.get("job_id", 0)
    payload = params.get("payload", {})
    brief = payload.get("brief", payload)  # accept brief directly or nested
    cycle_id = payload.get("cycle_id") if isinstance(payload, dict) else None

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        msg = "ANTHROPIC_API_KEY not set"
        print(f"[designer] ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"designer failed: {msg}",
        }

    product_type = brief.get("product_type", "") if isinstance(brief, dict) else ""
    is_3d = product_type in ("stl_file", "3d_model")

    print(f"[designer] job_id={job_id} calling Anthropic model={MODEL} pt={product_type!r}", file=sys.stderr, flush=True)
    # provider_calls accumulates every non-Anthropic call this designer
    # job ran — Tripo / Meshy mesh tasks, Gemini/Higgsfield reference
    # renders, etc. The supervisor records one budget_ledger row per
    # entry using the per-call rate card in budget.rs. Token-based
    # Anthropic cost is reported separately via the top-level `model` +
    # `tokens_in/out` fields. Designer NEVER puts a 3D-provider name in
    # `model` — that corrupts the token-pricing math.
    provider_calls: list[dict] = []
    try:
        asset, tokens_in, tokens_out = call_anthropic(api_key, brief)
        asset_type = asset.get("asset_type", "printable")
        dimensions = asset.get("dimensions", "")

        if is_3d:
            # 3D product route. Three strategies, in priority order:
            #   (0) brief.bundle present + enabled → per-item Nano Banana
            #       ref render → image-to-3D, ship as a multi-file listing.
            #       Falls back to text-to-3D per-item if Higgsfield is
            #       unauthed or a ref render fails. Skipped if fewer than
            #       2 items succeed.
            #   (1) Higgsfield CLI authed + 3D provider key → Nano Banana
            #       Pro ref render (via Higgsfield CLI) → image-to-3D
            #       (tripo or meshy). Default route — image-first locks
            #       silhouette + proportions before the mesh step.
            #   (2) otherwise → text-to-3D fallback chain (meshy → tripo).
            # Image-gen cost is on Higgsfield credits; mesh-gen on Tripo/Meshy.
            meshy_key = os.environ.get("MESHY_API_KEY", "")
            tripo_key = os.environ.get("TRIPO_API_KEY", "")
            data_dir = os.environ.get(
                "AGENT_FACTORY_DATA", os.path.expanduser("~/.agent-factory")
            )
            assets_dir = os.path.join(data_dir, "assets")

            # Strategy 0: bundle expansion. Returns the list of successfully
            # generated bundle items. Empty list means "skip — fall through to
            # single-item path" (bundle missing / disabled / all items failed).
            bundle_items = _generate_bundle_items(
                brief=brief,
                asset=asset,
                job_id=job_id,
                assets_dir=assets_dir,
                tripo_key=tripo_key,
                meshy_key=meshy_key,
            )
            # Roll every successful bundle item's provider charges into
            # provider_calls so the supervisor records each Tripo/Meshy
            # task + each reference render. Counts collapse by model id
            # so a 3-item all-Tripo-image-to-3d bundle becomes one row
            # with calls=3 rather than three identical rows.
            for it in bundle_items:
                ig_model = it.get("image_gen_model")
                if ig_model:
                    provider_calls.append({"model": ig_model, "calls": 1})
                m = it.get("model")
                if m:
                    provider_calls.append({"model": m, "calls": 1})
            if len(bundle_items) >= 2:
                primary = bundle_items[0]
                asset["asset_path"] = primary["asset_path"]
                asset["glb_path"] = primary["glb_path"]
                asset["preview_png"] = primary["preview_png"]
                asset["asset_paths"] = [it["asset_path"] for it in bundle_items]
                asset["glb_paths"] = [it["glb_path"] for it in bundle_items]
                asset["preview_pngs"] = [it["preview_png"] for it in bundle_items]
                asset["bundle"] = {
                    "items": bundle_items,
                    "shared_theme": (
                        brief.get("bundle", {}).get("shared_theme")
                        if isinstance(brief.get("bundle"), dict) else None
                    ),
                }
                asset["dimensions"] = (
                    f"3D printable bundle ({len(bundle_items)} STLs + GLBs)"
                )
                model_used = primary["model"]
                svg_glyph = f"stl ✓ bundle ({len(bundle_items)} items)"
                print(
                    f"[designer] job_id={job_id} bundle "
                    f"({len(bundle_items)} items, theme="
                    f"{asset['bundle']['shared_theme']!r}) ready",
                    file=sys.stderr, flush=True,
                )
                # Skip the single-item branches below — bundle path owns the
                # asset dict from here on.
                bundle_done = True
            elif len(bundle_items) == 1:
                # Bundle partially failed but one item survived. Use it as a
                # single-file listing rather than throw away the work — the
                # listing copy will still describe a single item.
                primary = bundle_items[0]
                asset["asset_path"] = primary["asset_path"]
                asset["glb_path"] = primary["glb_path"]
                asset["preview_png"] = primary["preview_png"]
                asset["preview_pngs"] = [primary["preview_png"]]
                asset["dimensions"] = "3D printable (.stl + .glb, bundle degraded)"
                model_used = primary["model"]
                svg_glyph = "stl ✓ (bundle degraded to single)"
                print(
                    f"[designer] job_id={job_id} bundle degraded: only 1 of "
                    f"{len(brief.get('bundle', {}).get('items', []))} "
                    "items survived; shipping as single",
                    file=sys.stderr, flush=True,
                )
                bundle_done = True
            else:
                bundle_done = False

            if bundle_done:
                # Bundle (or degraded-single) path took over. Continue to the
                # downstream listing/publisher handoff at the end of the
                # function — same shape as the existing happy path.
                # Set the unused variables that the post-3D block expects.
                try:
                    import time as _t
                    from . import preview as _preview
                    t0 = _t.time()
                    angle_paths = _preview.try_render_angles(
                        asset["glb_path"], output_dir=assets_dir,
                        job_id=job_id, resolution=768,
                    )
                    if angle_paths:
                        # Prepend angle renders to the existing preview list
                        # (bundle path already populated preview_pngs with each
                        # item's primary thumbnail).
                        asset["preview_pngs"] = angle_paths + asset.get(
                            "preview_pngs", []
                        )
                    print(
                        f"[designer] job_id={job_id} bundle angle previews done "
                        f"({len(angle_paths)} files, {_t.time()-t0:.1f}s)",
                        file=sys.stderr, flush=True,
                    )
                except Exception as e:
                    print(
                        f"[designer] bundle angle render failed: {e} "
                        "— shipping with item thumbnails only",
                        file=sys.stderr, flush=True,
                    )
                # Bundle path took over. Skip strategy-1/2 below.
                i23 = None
                image3d_timed_out = False
                nb_available = False
            else:
                # Bundle wasn't applicable — proceed with strategy 1/2 below.
                # Lazy import — falls through to text-to-3D if the module or
                # CLI is unavailable, never raises.
                try:
                    from . import nanobanana as _nb
                    nb_available = _nb.is_configured()
                except Exception as e:
                    print(f"[designer] nanobanana check failed: {e}", file=sys.stderr, flush=True)
                    nb_available = False

                i23 = None
                image3d_timed_out = False
            if not bundle_done and nb_available and (tripo_key or meshy_key):
                try:
                    i23 = _run_image_to_3d(
                        brief=brief,
                        asset=asset,
                        job_id=job_id,
                        assets_dir=assets_dir,
                        meshy_key=meshy_key,
                        tripo_key=tripo_key,
                    )
                except _Image3dTimedOut:
                    # Provider was queued; skip the text-to-3D cascade so we
                    # don't burn another 240s + trip the supervisor's outer
                    # timeout. Cycle ends cleanly and the next one gets a
                    # fresh slot at the provider.
                    image3d_timed_out = True

            if bundle_done:
                # Bundle path already populated asset, model_used, svg_glyph.
                # Skip strategy-1/2.
                pass
            elif i23 is not None:
                glb_path, stl_path, preview_png, model_used, image_gen_model = i23
                # Two provider charges: the reference image render +
                # the image-to-3D task.
                provider_calls.append({"model": image_gen_model, "calls": 1})
                provider_calls.append({"model": model_used, "calls": 1})
                print(
                    f"[designer] job_id={job_id} image-to-3d done glb={glb_path} "
                    f"(billed: {image_gen_model} + {model_used})",
                    file=sys.stderr, flush=True,
                )
                preview_png = _maybe_higgsfield_enhance(
                    preview_png, brief, job_id, assets_dir,
                    elapsed_sec=_time_handle.time() - _handle_t0,
                )
                asset["asset_path"] = stl_path
                asset["glb_path"] = glb_path
                asset["preview_png"] = preview_png
                asset["dimensions"] = "3D printable (.stl + .glb, image-to-3D)"
                svg_glyph = f"stl ✓ ({model_used.split('-')[0]} img→3d)"
                # Multi-angle previews: render 5 camera angles off the GLB so
                # the Etsy listing can show the model from every side, not
                # just one ambiguous thumbnail. 768px is plenty — Etsy renders
                # listing photos at ~570px and the rasterizer is pure-Python,
                # so cutting from 1024 to 768 halves the wall-clock cost.
                # Falls back silently to the single thumbnail when the mesh
                # is degenerate / unrenderable.
                try:
                    import time as _t
                    from . import preview as _preview
                    t0 = _t.time()
                    print(f"[designer] job_id={job_id} rendering 5 angle previews…", file=sys.stderr, flush=True)
                    angle_paths = _preview.try_render_angles(
                        glb_path, output_dir=assets_dir, job_id=job_id, resolution=768,
                    )
                    print(
                        f"[designer] job_id={job_id} angle previews done "
                        f"({len(angle_paths)} files, {_t.time()-t0:.1f}s)",
                        file=sys.stderr, flush=True,
                    )
                except Exception as e:
                    print(f"[designer] angle render import failed: {e}", file=sys.stderr, flush=True)
                    angle_paths = []
                asset["preview_pngs"] = angle_paths + [preview_png] if angle_paths else [preview_png]
            elif image3d_timed_out:
                # Image-to-3D timed out — provider was queued. Skip the
                # text-to-3D cascade (a second 240s wait would likely hit
                # the same backlog and risk the supervisor's outer timeout).
                # Surface as a soft fail; next cycle gets a fresh attempt.
                print(
                    f"[designer] job_id={job_id} skipping text-to-3d cascade "
                    "after image-to-3d timeout",
                    file=sys.stderr, flush=True,
                )
                asset["asset_path"] = None
                model_used = MODEL
                svg_glyph = "3d timeout (provider queued)"
            else:
                # Text-to-3D fallback. Provider selection is EXCLUSIVE —
                # whatever IMAGE_TO_3D_PROVIDER is set to (default 'tripo')
                # is the only provider we'll call. Never silently swap to
                # the other side; the operator pays per provider and a
                # silent swap burns credits on a service they didn't pick.
                preferred = _image_to_3d_provider()
                provider: str | None = None
                if preferred == "tripo" and tripo_key:
                    provider = "tripo"
                elif preferred == "meshy" and meshy_key:
                    provider = "meshy"
                if provider is None:
                    missing_key = (
                        "TRIPO_API_KEY" if preferred == "tripo" else "MESHY_API_KEY"
                    )
                    print(
                        f"[designer] 3d job: IMAGE_TO_3D_PROVIDER={preferred} "
                        f"but {missing_key} not set — skipping mesh, "
                        "publishing text-only brief",
                        file=sys.stderr, flush=True,
                    )
                    asset["asset_path"] = None
                    model_used = MODEL
                    svg_glyph = f"3d skipped ({missing_key} missing)"
                else:
                    try:
                        prompt_3d = (
                            asset.get("brief_for_image_gen")
                            or asset.get("concept")
                            or brief.get("niche", "")
                        )
                        if provider == "meshy":
                            from . import meshy as m3d
                            glb_path, stl_path, preview_png = m3d.generate_3d(
                                meshy_key, prompt_3d, job_id=job_id, assets_dir=assets_dir
                            )
                            model_used = "meshy-text-to-3d"
                        else:
                            from . import tripo as t3d
                            glb_path, stl_path, preview_png = t3d.generate_3d(
                                tripo_key, prompt_3d, job_id=job_id, assets_dir=assets_dir
                            )
                            model_used = "tripo-text-to-model"
                        provider_calls.append({"model": model_used, "calls": 1})
                        preview_png = _maybe_higgsfield_enhance(
                            preview_png, brief, job_id, assets_dir,
                            elapsed_sec=_time_handle.time() - _handle_t0,
                        )
                        asset["asset_path"] = stl_path
                        asset["glb_path"] = glb_path
                        asset["preview_png"] = preview_png
                        asset["dimensions"] = "3D printable (.stl + .glb)"
                        svg_glyph = f"stl ✓ ({provider})"
                        try:
                            import time as _t
                            from . import preview as _preview
                            t0 = _t.time()
                            print(
                                f"[designer] job_id={job_id} rendering 5 angle previews…",
                                file=sys.stderr, flush=True,
                            )
                            angle_paths = _preview.try_render_angles(
                                glb_path, output_dir=assets_dir, job_id=job_id, resolution=768,
                            )
                            print(
                                f"[designer] job_id={job_id} angle previews done "
                                f"({len(angle_paths)} files, {_t.time()-t0:.1f}s)",
                                file=sys.stderr, flush=True,
                            )
                        except Exception as e:
                            print(f"[designer] angle render import failed: {e}", file=sys.stderr, flush=True)
                            angle_paths = []
                        asset["preview_pngs"] = (
                            angle_paths + [preview_png] if angle_paths else [preview_png]
                        )
                    except Exception as e:
                        raw_err = str(e)
                        print(f"[designer] 3d generation failed: {raw_err}", file=sys.stderr, flush=True)
                        asset["asset_path"] = None
                        model_used = MODEL
                        # Try to give the user a human-readable reason
                        # (out of credits / key invalid / rate-limited /
                        # network) — the raw HTTP body still goes to
                        # stderr above for diagnostics. Falls back to the
                        # raw 240-char snippet when the cause isn't one
                        # of the well-known patterns.
                        friendly = _classify_3d_provider_failure(raw_err)
                        svg_glyph = friendly if friendly else f"3d failed: {raw_err[:240]}"
        else:
            # Second call: Sonnet generates real SVG markup we save to disk.
            # Any failure here is logged and the pipeline continues text-only.
            svg_result = _call_svg(api_key, brief, asset)
            if svg_result is not None:
                svg, svg_in, svg_out = svg_result
                asset_path = _save_svg(job_id, svg)
                if asset_path:
                    asset["asset_path"] = asset_path
                    tokens_in += svg_in
                    tokens_out += svg_out
                    model_used = SVG_MODEL  # Sonnet dominates cost
                    svg_glyph = "svg ✓"
                else:
                    asset["asset_path"] = None
                    model_used = MODEL
                    svg_glyph = "text only"
            else:
                asset["asset_path"] = None
                model_used = MODEL
                svg_glyph = "text only"

        print(
            f"[designer] job_id={job_id} done asset_type={asset_type!r} "
            f"in={tokens_in} out={tokens_out} model={model_used} "
            f"asset_path={asset.get('asset_path')!r}",
            file=sys.stderr, flush=True,
        )

        # 3D-only shop: if we have no asset on disk, the cycle cannot continue.
        # Stopping here prevents listing/publisher and the five marketplace
        # fan-out tasks (Etsy/POD/Cults3D/Sketchfab/Gumroad/MMF) from each
        # failing loudly with "missing asset_path". One critical message
        # instead of five errors.
        if not asset.get("asset_path"):
            # When svg_glyph already carries a classified reason (e.g.
            # "Tripo: out of credits ..."), promote it directly into the
            # fail_msg so the supervisor → UI alert reads cleanly. The
            # generic 3D-failure path keeps the historical "no asset
            # produced (...)" wrapping for diagnosability.
            classified = (
                svg_glyph if _classify_3d_provider_failure(svg_glyph) is not None
                else None
            )
            fail_msg = classified if classified else f"no asset produced ({svg_glyph})"
            print(
                f"[designer] job_id={job_id} HARD FAIL: {fail_msg}",
                file=sys.stderr, flush=True,
            )
            fail_result: dict = {
                "ok": False,
                "error": fail_msg,
                "ticker_text": f"designer → CYCLE STOPPED: {fail_msg}",
                # Same shape as the success path: model is always Claude;
                # provider_calls carries every (possibly successful)
                # mesh / image-gen task we burned credits on before the
                # failure. Even on a failed cycle the operator paid for
                # the upstream calls and the ledger must reflect that.
                "model": MODEL,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "provider_calls": provider_calls,
                "messages": [
                    {
                        "from": "designer",
                        "to": "*",
                        "topic": "asset_failed",
                        "importance": "critical",
                        "content": (
                            f"Aborted this cycle. "
                            f"{fail_msg.strip().rstrip('.')}. "
                            f"The **{brief.get('niche', '?')}** brief never made it past "
                            f"asset generation — no asset handoff to Theo for the listing."
                        ),
                    }
                ],
            }
            if cycle_id:
                fail_result["cycle_id"] = cycle_id
            return fail_result

        handoff_payload: dict = {"brief": brief, "asset": asset}
        if cycle_id:
            handoff_payload["cycle_id"] = cycle_id

        # Conversation log: describe what we drew so listing can pick titles /
        # tags that match the actual image, and strategist sees the chain.
        # Conversational prose — reads as the designer handing off to the
        # listing copywriter, not as a log entry.
        title_hint = asset.get("title") or asset.get("concept") or asset_type
        description_hint = (asset.get("description") or "").strip()
        niche_name = brief.get("niche", "?")

        listing_parts = [
            f"Theo — asset ready for **{niche_name}**. "
            f"**{title_hint}** as a {asset_type} at {dimensions}."
        ]
        if description_hint:
            listing_parts.append(description_hint[:600])
        designer_to_listing = "\n\n".join(listing_parts)
        broadcast = (
            f"Asset finished: **{title_hint}** for the **{niche_name}** brief."
        )
        messages = [
            {
                "from": "designer",
                "to": "listing",
                "topic": "asset_ready",
                "importance": "heads_up",
                "content": designer_to_listing,
            },
            {
                "from": "designer",
                "to": "*",
                "topic": "asset_ready",
                "importance": "info",
                "content": broadcast,
            },
        ]
        # `model` is the LLM that consumed `tokens_in/out` — always Claude
        # for designer jobs (the brief-generation call). The 3D / image
        # provider names live in provider_calls so the supervisor bills
        # them separately at flat per-call rates. Mixing them under
        # `model` is what historically caused tripo/meshy/gemini spend
        # to be silently undercounted.
        llm_model = SVG_MODEL if (
            isinstance(model_used, str) and model_used == SVG_MODEL
        ) else MODEL
        result: dict = {
            "ok": True,
            "asset": asset,
            "ticker_text": f"designer → listing: {asset_type} · {dimensions} · {svg_glyph}",
            "model": llm_model,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "provider_calls": provider_calls,
            "handoff": {
                "to_role": "listing",
                "payload": handoff_payload,
            },
            "messages": messages,
        }
        if cycle_id:
            result["cycle_id"] = cycle_id
        return result
    except Exception as e:
        msg = str(e)
        print(f"[designer] job_id={job_id} ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"designer failed: {msg}",
        }
