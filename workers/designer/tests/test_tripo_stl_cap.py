"""Tests for ensure_stl_under_cap — the loop-decimation guard that keeps
Tripo/Meshy STLs under Etsy's 19 MB upload cap.

Earlier production behavior: when decimation couldn't shrink the STL
below cap (either trimesh missing or mesh too dense), the function logged
a warning and left the oversized file on disk. Downstream the publisher
rejected the upload with ETSY_ASSET_TOO_LARGE, surfacing 4+ alerts in
quick succession. The fix moves the failure upstream — ensure_stl_under_cap
now raises StlTooLargeError so the designer cycle aborts cleanly.
"""
import os

import pytest

from designer import tripo


def test_stl_under_cap_passes_through(tmp_path, monkeypatch):
    """When the first STL conversion is already under cap, the function
    short-circuits without invoking decimation."""
    glb = tmp_path / "x.glb"
    stl = tmp_path / "x.stl"
    glb.write_bytes(b"GLB")  # content doesn't matter — we'll stub glb_to_stl

    def fake_glb_to_stl(glb_p, stl_p):
        # First (and only) conversion: write a tiny STL.
        with open(stl_p, "wb") as f:
            f.write(b"x" * (10 * 1024 * 1024))  # 10 MB

    monkeypatch.setattr(tripo, "glb_to_stl", fake_glb_to_stl)

    called = {"n": 0}
    monkeypatch.setattr(tripo, "_decimate_glb_in_place",
                        lambda *a, **kw: (_record(called), True)[1])

    tripo.ensure_stl_under_cap(str(glb), str(stl))
    assert called["n"] == 0, "decimation must not run when STL already fits"
    assert os.path.getsize(str(stl)) == 10 * 1024 * 1024


def test_decimation_failure_raises_stl_too_large(tmp_path, monkeypatch):
    """When decimation can't run (trimesh missing or method unavailable),
    the function must RAISE so the designer cycle aborts upstream.
    Previously it returned silently and let the publisher reject."""
    glb = tmp_path / "x.glb"
    stl = tmp_path / "x.stl"
    glb.write_bytes(b"GLB")

    def fake_glb_to_stl(glb_p, stl_p):
        with open(stl_p, "wb") as f:
            f.write(b"x" * (24 * 1024 * 1024))  # 24 MB — over cap

    monkeypatch.setattr(tripo, "glb_to_stl", fake_glb_to_stl)
    monkeypatch.setattr(tripo, "_decimate_glb_in_place", lambda *a, **kw: False)

    with pytest.raises(tripo.StlTooLargeError) as exc:
        tripo.ensure_stl_under_cap(str(glb), str(stl))
    assert "24.0 MB" in str(exc.value)
    assert "decimation failed" in str(exc.value).lower()


def test_decimation_exhausted_raises_stl_too_large(tmp_path, monkeypatch):
    """Even when decimation runs successfully every round, if the mesh
    is too dense to shrink below cap inside the MAX_ROUNDS budget,
    we must raise rather than ship an oversized STL."""
    glb = tmp_path / "x.glb"
    stl = tmp_path / "x.stl"
    glb.write_bytes(b"GLB")

    # Simulate a stubborn mesh: each "decimation" only shrinks by ~5%,
    # so 8 rounds of ×0.95 leaves the file still well over cap.
    state = {"size": 25 * 1024 * 1024}

    def fake_glb_to_stl(glb_p, stl_p):
        with open(stl_p, "wb") as f:
            f.write(b"x" * state["size"])

    def fake_decimate(glb_p, ratio):
        state["size"] = int(state["size"] * 0.95)
        return True

    monkeypatch.setattr(tripo, "glb_to_stl", fake_glb_to_stl)
    monkeypatch.setattr(tripo, "_decimate_glb_in_place", fake_decimate)

    with pytest.raises(tripo.StlTooLargeError) as exc:
        tripo.ensure_stl_under_cap(str(glb), str(stl))
    msg = str(exc.value).lower()
    assert "after" in msg and "decimation rounds" in msg


def test_decimation_succeeds_inside_budget(tmp_path, monkeypatch):
    """When decimation drops the STL under cap within MAX_ROUNDS, the
    function returns normally — no exception."""
    glb = tmp_path / "x.glb"
    stl = tmp_path / "x.stl"
    glb.write_bytes(b"GLB")

    # Each round halves the file; round 1 brings 22 MB → 11 MB → under
    # the 16 MB cap, so we expect a clean return.
    state = {"size": 22 * 1024 * 1024}

    def fake_glb_to_stl(glb_p, stl_p):
        with open(stl_p, "wb") as f:
            f.write(b"x" * state["size"])

    def fake_decimate(glb_p, ratio):
        state["size"] = state["size"] // 2
        return True

    monkeypatch.setattr(tripo, "glb_to_stl", fake_glb_to_stl)
    monkeypatch.setattr(tripo, "_decimate_glb_in_place", fake_decimate)

    # Must not raise.
    tripo.ensure_stl_under_cap(str(glb), str(stl))
    assert os.path.getsize(str(stl)) <= tripo.ETSY_STL_MAX_BYTES


def _record(counter: dict):
    counter["n"] = counter.get("n", 0) + 1
    return counter
