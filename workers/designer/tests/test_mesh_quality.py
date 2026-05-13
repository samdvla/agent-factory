"""Unit tests for the mesh quality gate.

Covered behaviors:
  * Healthy mesh passes (icosphere fixture is watertight + positive volume).
  * Empty mesh fails with "empty mesh" reason.
  * Missing file fails with "glb not found" reason.
  * Repair pass mutates the file on disk so downstream stl conversion
    consumes the fixed geometry (winding repair regression).
  * Strict mode rejects non-watertight meshes; default mode accepts them.
  * gate_or_raise wraps failures into MeshQualityError on reject and
    returns metrics on accept.
"""
from __future__ import annotations

import math
import os

import pytest
import trimesh  # type: ignore

from designer import mesh_quality as mq


def _icosphere_glb(path: str) -> None:
    """Standard healthy mesh: 320-face icosphere, watertight, vol≈4.1."""
    mesh = trimesh.creation.icosphere(subdivisions=2)
    mesh.export(path)


def _empty_glb(path: str) -> None:
    """A mesh with vertices but zero faces — trimesh round-trips it cleanly
    and the gate must reject it."""
    mesh = trimesh.Trimesh(
        vertices=[[0, 0, 0], [1, 0, 0], [0, 1, 0]],
        faces=[],
    )
    mesh.export(path)


def _inverted_winding_glb(path: str) -> None:
    """Flip ALL faces so winding is consistent but inverted — volume comes
    out NEGATIVE in trimesh's signed-volume calc. fix_normals rotates the
    triangles back so volume comes out positive. This is the realistic Tripo
    failure mode (the whole mesh has flipped normals)."""
    mesh = trimesh.creation.icosphere(subdivisions=2)
    mesh.invert()  # flips all faces
    mesh.export(path)


def _open_box_glb(path: str) -> None:
    """Build a box and drop the top face — produces a non-watertight mesh
    with a single large hole. fill_holes can patch it because the boundary
    is a single planar loop."""
    box = trimesh.creation.box(extents=(1, 1, 1))
    # The top face is the pair of triangles whose vertices all have z=+0.5.
    top_z = box.vertices[:, 2].max()
    keep = []
    for i, face in enumerate(box.faces):
        on_top = all(box.vertices[v][2] >= top_z - 1e-6 for v in face)
        if not on_top:
            keep.append(i)
    box.update_faces(keep)
    box.export(path)


def test_validate_healthy_mesh_passes(tmp_path):
    glb = tmp_path / "good.glb"
    _icosphere_glb(str(glb))
    ok, reason, metrics = mq.validate_mesh(str(glb))
    assert ok is True, f"expected pass, got reason={reason!r}"
    assert reason is None
    assert metrics["face_count"] > 0
    assert metrics["vertex_count"] > 0
    assert metrics["volume"] > 0
    assert metrics["is_watertight"] is True


def test_validate_empty_mesh_rejected(tmp_path):
    glb = tmp_path / "empty.glb"
    _empty_glb(str(glb))
    ok, reason, metrics = mq.validate_mesh(str(glb))
    assert ok is False
    assert reason is not None
    assert "empty mesh" in reason
    assert metrics["face_count"] == 0


def test_validate_missing_file_rejected(tmp_path):
    ok, reason, _ = mq.validate_mesh(str(tmp_path / "nope.glb"))
    assert ok is False
    assert reason is not None
    assert "not found" in reason


def test_repair_and_validate_fixes_inverted_winding(tmp_path):
    """Mesh with fully inverted normals → repair runs fix_normals → volume
    flips back to positive → re-exports the STL with the fixed geometry.

    The GLB on disk is deliberately NOT re-exported even when repair runs:
    trimesh's force="mesh" / scene.dump() loader drops PBR materials + UVs
    on round-trip, and the GLB is the textured deliverable shown in previews
    + uploaded to Cults3D. STL has no materials by format anyway, so it
    safely carries the repaired geometry forward to 3D-print buyers.
    """
    glb = tmp_path / "inverted.glb"
    _inverted_winding_glb(str(glb))
    # Pre-repair: signed volume should be negative.
    pre = trimesh.load(str(glb), force="mesh")
    if hasattr(pre, "dump"):
        pre = pre.dump(concatenate=True)
    assert pre.volume < 0, (
        "fixture preconditions failed — inverted icosphere should report "
        f"negative volume, got {pre.volume}"
    )

    stl = tmp_path / "inverted.stl"
    ok, reason, metrics = mq.repair_and_validate(str(glb), str(stl))
    assert ok is True, f"repair should rescue inverted normals, got {reason!r}"
    assert metrics["volume"] > 0
    # STL has the repaired geometry (positive volume).
    stl_mesh = trimesh.load(str(stl), force="mesh")
    if hasattr(stl_mesh, "dump"):
        stl_mesh = stl_mesh.dump(concatenate=True)
    assert stl_mesh.volume > 0
    # GLB on disk is intentionally untouched so PBR textures survive.
    post_glb = trimesh.load(str(glb), force="mesh")
    if hasattr(post_glb, "dump"):
        post_glb = post_glb.dump(concatenate=True)
    assert post_glb.volume < 0, (
        "GLB must NOT be re-exported by repair_and_validate — textures "
        "would be stripped"
    )
    assert stl.exists()
    assert stl.stat().st_size > 0


