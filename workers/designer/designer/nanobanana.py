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
import time
import urllib.error
import urllib.request

CLI = "higgsfield"
# Higgsfield CLI model identifier. The CLI renames sometimes — at the
# time of writing (May 2026) `higgsfield model list` shows:
#   nano_banana       → "Nano Banana"     (original)
#   nano_banana_flash → "Nano Banana 2"   (faster variant)
#   nano_banana_2     → "Nano Banana Pro" (high-control, our target)
# The legacy id `nano_banana_pro` was renamed to `nano_banana_2` and now
# fails fast with "Unknown model". Verify with `higgsfield model list`
# whenever this errors after a CLI upgrade.
DEFAULT_MODEL = os.environ.get("NANOBANANA_MODEL", "nano_banana_2")
# 9:16 vertical: full-body character refs need head + body without cropping.
# Square / landscape framings tend to lose either the head or the feet.
DEFAULT_ASPECT_RATIO = os.environ.get("NANOBANANA_ASPECT", "9:16")

# Nano Banana Pro typical end-to-end (CLI submit → poll → result URL) is
# 30-60s on a healthy day; we measured 48s for the probe call. 120s catches
# busy days while still bounding the worker's outer 750s supervisor cap
# (anthropic 220 + nano 120 + tripo 240 + higgsfield 150 + raster 40 = 770
# — but Higgsfield skip-after-500s keeps the realistic ceiling ~620s).
DEFAULT_TIMEOUT_SEC = 120
DOWNLOAD_TIMEOUT_SEC = 45

# Higgsfield prints image URLs to stdout/stderr on completion. Same
# regex used by the existing higgsfield.py product-photoshoot client —
# any png/jpg/jpeg/webp under any host counts.
_URL_RE = re.compile(r"https?://[^\s'\"<>]+\.(?:png|jpg|jpeg|webp)(?:\?[^\s'\"<>]*)?")


class NanobananaError(Exception):
    """Non-recoverable reference-render failure. Caller should fall
    back to text-to-3D — never block the pipeline."""


# Bounded retry for TCP/DNS/connect-level blips when fetching a finished
# render from the Higgsfield CDN. The image was already paid for by the
# time we reach `_download` — a single dropped TCP connection should not
# burn that credit.
_NET_RETRY_ATTEMPTS = 3
_NET_RETRY_BACKOFF_SEC = (1.0, 3.0)


