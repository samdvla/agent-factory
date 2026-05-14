"""URLError retries on the Meshy / Tripo HTTP helpers.

The pipeline upstream of these calls has already spent a nanobanana credit
on the reference image. Letting a 1-second TCP/DNS blip kill the cycle
forces the next run to re-spend that credit. These tests pin down the
bounded retry behavior so a future refactor can't silently re-introduce
the regression.

HTTPError (4xx/5xx) must NOT be retried — a response came back, the
provider may have charged, and a retry could double-charge.
"""
from __future__ import annotations

import io
import json
import urllib.error
import urllib.request

import pytest

from designer import meshy as meshy_mod
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
