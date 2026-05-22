"""Tests for realism mode reference acquisition.

Mocks SerpAPI + image-download HTTP via urllib monkeypatch (same
pattern as test_designer.py). Generates real PNGs on disk so the
Pillow-based scoring path is exercised, not stubbed."""
from __future__ import annotations

import io
import json
import urllib.request
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from designer import realism


def _make_sharp_png(size: tuple[int, int] = (1200, 1200)) -> bytes:
    """A noisy random-ish image — high Laplacian variance so it sails
    past the sharpness floor. Solid-color images fail the gate by
    design, which is correct behavior."""
    rng = np.random.default_rng(seed=42)
    arr = rng.integers(0, 256, size=(size[1], size[0], 3), dtype=np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return buf.getvalue()


def _make_tiny_png() -> bytes:
    """Below the resolution gate — every realism call should reject."""
    buf = io.BytesIO()
    Image.new("RGB", (200, 200), color=(128, 128, 128)).save(buf, format="PNG")
    return buf.getvalue()


class _Resp:
    def __init__(self, body: bytes):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._body


def _install_urlopen(monkeypatch, *, search_payload: dict, image_bytes: bytes,
                     captured: dict | None = None):
    """Mock urllib.request.urlopen so SerpAPI returns search_payload and
    every image URL returns image_bytes. If `captured` is provided, the
    SerpAPI request URL is recorded under captured['serpapi_url']."""
    def _fake(req, timeout=30):
        url = req.full_url if hasattr(req, "full_url") else str(req)
        if "serpapi.com" in url:
            if captured is not None:
                captured["serpapi_url"] = url
            return _Resp(json.dumps(search_payload).encode("utf-8"))
        return _Resp(image_bytes)
    monkeypatch.setattr(urllib.request, "urlopen", _fake)


def test_is_configured_requires_api_key(monkeypatch):
    monkeypatch.delenv("SERPAPI_API_KEY", raising=False)
    assert realism.is_configured() is False
    monkeypatch.setenv("SERPAPI_API_KEY", "k-test")
    assert realism.is_configured() is True


def test_acquire_reference_without_key_raises(monkeypatch, tmp_path):
    monkeypatch.delenv("SERPAPI_API_KEY", raising=False)
    with pytest.raises(realism.RealismError, match="SERPAPI_API_KEY"):
        realism.acquire_reference("lebron james", job_id=1, assets_dir=str(tmp_path))


def test_acquire_reference_empty_query_raises(monkeypatch, tmp_path):
    monkeypatch.setenv("SERPAPI_API_KEY", "k-test")
    with pytest.raises(realism.RealismError, match="subject query"):
        realism.acquire_reference("   ", job_id=1, assets_dir=str(tmp_path))


def test_acquire_reference_happy_path(monkeypatch, tmp_path):
    """End-to-end: SerpAPI returns 3 hits, all download as sharp 1200px
    PNGs, scoring picks one, ref file lands at the canonical slot."""
    monkeypatch.setenv("SERPAPI_API_KEY", "k-test")
    monkeypatch.delenv("REALISM_CANDIDATES", raising=False)
    monkeypatch.delenv("REALISM_MIN_RES", raising=False)

    payload = {
        "images_results": [
            {"original": f"https://example.com/img-{i}.jpg",
             "thumbnail": f"https://example.com/thumb-{i}.jpg",
             "source": f"site{i}.com"}
            for i in range(3)
        ]
    }
    _install_urlopen(monkeypatch, search_payload=payload, image_bytes=_make_sharp_png())

    path, model_id = realism.acquire_reference(
        "lebron james", job_id=42, assets_dir=str(tmp_path)
    )
    assert model_id == realism.SOURCE_MODEL_ID
    assert Path(path).name == "42-ref.png"
    assert Path(path).exists()
    assert Path(path).stat().st_size > 2048
    # Candidate scratch files should be cleaned up — only the canonical
    # ref file (and any pre-existing files) remain.
    leftovers = [p.name for p in tmp_path.iterdir() if p.name.startswith("42-cand-")]
    assert leftovers == []


def test_acquire_reference_empty_search_raises(monkeypatch, tmp_path):
    monkeypatch.setenv("SERPAPI_API_KEY", "k-test")
    _install_urlopen(monkeypatch, search_payload={"images_results": []},
                     image_bytes=_make_sharp_png())
    with pytest.raises(realism.RealismError, match="0 face-tagged"):
        realism.acquire_reference("obscure subject", job_id=1, assets_dir=str(tmp_path))


def test_acquire_reference_all_below_resolution(monkeypatch, tmp_path):
    """Every candidate downloads but fails the resolution gate.
    Surfaced as RealismError so the designer treats it as a hard 3D
    failure rather than silently shipping a tiny reference."""
    monkeypatch.setenv("SERPAPI_API_KEY", "k-test")
    payload = {"images_results": [
        {"original": f"https://example.com/tiny-{i}.jpg"} for i in range(2)
    ]}
    _install_urlopen(monkeypatch, search_payload=payload, image_bytes=_make_tiny_png())
    with pytest.raises(realism.RealismError, match="quality gates"):
        realism.acquire_reference("subject", job_id=7, assets_dir=str(tmp_path))


def test_score_rejects_low_resolution(tmp_path):
    path = tmp_path / "small.png"
    path.write_bytes(_make_tiny_png())
    assert realism._score(path, min_res=1040) is None


def test_score_rejects_extreme_aspect(tmp_path):
    """Banner-shaped images aren't usable for image-to-3D character
    references — gated out before scoring."""
    path = tmp_path / "wide.png"
    rng = np.random.default_rng(0)
    arr = rng.integers(0, 256, size=(400, 2400, 3), dtype=np.uint8)
    Image.fromarray(arr).save(path, format="PNG")
    assert realism._score(path, min_res=300) is None


def test_score_accepts_sharp_portrait(tmp_path):
    path = tmp_path / "good.png"
    path.write_bytes(_make_sharp_png((1500, 1500)))
    score = realism._score(path, min_res=1040)
    assert score is not None
    assert 0.0 < score <= 1.0


import urllib.parse


def _serpapi_params(captured: dict) -> dict:
    """Parse the captured SerpAPI request URL into a flat param dict."""
    qs = urllib.parse.urlparse(captured["serpapi_url"]).query
    return {k: v[0] for k, v in urllib.parse.parse_qs(qs).items()}


def test_search_targets_full_body_photos_not_face_crops(monkeypatch, tmp_path):
    """The dominant slop bug: itp:face forces tight headshots and sur:fmc
    drops every real photo of a famous subject. The search must instead
    request real full-body photographs."""
    monkeypatch.setenv("SERPAPI_API_KEY", "k-test")
    monkeypatch.delenv("REALISM_SAFE_LICENSE", raising=False)
    monkeypatch.delenv("REALISM_FRAMING", raising=False)
    captured: dict = {}
    payload = {"images_results": [{"original": "https://example.com/a.jpg"}]}
    _install_urlopen(monkeypatch, search_payload=payload,
                     image_bytes=_make_sharp_png(), captured=captured)
    monkeypatch.setattr(realism, "_detect_faces", lambda img: None)

    realism.acquire_reference("lebron james", job_id=1, assets_dir=str(tmp_path))

    params = _serpapi_params(captured)
    tbs = params.get("tbs", "")
    assert "itp:face" not in tbs, "face-crop filter forces headshots"
    assert "sur:fmc" not in tbs, "license filter drops real-person photos by default"
    assert "itp:photo" in tbs, "should bias to real photographs over clipart"
    assert "isz:l" in tbs
    assert "full body" in params.get("q", "").lower()


def test_search_keeps_license_filter_when_operator_opts_in(monkeypatch, tmp_path):
    monkeypatch.setenv("SERPAPI_API_KEY", "k-test")
    monkeypatch.setenv("REALISM_SAFE_LICENSE", "1")
    captured: dict = {}
    payload = {"images_results": [{"original": "https://example.com/a.jpg"}]}
    _install_urlopen(monkeypatch, search_payload=payload,
                     image_bytes=_make_sharp_png(), captured=captured)
    monkeypatch.setattr(realism, "_detect_faces", lambda img: None)

    realism.acquire_reference("subject", job_id=1, assets_dir=str(tmp_path))
    assert "sur:fmc" in _serpapi_params(captured).get("tbs", "")


def test_score_rejects_image_with_no_detectable_face(tmp_path, monkeypatch):
    """When a face detector is available and finds no face, the candidate
    is slop (no subject) and must be rejected."""
    path = tmp_path / "noface.png"
    path.write_bytes(_make_sharp_png((1200, 1200)))
    monkeypatch.setattr(realism, "_detect_faces", lambda img: [])
    assert realism._score(path, min_res=1040) is None


def test_score_unknown_face_does_not_gate(tmp_path, monkeypatch):
    """No detector installed (returns None) → we cannot gate on faces, so
    the resolution/sharpness path still scores the candidate."""
    path = tmp_path / "ok.png"
    path.write_bytes(_make_sharp_png((1200, 1200)))
    monkeypatch.setattr(realism, "_detect_faces", lambda img: None)
    score = realism._score(path, min_res=1040)
    assert score is not None and 0.0 < score <= 1.0


def test_full_body_framing_outscores_headshot(tmp_path, monkeypatch):
    """Same sharp portrait; a small face (full-body framing) must score
    higher than a face that fills the frame (headshot)."""
    path = tmp_path / "portrait.png"
    path.write_bytes(_make_sharp_png((1200, 1600)))

    monkeypatch.setattr(realism, "_detect_faces", lambda img: [(0, 0, 140, 140)])
    full_body = realism._score(path, min_res=1040)

    monkeypatch.setattr(realism, "_detect_faces", lambda img: [(0, 0, 900, 1000)])
    headshot = realism._score(path, min_res=1040)

    assert full_body is not None and headshot is not None
    assert full_body > headshot


def test_all_faceless_candidates_raise(monkeypatch, tmp_path):
    """Detector present + every candidate faceless → hard RealismError,
    never silently ship a subject-less reference."""
    monkeypatch.setenv("SERPAPI_API_KEY", "k-test")
    payload = {"images_results": [
        {"original": f"https://example.com/x-{i}.jpg"} for i in range(3)
    ]}
    _install_urlopen(monkeypatch, search_payload=payload, image_bytes=_make_sharp_png())
    monkeypatch.setattr(realism, "_detect_faces", lambda img: [])
    with pytest.raises(realism.RealismError, match="quality gates"):
        realism.acquire_reference("subject", job_id=9, assets_dir=str(tmp_path))


# Brief-normalization tests for realism mode live in
# workers/research/tests/test_brief.py — _normalize_brief is owned by the
# research worker, not the designer.
