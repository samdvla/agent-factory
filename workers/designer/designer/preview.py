"""Multi-angle preview rasterizer for 3D meshes.

Goal: turn a generated GLB into 3–5 PNG renders from different angles so
Etsy listings can show the buyer what the model actually looks like instead
of one ambiguous thumbnail. Etsy supports up to 10 listing images and the
extras dramatically improve click-through.

Why pure numpy + Pillow:
  - Headless. No display, no GPU, no GL context. Works in the supervisor
    process, in CI, in `pytest` runs, on the user's laptop the same way.
  - Zero new dependencies — trimesh / numpy / Pillow are already pinned in
    workers/designer/pyproject.toml. Adding pyrender + pyopengl + osmesa
    just for a preview render would be substantial install pain on macOS.
  - Deterministic. Same mesh + same camera = same pixels; easy to test.

What it does:
  1. Load + normalize the mesh (center + scale to unit cube).
  2. For each of `N` camera angles, build a view matrix, project the
     vertices orthographically into screen space.
  3. Per-face Lambertian shading from a key light (front-right) plus a
     soft fill (left) plus a rim (back). All in view space so the lighting
     follows the camera and the silhouette reads clearly at every angle.
  4. Scanline-rasterize each triangle with a per-pixel z-buffer so back
     faces never bleed through the silhouette.

The output PNGs land at `{output_dir}/{job_id}-angle-{N}.png` and the
function returns the absolute paths in render order (front first, so the
publisher can default-pick rank-1 to the front view).
"""
from __future__ import annotations

import math
import os
import sys
from typing import Iterable, Tuple

import numpy as np


class PreviewError(Exception):
    """Non-fatal: caller should fall back to single-thumbnail mode."""


# Camera angles (yaw, pitch) in degrees relative to the model's +Z forward.
# Order is intentional: index 0 is the "hero" / front render, then a 3/4
# right view, then full right side, then a 3/4 back, then top-down. Etsy
# uses image rank starting at 1 — we mirror that left-to-right ordering so
# buyers see "front first, dimensional second, profile third, back fourth,
# top fifth" which matches how Etsy photo carousels are typically curated.
DEFAULT_ANGLES: Tuple[Tuple[float, float], ...] = (
    (0.0, -10.0),     # front, slight downward tilt (showcase the face)
    (-40.0, -10.0),   # 3/4 right
    (-90.0, 0.0),     # right side
    (-150.0, -10.0),  # 3/4 back
    (0.0, -80.0),     # top-down
)

# 3-point soft light rig in view space. Values picked so the front render
# is bright on the face/chest, the side has dimensional rim, and the top
# view still reads instead of going flat.
_KEY_LIGHT = np.array([0.6, 0.8, 0.6], dtype=np.float32)
_KEY_INT = 0.85
_FILL_LIGHT = np.array([-0.7, 0.2, 0.4], dtype=np.float32)
_FILL_INT = 0.35
_RIM_LIGHT = np.array([0.1, 0.3, -0.9], dtype=np.float32)
_RIM_INT = 0.40
_AMBIENT = 0.18

# Neutral warm-grey background that mirrors typical Etsy product-photo
# backdrops. Avoids pure white (washes out white models) and pure grey
# (looks like a Blender default).
_BG_RGB = (243, 240, 234)
# Base material colour for the rendered surface — warm off-white. Real
# 3D-printed minis are usually grey resin or PLA; this reads better in a
# search-feed thumbnail than dead-white.
_MATERIAL_RGB = np.array([222, 218, 208], dtype=np.float32)


def _normalize_mesh(vertices: np.ndarray) -> np.ndarray:
    """Center the mesh on origin and scale so it fits in the unit cube.

    Returns a fresh (N, 3) float32 array. Input is not mutated.
    """
    if vertices.size == 0:
        raise PreviewError("mesh has no vertices")
    v = np.asarray(vertices, dtype=np.float32)
    mn = v.min(axis=0)
    mx = v.max(axis=0)
    center = (mn + mx) * 0.5
    extent = float(np.max(mx - mn))
    if extent <= 0.0:
        raise PreviewError("mesh extent is zero — degenerate model")
    return (v - center) / (extent * 0.5)


def _rotation_matrix(yaw_deg: float, pitch_deg: float) -> np.ndarray:
    """Y-axis yaw then X-axis pitch. Order chosen so 'yaw' rotates the model
    around its vertical axis (typical 3D viewer convention) and 'pitch'
    tilts the camera up/down without rolling the horizon."""
    yaw = math.radians(yaw_deg)
    pitch = math.radians(pitch_deg)
    cy, sy = math.cos(yaw), math.sin(yaw)
    cp, sp = math.cos(pitch), math.sin(pitch)
    ry = np.array(
        [
            [cy, 0.0, sy],
            [0.0, 1.0, 0.0],
            [-sy, 0.0, cy],
        ],
        dtype=np.float32,
    )
    rx = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, cp, -sp],
            [0.0, sp, cp],
        ],
        dtype=np.float32,
    )
    return rx @ ry


