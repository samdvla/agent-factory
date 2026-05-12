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


def _parse_loose_json_object(text: str) -> dict:
    """Parse the first JSON object out of `text`, tolerating fences and trailing prose.

    Models occasionally append explanatory text after the JSON, or wrap it in
    ```json fences with extra paragraphs underneath. Stripping fences naively
    and then calling json.loads() blows up with "Extra data: line N col 1".
    Instead, locate the first '{', call JSONDecoder.raw_decode(), and ignore
    everything after the matching closing brace.
    """
    s = text.strip()
    if s.startswith("```"):
        nl = s.find("\n")
        s = s[nl + 1 :] if nl != -1 else s
    start = s.find("{")
    if start == -1:
        raise ValueError("no JSON object found in response")
    obj, _end = json.JSONDecoder().raw_decode(s[start:])
    if not isinstance(obj, dict):
        raise ValueError(f"expected JSON object, got {type(obj).__name__}")
    return obj


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


def build_designer_prompt(brief: dict) -> tuple[str, str]:
    system = (
        "You are the Designer at an AI-run digital-products Etsy shop. "
        "Given a Demand Brief, produce an asset description that an image generator "
        "would render into the actual product. Be specific about style, palette, "
        "composition, and dimensions. Return JSON only:\n"
        "{\n"
        '  "asset_type": "<printable | svg | template | ebook>",\n'
        '  "style": "<descriptive style notes, 1 sentence>",\n'
        '  "palette": ["<hex>", "<hex>", "<hex>"],\n'
        '  "dimensions": "<e.g. \'8.5x11 inch printable, 300dpi\'>",\n'
        '  "mockup_count": <int 1-4>,\n'
        '  "brief_for_image_gen": "<single concise prompt suitable for SDXL>"\n'
        "}"
    )
    user = json.dumps(brief)
    return system, user


def call_anthropic(api_key: str, brief: dict) -> tuple[dict, int, int]:
    system_prompt, user_prompt = build_designer_prompt(brief)
    override = _load_system_override("designer")
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

    print(f"[designer] job_id={job_id} calling Anthropic model={MODEL}", file=sys.stderr, flush=True)
    try:
        asset, tokens_in, tokens_out = call_anthropic(api_key, brief)
        asset_type = asset.get("asset_type", "printable")
        dimensions = asset.get("dimensions", "")

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
        handoff_payload: dict = {"brief": brief, "asset": asset}
        if cycle_id:
            handoff_payload["cycle_id"] = cycle_id
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
