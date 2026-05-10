"""Behavior coverage for the _retry_request helper.

The helper is copy-pasted into every LLM worker — this single test suite is
the source of truth for its retry semantics. Other worker agent.py files
reference this file in a comment near their own _retry_request copy.
"""
import io
import json
import urllib.error
import urllib.request


class _FakeResp:
    """Minimal context-manager that mimics urlopen()'s response object."""
    def __init__(self, body: str):
        self._body = body.encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._body


def _ok_body() -> str:
    return json.dumps({
        "content": [{"type": "text", "text": json.dumps({
            "niche": "test niche",
            "keywords": ["a"] * 10,
            "price_band_usd": [3, 8],
            "competition": "low",
            "rationale": "testing",
        })}],
        "usage": {"input_tokens": 1, "output_tokens": 1},
    })


def test_retry_request_recovers_after_two_503s(monkeypatch):
    """503 twice, then 200 — _retry_request should swallow the failures
    and return the third response body. No real sleep should leak through;
    we monkey-patch time.sleep to a no-op so the test runs instantly."""
    from research.agent import _retry_request

    calls = {"n": 0}

    def _flaky_urlopen(req, timeout=60):
        calls["n"] += 1
        if calls["n"] < 3:
            # urlopen raises HTTPError(code, ...); construct a 503.
            raise urllib.error.HTTPError(
                "https://api.anthropic.com/v1/messages",
                503,
                "Service Unavailable",
                {},
                io.BytesIO(b""),
            )
        return _FakeResp(_ok_body())

    monkeypatch.setattr(urllib.request, "urlopen", _flaky_urlopen)
    # Skip real backoff sleeps in the test.
    import time as _t
    monkeypatch.setattr(_t, "sleep", lambda *_a, **_k: None)

    req = urllib.request.Request("https://api.anthropic.com/v1/messages")
    raw = _retry_request(req, timeout=60)
    parsed = json.loads(raw)
    assert parsed["usage"]["input_tokens"] == 1
    assert calls["n"] == 3, "should have retried twice and succeeded on the third try"


def test_retry_request_does_not_retry_on_4xx(monkeypatch):
    """A 400 must propagate immediately — 4xx is persistent and must NOT be retried."""
    from research.agent import _retry_request

    calls = {"n": 0}

    def _bad_request(req, timeout=60):
        calls["n"] += 1
        raise urllib.error.HTTPError(
            "https://api.anthropic.com/v1/messages",
            400,
            "Bad Request",
            {},
            io.BytesIO(b""),
        )

    monkeypatch.setattr(urllib.request, "urlopen", _bad_request)
    import time as _t
    monkeypatch.setattr(_t, "sleep", lambda *_a, **_k: None)

    req = urllib.request.Request("https://api.anthropic.com/v1/messages")
    try:
        _retry_request(req, timeout=60)
    except urllib.error.HTTPError as e:
        assert e.code == 400
    else:
        raise AssertionError("expected HTTPError(400) to propagate")
    assert calls["n"] == 1, "must call urlopen exactly once for a 4xx"
