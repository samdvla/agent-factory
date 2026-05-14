"""Direct Google AI Studio image-generation client.

Drop-in replacement for the higgsfield-CLI path in nanobanana.py — same
function signature, same output (`{assets_dir}/{job_id}-ref.png`), but
hits the Gemini API directly so we skip Higgsfield's middleman markup.

Defaults to `gemini-3.1-flash-image-preview` (a.k.a. Nano Banana 2),
which Google labels "Pro-level" quality and prices at ~$0.067 per 1024px
image — about half the cost of `gemini-3-pro-image-preview` (Nano Banana
Pro) at $0.134. Override via `GEMINI_IMAGE_MODEL` env when a specific
brief needs the Pro model's extra fidelity.

Auth: GEMINI_IMAGE_API_KEY env. Get a key at
https://aistudio.google.com/apikey — image generation has no free tier,
so the key must be on a billing-enabled project.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

GEMINI_API_BASE = os.environ.get(
    "GEMINI_API_BASE", "https://generativelanguage.googleapis.com/v1beta"
).rstrip("/")

DEFAULT_MODEL = os.environ.get(
    "GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image-preview"
)
DEFAULT_ASPECT_RATIO = os.environ.get("NANOBANANA_ASPECT", "9:16")
DEFAULT_TIMEOUT_SEC = 120


class GeminiImageError(Exception):
    """Non-recoverable image-generation failure. Caller should fall back
    to text-to-3D — never block the pipeline on a missing reference."""


# Bounded retry for TCP/DNS/connect-level blips. A bare URLError means the
# HTTP request never landed at Google, so the account wasn't debited and
# retrying is safe. HTTPError is excluded — a 4xx/5xx response proves the
# request *did* arrive and may have charged.
_NET_RETRY_ATTEMPTS = 3
_NET_RETRY_BACKOFF_SEC = (1.0, 3.0)


def _backoff_sleep(attempt: int) -> None:
    idx = min(attempt, len(_NET_RETRY_BACKOFF_SEC) - 1)
    time.sleep(_NET_RETRY_BACKOFF_SEC[idx])


# Accept any of the common Google-AI key env names. Different docs use
# different names for the same Gemini key — having a single source of
# truth means the operator can paste their key into whichever Settings
# field they reach first and the worker picks it up.
_API_KEY_ENV_VARS = (
    "GEMINI_IMAGE_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
)


def _resolve_api_key() -> str:
    for name in _API_KEY_ENV_VARS:
        v = os.environ.get(name, "").strip()
        if v:
            return v
    return ""


def is_configured() -> bool:
    """True when the Gemini direct path is usable (any supported key var set)."""
    return bool(_resolve_api_key())


def _enrich_prompt(prompt: str, aspect_ratio: str) -> str:
    """Wrap the designer's brief into a studio-reference rendering plate
    optimized for downstream image-to-3D ingestion. Mirrors the enrichment
    in nanobanana.py so swapping providers produces a comparable output
    framing (single hero subject, clean grey backdrop, even lighting).

    Aspect-ratio is requested explicitly in the prompt because the
    Gemini API's image config field set is in flux across previews —
    putting the ask in plain text reliably steers composition even when
    the structured config doesn't take effect.
    """
    return (
        f"{prompt}\n\n"
        f"Aspect ratio: {aspect_ratio} vertical portrait.\n"
        "Composition: single hero subject, centered, fills 60-70% of "
        "frame, three-quarter view for characters / front-elevation for "
        "symmetric props / top-down for terrain tiles. Full subject "
        "visible from base to top — no edge cropping.\n"
        "Background: clean neutral light-grey #E8E8E8 seamless backdrop. "
        "No horizon line, no environment, no shadow on backdrop.\n"
        "Lighting: even soft ambient illumination, no harsh directional "
        "light, no rim light, no cast shadows.\n"
        "Style: photorealistic studio-reference render of a single 3D-"
        "printable object. Matte single-color surface. No painted decals, "
        "no PBR textures, no rigging, no moving parts.\n"
        "(negative: no text, no logos, no watermarks, no UI overlays, no "
        "multiple subjects, no environment, no humans, no measuring tools, "
        "no film grain, no depth-of-field blur, no specular highlights, "
        "no second figure, no props occluding the subject)"
    )


def _extract_image_bytes(response: dict) -> bytes:
    """Walk the Gemini response and return decoded image bytes.

    The field has been seen as both `inline_data` (snake_case, per the
    REST spec) and `inlineData` (camelCase, from some preview models),
    so we accept both. Raises GeminiImageError when no image is present —
    common when the model declined to generate (safety filter, prompt
    interpreted as text-only, etc.); the error text includes a short
    response preview so the operator can see why.
    """
    candidates = response.get("candidates") or []
    for cand in candidates:
        content = cand.get("content") or {}
        parts = content.get("parts") or []
        for part in parts:
            inline = part.get("inline_data") or part.get("inlineData")
            if not isinstance(inline, dict):
                continue
            data = inline.get("data")
            if not isinstance(data, str) or not data:
                continue
            try:
                return base64.b64decode(data)
            except (ValueError, TypeError) as e:
                raise GeminiImageError(
                    f"base64 decode failed: {e}"
                ) from e
    raise GeminiImageError(
        "Gemini response had no image part. "
        f"First 400 chars: {json.dumps(response)[:400]!r}"
    )


def generate_reference_image(
    api_key: str | None,
    prompt: str,
    *,
    job_id: int,
    assets_dir: str,
    aspect_ratio: str = DEFAULT_ASPECT_RATIO,
    model: str = DEFAULT_MODEL,
    timeout: int = DEFAULT_TIMEOUT_SEC,
) -> tuple[str, str]:
    """Render `prompt` to `{assets_dir}/{job_id}-ref.png`. Returns
    `(path, backend_model)` — the model name is the budget-ledger
    identifier the caller stamps on its provider_calls entry, so the
    supervisor can record an accurate per-call cost.

    `api_key` is accepted for back-compat with the older signature but
    ignored; the real key comes from GEMINI_IMAGE_API_KEY env.
    """
    key = _resolve_api_key()
    if not key:
        raise GeminiImageError(
            "No Google AI key set — get one at "
            "https://aistudio.google.com/apikey and add it to secrets "
            "(any of GEMINI_IMAGE_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY)"
        )

    os.makedirs(assets_dir, exist_ok=True)
    enriched = _enrich_prompt(prompt, aspect_ratio)

    body = {
        "contents": [{"parts": [{"text": enriched}]}],
        "generationConfig": {
            # Both modalities required: the model emits a short text
            # acknowledgement alongside the image inline_data part.
            "responseModalities": ["TEXT", "IMAGE"],
        },
    }
    url = f"{GEMINI_API_BASE}/models/{model}:generateContent"
    body_bytes = json.dumps(body).encode("utf-8")

    print(
        f"[gemini_image] job_id={job_id} model={model} aspect={aspect_ratio} "
        f"prompt_len={len(enriched)}",
        file=sys.stderr, flush=True,
    )
    raw: str | None = None
    last_err: urllib.error.URLError | None = None
    for attempt in range(_NET_RETRY_ATTEMPTS):
        req = urllib.request.Request(
            url,
            data=body_bytes,
            headers={
                "x-goog-api-key": key,
                "content-type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
            break
        except urllib.error.HTTPError as e:
            try:
                body_text = e.read().decode("utf-8", errors="replace")[:400]
            except Exception:
                body_text = ""
            raise GeminiImageError(
                f"Gemini HTTP {e.code}: {body_text or e.reason}"
            ) from e
        except urllib.error.URLError as e:
            last_err = e
            if attempt + 1 < _NET_RETRY_ATTEMPTS:
                print(
                    f"[gemini_image] URLError "
                    f"(attempt {attempt + 1}/{_NET_RETRY_ATTEMPTS}): {e} — retrying",
                    file=sys.stderr, flush=True,
                )
                _backoff_sleep(attempt)
                continue
            raise GeminiImageError(f"Gemini network error: {e}") from e
    if raw is None:
        raise GeminiImageError(f"Gemini network error: {last_err}")

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise GeminiImageError(
            f"Gemini non-JSON response: {raw[:200]!r}"
        ) from e

    image_bytes = _extract_image_bytes(data)
    dest = os.path.join(assets_dir, f"{job_id}-ref.png")
    tmp = dest + ".tmp"
    with open(tmp, "wb") as f:
        f.write(image_bytes)
    os.replace(tmp, dest)
    print(
        f"[gemini_image] job_id={job_id} saved {len(image_bytes)} bytes → {dest}",
        file=sys.stderr, flush=True,
    )
    return dest, model
