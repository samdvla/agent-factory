"""Higgsfield product-photoshoot client.

Shells out to the `higgsfield` CLI to upgrade a 3D model's preview render
into a brand-quality product photo. Used as an optional post-processor on
the designer's auto-rendered preview.png so listings get studio-quality
thumbnails instead of raw turntable renders.

Prereqs (user-side, surfaced in the Settings UI):
  1. `higgsfield` CLI installed (via curl install.sh).
  2. `higgsfield auth login` completed interactively.
  3. A paid Higgsfield plan for sustained usage (free tier has tight limits).

If any of those is missing, `enhance_thumbnail` returns None and the
designer pipeline falls back to the original preview render — never raises.

Cost note: each product-photoshoot call costs Higgsfield credits and runs
on gpt_image_2. Gated in the supervisor on a `higgsfield_enabled` secret
so users don't accidentally burn through credits without opting in.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

CLI = "higgsfield"
DEFAULT_MODE = "product_shot"
DEFAULT_TIMEOUT_SEC = 240
DEFAULT_ASPECT = "1:1"

# URL regex tuned for Higgsfield's output (most CDN URLs land on
# *.higgsfield.ai or signed S3-style links).
_URL_RE = re.compile(r"https?://[^\s'\"<>]+\.(?:png|jpg|jpeg|webp)(?:\?[^\s'\"<>]*)?")


class HiggsfieldError(Exception):
    """Surfaced to caller; treated as a non-fatal fallback in designer."""


def cli_available() -> bool:
    return shutil.which(CLI) is not None


def auth_ok(timeout: int = 15) -> bool:
    """Quick auth probe. Returns False on any failure (CLI missing, not
    authed, network blip)."""
    if not cli_available():
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
        # Heuristic: anything that mentions a plan/email/credit balance is
        # authed; explicit failure strings short-circuit.
        if "session expired" in out or "not authenticated" in out:
            return False
        return True
    except (subprocess.TimeoutExpired, OSError):
        return False


def _download(url: str, dest: Path, timeout: int = 60) -> bool:
    try:
        req = urllib.request.Request(
            url,
            headers={"User-Agent": "agent-factory/1.0"},
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            dest.parent.mkdir(parents=True, exist_ok=True)
            with open(dest, "wb") as f:
                f.write(resp.read())
        return dest.exists() and dest.stat().st_size > 0
    except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
        print(f"[higgsfield] download {url} failed: {e}", file=sys.stderr, flush=True)
        return False


def enhance_thumbnail(
    input_png_path: str,
    prompt_hint: str,
    *,
    mode: str = DEFAULT_MODE,
    job_id: int | str | None = None,
    assets_dir: str | None = None,
    aspect_ratio: str = DEFAULT_ASPECT,
    timeout: int = DEFAULT_TIMEOUT_SEC,
) -> Optional[str]:
    """Run a Higgsfield product-photoshoot pass on the given preview PNG.

    Returns the path to the downloaded enhanced image, or None on any
    failure (caller treats failure as "stick with original preview").

    `prompt_hint` is a short brand/scene description from the brief — the
    Higgsfield backend prompt-enhancer handles the heavy lifting, so this
    can be terse.
    """
    src = Path(input_png_path)
    if not src.exists():
        print(f"[higgsfield] input missing: {src}", file=sys.stderr, flush=True)
        return None
    if not cli_available():
        print(f"[higgsfield] CLI not on PATH — skipping enhancement", file=sys.stderr, flush=True)
        return None

    # Auth probe — cheap, avoids burning a credit on a job that'll 401.
    if not auth_ok():
        print(f"[higgsfield] not authenticated — skipping enhancement", file=sys.stderr, flush=True)
        return None

    target_dir = Path(assets_dir) if assets_dir else src.parent
    target_dir.mkdir(parents=True, exist_ok=True)
    suffix = f"_hf_{job_id}" if job_id is not None else "_hf"
    out_path = target_dir / f"{src.stem}{suffix}.png"

    cmd = [
        CLI, "product-photoshoot", "create",
        "--mode", mode,
        "--prompt", prompt_hint[:500],  # cap length defensively
        "--image", str(src),
        "--count", "1",
        "--aspect_ratio", aspect_ratio,
    ]
    print(f"[higgsfield] running: {' '.join(cmd[:6])} ... (mode={mode})", file=sys.stderr, flush=True)
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        print(f"[higgsfield] CLI timed out after {timeout}s", file=sys.stderr, flush=True)
        return None
    except OSError as e:
        print(f"[higgsfield] CLI invocation failed: {e}", file=sys.stderr, flush=True)
        return None

    if result.returncode != 0:
        err_snippet = (result.stderr or result.stdout or "")[:400]
        print(f"[higgsfield] CLI exit {result.returncode}: {err_snippet}", file=sys.stderr, flush=True)
        return None

    combined = result.stdout + "\n" + result.stderr
    urls = _URL_RE.findall(combined)
    if not urls:
        print(f"[higgsfield] no image URL in CLI output", file=sys.stderr, flush=True)
        return None

    # First match is usually the canonical result; subsequent ones may be
    # thumbnails or alt variants. Take the first.
    if not _download(urls[0], out_path):
        return None
    print(f"[higgsfield] enhanced → {out_path}", file=sys.stderr, flush=True)
    return str(out_path)


def is_enabled() -> bool:
    """Designer reads this to decide whether to invoke the enhancer at
    runtime. Toggled by Rust supervisor via env var, default off."""
    v = os.environ.get("HIGGSFIELD_ENABLED", "").strip().lower()
    return v in {"1", "true", "yes", "on"}
