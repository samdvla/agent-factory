"""URLError retries on every paid-credit HTTP path in the designer.

The pipeline can spend credit on (a) nanobanana / Gemini for the reference
image, then (b) Tripo / Meshy for the mesh. Letting a 1-second TCP/DNS
blip kill any of these forces the next cycle to re-spend whatever already
landed. These tests pin down the bounded retry behavior so a future
refactor can't silently re-introduce the regression.

HTTPError (4xx/5xx) must NOT be retried — a response came back, the
provider may have charged, and a retry could double-charge.
"""
from __future__ import annotations

import base64
import io
import json
import urllib.error
import urllib.request

import pytest

from designer import gemini_image as gemini_mod
from designer import meshy as meshy_mod
from designer import nanobanana as nanobanana_mod
from designer import tripo as tripo_mod


def _fake_resp(payload: dict):
    body = json.dumps(payload).encode("utf-8")
    fake = io.BytesIO(body)

    class _Ctx:
        def __enter__(self_inner):
            return fake

        def __exit__(self_inner, *exc):
            return False

    return _Ctx()


def _http_error(code: int, body: bytes = b"forbidden"):
    return urllib.error.HTTPError(
        url="x", code=code, msg="x", hdrs=None, fp=io.BytesIO(body)
    )


# ---- Meshy ----------------------------------------------------------------

