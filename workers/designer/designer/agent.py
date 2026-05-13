import json
import os
import sys
import urllib.request
import urllib.error

MODEL = "claude-haiku-4-5-20251001"
MAX_TOKENS = 600

SVG_MODEL = "claude-sonnet-4-6"
SVG_MAX_TOKENS = 16000

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
    """Read operator standing instructions written by the operator from the
    ChatPanel Steer action. Returns [] when missing or malformed."""
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
    """Append operator standing instructions as the final block of the system
    prompt. Operator steers compose with — and take precedence over — both the
    default prompt and any strategist-tuned override, because the last block
    in the system prompt gets the model's strongest attention."""
    steers = _load_operator_steers(role)
    if not steers:
        return system_prompt
    block = (
        "OPERATOR STANDING INSTRUCTIONS (operator-set, highest priority — "
        "apply to this job):\n"
        + "\n".join(f"- {s}" for s in steers)
    )
    return system_prompt.rstrip() + "\n\n" + block


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
        philosophy = (
            "You are the Designer at an AI-run 3D-asset shop. We sell STL + "
            "GLB downloads on Etsy + Cults3D. Given a Demand Brief, produce a "
            "concise structured description that feeds directly into a "
            "text-to-3D or image-to-3D generator (Tripo / Meshy / "
            "nanobanana). Be specific about subject, stylization, scale, and "
            "printability constraints."
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

    body = json.dumps({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system_prompt,
                "messages": _messages_for_json_call(user_prompt),
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


CHARACTER_KEYWORDS = (
    "character", "figurine", "figure", "mini", "miniature", "bust",
    "hero", "villain", "warrior", "knight", "samurai", "ninja", "wizard",
    "mage", "sorcerer", "monk", "paladin", "ranger", "rogue", "barbarian",
    "elf", "orc", "goblin", "dwarf", "troll", "ogre", "demon", "angel",
    "god", "goddess", "deity", "yokai", "spirit", "ghost",
    "anime", "manga", "shonen", "shounen", "mecha", "magical-girl",
    "magical girl", "cosplay", "fan art", "fan-art", "fanart",
    "samurai", "shogun", "dragon rider", "valkyrie", "amazon", "centaur",
    "minotaur", "nymph", "fairy", "elf", "wraith", "lich", "vampire",
    "werewolf", "kitsune", "tengu", "oni",
)


def _is_character_brief(brief: dict) -> bool:
    """Detect briefs whose subject is a character/figure — those benefit
    from the nanobanana → image-to-3D route. Heuristic, not authoritative:
    falls back to text-to-3D if uncertain, which is the safe default."""
    if not isinstance(brief, dict):
        return False
    if brief.get("ip_risk") in {"high", "mythology", "original"}:
        return True
    haystack = " ".join(
        str(brief.get(k) or "").lower()
        for k in ("niche", "design_direction")
    )
    return any(kw in haystack for kw in CHARACTER_KEYWORDS)


def _image_to_3d_provider() -> str:
    """tripo (default) | meshy. Validated; unknown values fall through to
    tripo to avoid surprising provider swaps from a typo."""
    v = os.environ.get("IMAGE_TO_3D_PROVIDER", "").strip().lower()
    if v in {"tripo", "meshy"}:
        return v
    return "tripo"


def _run_image_to_3d(
    *,
    brief: dict,
    asset: dict,
    job_id: int,
    assets_dir: str,
    meshy_key: str,
    tripo_key: str,
) -> tuple[str, str, str, str] | None:
    """Run Nano Banana Pro reference render (via Higgsfield CLI) → chosen
    image-to-3D provider. Returns (glb_path, stl_path, preview_png,
    model_used) on success, or None to signal the caller to fall through
    to text-to-3D.

    `model_used` is a short tag for budget tracking + UI ticker text.
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
        ref_path = nanobanana.generate_reference_image(
            None, prompt, job_id=job_id, assets_dir=assets_dir
        )
    except Exception as e:
        print(
            f"[designer] nanobanana failed: {e} — falling back to text-to-3D",
            file=sys.stderr, flush=True,
        )
        return None

    provider = _image_to_3d_provider()
    # Honour the provider preference, but if the chosen provider's key isn't
    # available, swap to whichever IS. We never let a config mismatch crash
    # a job that already burned a nanobanana credit.
    if provider == "tripo" and not tripo_key and meshy_key:
        provider = "meshy"
    elif provider == "meshy" and not meshy_key and tripo_key:
        provider = "tripo"

    try:
        if provider == "tripo":
            if not tripo_key:
                raise RuntimeError("TRIPO_API_KEY not set for image-to-3d")
            from . import tripo as t3d
            glb, stl, png = t3d.generate_3d_from_image(
                tripo_key, ref_path, job_id=job_id, assets_dir=assets_dir
            )
            return glb, stl, png, "tripo-image-to-3d"
        else:
            if not meshy_key:
                raise RuntimeError("MESHY_API_KEY not set for image-to-3d")
            from . import meshy as m3d
            glb, stl, png = m3d.generate_3d_from_image(
                meshy_key, ref_path, job_id=job_id, assets_dir=assets_dir
            )
            return glb, stl, png, "meshy-image-to-3d"
    except Exception as e:
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
) -> str | None:
    """If Higgsfield is enabled + authenticated, run the preview through a
    product-photoshoot enhancement and return the new path. On any failure
    returns the original preview_png. Best-effort, never raises."""
    if not preview_png:
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


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}

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
    try:
        asset, tokens_in, tokens_out = call_anthropic(api_key, brief)
        asset_type = asset.get("asset_type", "printable")
        dimensions = asset.get("dimensions", "")

        if is_3d:
            # 3D product route. Two strategies:
            #   (1) character-style brief + Higgsfield CLI authed →
            #       Nano Banana Pro ref render (via Higgsfield CLI) →
            #       image-to-3D (tripo or meshy). Better face/silhouette
            #       preservation for characters.
            #   (2) otherwise → text-to-3D fallback chain (meshy → tripo).
            # Image-gen cost is on Higgsfield credits; mesh-gen on Tripo/Meshy.
            meshy_key = os.environ.get("MESHY_API_KEY", "")
            tripo_key = os.environ.get("TRIPO_API_KEY", "")
            data_dir = os.environ.get(
                "AGENT_FACTORY_DATA", os.path.expanduser("~/.agent-factory")
            )
            assets_dir = os.path.join(data_dir, "assets")

            # Lazy import — falls through to text-to-3D if the module or CLI
            # is unavailable, never raises.
            try:
                from . import nanobanana as _nb
                nb_available = _nb.is_configured()
            except Exception as e:
                print(f"[designer] nanobanana check failed: {e}", file=sys.stderr, flush=True)
                nb_available = False

            i23 = None
            if nb_available and _is_character_brief(brief) and (tripo_key or meshy_key):
                i23 = _run_image_to_3d(
                    brief=brief,
                    asset=asset,
                    job_id=job_id,
                    assets_dir=assets_dir,
                    meshy_key=meshy_key,
                    tripo_key=tripo_key,
                )

            if i23 is not None:
                glb_path, stl_path, preview_png, model_used = i23
                print(
                    f"[designer] job_id={job_id} image-to-3d done glb={glb_path}",
                    file=sys.stderr, flush=True,
                )
                preview_png = _maybe_higgsfield_enhance(
                    preview_png, brief, job_id, assets_dir,
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
            else:
                # Text-to-3D fallback. Honour the user's preferred 3D provider
                # (IMAGE_TO_3D_PROVIDER env, default 'tripo') for this path
                # too — the setting was originally scoped to image-to-3D but
                # the user wants Tripo for ALL 3D work. Falls through to
                # whichever provider's key is present if the preferred one
                # isn't configured.
                preferred = _image_to_3d_provider()
                provider: str | None = None
                if preferred == "tripo" and tripo_key:
                    provider = "tripo"
                elif preferred == "meshy" and meshy_key:
                    provider = "meshy"
                elif tripo_key:
                    provider = "tripo"
                elif meshy_key:
                    provider = "meshy"
                if provider is None:
                    print(
                        "[designer] 3d job but no Meshy/Tripo key — skipping mesh, "
                        "publishing text-only brief",
                        file=sys.stderr, flush=True,
                    )
                    asset["asset_path"] = None
                    model_used = MODEL
                    svg_glyph = "3d skipped (no 3d-gen key)"
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
                        preview_png = _maybe_higgsfield_enhance(
                            preview_png, brief, job_id, assets_dir,
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
                        print(f"[designer] 3d generation failed: {e}", file=sys.stderr, flush=True)
                        asset["asset_path"] = None
                        model_used = MODEL
                        svg_glyph = f"3d failed: {str(e)[:60]}"
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
            fail_msg = f"no asset produced ({svg_glyph})"
            print(
                f"[designer] job_id={job_id} HARD FAIL: {fail_msg}",
                file=sys.stderr, flush=True,
            )
            fail_result: dict = {
                "ok": False,
                "error": fail_msg,
                "ticker_text": f"designer → CYCLE STOPPED: {fail_msg}",
                "model": model_used,
                "tokens_in": tokens_in,
                "tokens_out": tokens_out,
                "messages": [
                    {
                        "from": "designer",
                        "to": "*",
                        "topic": "asset_failed",
                        "importance": "critical",
                        "content": (
                            f"Designer aborted: {fail_msg}. "
                            f"niche={brief.get('niche', '?')}, "
                            f"product_type={brief.get('product_type', '?')}. "
                            f"No handoff to listing — cycle ended."
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
        title_hint = asset.get("title") or asset.get("concept") or asset_type
        description_hint = asset.get("description") or ""
        designer_to_listing = (
            f"Asset ready: type={asset_type}, dims={dimensions}. "
            f"Concept: {title_hint}. {description_hint[:280]}"
        )
        broadcast = (
            f"Drew '{title_hint}' for niche='{brief.get('niche', '?')}' "
            f"({svg_glyph})."
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
        result: dict = {
            "ok": True,
            "asset": asset,
            "ticker_text": f"designer → listing: {asset_type} · {dimensions} · {svg_glyph}",
            "model": model_used,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
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
