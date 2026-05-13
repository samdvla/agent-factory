"""Tripo 3D text-to-model client.

Stdlib only: urllib for HTTP, json for bodies. Mirrors the retry pattern
used in the rest of the worker codebase. Two-step flow:
  1. POST /v2/openapi/task with {"type": "text_to_model", "prompt": ...}
     → returns a task_id.
  2. GET /v2/openapi/task/<task_id> until status == "success".
     → response contains output URLs (pbr_model, model, base_model).

The model URL points to a GLB file. We download it, then optionally call
`glb_to_stl()` (uses trimesh) so a single generation yields both formats —
GLB for game devs / web viewers, STL for 3D-printer buyers.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Optional, Tuple

# Tripo API surface area. Override the base via env for sandbox/staging.
TRIPO_API_BASE = os.environ.get("TRIPO_API_BASE", "https://api.tripo3d.ai").rstrip("/")
# Latest stable model version as of 2026-05. Override via env if Tripo
# ships a newer one we want to opt into without a code change.
DEFAULT_MODEL_VERSION = os.environ.get("TRIPO_MODEL_VERSION", "v2.5-20250123")

# Poll cadence + ceiling. Tripo image→3D typically completes in 60-90s on
# a healthy day (we measured 82s end-to-end on a real probe). 240s catches
# busy-queue days while still leaving room for the worker's other stages
# (anthropic + nano + Higgsfield + raster) under the 750s outer cap.
POLL_INTERVAL_SEC = 5
POLL_TIMEOUT_SEC = 240


def _gate_mesh_or_raise(glb_path: str, stl_path: str, job_id: int) -> None:
    """Run the shared mesh quality gate on a Tripo output. Translates a
    MeshQualityError into TripoError so the designer's existing 3D-failure
    classifier / no-asset-produced path handles it uniformly with provider
    errors. Repair pass (fix_normals + fill_holes) happens inside the gate."""
    from . import mesh_quality as _mq
    try:
        metrics = _mq.gate_or_raise(glb_path, stl_path)
        print(
            f"[tripo] job_id={job_id} mesh quality ok "
            f"faces={metrics.get('face_count')} vol={metrics.get('volume', 0):.2f} "
            f"watertight={metrics.get('is_watertight')}",
            file=sys.stderr, flush=True,
        )
    except _mq.MeshQualityError as e:
        raise TripoError(f"Tripo mesh failed quality gate: {e}") from e


class TripoError(Exception):
    """Raised for any non-recoverable Tripo failure (bad request, task failed,
    download failed). Callers should treat this the same as a generation
    failure: fail the design job, fall through to text-only output."""


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
        raise TripoError(f"Tripo POST {url} HTTP {e.code}: {raw}") from e
    except urllib.error.URLError as e:
        raise TripoError(f"Tripo POST {url} network error: {e}") from e


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
        raise TripoError(f"Tripo GET {url} HTTP {e.code}: {raw}") from e
    except urllib.error.URLError as e:
        raise TripoError(f"Tripo GET {url} network error: {e}") from e


def _ext_from_path(path: str) -> str:
    """Tripo's task body wants a bare extension like 'jpg' / 'png' / 'webp'."""
    ext = os.path.splitext(path)[1].lstrip(".").lower()
    if ext == "jpeg":
        return "jpg"
    if ext not in {"jpg", "png", "webp"}:
        # Tripo's spec rejects anything else; default to png so the request
        # gets back a clear error rather than silently corrupting the upload.
        return "png"
    return ext