def test_meshy_post_retries_urlerror_and_succeeds(monkeypatch):
    calls = {"n": 0}

    def _urlopen(req, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("dns hiccup")
        return _fake_resp({"result": "ok"})

    monkeypatch.setattr(urllib.request, "urlopen", _urlopen)
    monkeypatch.setattr(meshy_mod.time, "sleep", lambda _s: None)

    result = meshy_mod._post("https://api.meshy.ai/x", {"a": 1}, "key")

    assert result == {"result": "ok"}
    assert calls["n"] == 2


def test_meshy_post_raises_after_all_retries_exhausted(monkeypatch):
    calls = {"n": 0}

    def _urlopen(req, timeout=None):
        calls["n"] += 1
        raise urllib.error.URLError("network unreachable")

    monkeypatch.setattr(urllib.request, "urlopen", _urlopen)
    monkeypatch.setattr(meshy_mod.time, "sleep", lambda _s: None)

    with pytest.raises(meshy_mod.MeshyError) as ei:
        meshy_mod._post("https://api.meshy.ai/x", {"a": 1}, "key")

    assert "network error" in str(ei.value)
    assert calls["n"] == meshy_mod._NET_RETRY_ATTEMPTS


def test_meshy_post_does_not_retry_http_error(monkeypatch):
    """HTTP 403 = server responded; a retry could double-charge. Must
    raise on the first attempt with no retry."""
    calls = {"n": 0}

    def _urlopen(req, timeout=None):
        calls["n"] += 1
        raise _http_error(403, b"forbidden")

    monkeypatch.setattr(urllib.request, "urlopen", _urlopen)
    monkeypatch.setattr(meshy_mod.time, "sleep", lambda _s: None)

    with pytest.raises(meshy_mod.MeshyError) as ei:
        meshy_mod._post("https://api.meshy.ai/x", {"a": 1}, "key")

    assert "HTTP 403" in str(ei.value)
    assert calls["n"] == 1


def test_meshy_get_retries_urlerror_and_succeeds(monkeypatch):
    calls = {"n": 0}

    def _urlopen(req, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("connection reset")
        return _fake_resp({"status": "SUCCEEDED"})

    monkeypatch.setattr(urllib.request, "urlopen", _urlopen)
    monkeypatch.setattr(meshy_mod.time, "sleep", lambda _s: None)

    result = meshy_mod._get("https://api.meshy.ai/x/1", "key")

    assert result == {"status": "SUCCEEDED"}
    assert calls["n"] == 2


# ---- Tripo ----------------------------------------------------------------

def test_tripo_post_retries_urlerror_and_succeeds(monkeypatch):
    calls = {"n": 0}

    def _urlopen(req, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("dns hiccup")
        return _fake_resp({"code": 0, "data": {"task_id": "abc"}})

    monkeypatch.setattr(urllib.request, "urlopen", _urlopen)
    monkeypatch.setattr(tripo_mod.time, "sleep", lambda _s: None)

    result = tripo_mod._post("https://api.tripo3d.ai/x", {"a": 1}, "key")

    assert result["data"]["task_id"] == "abc"
    assert calls["n"] == 2


def test_tripo_post_raises_after_all_retries_exhausted(monkeypatch):
    calls = {"n": 0}

    def _urlopen(req, timeout=None):
        calls["n"] += 1
        raise urllib.error.URLError("network unreachable")

    monkeypatch.setattr(urllib.request, "urlopen", _urlopen)
    monkeypatch.setattr(tripo_mod.time, "sleep", lambda _s: None)

    with pytest.raises(tripo_mod.TripoError) as ei:
        tripo_mod._post("https://api.tripo3d.ai/x", {"a": 1}, "key")

    assert "network error" in str(ei.value)
    assert calls["n"] == tripo_mod._NET_RETRY_ATTEMPTS


def test_tripo_post_does_not_retry_http_error(monkeypatch):
    calls = {"n": 0}

    def _urlopen(req, timeout=None):
        calls["n"] += 1
        raise _http_error(403, b"forbidden")

    monkeypatch.setattr(urllib.request, "urlopen", _urlopen)
    monkeypatch.setattr(tripo_mod.time, "sleep", lambda _s: None)

    with pytest.raises(tripo_mod.TripoError) as ei:
        tripo_mod._post("https://api.tripo3d.ai/x", {"a": 1}, "key")

    assert "HTTP 403" in str(ei.value)
    assert calls["n"] == 1


def test_tripo_download_to_path_retries_urlerror(tmp_path, monkeypatch):
    """Presigned URL fetches sometimes blip at the CloudFront edge — the
    GLB / preview PNG was already paid for upstream, so refetching costs
    nothing but wall clock."""
    calls = {"n": 0}
    payload = b"GLB-bytes"

    def _urlopen(req, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("connection reset")
        return _fake_resp_bytes(payload)

    def _fake_resp_bytes(body):
        fake = io.BytesIO(body)

        class _Ctx:
            def __enter__(self_inner):
                return fake

            def __exit__(self_inner, *exc):
                return False

        return _Ctx()

    monkeypatch.setattr(urllib.request, "urlopen", _urlopen)
    monkeypatch.setattr(tripo_mod.time, "sleep", lambda _s: None)

    dest = tmp_path / "out.glb"
    tripo_mod.download_to_path("https://presigned.example/glb", str(dest))

    assert dest.read_bytes() == payload
    assert calls["n"] == 2


def test_tripo_download_to_path_does_not_retry_http_error(tmp_path, monkeypatch):
    calls = {"n": 0}

    def _urlopen(req, timeout=None):
        calls["n"] += 1
        raise _http_error(404, b"gone")

    monkeypatch.setattr(urllib.request, "urlopen", _urlopen)
    monkeypatch.setattr(tripo_mod.time, "sleep", lambda _s: None)

    dest = tmp_path / "out.glb"
    with pytest.raises(tripo_mod.TripoError):
        tripo_mod.download_to_path("https://presigned.example/glb", str(dest))

    assert calls["n"] == 1


# ---- Nanobanana download (REMOVED) ----------------------------------------
# Higgsfield-CDN download retry tests lived here. That path was removed when
# the shop's Higgsfield plan ran out of credits — nanobanana now thin-
# delegates to gemini_image, and the Gemini POST retry is covered below.


def _bytes_resp(body: bytes):
    fake = io.BytesIO(body)

    class _Ctx:
        def __enter__(self_inner):
            return fake

        def __exit__(self_inner, *exc):
            return False

    return _Ctx()


# ---- Gemini image POST ----------------------------------------------------

def _gemini_success_resp() -> "_Ctx":  # noqa: F821
    """A minimal Gemini generateContent response containing an inline image."""
    img_b64 = base64.b64encode(b"PNG-bytes").decode("ascii")
    body = json.dumps({
        "candidates": [{
            "content": {
                "parts": [
                    {"text": "ok"},
                    {"inlineData": {"mimeType": "image/png", "data": img_b64}},
                ]
            }
        }]
    }).encode("utf-8")
    return _bytes_resp(body)


def test_gemini_post_retries_urlerror_and_succeeds(tmp_path, monkeypatch):
    """Gemini POST URLError = request never landed at Google. Retry it so
    a TCP blip doesn't lose the upstream Anthropic spend on the brief."""
    monkeypatch.setenv("GEMINI_IMAGE_API_KEY", "test-key")
    calls = {"n": 0}

    def _urlopen(req, timeout=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise urllib.error.URLError("dns hiccup")
        return _gemini_success_resp()

    monkeypatch.setattr(urllib.request, "urlopen", _urlopen)
    monkeypatch.setattr(gemini_mod.time, "sleep", lambda _s: None)

    path, model = gemini_mod.generate_reference_image(
        None,
        "minimalist line art",
        job_id=42,
        assets_dir=str(tmp_path),
    )
    assert path.endswith("42-ref.png")
    assert calls["n"] == 2


def test_gemini_post_raises_after_all_retries(tmp_path, monkeypatch):
    monkeypatch.setenv("GEMINI_IMAGE_API_KEY", "test-key")
    calls = {"n": 0}

    def _urlopen(req, timeout=None):
        calls["n"] += 1
        raise urllib.error.URLError("network unreachable")

    monkeypatch.setattr(urllib.request, "urlopen", _urlopen)
    monkeypatch.setattr(gemini_mod.time, "sleep", lambda _s: None)

    with pytest.raises(gemini_mod.GeminiImageError) as ei:
        gemini_mod.generate_reference_image(
            None, "x", job_id=42, assets_dir=str(tmp_path),
        )
    assert "network error" in str(ei.value)
    assert calls["n"] == gemini_mod._NET_RETRY_ATTEMPTS


def test_gemini_post_does_not_retry_http_error(tmp_path, monkeypatch):
    monkeypatch.setenv("GEMINI_IMAGE_API_KEY", "test-key")
    calls = {"n": 0}

    def _urlopen(req, timeout=None):
        calls["n"] += 1
        raise _http_error(429, b"rate limited")

    monkeypatch.setattr(urllib.request, "urlopen", _urlopen)
    monkeypatch.setattr(gemini_mod.time, "sleep", lambda _s: None)

    with pytest.raises(gemini_mod.GeminiImageError) as ei:
        gemini_mod.generate_reference_image(
            None, "x", job_id=42, assets_dir=str(tmp_path),
        )
    assert "HTTP 429" in str(ei.value)
    assert calls["n"] == 1
