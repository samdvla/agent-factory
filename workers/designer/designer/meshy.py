"""Meshy text-to-3D client.

Meshy's v2 text-to-3D flow is two-stage:
  1. Preview — fast (~30s) untextured low-poly mesh, ~5 credits.
  2. Refine — slower (~3-5 min) textured high-poly mesh, ~10 credits.

We default to BOTH stages (refine=True). The STL is geometry-only by
format and doesn't carry textures regardless, but the GLB we ship to
Cults3D + display in the in-app model viewer needs PBR materials so
buyers see the actual look, not a white silhouette. The same goes for
image-to-3D, where enable_pbr defaults to True.

The extra ~5 credits and ~3min latency per job are the price of an
actually-textured deliverable; the user has explicitly chosen quality
over per-job cost.

Stdlib HTTP, no third-party deps beyond what tripo.py / trimesh need.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Optional, Tuple

MESHY_API_BASE = os.environ.get("MESHY_API_BASE", "https://api.meshy.ai").rstrip("/")
# Poll cadence: preview is fast (~30s); refine can be 3-5min.
POLL_INTERVAL_SEC = 5
PREVIEW_TIMEOUT_SEC = 240
REFINE_TIMEOUT_SEC = 600

# Reuse Tripo's helpers where they're identical (download_to_path,
# _placeholder_preview, glb_to_stl). Keeps a single source of truth for
# the GLB→STL conversion + placeholder rendering.
from . import tripo as _tripo


class MeshyError(Exception):
    """Non-recoverable Meshy failure. Treated as a generation failure by
    the designer; the pipeline continues with text-only output."""


def _gate_mesh_or_raise(glb_path: str, stl_path: str, job_id: int) -> None:
    """Same shared gate as tripo._gate_mesh_or_raise — repair + validate
    Meshy output. MeshQualityError gets wrapped in MeshyError so the
    designer's existing failure classifier and no-asset-produced path
    treat mesh-quality rejects identically to provider errors."""
    from . import mesh_quality as _mq
    try:
        metrics = _mq.gate_or_raise(glb_path, stl_path)
        print(
            f"[meshy] job_id={job_id} mesh quality ok "
            f"faces={metrics.get('face_count')} vol={metrics.get('volume', 0):.2f} "
            f"watertight={metrics.get('is_watertight')}",
            file=sys.stderr, flush=True,
        )
    except _mq.MeshQualityError as e:
        raise MeshyError(f"Meshy mesh failed quality gate: {e}") from e


def _post(url: str, body: dict, api_key: str, timeout: int = 60) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        raise MeshyError(f"Meshy POST {url} HTTP {e.code}: {raw}") from e
    except urllib.error.URLError as e:
        raise MeshyError(f"Meshy POST {url} network error: {e}") from e


def _get(url: str, api_key: str, timeout: int = 60) -> dict:
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {api_key}"},
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        raise MeshyError(f"Meshy GET {url} HTTP {e.code}: {raw}") from e
    except urllib.error.URLError as e:
        raise MeshyError(f"Meshy GET {url} network error: {e}") from e


def _image_to_data_uri(image_path: str) -> str:
    """Read a local image into a data: URI so Meshy can fetch it inline.
    Meshy's image-to-3d endpoint accepts either a public HTTPS URL or a
    base64 data URI in `image_url`. Data URI is simpler when the reference
    image lives only on the user's machine."""
    import base64
    import mimetypes
    mime = mimetypes.guess_type(image_path)[0] or "image/png"
    with open(image_path, "rb") as f:
        encoded = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime};base64,{encoded}"


def submit_image_to_3d(
    api_key: str,
    image_path_or_url: str,
    *,
    enable_pbr: bool = True,
    ai_model: str = "meshy-4",
) -> str:
    """Create an image-to-3D task. Accepts a local file path (uploaded as a
    data URI) or a public HTTPS URL. Returns the task id."""
    if image_path_or_url.startswith("http://") or image_path_or_url.startswith("https://"):
        image_url = image_path_or_url
    else:
        image_url = _image_to_data_uri(image_path_or_url)
    body: dict = {
        "image_url": image_url,
        "enable_pbr": enable_pbr,
        "ai_model": ai_model,
    }
    resp = _post(f"{MESHY_API_BASE}/openapi/v1/image-to-3d", body, api_key)
    task_id = resp.get("result") or resp.get("task_id") or resp.get("id")
    if not isinstance(task_id, str) or not task_id:
        raise MeshyError(f"Meshy image-to-3d create missing task id: {resp}")
    return task_id


