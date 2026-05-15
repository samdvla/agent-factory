"""Meshy text-to-3D / image-to-3D / rigging+animation client.

Meshy's v2 text-to-3D flow is two-stage:
  1. Preview — fast (~30s) untextured low-poly mesh. Meshy 6 = 20 credits.
  2. Refine — slower (~3-5 min) textured high-poly mesh, 10 credits.

We default to BOTH stages (refine=True) and to ai_model=meshy-6 — that's
30 credits per text-to-3D listing. Image-to-3D on Meshy 6 with PBR is
also 30 credits in one shot. The STL is geometry-only by format and
doesn't carry textures regardless, but the GLB we ship to Cults3D +
display in the in-app model viewer needs PBR materials so buyers see
the actual look, not a white silhouette. enable_pbr defaults to True
for both flows.

For full-body humanoid figurines we additionally chain:
  • Auto-rigging (5 credits) — produces a rigged GLB plus FREE basic
    walking + running animations baked into separate GLBs.
  • Animation API (3 credits per action) — applies one extra preset
    action from the Animation Library so the listing has a hero loop
    beyond the rigging-bundled walk/run.

Total for a rigged + animated character listing: 30 + 5 + 3 = 38
credits, vs 30 for a static one. ~$0.16 extra at Meshy's $0.02/credit
plan rate — well within the per-listing margin even at the lowest
Cults3D / Etsy price points.

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
# Rigging + animation are post-mesh — both finish well under 60s in
# practice, but give them a generous cap so a queued slot doesn't kill
# an otherwise-good listing.
RIG_TIMEOUT_SEC = 240
ANIM_TIMEOUT_SEC = 240
# Meshy 6 is the current best model and the one the user has paid for.
# meshy-5 / meshy-4 remain selectable via env override for cost
# experiments; never default off meshy-6 silently.
DEFAULT_AI_MODEL = os.environ.get("MESHY_AI_MODEL", "meshy-6").strip() or "meshy-6"
# Operator toggle — supersedes any per-call default. When false, Meshy
# submits skip texture generation entirely (image-to-3D drops to 20
# credits, text-to-3D refine is skipped). The GLB ships flat-shaded.
# Default ON: textures are the headline value of the rigged-character
# product line. Wired through src-tauri/src/commands.rs::cmd_start as
# MESHY_TEXTURES_ENABLED.
def _textures_enabled() -> bool:
    return (os.environ.get("MESHY_TEXTURES_ENABLED", "true") or "true").strip().lower() != "false"


# Default animation action_id pulled from Meshy's Animation Library.
#   action_id=0 → "Idle" (DailyActions category) — the universal subtle
#   breathing/stance loop. Chosen as the default for two reasons:
#     1. It complements the FREE walking + running animations bundled
#        with the rigging task, instead of duplicating motion buyers
#        already get for the 5-credit rig.
#     2. Idle is pose-neutral: it works for ANY humanoid figurine
#        (warrior, dancer, mascot, monk, mini, etc.) without dictating
#        a specific narrative the buyer may not want.
# Override via MESHY_ANIMATION_ACTION_ID for niche-specific defaults
# (e.g. 28 = Big_Wave_Hello for greeting-card style listings,
# 290 = Wave_One_Hand for friendlier mascots, 92 = Double_Combo_Attack
# for action-figure listings).
DEFAULT_ANIMATION_ACTION_ID = int(os.environ.get("MESHY_ANIMATION_ACTION_ID", "0"))

# Reuse Tripo's helpers where they're identical (download_to_path,
# _placeholder_preview, glb_to_stl). Keeps a single source of truth for
# the GLB→STL conversion + placeholder rendering.
from . import tripo as _tripo


class MeshyError(Exception):
    """Non-recoverable Meshy failure. Treated as a generation failure by
    the designer; the pipeline continues with text-only output."""


# Bounded retry for TCP/DNS/connect-level blips. A bare URLError means the
# HTTP request never landed at Meshy, so the account wasn't debited and
# retrying is safe. HTTPError is excluded — a 4xx/5xx response proves the
# request *did* arrive, and any retry could double-charge. Worst-case wall
# clock when all retries miss: ~4s, far cheaper than burning the upstream
# nanobanana reference-render spend on a 1-second DNS hiccup.
_NET_RETRY_ATTEMPTS = 3
_NET_RETRY_BACKOFF_SEC = (1.0, 3.0)


def _backoff_sleep(attempt: int) -> None:
    idx = min(attempt, len(_NET_RETRY_BACKOFF_SEC) - 1)
    time.sleep(_NET_RETRY_BACKOFF_SEC[idx])


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
    last_err: urllib.error.URLError | None = None
    for attempt in range(_NET_RETRY_ATTEMPTS):
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
            last_err = e
            if attempt + 1 < _NET_RETRY_ATTEMPTS:
                print(
                    f"[meshy] POST {url} URLError "
                    f"(attempt {attempt + 1}/{_NET_RETRY_ATTEMPTS}): {e} — retrying",
                    file=sys.stderr, flush=True,
                )
                _backoff_sleep(attempt)
                continue
            raise MeshyError(f"Meshy POST {url} network error: {e}") from e
    raise MeshyError(f"Meshy POST {url} network error: {last_err}")


def _get(url: str, api_key: str, timeout: int = 60) -> dict:
    last_err: urllib.error.URLError | None = None
    for attempt in range(_NET_RETRY_ATTEMPTS):
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
            last_err = e
            if attempt + 1 < _NET_RETRY_ATTEMPTS:
                print(
                    f"[meshy] GET {url} URLError "
                    f"(attempt {attempt + 1}/{_NET_RETRY_ATTEMPTS}): {e} — retrying",
                    file=sys.stderr, flush=True,
                )
                _backoff_sleep(attempt)
                continue
            raise MeshyError(f"Meshy GET {url} network error: {e}") from e
    raise MeshyError(f"Meshy GET {url} network error: {last_err}")


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
    ai_model: str = DEFAULT_AI_MODEL,
    should_texture: bool = True,
) -> str:
    """Create an image-to-3D task. Accepts a local file path (uploaded as a
    data URI) or a public HTTPS URL. Returns the task id.

    Defaults: ai_model=meshy-6 + enable_pbr=True + should_texture=True →
    30 credits with full PBR maps (incl. emission, only emitted by
    meshy-6/latest).

    Operator override: MESHY_TEXTURES_ENABLED=false forces enable_pbr +
    should_texture off regardless of the per-call kwarg, so the operator
    can cut credit spend without touching code."""
    if not _textures_enabled():
        enable_pbr = False
        should_texture = False
    if image_path_or_url.startswith("http://") or image_path_or_url.startswith("https://"):
        image_url = image_path_or_url
    else:
        image_url = _image_to_data_uri(image_path_or_url)
    body: dict = {
        "image_url": image_url,
        "enable_pbr": enable_pbr,
        "ai_model": ai_model,
        "should_texture": should_texture,
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
) -> Tuple[str, str, str, str]:
    """One-shot image→3D via Meshy. Returns
    (glb_path, stl_path, preview_png, task_id).

    The trailing task_id lets the caller chain rigging via
    `input_task_id` instead of having to re-upload the GLB — Meshy
    treats input_task_id as the canonical handle and uses the same
    rendered mesh internally."""
    os.makedirs(assets_dir, exist_ok=True)
    print(
        f"[meshy] job_id={job_id} image-to-3d submitting {image_path}",
        file=sys.stderr, flush=True,
    )
    task_id = submit_image_to_3d(api_key, image_path, enable_pbr=enable_pbr)
    print(f"[meshy] job_id={job_id} task_id={task_id} polling", file=sys.stderr, flush=True)
    data = poll_image_task_until_done(api_key, task_id, REFINE_TIMEOUT_SEC)
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
    return glb_path, stl_path, png_path, task_id


def _clamp_prompt_to_meshy_limit(prompt: str) -> str:
    """Meshy text-to-3D rejects prompts longer than 800 chars with HTTP 400
    `Prompt must be a maximum of 800 characters in length`. Orchestrator
    briefs occasionally cross that threshold (the LLM doesn't honor a soft
    cap reliably). Truncate at a word boundary near 790 to leave headroom
    and avoid mid-word cuts. Sufficient for Meshy's intent extraction —
    the first ~700 chars carry the visual description; the tail tends to
    be style modifiers and instructions Meshy already infers."""
    LIMIT = 800
    SOFT = 790
    if len(prompt) <= LIMIT:
        return prompt
    cut = prompt[:SOFT]
    # Step back to the last space so we don't break a word.
    space = cut.rfind(" ")
    if space > SOFT - 80:
        cut = cut[:space]
    return cut


def submit_preview(
    api_key: str,
    prompt: str,
    art_style: str = "realistic",
    *,
    ai_model: str = DEFAULT_AI_MODEL,
) -> str:
    """Create a preview task. Returns the task id."""
    prompt = _clamp_prompt_to_meshy_limit(prompt)
    body: dict = {
        "mode": "preview",
        "prompt": prompt,
        "art_style": art_style,
        "ai_model": ai_model,
        # Meshy supports an optional AI seed; we omit it so each call is fresh.
    }
    resp = _post(f"{MESHY_API_BASE}/openapi/v2/text-to-3d", body, api_key)
    task_id = resp.get("result") or resp.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise MeshyError(f"Meshy preview create missing task id: {resp}")
    return task_id


def submit_refine(
    api_key: str,
    preview_task_id: str,
    *,
    ai_model: str = DEFAULT_AI_MODEL,
    enable_pbr: bool = True,
) -> str:
    """Refine a previously-completed preview into a textured mesh.

    enable_pbr+meshy-6 returns the full PBR set (base color, metallic,
    roughness, normal, emission). The emission map is exclusive to
    meshy-6 / latest and is what makes glow / hot-metal listings look
    right in the Cults3D viewer."""
    body = {
        "mode": "refine",
        "preview_task_id": preview_task_id,
        "ai_model": ai_model,
        "enable_pbr": enable_pbr,
    }
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

    Operator override: MESHY_TEXTURES_ENABLED=false forces refine off
    regardless of the per-call kwarg — refine without enable_pbr is a
    no-op spend (just reshapes geometry without texturing), so we skip
    it entirely and ship the preview mesh.
    """
    if not _textures_enabled() and refine:
        print(
            f"[meshy] job_id={job_id} MESHY_TEXTURES_ENABLED=false → "
            "skipping refine stage (untextured preview ships as-is)",
            file=sys.stderr, flush=True,
        )
        refine = False
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


