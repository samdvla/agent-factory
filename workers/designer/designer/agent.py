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
    """Build the (system, user) prompt pair for the SVG-generation Sonnet call."""
    system = (
        "You produce clean, valid SVG markup for digital-product Etsy listings. "
        "Output ONLY the SVG markup with no preamble, no explanation, no markdown "
        "fences. The SVG must use viewBox 0 0 800 800, have a transparent or "
        "palette-aligned background, and use simple shape primitives "
        "(path, rect, circle, polygon, line, g, text). HARD LIMITS: at most 40 "
        "shape elements total, total markup under 6000 characters, finish with "
        "the closing </svg> tag. Prefer a few bold shapes over many small ones. "
        "Match the requested style, palette, and niche."
    )
    niche = ""
    if isinstance(brief, dict):
        niche = brief.get("niche", "") or ""
    style = asset.get("style", "") if isinstance(asset, dict) else ""
    palette = asset.get("palette", []) if isinstance(asset, dict) else []
    if isinstance(palette, list):
        palette_str = ", ".join(str(p) for p in palette)
    else:
        palette_str = str(palette)
    image_brief = asset.get("brief_for_image_gen", "") if isinstance(asset, dict) else ""

    user = (
        f"Niche: {niche}\n"
        f"Style: {style}\n"
        f"Palette: {palette_str}\n"
        f"Image brief: {image_brief}\n"
        "Generate the complete SVG markup now."
    )
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