def poll_image_task_until_done(api_key: str, task_id: str, timeout_sec: int) -> dict:
    """Image-to-3d lives under a different path than text-to-3d. Otherwise
    identical to poll_until_done()."""
    deadline = time.time() + timeout_sec
    while True:
        if time.time() > deadline:
            raise MeshyError(f"Meshy task {task_id} timed out after {timeout_sec}s")
        resp = _get(f"{MESHY_API_BASE}/openapi/v1/image-to-3d/{task_id}", api_key)
        status = resp.get("status")
        if status == "SUCCEEDED":
            return resp
        if status in ("FAILED", "CANCELED", "EXPIRED"):
            raise MeshyError(f"Meshy task {task_id} status={status}: {resp}")
        time.sleep(POLL_INTERVAL_SEC)


def generate_3d_from_image(
    api_key: str,
    image_path: str,
    *,
    job_id: int,
    assets_dir: str,
    enable_pbr: bool = True,
) -> Tuple[str, str, str]:
    """One-shot image→3D via Meshy. Returns (glb_path, stl_path, preview_png).
    Mirrors generate_3d's shape so the designer can swap providers without
    branching its asset-handling logic."""
    os.makedirs(assets_dir, exist_ok=True)
    print(
        f"[meshy] job_id={job_id} image-to-3d submitting {image_path}",
        file=sys.stderr, flush=True,
    )
    task_id = submit_image_to_3d(api_key, image_path, enable_pbr=enable_pbr)
    print(f"[meshy] job_id={job_id} task_id={task_id} polling", file=sys.stderr, flush=True)
    data = poll_image_task_until_done(api_key, task_id, PREVIEW_TIMEOUT_SEC)
    model_url = pick_model_url(data)
    glb_path = os.path.join(assets_dir, f"{job_id}.glb")
    stl_path = os.path.join(assets_dir, f"{job_id}.stl")
    png_path = os.path.join(assets_dir, f"{job_id}.png")
    try:
        _tripo.download_to_path(model_url, glb_path)
    except _tripo.TripoError as e:
        raise MeshyError(f"download glb failed: {e}") from e
    # Convert to STL and loop-decimate until the STL itself fits Etsy's
    # 19 MB cap (binary STL is ~3-4× the size of the compressed GLB).
    try:
        _tripo.ensure_stl_under_cap(glb_path, stl_path)
    except _tripo.TripoError as e:
        raise MeshyError(f"glb→stl failed: {e}") from e
    _gate_mesh_or_raise(glb_path, stl_path, job_id)
    thumb = pick_thumbnail_url(data)
    if thumb:
        try:
            _tripo.download_to_path(thumb, png_path)
        except _tripo.TripoError:
            try:
                with open(image_path, "rb") as src, open(png_path, "wb") as dst:
                    dst.write(src.read())
            except OSError:
                _tripo._placeholder_preview(png_path, "image-to-3d output")
    else:
        try:
            with open(image_path, "rb") as src, open(png_path, "wb") as dst:
                dst.write(src.read())
        except OSError:
            _tripo._placeholder_preview(png_path, "image-to-3d output")
    return glb_path, stl_path, png_path


def submit_preview(api_key: str, prompt: str, art_style: str = "realistic") -> str:
    """Create a preview task. Returns the task id."""
    body: dict = {
        "mode": "preview",
        "prompt": prompt,
        "art_style": art_style,
        # Meshy supports an optional AI seed; we omit it so each call is fresh.
    }
    resp = _post(f"{MESHY_API_BASE}/openapi/v2/text-to-3d", body, api_key)
    task_id = resp.get("result") or resp.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise MeshyError(f"Meshy preview create missing task id: {resp}")
    return task_id


def submit_refine(api_key: str, preview_task_id: str) -> str:
    """Refine a previously-completed preview into a textured mesh."""
    body = {"mode": "refine", "preview_task_id": preview_task_id}
    resp = _post(f"{MESHY_API_BASE}/openapi/v2/text-to-3d", body, api_key)
    task_id = resp.get("result") or resp.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise MeshyError(f"Meshy refine create missing task id: {resp}")
    return task_id