# ─── Rigging + Animation ────────────────────────────────────────────────
#
# Auto-rigging requires a textured humanoid GLB and the character must
# face +Z (the standard glTF forward direction). Meshy 6 image-to-3D
# output already meets both constraints when the input reference image
# shows a single front-facing humanoid. Calling rig on a non-humanoid
# (a vase, a prop, a building) returns 422 Unprocessable Entity — wrap
# it in MeshyError so the caller treats it as "no rig produced" rather
# than blowing up the whole job.


def submit_rigging(
    api_key: str,
    *,
    input_task_id: Optional[str] = None,
    model_url: Optional[str] = None,
    height_meters: float = 1.7,
) -> str:
    """Create an auto-rigging task. Pass either input_task_id (preferred —
    avoids an extra GLB upload) or a publicly-reachable model_url. 5
    credits per call."""
    if not input_task_id and not model_url:
        raise MeshyError("submit_rigging needs input_task_id or model_url")
    body: dict = {"height_meters": height_meters}
    if input_task_id:
        body["input_task_id"] = input_task_id
    else:
        body["model_url"] = model_url
    resp = _post(f"{MESHY_API_BASE}/openapi/v1/rigging", body, api_key)
    task_id = resp.get("result") or resp.get("task_id") or resp.get("id")
    if not isinstance(task_id, str) or not task_id:
        raise MeshyError(f"Meshy rigging create missing task id: {resp}")
    return task_id