def _backoff_sleep(attempt: int) -> None:
    idx = min(attempt, len(_NET_RETRY_BACKOFF_SEC) - 1)
    time.sleep(_NET_RETRY_BACKOFF_SEC[idx])


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
    path is available. Two backends accepted, in priority order:

      1. Direct Gemini (`GEMINI_IMAGE_API_KEY` set) — preferred. Cheaper
         per image (~$0.067 on Flash 3.1 vs Higgsfield's bundled rate)
         and no separate CLI auth flow.
      2. Higgsfield CLI authed — the legacy path. Used when no Gemini
         key is configured.

    Returns True if either backend is ready.
    """
    try:
        from . import gemini_image as _gemini
        if _gemini.is_configured():
            return True
    except ImportError:
        pass
    return _cli_available() and _auth_ok()


def _download(url: str, dest: str, timeout: int = DOWNLOAD_TIMEOUT_SEC) -> None:
    """Stream a Higgsfield result URL to `dest`. Raises NanobananaError
    on any failure so the caller's existing try/except triggers the
    text-to-3D fallback.

    IPv4-only: Higgsfield serves images from AWS CloudFront which
    advertises broken IPv6 endpoints from some networks (operator's). The
    stdlib doesn't do Happy Eyeballs, so without forcing IPv4 we hang in
    SYN_SENT for ~75s/attempt before the timeout fires.
    """
    from .ipv4 import force_ipv4
    last_err: urllib.error.URLError | None = None
    for attempt in range(_NET_RETRY_ATTEMPTS):
        try:
            req = urllib.request.Request(
                url,
                headers={"User-Agent": "agent-factory/1.0"},
            )
            with force_ipv4(), urllib.request.urlopen(req, timeout=timeout) as resp:
                tmp = dest + ".tmp"
                with open(tmp, "wb") as f:
                    f.write(resp.read())
            os.replace(tmp, dest)
            if not (os.path.exists(dest) and os.path.getsize(dest) > 0):
                raise NanobananaError(f"downloaded file empty: {dest}")
            return
        except urllib.error.HTTPError as e:
            raise NanobananaError(f"download {url} failed: {e}") from e
        except urllib.error.URLError as e:
            last_err = e
            if attempt + 1 < _NET_RETRY_ATTEMPTS:
                print(
                    f"[nanobanana] download {url} URLError "
                    f"(attempt {attempt + 1}/{_NET_RETRY_ATTEMPTS}): {e} — retrying",
                    file=sys.stderr, flush=True,
                )
                _backoff_sleep(attempt)
                continue
            raise NanobananaError(f"download {url} failed: {e}") from e
        except OSError as e:
            # Disk-side failure (no space, permission, bad path) — local,
            # not transient at the network layer. Surface immediately.
            raise NanobananaError(f"download {url} failed: {e}") from e
    raise NanobananaError(f"download {url} failed: {last_err}")


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
    """Render `prompt` to a reference PNG saved at
    `{assets_dir}/{job_id}-ref.png`. Returns `(path, backend_model)`.

    `backend_model` is the budget-ledger identifier for the model that
    actually generated the image — `gemini-3.1-flash-image-preview` /
    `gemini-3-pro-image-preview` when the direct Gemini path runs,
    or the Higgsfield CLI model id (`nano_banana_2`) when falling back
    to the CLI. Callers stamp this into provider_calls so the
    supervisor records the right per-call cost.

    `api_key` is accepted for backwards compatibility with the previous
    Gemini-direct signature, but ignored — Higgsfield CLI handles its
    own auth via `higgsfield auth login`.

    The output is meant as INPUT to the image-to-3D step, not as a
    final listing image — vertical aspect for character work, no text
    in frame requested.
    """
    # Direct Gemini path wins when its key is set — cheaper per image
    # and no CLI dependency. Falls through to the Higgsfield path when
    # GEMINI_IMAGE_API_KEY is missing.
    try:
        from . import gemini_image as _gemini
        if _gemini.is_configured():
            try:
                return _gemini.generate_reference_image(
                    api_key, prompt,
                    job_id=job_id, assets_dir=assets_dir,
                    aspect_ratio=aspect_ratio, timeout=timeout,
                )
            except _gemini.GeminiImageError as e:
                # Surface as NanobananaError so the designer's existing
                # soft-fallback to text-to-3D handles it identically to
                # the Higgsfield failure modes — never blocks the cycle.
                raise NanobananaError(f"gemini direct: {e}") from e
    except ImportError:
        pass

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
    # Nano Banana Pro prompt — this is THE pivot point. Tripo/Meshy
    # reconstruct the 3D mesh from this single PNG, so the reference must
    # be image-to-3D-optimal: single hero subject, clean background, even
    # lighting, no shadows, no occluders. The brief_for_image_gen string
    # the Designer wrote owns the subject + pose + stylization; we add the
    # universal studio-reference wrapping that turns it into a Tripo-ready
    # plate.
    #
    # Structure follows Nano Banana Pro's documented best-practice formula
    # (Subject · Composition · Lighting · Style · Negative), with command
    # syntax (no "please", no conversational filler — every token is an
    # instruction). The model handles complex multi-constraint synthesis;
    # we exploit that by stating each constraint as a hard rule.
    enriched = (
        f"{prompt}\n\n"
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
    return path, model


def verify_api_key(api_key: str | None = None) -> None:
    """Back-compat shim. The Settings UI used to call this to verify a
    Gemini key; now reference generation flows through the Higgsfield
    CLI, so the check is just CLI presence + auth. Raises
    NanobananaError on failure to match the previous contract."""
    if not _cli_available():
        raise NanobananaError("higgsfield CLI not on PATH")
    if not _auth_ok():
        raise NanobananaError("higgsfield CLI not authenticated")
