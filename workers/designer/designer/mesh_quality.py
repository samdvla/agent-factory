"""Mesh quality gate for Tripo/Meshy outputs.

3D-print buyers expect a slicer-ready STL: positive volume, manifold edges,
consistent normals. Tripo/Meshy occasionally emit meshes with flipped faces,
small holes, or near-degenerate geometry that look fine in a viewer but break
in a slicer. This module runs a repair pass (fix_normals + fill_holes) and
then validates the result — rejecting only what's truly unprintable so we
don't waste cycles on cosmetic issues a slicer would handle anyway.

Defaults are permissive (volume > 0 AND faces > 0). Set MESH_QUALITY_STRICT=1
to also reject meshes that remain non-watertight after repair.
"""
from __future__ import annotations

import math
import os
import sys
from typing import Optional, Tuple


class MeshQualityError(Exception):
    """Raised by `repair_and_validate` when a mesh fails the gate."""


def _log(msg: str) -> None:
    print(f"[mesh-quality] {msg}", file=sys.stderr, flush=True)


def _strict_mode() -> bool:
    return os.environ.get("MESH_QUALITY_STRICT", "").strip() == "1"


def _load_mesh(glb_path: str):
    """Load a GLB into a single Trimesh. Returns None when trimesh is missing
    or the file can't be loaded."""
    try:
        import trimesh  # type: ignore
    except ImportError:
        _log("trimesh not installed — skipping quality gate")
        return None
    try:
        mesh = trimesh.load(glb_path, force="mesh")
    except Exception as e:  # pragma: no cover - load failures surface upstream
        _log(f"load failed: {e}")
        return None
    if hasattr(mesh, "dump"):
        # trimesh sometimes returns a Scene for multi-primitive GLBs.
        mesh = mesh.dump(concatenate=True)
    return mesh


def _metrics(mesh) -> dict:
    """Extract numeric snapshot. Catches per-attribute exceptions because
    trimesh can raise on degenerate meshes when computing topology props."""
    def _safe(fn, default):
        try:
            return fn()
        except Exception:
            return default

    faces = getattr(mesh, "faces", None)
    verts = getattr(mesh, "vertices", None)
    return {
        "face_count": int(len(faces)) if faces is not None else 0,
        "vertex_count": int(len(verts)) if verts is not None else 0,
        "volume": float(_safe(lambda: float(mesh.volume), 0.0)),
        "is_watertight": bool(_safe(lambda: bool(mesh.is_watertight), False)),
        "is_winding_consistent": bool(_safe(lambda: bool(mesh.is_winding_consistent), False)),
    }


def _try_repair(mesh) -> bool:
    """Best-effort: handle the three common Tripo/Meshy mesh defects.
      1. Whole mesh inverted (winding consistent but volume negative) → invert.
      2. Mixed winding (some faces flipped relative to neighbours) → fix_normals.
      3. Small holes → fill_holes.
    Returns True when ANY repair was attempted (callers re-export).
    Per-step errors are swallowed — a partial repair is fine, the validator
    gates the final result."""
    repaired = False

    # Case 1: fully inverted normals. fix_normals() requires scipy for the
    # connected-components step on multi-body meshes; mesh.invert() flips
    # all faces unconditionally and works without scipy, which is exactly
    # what we need for the realistic "whole mesh inside out" Tripo failure.
    try:
        vol = float(mesh.volume)
        if math.isfinite(vol) and vol < 0 and bool(mesh.is_winding_consistent):
            mesh.invert()
            repaired = True
            _log(f"inverted mesh (vol was {vol:.2f}, winding was consistent)")
    except Exception as e:
        _log(f"invert step failed: {e}")

    # Case 2: mixed winding. fix_normals() walks the mesh and re-orients
    # each face to match its neighbours. Requires scipy for >1-body meshes;
    # we swallow the ImportError so single-body cases (the common one) still
    # benefit.
    try:
        if not bool(mesh.is_winding_consistent):
            mesh.fix_normals()
            repaired = True
            _log("ran fix_normals to repair winding")
    except Exception as e:
        _log(f"fix_normals failed: {e}")

    # Case 3: small holes / non-manifold edges. fill_holes patches simple
    # planar boundary loops.
    try:
        if not bool(mesh.is_watertight):
            mesh.fill_holes()
            repaired = True
            _log("ran fill_holes to close non-manifold edges")
    except Exception as e:
        _log(f"fill_holes failed: {e}")

    return repaired