def poll_rigging_until_done(api_key: str, task_id: str, timeout_sec: int) -> dict:
    deadline = time.time() + timeout_sec
    while True:
        if time.time() > deadline:
            raise MeshyError(f"Meshy rigging task {task_id} timed out after {timeout_sec}s")
        resp = _get(f"{MESHY_API_BASE}/openapi/v1/rigging/{task_id}", api_key)
        status = resp.get("status")
        if status == "SUCCEEDED":
            return resp
        if status in ("FAILED", "CANCELED", "EXPIRED"):
            raise MeshyError(f"Meshy rigging task {task_id} status={status}: {resp}")
        time.sleep(POLL_INTERVAL_SEC)


def submit_animation(
    api_key: str,
    rig_task_id: str,
    action_id: int = DEFAULT_ANIMATION_ACTION_ID,
) -> str:
    """Apply a single Animation Library action to a rigged character.
    3 credits per call. Catalog: https://docs.meshy.ai/en/api/animation."""
    body = {"rig_task_id": rig_task_id, "action_id": int(action_id)}
    resp = _post(f"{MESHY_API_BASE}/openapi/v1/animations", body, api_key)
    task_id = resp.get("result") or resp.get("task_id") or resp.get("id")
    if not isinstance(task_id, str) or not task_id:
        raise MeshyError(f"Meshy animation create missing task id: {resp}")
    return task_id


def poll_animation_until_done(api_key: str, task_id: str, timeout_sec: int) -> dict:
    deadline = time.time() + timeout_sec
    while True:
        if time.time() > deadline:
            raise MeshyError(f"Meshy animation task {task_id} timed out after {timeout_sec}s")
        resp = _get(f"{MESHY_API_BASE}/openapi/v1/animations/{task_id}", api_key)
        status = resp.get("status")
        if status == "SUCCEEDED":
            return resp
        if status in ("FAILED", "CANCELED", "EXPIRED"):
            raise MeshyError(f"Meshy animation task {task_id} status={status}: {resp}")
        time.sleep(POLL_INTERVAL_SEC)