def _shade_faces(normals_view: np.ndarray) -> np.ndarray:
    """Per-face RGB after Lambertian shading. Returns (M, 3) float32 in [0, 1]
    multiplied into the base material color so the silhouette has volume."""
    if normals_view.size == 0:
        return np.zeros((0, 3), dtype=np.float32)

    def _lit(direction: np.ndarray, intensity: float) -> np.ndarray:
        d = direction / (np.linalg.norm(direction) + 1e-9)
        # Lambertian: max(N · L, 0). We also let backlit faces leak a touch
        # by adding 0.15 * max(0, -N·L) — keeps the back outline visible
        # from the front view.
        front = np.maximum(normals_view @ d, 0.0)
        back = np.maximum(-(normals_view @ d), 0.0)
        return intensity * (front + 0.15 * back)

    light = _AMBIENT + _lit(_KEY_LIGHT, _KEY_INT) + _lit(_FILL_LIGHT, _FILL_INT) + _lit(_RIM_LIGHT, _RIM_INT)
    light = np.clip(light, 0.0, 1.0)
    # Multiply lighting by material; clamp to [0, 255] for uint8 conversion.
    return np.clip(light[:, None] * (_MATERIAL_RGB / 255.0), 0.0, 1.0)


def _rasterize(
    verts_screen: np.ndarray,
    faces: np.ndarray,
    face_colors: np.ndarray,
    resolution: int,
) -> np.ndarray:
    """Software z-buffer rasterizer.

    `verts_screen` is (N, 3) with X,Y already in pixel coordinates and Z in
    view-space depth (more negative = farther). `faces` is (M, 3) int64.
    `face_colors` is (M, 3) float32 in [0, 1].

    Returns (H, W, 3) uint8 RGB. Background pixels carry the neutral
    backdrop colour; covered pixels carry the shaded triangle.
    """
    h = w = resolution
    image = np.full((h, w, 3), _BG_RGB, dtype=np.uint8)
    depth = np.full((h, w), np.inf, dtype=np.float32)

    # Drop tiny / degenerate faces early; they would otherwise generate
    # 0-area bounding boxes that waste cycles for no pixels.
    if faces.shape[0] == 0:
        return image

    # Sort faces back-to-front for a stable paint order. The z-buffer makes
    # this redundant for correctness, but on near-coplanar surfaces it
    # picks a deterministic winner instead of relying on float ties.
    face_depths = verts_screen[faces, 2].mean(axis=1)
    order = np.argsort(face_depths)  # smallest (most negative = farthest) first

    px = verts_screen[:, 0]
    py = verts_screen[:, 1]
    pz = verts_screen[:, 2]

    for idx in order:
        i0, i1, i2 = faces[idx]
        x0, x1, x2 = px[i0], px[i1], px[i2]
        y0, y1, y2 = py[i0], py[i1], py[i2]
        z0, z1, z2 = pz[i0], pz[i1], pz[i2]

        # Screen-space bounding box, clipped to the image rect.
        x_min = max(0, int(math.floor(min(x0, x1, x2))))
        x_max = min(w - 1, int(math.ceil(max(x0, x1, x2))))
        y_min = max(0, int(math.floor(min(y0, y1, y2))))
        y_max = min(h - 1, int(math.ceil(max(y0, y1, y2))))
        if x_max < x_min or y_max < y_min:
            continue

        # Edge-function denominator. Degenerate (collinear) triangles get a
        # near-zero denom and we just skip them — they'd contribute a
        # divide-by-zero with no useful pixels anyway.
        denom = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(denom) < 1e-6:
            continue

        # Compute barycentric coordinates for every pixel in the bbox using
        # a small grid (vectorised in numpy). This keeps the inner loop in
        # native ops rather than Python.
        ys, xs = np.mgrid[y_min : y_max + 1, x_min : x_max + 1]
        xs = xs.astype(np.float32)
        ys = ys.astype(np.float32)
        # Pixel centers are at integer coords here (we round/floor above);
        # adding 0.5 made debug renders slightly softer but didn't help
        # quality enough to justify the off-by-half complexity downstream.
        u = ((y1 - y2) * (xs - x2) + (x2 - x1) * (ys - y2)) / denom
        v = ((y2 - y0) * (xs - x2) + (x0 - x2) * (ys - y2)) / denom
        w_bc = 1.0 - u - v

        mask = (u >= 0.0) & (v >= 0.0) & (w_bc >= 0.0)
        if not mask.any():
            continue

        # Interpolated depth at each covered pixel. We use view-space z
        # (negative = behind camera) so lower numbers are nearer.
        z = u * z0 + v * z1 + w_bc * z2

        sub_depth = depth[y_min : y_max + 1, x_min : x_max + 1]
        win = mask & (z < sub_depth)
        if not win.any():
            continue

        sub_depth[win] = z[win]
        col_u8 = (face_colors[idx] * 255.0).clip(0, 255).astype(np.uint8)
        sub_image = image[y_min : y_max + 1, x_min : x_max + 1]
        sub_image[win] = col_u8

    return image