def upload_image(api_key: str, image_path: str, timeout: int = 120) -> str:
    """POST an image to Tripo's upload endpoint via multipart/form-data.

    Returns the image_token Tripo issues, which the task-create call passes
    back as `file.file_token`. Stdlib-only multipart: build the body by hand
    so we don't drag in `requests` just for one upload.
    """
    import secrets as _secrets
    import mimetypes

    with open(image_path, "rb") as f:
        data = f.read()
    filename = os.path.basename(image_path)
    mime = mimetypes.guess_type(filename)[0] or "image/png"
    boundary = "----tripo-" + _secrets.token_hex(16)
    crlf = b"\r\n"
    body = (
        f"--{boundary}{crlf.decode()}"
        f'Content-Disposition: form-data; name="file"; filename="{filename}"{crlf.decode()}'
        f"Content-Type: {mime}{crlf.decode()}{crlf.decode()}"
    ).encode("utf-8") + data + (
        f"{crlf.decode()}--{boundary}--{crlf.decode()}"
    ).encode("utf-8")

    req = urllib.request.Request(
        f"{TRIPO_API_BASE}/v2/openapi/upload",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        raise TripoError(f"Tripo upload HTTP {e.code}: {raw}") from e
    except urllib.error.URLError as e:
        raise TripoError(f"Tripo upload network error: {e}") from e

    if payload.get("code") != 0:
        raise TripoError(f"Tripo upload returned code={payload.get('code')}: {payload}")
    data_block = payload.get("data") or {}
    # Tripo has shipped both `image_token` and `file_token` historically —
    # accept whichever the running deployment returns.
    token = data_block.get("image_token") or data_block.get("file_token")
    if not isinstance(token, str) or not token:
        raise TripoError(f"Tripo upload response missing image_token: {payload}")
    return token


def submit_image_to_model(
    api_key: str,
    image_path: str,
    *,
    model_version: str = DEFAULT_MODEL_VERSION,
    style: Optional[str] = None,
) -> str:
    """Create an image-to-3D task from a local PNG/JPG/WEBP. Returns task_id.

    `texture` + `pbr` default to true on v2.0-20240919+ per Tripo's docs, so
    omitting them works today. We set them explicitly anyway: a future
    default flip would silently downgrade us to texture-less generation,
    which already happened once after the worker's decimation step
    overwrote textured GLBs in place.
    """
    file_token = upload_image(api_key, image_path)
    body: dict = {
        "type": "image_to_model",
        "model_version": model_version,
        "file": {
            "type": _ext_from_path(image_path),
            "file_token": file_token,
        },
        "texture": True,
        "pbr": True,
        "texture_quality": "standard",
    }
    if style:
        body["style"] = style
    resp = _post(f"{TRIPO_API_BASE}/v2/openapi/task", body, api_key)
    code = resp.get("code")
    if code != 0:
        raise TripoError(f"Tripo image task create returned code={code}: {resp}")
    task_id = resp.get("data", {}).get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise TripoError(f"Tripo image task create missing task_id: {resp}")
    return task_id


def submit_text_to_model(
    api_key: str,
    prompt: str,
    *,
    model_version: str = DEFAULT_MODEL_VERSION,
    style: Optional[str] = None,
) -> str:
    """Create a text-to-3D task. Returns task_id on success.

    See submit_image_to_model docstring for why texture/pbr are explicit.
    """
    body: dict = {
        "type": "text_to_model",
        "prompt": prompt,
        "model_version": model_version,
        "texture": True,
        "pbr": True,
        "texture_quality": "standard",
    }
    if style:
        body["style"] = style
    resp = _post(f"{TRIPO_API_BASE}/v2/openapi/task", body, api_key)
    code = resp.get("code")
    if code != 0:
        raise TripoError(f"Tripo task create returned code={code}: {resp}")
    task_id = resp.get("data", {}).get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise TripoError(f"Tripo task create missing task_id: {resp}")
    return task_id


def poll_until_done(api_key: str, task_id: str) -> dict:
    """Poll the task until it succeeds, fails, or we hit POLL_TIMEOUT_SEC.
    Returns the final `data` block on success."""
    deadline = time.time() + POLL_TIMEOUT_SEC
    while True:
        if time.time() > deadline:
            raise TripoError(f"Tripo task {task_id} timed out after {POLL_TIMEOUT_SEC}s")
        resp = _get(f"{TRIPO_API_BASE}/v2/openapi/task/{task_id}", api_key)
        if resp.get("code") != 0:
            raise TripoError(f"Tripo task query failed: {resp}")
        data = resp.get("data", {})
        status = data.get("status")
        if status == "success":
            return data
        if status in ("failed", "cancelled", "banned", "expired"):
            raise TripoError(f"Tripo task {task_id} ended with status={status}: {data}")
        # Anything else (queued, running, etc.) → wait and poll again.
        time.sleep(POLL_INTERVAL_SEC)


def _extract_url(val) -> Optional[str]:
    if isinstance(val, str) and val.startswith("http"):
        return val
    if isinstance(val, dict):
        inner = val.get("url")
        if isinstance(inner, str) and inner.startswith("http"):
            return inner
    return None


def pick_model_url(data: dict) -> str:
    """Tripo's response shape has shifted across versions. Prefer pbr_model
    (textured) and fall back to model / base_model. Raises if none are
    present."""
    output = data.get("output") or {}
    for key in ("pbr_model", "model", "base_model"):
        url = _extract_url(output.get(key))
        if url:
            return url
    raise TripoError(f"Tripo task output has no recognized model URL: {output}")


def pick_preview_url(data: dict) -> Optional[str]:
    """Tripo usually returns a rendered preview alongside the model. Used as
    the Etsy listing thumbnail. Returns None when missing — caller should
    fall back to a placeholder."""
    output = data.get("output") or {}
    for key in ("rendered_image", "thumbnail", "preview_image"):
        url = _extract_url(output.get(key))
        if url:
            return url
    return None


def download_to_path(url: str, dest_path: str, timeout: int = 120) -> None:
    """Stream a binary file from a presigned URL into dest_path."""
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            with open(dest_path, "wb") as f:
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
    except (urllib.error.HTTPError, urllib.error.URLError, OSError) as e:
        raise TripoError(f"Tripo download {url} failed: {e}") from e


def glb_to_stl(glb_path: str, stl_path: str) -> None:
    """Convert a downloaded GLB to STL via trimesh. STL is the de-facto
    standard for desktop 3D printers — almost no Etsy STL buyer wants GLB.
    We ship both so game devs are covered too."""
    try:
        import trimesh  # type: ignore
    except ImportError as e:
        raise TripoError(
            "trimesh not installed — run `pip install -e .` in workers/designer "
            "or skip 3D output by clearing TRIPO_API_KEY."
        ) from e
    scene_or_mesh = trimesh.load(glb_path, force="mesh")
    # trimesh sometimes returns a Scene; .dump(concatenate=True) collapses it.
    if hasattr(scene_or_mesh, "dump"):
        scene_or_mesh = scene_or_mesh.dump(concatenate=True)
    scene_or_mesh.export(stl_path, file_type="stl")


# Etsy's digital-file upload hard-caps at 19 MB on the publisher side (see
# ETSY_DIGITAL_FILE_MAX_BYTES in src-tauri/src/etsy_publish.rs). Binary STL
# is roughly 3-4× the size of the compressed GLB (each triangle = 50 bytes
# uncompressed in STL vs. indexed/draco-compressed in GLB), so gating on
# GLB size lets oversized STLs through. We aim for ≤ 16 MB on the STL with
# a 3 MB safety margin — observed Tripo output sat at 23-24 MB with the
# older 18 MB target × 0.85 ratio × 5 rounds budget, blowing through the
# 19 MB cap and triggering ETSY_ASSET_TOO_LARGE on the publisher.
ETSY_STL_MAX_BYTES = 16 * 1024 * 1024
# Legacy alias — pre-2026-05-13 code gated on GLB size at 15 MB. Kept as
# the first-pass target so small models still pass through untouched.
ETSY_FILE_MAX_BYTES = 15 * 1024 * 1024


class StlTooLargeError(Exception):
    """Raised when ensure_stl_under_cap can't decimate the mesh below the
    Etsy upload cap. The designer cycle should abort cleanly instead of
    handing an oversized STL to the publisher (which would just reject it
    with ETSY_ASSET_TOO_LARGE)."""


def _decimate_glb_in_place(glb_path: str, target_ratio: float) -> bool:
    """Decimate the GLB to `target_ratio` of its current face count via
    trimesh, writing back to `glb_path`. Returns True on success. Best-
    effort — any failure logs and returns False without mutating the file.
    """
    import os, sys
    try:
        import trimesh  # type: ignore
    except ImportError:
        print("[tripo] decimate: trimesh not available", file=sys.stderr, flush=True)
        return False
    try:
        scene_or_mesh = trimesh.load(glb_path, force="mesh")
        if hasattr(scene_or_mesh, "dump"):
            scene_or_mesh = scene_or_mesh.dump(concatenate=True)
        faces = getattr(scene_or_mesh, "faces", None)
        if faces is None or len(faces) == 0:
            return False
        face_count = len(faces)
        try_target = max(2000, int(face_count * max(0.05, target_ratio)))
        if try_target >= face_count:
            return False
        decimated = None
        # trimesh 4.x's simplify_quadric_decimation uses keyword args
        # `percent=` (fraction to KEEP, 0–1) or `face_count=` (target count).
        # Older versions accepted a bare positional face-count int. Try the
        # new API first, fall back to the legacy form, fall back to the
        # alt-spelled `simplify_quadratic_decimation`.
        if hasattr(scene_or_mesh, "simplify_quadric_decimation"):
            try:
                decimated = scene_or_mesh.simplify_quadric_decimation(face_count=try_target)
            except TypeError:
                # Legacy positional API
                decimated = scene_or_mesh.simplify_quadric_decimation(try_target)
        elif hasattr(scene_or_mesh, "simplify_quadratic_decimation"):
            decimated = scene_or_mesh.simplify_quadratic_decimation(try_target)
        else:
            print("[tripo] decimate: trimesh has no decimation method", file=sys.stderr, flush=True)
            return False
        if decimated is None or not hasattr(decimated, "export"):
            return False
        decimated.export(glb_path, file_type="glb")
        new_size = os.path.getsize(glb_path)
        print(
            f"[tripo] decimate: {face_count} → {try_target} faces, "
            f"GLB now {new_size / 1024 / 1024:.1f} MB",
            file=sys.stderr, flush=True,
        )
        return True
    except Exception as e:
        print(f"[tripo] decimate: failed: {e}", file=sys.stderr, flush=True)
        return False


def ensure_stl_under_cap(glb_path: str, stl_path: str, max_bytes: int = ETSY_STL_MAX_BYTES) -> None:
    """Convert GLB to STL preserving the textured GLB at glb_path. If the
    resulting STL exceeds `max_bytes`, decimate a working copy of the GLB
    and reconvert — looping until under cap or attempts exhausted.

    The textured GLB is the deliverable shown in previews + uploaded to
    Cults3D and the model viewer. Decimation goes through trimesh, which
    only round-trips geometry (force="mesh" or scene.dump()) and drops
    PBR materials + UV maps on re-export. Before this change ensure_stl
    overwrote glb_path with the decimated geometry, silently stripping
    textures on every job whose STL didn't fit in one shot — which was
    most of them. Now decimation runs against a sidecar copy and only the
    STL is regenerated; the textured GLB stays exactly as Tripo returned it.
    """
    import os, shutil, sys

    # Decimate against a sidecar copy so glb_path stays textured. If the
    # copy fails (out-of-disk, permissions), fall back to in-place editing
    # rather than failing the whole cycle — losing textures is bad, losing
    # the whole asset is worse.
    work_glb = os.path.splitext(glb_path)[0] + "-stl-src.glb"
    cleanup_work = False
    try:
        shutil.copyfile(glb_path, work_glb)
        cleanup_work = True
    except OSError as e:
        print(
            f"[tripo] ensure_stl_under_cap: working-copy failed ({e}); "
            "decimation will run on the textured GLB and may strip materials",
            file=sys.stderr, flush=True,
        )
        work_glb = glb_path

    try:
        glb_to_stl(work_glb, stl_path)
        try:
            stl_size = os.path.getsize(stl_path)
        except OSError:
            return
        if stl_size <= max_bytes:
            return

        # Iterative decimation. Each round targets stl_size→max_bytes
        # proportionally, then re-converts. Bias each ratio harder (×0.7)
        # to compensate for the STL/GLB compression ratio variance per
        # mesh — observed earlier output at 23 MB after 5 rounds of ×0.85,
        # blowing the publisher cap.
        MAX_ROUNDS = 8
        for round_idx in range(MAX_ROUNDS):
            target_ratio = (max_bytes / float(stl_size)) * 0.7
            target_ratio = max(0.05, min(0.85, target_ratio))
            print(
                f"[tripo] ensure_stl_under_cap: STL is {stl_size / 1024 / 1024:.1f} MB "
                f"(over {max_bytes / 1024 / 1024:.0f} MB cap), round {round_idx+1}/{MAX_ROUNDS} "
                f"decimating to {target_ratio:.0%} of current faces (sidecar — "
                "textured GLB preserved)",
                file=sys.stderr, flush=True,
            )
            if not _decimate_glb_in_place(work_glb, target_ratio):
                # Decimation can't run (trimesh missing or method unavailable).
                # Don't silently leave a 24 MB STL on disk — raise so the
                # designer cycle aborts cleanly instead of the publisher
                # rejecting it later.
                raise StlTooLargeError(
                    f"STL is {stl_size / 1024 / 1024:.1f} MB and decimation failed "
                    f"(trimesh missing or decimation method unavailable). "
                    f"Cap is {max_bytes / 1024 / 1024:.0f} MB."
                )
            glb_to_stl(work_glb, stl_path)
            try:
                stl_size = os.path.getsize(stl_path)
            except OSError:
                return
            if stl_size <= max_bytes:
                print(
                    f"[tripo] ensure_stl_under_cap: STL now "
                    f"{stl_size / 1024 / 1024:.1f} MB — under cap "
                    "(textured GLB unchanged)",
                    file=sys.stderr, flush=True,
                )
                return
        # All rounds exhausted, still over cap. Fail fast — better to abort
        # the cycle here than ship a doomed file to the publisher.
        raise StlTooLargeError(
            f"STL still {stl_size / 1024 / 1024:.1f} MB after {MAX_ROUNDS} decimation "
            f"rounds (cap is {max_bytes / 1024 / 1024:.0f} MB). The source mesh is "
            f"too dense — try a lower-detail Tripo/Meshy preset or a simpler subject."
        )
    finally:
        if cleanup_work and work_glb != glb_path:
            try:
                os.unlink(work_glb)
            except OSError:
                pass


def shrink_glb_for_etsy(glb_path: str) -> None:
    """If the GLB on disk is larger than `ETSY_FILE_MAX_BYTES`, decimate the
    mesh in-place via trimesh until it fits. No-op on small files.

    Best-effort: any failure (trimesh missing, broken mesh, export error) is
    swallowed — the publisher's own size guard will then reject the listing
    cleanly instead of half-creating a draft. We log the outcome to stderr so
    operators can tell whether shrinking ran.
    """
    import os
    import sys

    try:
        size = os.path.getsize(glb_path)
    except OSError as e:
        print(f"[tripo] shrink_glb: stat {glb_path} failed: {e}", file=sys.stderr, flush=True)
        return
    if size <= ETSY_FILE_MAX_BYTES:
        return

    print(
        f"[tripo] shrink_glb: {glb_path} is {size / 1024 / 1024:.1f} MB "
        f"(over {ETSY_FILE_MAX_BYTES / 1024 / 1024:.0f} MB target), decimating…",
        file=sys.stderr, flush=True,
    )
    try:
        import trimesh  # type: ignore
    except ImportError:
        print("[tripo] shrink_glb: trimesh not available; leaving file alone", file=sys.stderr, flush=True)
        return

    try:
        scene_or_mesh = trimesh.load(glb_path, force="mesh")
        if hasattr(scene_or_mesh, "dump"):
            scene_or_mesh = scene_or_mesh.dump(concatenate=True)
        face_count = len(getattr(scene_or_mesh, "faces", []) or [])
        if face_count == 0:
            print("[tripo] shrink_glb: no faces to decimate", file=sys.stderr, flush=True)
            return

        # Estimate target face count from file size — roughly proportional.
        # Cap at a few well-known retry rungs so we converge quickly instead
        # of micromanaging per-byte targets.
        target_ratio = min(0.75, (ETSY_FILE_MAX_BYTES / float(size)) * 0.85)
        target_faces = max(2000, int(face_count * target_ratio))

        decimated = None
        # trimesh's quadratic decimation API name varies across versions;
        # try the most common, fall back to the older.
        for attempt_ratio in (target_ratio, target_ratio * 0.6, 0.25):
            try_target = max(2000, int(face_count * attempt_ratio))
            try:
                if hasattr(scene_or_mesh, "simplify_quadric_decimation"):
                    decimated = scene_or_mesh.simplify_quadric_decimation(try_target)
                elif hasattr(scene_or_mesh, "simplify_quadratic_decimation"):
                    decimated = scene_or_mesh.simplify_quadratic_decimation(try_target)
                else:
                    print("[tripo] shrink_glb: trimesh has no decimation method", file=sys.stderr, flush=True)
                    return
            except Exception as e:
                print(f"[tripo] shrink_glb: decimate to {try_target} failed: {e}", file=sys.stderr, flush=True)
                continue
            if decimated is None or not hasattr(decimated, "export"):
                continue
            decimated.export(glb_path, file_type="glb")
            try:
                new_size = os.path.getsize(glb_path)
            except OSError:
                new_size = size
            print(
                f"[tripo] shrink_glb: {face_count} → {try_target} faces, "
                f"{size / 1024 / 1024:.1f} MB → {new_size / 1024 / 1024:.1f} MB",
                file=sys.stderr, flush=True,
            )
            if new_size <= ETSY_FILE_MAX_BYTES:
                return
            # Otherwise try another, more aggressive rung.
            size = new_size
            target_faces = try_target
        # If we got here all rungs were tried — leave whatever's on disk.
        # The publisher's size guard will still reject cleanly if needed.
        _ = target_faces  # silence linter; we kept the var for tracing
    except Exception as e:
        # Don't let mesh weirdness break the whole pipeline.
        print(f"[tripo] shrink_glb: unexpected error: {e}", file=sys.stderr, flush=True)


def _placeholder_preview(png_path: str, prompt: str) -> None:
    """Create a simple branded PNG when Tripo doesn't return a preview.
    Etsy requires at least one listing image — without this the publisher
    would fail. Uses Pillow if available; falls back to a tiny solid-color
    PNG written by hand so the pipeline never gets blocked on imports."""
    try:
        from PIL import Image, ImageDraw, ImageFont  # type: ignore
    except ImportError:
        # Stdlib-only fallback: write a minimal 64x64 solid PNG.
        import struct, zlib
        w = h = 64
        raw = b"".join(b"\x00" + b"\x2d\x2d\x33" * w for _ in range(h))
        compressor = zlib.compressobj()
        compressed = compressor.compress(raw) + compressor.flush()
        def chunk(tag: bytes, data: bytes) -> bytes:
            return struct.pack(">I", len(data)) + tag + data + struct.pack(
                ">I", zlib.crc32(tag + data) & 0xffffffff
            )
        png = b"\x89PNG\r\n\x1a\n"
        png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        png += chunk(b"IDAT", compressed)
        png += chunk(b"IEND", b"")
        with open(png_path, "wb") as f:
            f.write(png)
        return
    img = Image.new("RGB", (1024, 1024), color=(45, 45, 51))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("Helvetica.ttc", 40)
        font_sm = ImageFont.truetype("Helvetica.ttc", 24)
    except Exception:
        font = ImageFont.load_default()
        font_sm = ImageFont.load_default()
    draw.text((64, 64), "3D printable file", fill=(245, 166, 35), font=font)
    snippet = (prompt or "").strip()[:280]
    # Word-wrap roughly at 50 chars/line.
    line_start = 0
    y = 160
    while line_start < len(snippet):
        line = snippet[line_start : line_start + 50]
        draw.text((64, y), line, fill=(212, 216, 222), font=font_sm)
        y += 34
        line_start += 50
        if y > 900:
            break
    img.save(png_path, "PNG")


def generate_3d_from_image(
    api_key: str,
    image_path: str,
    *,
    job_id: int,
    assets_dir: str,
    style: Optional[str] = None,
) -> Tuple[str, str, str]:
    """One-shot image→3D via Tripo. Returns (glb_path, stl_path, preview_png).

    The prompt path is replaced by an uploaded reference image (typically a
    nanobanana / Gemini-Flash-Image render). Tripo's image-to-3D is the
    user's preferred provider for character work — Meshy is available as a
    swap via the image_to_3d_provider setting.
    """
    os.makedirs(assets_dir, exist_ok=True)
    print(
        f"[tripo] job_id={job_id} image-to-3d submitting {image_path}",
        file=sys.stderr, flush=True,
    )
    task_id = submit_image_to_model(api_key, image_path, style=style)
    print(f"[tripo] job_id={job_id} task_id={task_id} polling", file=sys.stderr, flush=True)
    data = poll_until_done(api_key, task_id)
    model_url = pick_model_url(data)
    glb_path = os.path.join(assets_dir, f"{job_id}.glb")
    stl_path = os.path.join(assets_dir, f"{job_id}.stl")
    png_path = os.path.join(assets_dir, f"{job_id}.png")
    download_to_path(model_url, glb_path)
    # Convert to STL and loop-decimate until the STL fits Etsy's 19 MB cap
    # (binary STL is ~3-4× the size of the compressed GLB, so gating on GLB
    # size alone let oversized STLs through). Keeps the GLB and STL aligned
    # on the same low-poly mesh either way.
    ensure_stl_under_cap(glb_path, stl_path)
    _gate_mesh_or_raise(glb_path, stl_path, job_id)
    preview_url = pick_preview_url(data)
    if preview_url:
        try:
            download_to_path(preview_url, png_path)
        except TripoError as e:
            print(
                f"[tripo] job_id={job_id} preview download failed: {e} — "
                "reusing reference image as listing thumbnail",
                file=sys.stderr, flush=True,
            )
            # Reference image is already a high-quality character render;
            # using it as the listing thumbnail is strictly better than a
            # placeholder when Tripo's render isn't available.
            try:
                with open(image_path, "rb") as src, open(png_path, "wb") as dst:
                    dst.write(src.read())
            except OSError:
                _placeholder_preview(png_path, "image-to-3d output")
    else:
        try:
            with open(image_path, "rb") as src, open(png_path, "wb") as dst:
                dst.write(src.read())
        except OSError:
            _placeholder_preview(png_path, "image-to-3d output")
    return glb_path, stl_path, png_path


def generate_3d(
    api_key: str,
    prompt: str,
    *,
    job_id: int,
    assets_dir: str,
    style: Optional[str] = None,
) -> Tuple[str, str, str]:
    """One-shot text→3D: submit, poll, download. Returns
    (glb_path, stl_path, preview_png_path).

    `assets_dir` is created if it does not exist. File names are derived
    from `job_id` so re-runs are idempotent and easy to trace back.
    """
    os.makedirs(assets_dir, exist_ok=True)
    print(f"[tripo] job_id={job_id} submitting prompt ({len(prompt)} chars)", file=sys.stderr, flush=True)
    task_id = submit_text_to_model(api_key, prompt, style=style)
    print(f"[tripo] job_id={job_id} task_id={task_id} polling", file=sys.stderr, flush=True)
    data = poll_until_done(api_key, task_id)
    model_url = pick_model_url(data)
    glb_path = os.path.join(assets_dir, f"{job_id}.glb")
    stl_path = os.path.join(assets_dir, f"{job_id}.stl")
    png_path = os.path.join(assets_dir, f"{job_id}.png")
    download_to_path(model_url, glb_path)
    print(f"[tripo] job_id={job_id} downloaded glb ({os.path.getsize(glb_path)} bytes)", file=sys.stderr, flush=True)
    ensure_stl_under_cap(glb_path, stl_path)
    print(f"[tripo] job_id={job_id} converted stl ({os.path.getsize(stl_path)} bytes)", file=sys.stderr, flush=True)
    _gate_mesh_or_raise(glb_path, stl_path, job_id)
    # Listing thumbnail: prefer Tripo's preview render; placeholder otherwise.
    preview_url = pick_preview_url(data)
    if preview_url:
        try:
            download_to_path(preview_url, png_path)
            print(f"[tripo] job_id={job_id} downloaded preview png", file=sys.stderr, flush=True)
        except TripoError as e:
            print(f"[tripo] job_id={job_id} preview download failed: {e} — using placeholder", file=sys.stderr, flush=True)
            _placeholder_preview(png_path, prompt)
    else:
        _placeholder_preview(png_path, prompt)
    return glb_path, stl_path, png_path