def rig_and_animate(
    api_key: str,
    *,
    input_task_id: str,
    job_id: int,
    assets_dir: str,
    height_meters: float = 1.7,
    action_id: int = DEFAULT_ANIMATION_ACTION_ID,
    skip_animation: bool = False,
) -> dict:
    """Rig a previously-completed image-to-3D task and (optionally) apply
    one preset animation. Returns a dict with downloaded asset paths:

        {
          "rigged_glb": "<assets_dir>/<job_id>.rigged.glb",
          "walking_glb": "<assets_dir>/<job_id>.walking.glb" | None,
          "running_glb": "<assets_dir>/<job_id>.running.glb" | None,
          "animation_glb": "<assets_dir>/<job_id>.animated.glb" | None,
          "rig_task_id": "...",
          "animation_task_id": "..." | None,
        }

    Cost: 5 (rig) + 3 (animation) = 8 credits per character. Pass
    skip_animation=True to skip the +3-credit Animation API call —
    you still get the free walking + running loops bundled with the
    rigging task, so it's a 5-credit "rig only" mode (operator toggle
    MESHY_ANIMATION_ENABLED=false routes here).

    Mesh-quality gating is intentionally NOT applied here — the rigged
    GLB has the same geometry as the static one (which was already
    gated), and Meshy guarantees the rigged output is just the static
    mesh + a skeleton."""
    os.makedirs(assets_dir, exist_ok=True)
    print(
        f"[meshy] job_id={job_id} rigging input_task={input_task_id} "
        f"(h={height_meters}m)",
        file=sys.stderr, flush=True,
    )
    rig_task_id = submit_rigging(
        api_key, input_task_id=input_task_id, height_meters=height_meters
    )
    rig_data = poll_rigging_until_done(api_key, rig_task_id, RIG_TIMEOUT_SEC)
    rig_result = rig_data.get("result") or {}
    rigged_glb_url = rig_result.get("rigged_character_glb_url")
    if not rigged_glb_url:
        raise MeshyError(f"Meshy rigging task {rig_task_id} missing rigged_character_glb_url")

    rigged_path = os.path.join(assets_dir, f"{job_id}.rigged.glb")
    try:
        _tripo.download_to_path(rigged_glb_url, rigged_path)
    except _tripo.TripoError as e:
        raise MeshyError(f"download rigged glb failed: {e}") from e

    # Free walking/running animations from the rigging task. Best-effort
    # — they're a bonus, not a contract; don't fail the job if Meshy
    # omits them for some reason.
    basic = rig_result.get("basic_animations") or {}
    walking_path = _maybe_download(
        basic.get("walking_glb_url"),
        os.path.join(assets_dir, f"{job_id}.walking.glb"),
    )
    running_path = _maybe_download(
        basic.get("running_glb_url"),
        os.path.join(assets_dir, f"{job_id}.running.glb"),
    )

    if skip_animation:
        print(
            f"[meshy] job_id={job_id} rigged ✓ — skipping animation API call "
            "(MESHY_ANIMATION_ENABLED=false). Free walking + running loops "
            "from rigging task are still available.",
            file=sys.stderr, flush=True,
        )
        return {
            "rigged_glb": rigged_path,
            "walking_glb": walking_path,
            "running_glb": running_path,
            "animation_glb": None,
            "rig_task_id": rig_task_id,
            "animation_task_id": None,
        }

    print(
        f"[meshy] job_id={job_id} rigged ✓ — submitting animation action_id={action_id}",
        file=sys.stderr, flush=True,
    )
    anim_task_id = submit_animation(api_key, rig_task_id, action_id=action_id)
    anim_data = poll_animation_until_done(api_key, anim_task_id, ANIM_TIMEOUT_SEC)
    anim_result = anim_data.get("result") or {}
    anim_url = anim_result.get("animation_glb_url")
    animation_path = _maybe_download(
        anim_url,
        os.path.join(assets_dir, f"{job_id}.animated.glb"),
    )
    print(
        f"[meshy] job_id={job_id} rig+anim done "
        f"(rigged={os.path.basename(rigged_path)}, "
        f"anim={os.path.basename(animation_path) if animation_path else 'none'})",
        file=sys.stderr, flush=True,
    )
    return {
        "rigged_glb": rigged_path,
        "walking_glb": walking_path,
        "running_glb": running_path,
        "animation_glb": animation_path,
        "rig_task_id": rig_task_id,
        "animation_task_id": anim_task_id,
    }


def _maybe_download(url: Optional[str], dest: str) -> Optional[str]:
    if not url:
        return None
    try:
        _tripo.download_to_path(url, dest)
        return dest
    except _tripo.TripoError as e:
        print(
            f"[meshy] optional asset download failed ({url[:80]}…): {e}",
            file=sys.stderr, flush=True,
        )
        return None