def poll_until_done(api_key: str, task_id: str, timeout_sec: int) -> dict:
    deadline = time.time() + timeout_sec
    while True:
        if time.time() > deadline:
            raise MeshyError(f"Meshy task {task_id} timed out after {timeout_sec}s")
        resp = _get(f"{MESHY_API_BASE}/openapi/v2/text-to-3d/{task_id}", api_key)
        status = resp.get("status")
        if status == "SUCCEEDED":
            return resp
        if status in ("FAILED", "CANCELED", "EXPIRED"):
            raise MeshyError(f"Meshy task {task_id} status={status}: {resp}")
        time.sleep(POLL_INTERVAL_SEC)


def pick_model_url(data: dict) -> str:
    """Meshy returns multiple formats in `model_urls`. Prefer GLB."""
    urls = data.get("model_urls") or {}
    for key in ("glb", "fbx", "obj"):
        val = urls.get(key)
        if isinstance(val, str) and val.startswith("http"):
            return val
    raise MeshyError(f"Meshy task has no usable model URL: {urls}")


def pick_thumbnail_url(data: dict) -> Optional[str]:
    val = data.get("thumbnail_url")
    if isinstance(val, str) and val.startswith("http"):
        return val
    return None


def generate_3d(
    api_key: str,
    prompt: str,
    *,
    job_id: int,
    assets_dir: str,
    art_style: str = "realistic",
    refine: bool = True,
) -> Tuple[str, str, str]:
    """One-shot text→3D via Meshy. Returns (glb_path, stl_path, preview_png).

    Defaults to preview + refine so the shipped GLB carries PBR textures —
    Cults3D buyers and the in-app model viewer need them; without refine
    Meshy returns a flat untextured mesh. Set refine=False only when you
    explicitly want the cheap untextured preview (game-asset prototyping).
    """
    os.makedirs(assets_dir, exist_ok=True)
    print(f"[meshy] job_id={job_id} preview submit ({len(prompt)} chars)", file=sys.stderr, flush=True)
    preview_id = submit_preview(api_key, prompt, art_style=art_style)
    print(f"[meshy] job_id={job_id} preview task={preview_id} polling", file=sys.stderr, flush=True)
    preview_data = poll_until_done(api_key, preview_id, PREVIEW_TIMEOUT_SEC)

    if refine:
        refine_id = submit_refine(api_key, preview_id)
        print(f"[meshy] job_id={job_id} refine task={refine_id} polling", file=sys.stderr, flush=True)
        final_data = poll_until_done(api_key, refine_id, REFINE_TIMEOUT_SEC)
    else:
        final_data = preview_data

    model_url = pick_model_url(final_data)
    glb_path = os.path.join(assets_dir, f"{job_id}.glb")
    stl_path = os.path.join(assets_dir, f"{job_id}.stl")
    png_path = os.path.join(assets_dir, f"{job_id}.png")

    # Reuse Tripo's download + STL conversion helpers (same code path).
    try:
        _tripo.download_to_path(model_url, glb_path)
    except _tripo.TripoError as e:
        raise MeshyError(f"download glb failed: {e}") from e
    print(f"[meshy] job_id={job_id} downloaded glb ({os.path.getsize(glb_path)} bytes)", file=sys.stderr, flush=True)
    try:
        _tripo.ensure_stl_under_cap(glb_path, stl_path)
    except _tripo.TripoError as e:
        raise MeshyError(f"glb→stl failed: {e}") from e
    print(f"[meshy] job_id={job_id} converted stl ({os.path.getsize(stl_path)} bytes)", file=sys.stderr, flush=True)
    _gate_mesh_or_raise(glb_path, stl_path, job_id)

    thumb = pick_thumbnail_url(final_data)
    if thumb:
        try:
            _tripo.download_to_path(thumb, png_path)
            print(f"[meshy] job_id={job_id} downloaded thumbnail", file=sys.stderr, flush=True)
        except _tripo.TripoError as e:
            print(f"[meshy] thumb download failed: {e} — using placeholder", file=sys.stderr, flush=True)
            _tripo._placeholder_preview(png_path, prompt)
    else:
        _tripo._placeholder_preview(png_path, prompt)
    return glb_path, stl_path, png_path
