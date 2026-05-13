"""Nano Banana Pro reference-image client (via Higgsfield CLI).

Generates a vertical character reference render from a text prompt by
shelling out to the `higgsfield` CLI. The output PNG is then fed into
the image-to-3D provider (Tripo or Meshy) to turn it into a printable
mesh. Two-stage character pipelines (reference image → 3D) preserve
face structure + silhouette far better than pure text-to-3D for shonen
/ mythology / character work.

History: this module used to POST directly to Gemini's
`generativelanguage.googleapis.com` (Gemini 2.5 Flash Image). It was
migrated to Higgsfield's Nano Banana Pro so the project can spend
existing Higgsfield credits instead of carrying a separate Google
billing relationship, and so character refs run on the higher-quality
nano_banana_pro model. The function name + exception name are kept for
backwards compat with callers; the param `api_key` is accepted-and-
ignored for the same reason.

Auth: handled by the CLI (`higgsfield auth login`). No env key needed.
If the CLI is missing or not authed, `generate_reference_image` raises
NanobananaError, which the designer treats as a soft fallback to
text-to-3D — never crashes the job.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request

CLI = "higgsfield"
DEFAULT_MODEL = os.environ.get("NANOBANANA_MODEL", "nano_banana_pro")
# 9:16 vertical: full-body character refs need head + body without cropping.
# Square / landscape framings tend to lose either the head or the feet.
DEFAULT_ASPECT_RATIO = os.environ.get("NANOBANANA_ASPECT", "9:16")

# Nano Banana Pro typically resolves in 10–40s; bake in headroom so a
# slow upstream doesn't kill a job mid-render.
DEFAULT_TIMEOUT_SEC = 180
DOWNLOAD_TIMEOUT_SEC = 60

# Higgsfield prints image URLs to stdout/stderr on completion. Same
# regex used by the existing higgsfield.py product-photoshoot client —
# any png/jpg/jpeg/webp under any host counts.
_URL_RE = re.compile(r"https?://[^\s'\"<>]+\.(?:png|jpg|jpeg|webp)(?:\?[^\s'\"<>]*)?")


class NanobananaError(Exception):
    """Non-recoverable reference-render failure. Caller should fall
    back to text-to-3D — never block the pipeline."""


def _cli_available() -> bool:
    return shutil.which(CLI) is not None


def _auth_ok(timeout: int = 15) -> bool:
    """Quick auth probe. Returns False on any failure (CLI missing,
    not authed, network blip)."""
    if not _cli_available():
        return False
    try:
        result = subprocess.run(
            [CLI, "account", "status"],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode != 0:
            return False
        out = (result.stdout + result.stderr).lower()
        if "session expired" in out or "not authenticated" in out:
            return False
        return True
    except (subprocess.TimeoutExpired, OSError):
        return False


def is_configured() -> bool:
    """Designer reads this to decide whether the nanobanana → image-to-3D
    path is available. True only when the CLI is on PATH and authed."""
    return _cli_available() and _auth_ok()


def _download(url: str, dest: str, timeout: int = DOWNLOAD_TIMEOUT_SEC) -> None:
    """Stream a Higgsfield result URL to `dest`. Raises NanobananaError
    on any failure so the caller's existing try/except triggers the
    text-to-3D fallback."""
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "agent-factory/1.0"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            tmp = dest + ".tmp"
            with open(tmp, "wb") as f:
                f.write(resp.read())
        os.replace(tmp, dest)
        if not (os.path.exists(dest) and os.path.getsize(dest) > 0):
            raise NanobananaError(f"downloaded file empty: {dest}")
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        raise NanobananaError(f"download {url} failed: {e}") from e


def generate_reference_image(
    api_key: str | None,
    prompt: str,
    *,
    job_id: int,
    assets_dir: str,
    aspect_ratio: str = DEFAULT_ASPECT_RATIO,
    model: str = DEFAULT_MODEL,
    timeout: int = DEFAULT_TIMEOUT_SEC,
) -> str:
    """Render `prompt` to a reference PNG saved at
    `{assets_dir}/{job_id}-ref.png`. Returns the absolute path.

    `api_key` is accepted for backwards compatibility with the previous
    Gemini-direct signature, but ignored — Higgsfield CLI handles its
    own auth via `higgsfield auth login`.

    The output is meant as INPUT to the image-to-3D step, not as a
    final listing image — vertical aspect for character work, no text
    in frame requested.
    """
    if not _cli_available():
        raise NanobananaError(
            "higgsfield CLI not on PATH — install via "
            "`curl -fsSL https://raw.githubusercontent.com/higgsfield-ai/cli/main/install.sh | sh`"
        )
    if not _auth_ok():
        raise NanobananaError(
            "higgsfield CLI not authenticated — run `higgsfield auth login`"
        )

    os.makedirs(assets_dir, exist_ok=True)
    # Same enrichment that worked well with Gemini: clean background,
    # single centered subject, no text/logos/props. Tripo/Meshy
    # downstream both prefer this composition.
    enriched = (
        "Full-body character render on a clean neutral background (light "
        "grey or off-white). Single subject, centered, facing camera, "
        "even diffuse lighting, no harsh shadows, no text, no logos, no "
        "watermarks, no second character, no props occluding the body. "
        f"Subject: {prompt}"
    )

    cmd = [
        CLI, "generate", "create", model,
        "--prompt", enriched[:2000],  # CLI accepts long prompts; cap defensively
        "--aspect_ratio", aspect_ratio,
        "--wait",
    ]
    print(
        f"[nanobanana] job_id={job_id} running {model} via higgsfield CLI "
        f"(aspect={aspect_ratio}, prompt_len={len(enriched)})",
        file=sys.stderr, flush=True,
    )
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        raise NanobananaError(f"higgsfield CLI timed out after {timeout}s") from e
    except OSError as e:
        raise NanobananaError(f"higgsfield CLI invocation failed: {e}") from e

    if result.returncode != 0:
        err = (result.stderr or result.stdout or "")[:400]
        raise NanobananaError(f"higgsfield CLI exit {result.returncode}: {err}")

    combined = (result.stdout or "") + "\n" + (result.stderr or "")
    urls = _URL_RE.findall(combined)
    if not urls:
        raise NanobananaError(
            f"no image URL in CLI output (first 400 chars): {combined[:400]!r}"
        )

    path = os.path.join(assets_dir, f"{job_id}-ref.png")
    _download(urls[0], path)
    size = os.path.getsize(path)
    print(
        f"[nanobanana] job_id={job_id} saved {size} bytes → {path}",
        file=sys.stderr, flush=True,
    )
    return path


def verify_api_key(api_key: str | None = None) -> None:
    """Back-compat shim. The Settings UI used to call this to verify a
    Gemini key; now reference generation flows through the Higgsfield
    CLI, so the check is just CLI presence + auth. Raises
    NanobananaError on failure to match the previous contract."""
    if not _cli_available():
        raise NanobananaError("higgsfield CLI not on PATH")
    if not _auth_ok():
        raise NanobananaError("higgsfield CLI not authenticated")
