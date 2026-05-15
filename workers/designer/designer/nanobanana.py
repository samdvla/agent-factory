"""Reference-image client — thin delegate to gemini_image.

History: this module used to support two backends — direct Gemini and a
Higgsfield CLI fallback (`nano_banana_2` via `higgsfield generate`). The
Higgsfield plan ran out of credits, so that fallback is gone. The module
is kept under its original name + function signature because the agent
already imports it as `nanobanana` in several places; the public surface
(`NanobananaError`, `is_configured()`, `generate_reference_image()`,
`verify_api_key()`) stays stable.

Auth: GEMINI_IMAGE_API_KEY env. See `gemini_image.py` for details.

If the Gemini path fails (no key, HTTP error, safety block), this module
raises `NanobananaError`, which the designer's existing fallback chain
treats as a soft signal to fall back to text-to-3D — never blocks the
cycle.
"""
from __future__ import annotations

from . import gemini_image as _gemini


class NanobananaError(Exception):
    """Non-recoverable reference-render failure. Caller should fall
    back to text-to-3D — never block the pipeline."""


def is_configured() -> bool:
    """True when the reference-image path is usable (Gemini key set)."""
    return _gemini.is_configured()


def generate_reference_image(
    api_key: str | None,
    prompt: str,
    *,
    job_id: int,
    assets_dir: str,
    aspect_ratio: str = _gemini.DEFAULT_ASPECT_RATIO,
    model: str = _gemini.DEFAULT_MODEL,
    timeout: int = _gemini.DEFAULT_TIMEOUT_SEC,
) -> tuple[str, str]:
    """Render `prompt` to `{assets_dir}/{job_id}-ref.png`. Returns
    `(path, backend_model)` — the model name is the budget-ledger
    identifier the caller stamps on its provider_calls entry, so the
    supervisor records an accurate per-call cost.

    `api_key` is accepted for back-compat with the older signature but
    ignored; the real key comes from GEMINI_IMAGE_API_KEY env.
    """
    if not _gemini.is_configured():
        raise NanobananaError(
            "No Google AI key set — get one at "
            "https://aistudio.google.com/apikey and add it to secrets "
            "(any of GEMINI_IMAGE_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY)"
        )
    try:
        return _gemini.generate_reference_image(
            api_key, prompt,
            job_id=job_id, assets_dir=assets_dir,
            aspect_ratio=aspect_ratio, model=model, timeout=timeout,
        )
    except _gemini.GeminiImageError as e:
        # Surface as NanobananaError so the designer's existing soft-
        # fallback to text-to-3D handles it identically to the legacy
        # Higgsfield failure modes — never blocks the cycle.
        raise NanobananaError(f"gemini direct: {e}") from e


def verify_api_key(api_key: str | None = None) -> None:
    """Back-compat shim for the Settings UI verify panel. Raises
    NanobananaError on failure to match the previous contract."""
    if not _gemini.is_configured():
        raise NanobananaError(
            "No Google AI key set — get one at "
            "https://aistudio.google.com/apikey"
        )