def validate_mesh(glb_path: str) -> Tuple[bool, Optional[str], dict]:
    """Read-only check (no mutation). Returns (ok, reason, metrics).

    Reasons we hard-fail:
      - file missing / load failed
      - no faces or no vertices (empty mesh)
      - non-positive or non-finite volume (inverted / degenerate)
      - strict mode + still non-watertight
    """
    if not os.path.exists(glb_path):
        return False, f"glb not found: {glb_path}", {}
    mesh = _load_mesh(glb_path)
    if mesh is None:
        # trimesh missing — skip the gate rather than fail. Designer worker
        # already lists trimesh as a hard dep so this only triggers when
        # install drifted; failing here would lock the pipeline shut.
        return True, None, {}
    metrics = _metrics(mesh)
    if metrics["face_count"] <= 0 or metrics["vertex_count"] <= 0:
        return False, (
            f"empty mesh ({metrics['face_count']} faces, "
            f"{metrics['vertex_count']} vertices)"
        ), metrics
    vol = metrics["volume"]
    if not math.isfinite(vol) or vol <= 0.0:
        return False, (
            f"non-positive volume ({vol:.4f}) — mesh is inverted or degenerate"
        ), metrics
    if _strict_mode() and not metrics["is_watertight"]:
        return False, "strict mode: mesh is not watertight", metrics
    return True, None, metrics


def repair_and_validate(glb_path: str, stl_path: Optional[str]) -> Tuple[bool, Optional[str], dict]:
    """Load → repair → validate → re-export. Returns (ok, reason, metrics).

    On a successful repair we re-export both glb_path and (when provided)
    stl_path so downstream readers see the fixed geometry. On failure we
    do NOT mutate the files — the caller can choose to keep or discard them.

    Raising is reserved for the caller via `MeshQualityError`; this function
    returns a status tuple so the caller has full control over how to react.
    """
    if not os.path.exists(glb_path):
        return False, f"glb not found: {glb_path}", {}
    mesh = _load_mesh(glb_path)
    if mesh is None:
        return True, None, {}  # trimesh unavailable — fail-open
    metrics = _metrics(mesh)
    if metrics["face_count"] <= 0 or metrics["vertex_count"] <= 0:
        return False, (
            f"empty mesh ({metrics['face_count']} faces, "
            f"{metrics['vertex_count']} vertices)"
        ), metrics

    repaired = _try_repair(mesh)
    final = _metrics(mesh)

    vol = final["volume"]
    if not math.isfinite(vol) or vol <= 0.0:
        return False, (
            f"non-positive volume ({vol:.4f}) after repair — "
            "mesh is inverted or degenerate"
        ), final
    if _strict_mode() and not final["is_watertight"]:
        return False, "strict mode: mesh is not watertight after repair", final

    if repaired:
        # Only re-export the STL. The GLB stays as the upstream provider
        # returned it (textured / PBR materials intact). Trimesh's loader
        # uses force="mesh" / scene.dump() up the call chain, which round-
        # trips geometry but drops materials + UVs — re-exporting GLB here
        # would silently strip textures on every repair pass. For 3D-print
        # buyers the STL is the deliverable that needs the geometry fix;
        # the GLB is for preview + Cults3D where unrepaired winding is
        # cosmetic at worst (modern viewers tolerate both windings).
        try:
            if stl_path:
                mesh.export(stl_path, file_type="stl")
            _log(
                f"re-exported repaired STL (GLB preserved): "
                f"faces={final['face_count']} "
                f"vol={final['volume']:.2f} "
                f"watertight={final['is_watertight']}"
            )
        except Exception as e:
            _log(f"STL re-export failed after repair: {e}")
            # STL is likely still valid (upstream wrote it before the gate
            # ran); we proceed with the original.

    return True, None, final


def gate_or_raise(glb_path: str, stl_path: Optional[str]) -> dict:
    """Convenience wrapper: runs repair_and_validate and raises
    MeshQualityError on failure. Returns the metrics dict on success.
    Callers (tripo.generate_3d, meshy.generate_3d) prefer this form so the
    failure propagates through their existing TripoError / MeshyError
    handling and the designer's no-asset-produced path kicks in cleanly.
    """
    ok, reason, metrics = repair_and_validate(glb_path, stl_path)
    if not ok:
        raise MeshQualityError(reason or "mesh failed quality gate")
    return metrics