def _project(
    vertices: np.ndarray,
    yaw_deg: float,
    pitch_deg: float,
    resolution: int,
    margin: float = 0.92,
) -> Tuple[np.ndarray, np.ndarray]:
    """Rotate + orthographically project. Returns (verts_screen, normals_view).

    `verts_screen` is (N, 3) in pixel coords with z in view space.
    """
    rot = _rotation_matrix(yaw_deg, pitch_deg)
    view = vertices @ rot.T  # rotate model so camera looks down -Z
    # Fit the mesh inside the image with a small margin so the silhouette
    # doesn't kiss the frame edge — keeps the listing thumbnail feeling
    # composed instead of cropped.
    half = resolution * 0.5
    scale = half * margin
    xs = view[:, 0] * scale + half
    ys = -view[:, 1] * scale + half  # invert Y so +Y goes up in image space
    zs = view[:, 2]
    return np.column_stack([xs, ys, zs]).astype(np.float32), rot


def _face_normals_view(vertices_view: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Per-face normal in view space, unit length."""
    if faces.shape[0] == 0:
        return np.zeros((0, 3), dtype=np.float32)
    v0 = vertices_view[faces[:, 0]]
    v1 = vertices_view[faces[:, 1]]
    v2 = vertices_view[faces[:, 2]]
    n = np.cross(v1 - v0, v2 - v0)
    norms = np.linalg.norm(n, axis=1, keepdims=True)
    norms = np.where(norms < 1e-9, 1.0, norms)
    return (n / norms).astype(np.float32)


def render_angles(
    mesh_path: str,
    *,
    output_dir: str,
    job_id: int,
    angles: Iterable[Tuple[float, float]] = DEFAULT_ANGLES,
    resolution: int = 1024,
) -> list[str]:
    """Render the GLB/STL at `mesh_path` from each (yaw, pitch) in `angles`.

    Saves to `{output_dir}/{job_id}-angle-{i}.png` and returns the absolute
    paths in render order. Raises PreviewError on a degenerate mesh; the
    caller should catch + fall back to the single-thumbnail flow.
    """
    try:
        import trimesh  # type: ignore
    except ImportError as e:
        raise PreviewError(
            "trimesh not installed — designer worker is missing core deps"
        ) from e
    loaded = trimesh.load(mesh_path, force="mesh")
    if hasattr(loaded, "dump"):
        loaded = loaded.dump(concatenate=True)
    if not hasattr(loaded, "vertices") or not hasattr(loaded, "faces"):
        raise PreviewError(f"loaded object has no vertices/faces: {type(loaded)}")
    vertices = np.asarray(loaded.vertices, dtype=np.float32)
    faces = np.asarray(loaded.faces, dtype=np.int64)
    if faces.size == 0:
        raise PreviewError("mesh has no faces")
    # Re-orient so +Y is up. trimesh / glTF use Y-up by default; STL doesn't
    # carry orientation info, but Tripo/Meshy outputs we feed in here always
    # already conform to Y-up.
    vertices = _normalize_mesh(vertices)

    os.makedirs(output_dir, exist_ok=True)
    out_paths: list[str] = []
    for i, (yaw, pitch) in enumerate(angles):
        verts_screen, rot = _project(vertices, yaw, pitch, resolution)
        view_verts = vertices @ rot.T
        normals = _face_normals_view(view_verts, faces)
        colors = _shade_faces(normals)
        image = _rasterize(verts_screen, faces, colors, resolution)

        try:
            from PIL import Image  # type: ignore
        except ImportError as e:
            raise PreviewError("Pillow missing — cannot encode PNG") from e
        path = os.path.join(output_dir, f"{job_id}-angle-{i}.png")
        Image.fromarray(image, mode="RGB").save(path, "PNG")
        out_paths.append(path)
        print(
            f"[preview] job_id={job_id} angle={i} yaw={yaw:.1f} pitch={pitch:.1f} → {path}",
            file=sys.stderr, flush=True,
        )
    return out_paths


def try_render_angles(
    mesh_path: str | None,
    *,
    output_dir: str,
    job_id: int,
    angles: Iterable[Tuple[float, float]] = DEFAULT_ANGLES,
    resolution: int = 1024,
) -> list[str]:
    """Soft-fail wrapper: never raises. Returns an empty list on any error so
    callers can do `paths = try_render_angles(...) or [thumb]` without a
    try/except at every callsite."""
    if not mesh_path or not os.path.exists(mesh_path):
        return []
    try:
        return render_angles(
            mesh_path,
            output_dir=output_dir,
            job_id=job_id,
            angles=angles,
            resolution=resolution,
        )
    except Exception as e:  # PreviewError, trimesh load errors, file IO
        print(
            f"[preview] job_id={job_id} angle render failed: {e}",
            file=sys.stderr, flush=True,
        )
        return []