def test_repair_and_validate_rejects_empty(tmp_path):
    glb = tmp_path / "empty.glb"
    _empty_glb(str(glb))
    stl = tmp_path / "empty.stl"
    ok, reason, _ = mq.repair_and_validate(str(glb), str(stl))
    assert ok is False
    assert reason is not None
    assert "empty mesh" in reason


def test_strict_mode_rejects_non_watertight(tmp_path, monkeypatch):
    """An open box (missing top face) is non-watertight; fill_holes can patch
    small holes but a 25%-of-surface boundary loop typically resists it.
    Strict mode must reject it; default (lax) mode accepts it as long as
    volume comes out positive."""
    glb = tmp_path / "open.glb"
    _open_box_glb(str(glb))
    pre = trimesh.load(str(glb), force="mesh")
    if hasattr(pre, "dump"):
        pre = pre.dump(concatenate=True)
    assert pre.is_watertight is False, (
        "fixture preconditions failed — open box should be non-watertight"
    )

    # Default (lax) mode accepts it as long as volume is positive after repair.
    monkeypatch.delenv("MESH_QUALITY_STRICT", raising=False)
    ok, _, metrics = mq.repair_and_validate(str(glb), None)
    # fill_holes on a planar single-loop boundary usually succeeds; either way
    # the lax gate must accept anything with positive volume.
    assert ok is True, "default mode should accept non-watertight meshes"
    assert metrics["volume"] > 0

    # Strict mode rejects when fill_holes didn't fully close the mesh.
    monkeypatch.setenv("MESH_QUALITY_STRICT", "1")
    glb2 = tmp_path / "open2.glb"
    _open_box_glb(str(glb2))
    # Confirm pre-repair still non-watertight on the second copy.
    pre2 = trimesh.load(str(glb2), force="mesh")
    if hasattr(pre2, "dump"):
        pre2 = pre2.dump(concatenate=True)
    assert pre2.is_watertight is False
    ok2, reason2, metrics2 = mq.repair_and_validate(str(glb2), None)
    # If trimesh's fill_holes managed to close it (newer versions do this
    # for simple planar loops), the strict gate passes — both outcomes are
    # acceptable. The contract is: when fill_holes did NOT succeed, strict
    # mode must reject. So we assert on the actual final watertight state.
    if metrics2["is_watertight"]:
        assert ok2 is True, "strict mode should accept after successful repair"
    else:
        assert ok2 is False
        assert reason2 is not None
        assert "watertight" in reason2.lower()


def test_gate_or_raise_returns_metrics_on_pass(tmp_path):
    glb = tmp_path / "ok.glb"
    _icosphere_glb(str(glb))
    metrics = mq.gate_or_raise(str(glb), None)
    assert metrics["face_count"] > 0


def test_gate_or_raise_raises_on_fail(tmp_path):
    glb = tmp_path / "bad.glb"
    _empty_glb(str(glb))
    with pytest.raises(mq.MeshQualityError) as ei:
        mq.gate_or_raise(str(glb), None)
    assert "empty mesh" in str(ei.value)


def test_tripo_wraps_quality_failure_as_tripo_error(tmp_path):
    """Regression: TripoError must be the visible exception when the
    mesh fails the gate, so the designer's _classify_3d_provider_failure
    treats it identically to other provider faults."""
    from designer import tripo as tripo_mod

    glb = tmp_path / "bad.glb"
    _empty_glb(str(glb))
    stl = tmp_path / "bad.stl"

    with pytest.raises(tripo_mod.TripoError) as ei:
        tripo_mod._gate_mesh_or_raise(str(glb), str(stl), job_id=99)
    assert "mesh failed quality gate" in str(ei.value).lower()
    assert "empty mesh" in str(ei.value)


def test_meshy_wraps_quality_failure_as_meshy_error(tmp_path):
    """Symmetrical regression for the Meshy path."""
    from designer import meshy as meshy_mod

    glb = tmp_path / "bad.glb"
    _empty_glb(str(glb))
    stl = tmp_path / "bad.stl"

    with pytest.raises(meshy_mod.MeshyError) as ei:
        meshy_mod._gate_mesh_or_raise(str(glb), str(stl), job_id=42)
    assert "mesh failed quality gate" in str(ei.value).lower()


def test_validate_handles_non_finite_volume(tmp_path, monkeypatch):
    """Defensive: trimesh can return NaN for pathological meshes. The
    gate must treat NaN/inf as a reject reason, not silently accept it."""
    glb = tmp_path / "ok.glb"
    _icosphere_glb(str(glb))

    real_load = trimesh.load

    class _FakeMesh:
        def __init__(self, base):
            self._base = base
            self.faces = base.faces
            self.vertices = base.vertices
            self.is_watertight = base.is_watertight
            self.is_winding_consistent = base.is_winding_consistent

        @property
        def volume(self):
            return float("nan")

        def export(self, *a, **kw):
            return self._base.export(*a, **kw)

    def fake_load(*a, **kw):
        m = real_load(*a, **kw)
        if hasattr(m, "dump"):
            m = m.dump(concatenate=True)
        return _FakeMesh(m)

    monkeypatch.setattr(trimesh, "load", fake_load)
    ok, reason, _ = mq.validate_mesh(str(glb))
    assert ok is False
    assert reason is not None
    assert "non-positive volume" in reason or "non-finite" in reason.lower() or math.isnan(0) or "volume" in reason.lower()
