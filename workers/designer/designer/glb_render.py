"""Headless GLB renderer — textured hero shot + untextured clay angles.

Shells out to the bundled Node renderer (`workers/designer/renderer/`),
which drives headless Chromium + three.js to render a GLB with full PBR
materials. This produces marketplace-grade listing images: one textured
"hero" render followed by several untextured "clay" angles.

Why a subprocess and not pure Python: a faithful PBR render (environment
lighting, tone mapping, real materials) needs a GPU-class renderer.
three.js in headless Chromium gives that; a numpy rasterizer cannot.

This module never raises from `try_render` — if Node, npm, or Chromium
is unavailable the caller falls back to the pure-Python clay rasterizer
in `preview.py`. So the factory still publishes; it just gets the lesser
images until the render environment is set up.
"""
from __future__ import annotations

import glob
import os
import shutil
import subprocess
import sys
import time

# workers/designer/renderer/ — sibling of the `designer` package dir.
RENDERER_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "renderer")
RENDER_SCRIPT = os.path.join(RENDERER_DIR, "render_glb.js")
NODE_MODULES = os.path.join(RENDERER_DIR, "node_modules")
INSTALL_LOCK = os.path.join(RENDERER_DIR, ".install.lock")


class RenderError(Exception):
    """Non-fatal: caller should fall back to the clay rasterizer."""


def _find_binary(name: str) -> str | None:
    """Locate `node`/`npm`. The supervisor may spawn workers with a minimal
    PATH that omits nvm/homebrew, so check well-known locations too."""
    found = shutil.which(name)
    if found:
        return found
    candidates = [
        f"/opt/homebrew/bin/{name}",
        f"/usr/local/bin/{name}",
        f"/usr/bin/{name}",
    ]
    # nvm installs: ~/.nvm/versions/node/<ver>/bin/<name> — pick the newest.
    nvm = os.path.expanduser("~/.nvm/versions/node")
    if os.path.isdir(nvm):
        for ver in sorted(os.listdir(nvm), reverse=True):
            candidates.insert(0, os.path.join(nvm, ver, "bin", name))
    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def _deps_installed() -> bool:
    return os.path.isdir(os.path.join(NODE_MODULES, "puppeteer")) and os.path.isdir(
        os.path.join(NODE_MODULES, "three")
    )


def _ensure_deps() -> None:
    """Lazily `npm install` the renderer's deps on first use. Guarded by an
    exclusive lock so two designer jobs can't install concurrently."""
    if _deps_installed():
        return
    npm = _find_binary("npm")
    if not npm:
        raise RenderError("npm not found — cannot install renderer deps")
    # Acquire the install lock; if another process holds it, wait for it.
    try:
        fd = os.open(INSTALL_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
    except FileExistsError:
        for _ in range(120):  # wait up to ~10 min for the other installer
            time.sleep(5)
            if _deps_installed():
                return
        raise RenderError("timed out waiting for a concurrent npm install")
    try:
        print("[glb_render] installing renderer deps (one-time npm install)…",
              file=sys.stderr, flush=True)
        r = subprocess.run(
            [npm, "install", "--no-audit", "--no-fund"],
            cwd=RENDERER_DIR, capture_output=True, text=True, timeout=600,
        )
        if r.returncode != 0 or not _deps_installed():
            raise RenderError(f"npm install failed: {r.stderr.strip()[:300]}")
    finally:
        try:
            os.remove(INSTALL_LOCK)
        except OSError:
            pass


def render(glb_path: str, *, output_dir: str, job_id: int,
           timeout: int = 300) -> list[str]:
    """Render `glb_path` to one textured hero PNG + four clay-angle PNGs.

    Returns absolute paths, hero first. Raises RenderError on any failure.
    """
    if not glb_path or not os.path.exists(glb_path):
        raise RenderError(f"glb not found: {glb_path}")
    if not os.path.isfile(RENDER_SCRIPT):
        raise RenderError(f"renderer script missing: {RENDER_SCRIPT}")
    node = _find_binary("node")
    if not node:
        raise RenderError("node not found — install Node.js for textured renders")
    _ensure_deps()
    os.makedirs(output_dir, exist_ok=True)

    r = subprocess.run(
        [node, RENDER_SCRIPT, glb_path, output_dir, str(job_id)],
        capture_output=True, text=True, timeout=timeout,
    )
    if r.returncode != 0:
        raise RenderError(f"renderer exited {r.returncode}: {r.stderr.strip()[:300]}")

    tex = sorted(glob.glob(os.path.join(output_dir, f"{job_id}-tex-*.png")))
    clay = sorted(glob.glob(os.path.join(output_dir, f"{job_id}-clay-*.png")))
    paths = tex + clay
    if not paths:
        raise RenderError("renderer produced no PNGs")
    return paths


def try_render(glb_path: str | None, *, output_dir: str, job_id: int,
               timeout: int = 300) -> list[str]:
    """Soft-fail wrapper: returns [] on any error so callers can fall back
    to the pure-Python clay rasterizer without a try/except."""
    if not glb_path:
        return []
    try:
        t0 = time.time()
        paths = render(glb_path, output_dir=output_dir, job_id=job_id, timeout=timeout)
        print(f"[glb_render] job_id={job_id} textured render done "
              f"({len(paths)} PNGs, {time.time()-t0:.1f}s)",
              file=sys.stderr, flush=True)
        return paths
    except Exception as e:
        print(f"[glb_render] job_id={job_id} textured render unavailable: {e} "
              "— falling back to clay rasterizer", file=sys.stderr, flush=True)
        return []
