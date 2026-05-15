"""Direct Google AI Studio image-generation client.

This is the ONE production path for reference-image generation. Earlier
the shop also kept a Higgsfield CLI fallback in nanobanana.py, but the
Higgsfield plan ran out of credits and that path was removed; nanobanana
now thinly delegates to this module.

Defaults to `gemini-3-pro-image-preview` (Nano Banana Pro) at ~$0.134
per 1024px image. This is the most expensive image model we use, and
it is the default on purpose — the shop sells AAA-game-asset-quality
3D figurines, the mesh quality is upper-bounded by the ref-image PBR
fidelity, and a $0.07 saving per cycle (versus `gemini-2.5-flash-image`)
is not worth shipping clay-textured product. Override to a cheaper
model via `GEMINI_IMAGE_MODEL` env if budget pressure changes.

History on model picks:
  - `gemini-3.1-flash-image-preview` was tried but queues >120s in
    practice and times out the designer.
  - `gemini-2.5-flash-image` is stable + fast (~5s) at ~$0.067 but its
    material fidelity is visibly weaker than Pro on textured characters.

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
    "GEMINI_IMAGE_MODEL", "gemini-3-pro-image-preview"
)
DEFAULT_ASPECT_RATIO = os.environ.get("NANOBANANA_ASPECT", "9:16")
# Pro queues a few seconds longer than Flash on busy days; 180s comfortably
# covers the worst observed end-to-end while staying well under the
# designer's outer 750s supervisor cap.
DEFAULT_TIMEOUT_SEC = 180


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
    """Delegate to the shared studio-reference plate builder.

    The prompt body lives in `ref_prompt.py` so the Gemini direct path
    (this file) and the Higgsfield CLI fallback (`nanobanana.py`) stay
    in lock-step. Iterating the wording in one place but not the other
    is what shipped matte-grey clay characters to production for weeks
    while the CLI fallback path looked fixed.
    """
    from .ref_prompt import build_ref_prompt
    return build_ref_prompt(prompt, aspect_ratio)


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
    # Sidecar: the actual prompt we sent to Gemini, written next to the
    # ref PNG so the inspector can show "this is what produced that
    # image". Lets the operator iterate the wrapping in ref_prompt.py
    # against real outputs instead of guessing what Claude+wrapping
    # combined into.
    prompt_path = os.path.join(assets_dir, f"{job_id}-ref-prompt.txt")
    try:
        with open(prompt_path, "w", encoding="utf-8") as f:
            f.write(enriched)
    except OSError as e:
        # Non-fatal — the image already landed; losing the prompt sidecar
        # just means the inspector won't show it.
        print(
            f"[gemini_image] job_id={job_id} could not write prompt sidecar: {e}",
            file=sys.stderr, flush=True,
        )
    print(
        f"[gemini_image] job_id={job_id} saved {len(image_bytes)} bytes → {dest}",
        file=sys.stderr, flush=True,
    )
    return dest, model
