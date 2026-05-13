"""Tests for the direct Google AI Studio image client (gemini_image.py).

The module is a drop-in replacement for the higgsfield-CLI path in
nanobanana.py — same signature, same on-disk artifact at
{assets_dir}/{job_id}-ref.png. These tests pin the HTTP shape and the
graceful-degradation contract (raises GeminiImageError on any wire
failure, never crashes silently).
"""
import base64
import json
import os
from unittest.mock import patch

import pytest

from designer import gemini_image
from designer.gemini_image import (
    GeminiImageError,
    _extract_image_bytes,
    generate_reference_image,
    is_configured,
)


def _png_bytes() -> bytes:
    """8-byte PNG signature is enough for the tests to confirm the file
    landed — we're not validating it's a real image, just that bytes
    flowed end-to-end."""
    return b"\x89PNG\r\n\x1a\n"


def _gemini_response_with_image(png: bytes) -> bytes:
    body = {
        "candidates": [{
            "content": {
                "parts": [
                    {"text": "Here is your render."},
                    {"inline_data": {
                        "mime_type": "image/png",
                        "data": base64.b64encode(png).decode("ascii"),
                    }},
                ],
            },
        }],
    }
    return json.dumps(body).encode("utf-8")


class _FakeResp:
    def __init__(self, payload: bytes):
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def read(self):
        return self._payload


def _fake_urlopen(payload: bytes, captured: list | None = None):
    def _open(req, *a, **kw):
        if captured is not None:
            captured.append(req)
        return _FakeResp(payload)
    return _open


def _clear_key_vars(monkeypatch):
    for name in (
        "GEMINI_IMAGE_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)


def test_is_configured_reads_env(monkeypatch):
    _clear_key_vars(monkeypatch)
    assert is_configured() is False
    monkeypatch.setenv("GEMINI_IMAGE_API_KEY", "ga-test-123")
    assert is_configured() is True
    # Whitespace-only counts as unset — operators leave a blank field by
    # accident; we shouldn't claim to be configured.
    monkeypatch.setenv("GEMINI_IMAGE_API_KEY", "   ")
    assert is_configured() is False


def test_is_configured_accepts_legacy_env_names(monkeypatch):
    """Operators paste into whatever 'Google API Key' field they find
    first. We honor the canonical aliases so a stray paste into
    GOOGLE_API_KEY (the older field) still wires the new pipeline."""
    for env_name in (
        "GEMINI_IMAGE_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
    ):
        _clear_key_vars(monkeypatch)
        monkeypatch.setenv(env_name, "ga-test-123")
        assert is_configured() is True, (
            f"key set as {env_name!r} should configure gemini_image"
        )


def test_generate_raises_when_key_missing(tmp_path, monkeypatch):
    _clear_key_vars(monkeypatch)
    with pytest.raises(GeminiImageError) as exc:
        generate_reference_image(
            None, "a tiny ceramic mug",
            job_id=1, assets_dir=str(tmp_path),
        )
    # Error must point the operator at the canonical place to put the key.
    assert "aistudio.google.com/apikey" in str(exc.value)


def test_generate_happy_path_writes_png(tmp_path, monkeypatch):
    monkeypatch.setenv("GEMINI_IMAGE_API_KEY", "ga-test-123")
    payload = _gemini_response_with_image(_png_bytes())
    captured: list = []
    with patch(
        "urllib.request.urlopen",
        side_effect=_fake_urlopen(payload, captured),
    ):
        path, backend_model = generate_reference_image(
            None, "single ceramic mug, studio shot",
            job_id=42, assets_dir=str(tmp_path),
        )
    assert path == str(tmp_path / "42-ref.png")
    # Backend model is reported back so the supervisor can stamp the
    # right ledger model on the budget row.
    assert backend_model == "gemini-3.1-flash-image-preview"
    assert os.path.exists(path)
    with open(path, "rb") as f:
        assert f.read() == _png_bytes()
    # Request was a POST to the expected model endpoint with the API key
    # header — guards against silent endpoint drift.
    assert len(captured) == 1
    req = captured[0]
    assert req.method == "POST"
    assert "gemini-3.1-flash-image-preview" in req.full_url
    assert req.get_header("X-goog-api-key") == "ga-test-123"


def test_generate_passes_aspect_ratio_in_prompt(tmp_path, monkeypatch):
    """Aspect-ratio is requested in the prompt text (not the structured
    config) because Gemini's image config fields are in flux across
    previews. The prompt path always works."""
    monkeypatch.setenv("GEMINI_IMAGE_API_KEY", "ga-test-123")
    payload = _gemini_response_with_image(_png_bytes())
    captured: list = []
    with patch(
        "urllib.request.urlopen",
        side_effect=_fake_urlopen(payload, captured),
    ):
        generate_reference_image(
            None, "test subject",
            job_id=7, assets_dir=str(tmp_path),
            aspect_ratio="3:4",
        )
    body = json.loads(captured[0].data.decode("utf-8"))
    sent_text = body["contents"][0]["parts"][0]["text"]
    assert "3:4" in sent_text


def test_extract_image_handles_both_field_cases():
    """Gemini preview responses have been seen with both `inline_data`
    (snake_case, per the REST spec) and `inlineData` (camelCase, some
    preview builds). The extractor accepts both."""
    snake = {
        "candidates": [{"content": {"parts": [
            {"inline_data": {
                "data": base64.b64encode(b"snake").decode("ascii"),
            }},
        ]}}],
    }
    camel = {
        "candidates": [{"content": {"parts": [
            {"inlineData": {
                "data": base64.b64encode(b"camel").decode("ascii"),
            }},
        ]}}],
    }
    assert _extract_image_bytes(snake) == b"snake"
    assert _extract_image_bytes(camel) == b"camel"


def test_extract_image_raises_when_no_image_part():
    """Safety-filter rejections come back as text-only responses. The
    extractor must raise GeminiImageError with a short preview of the
    response so operators see WHY the render didn't happen."""
    text_only = {
        "candidates": [{"content": {"parts": [
            {"text": "I can't generate that."},
        ]}}],
    }
    with pytest.raises(GeminiImageError) as exc:
        _extract_image_bytes(text_only)
    assert "no image part" in str(exc.value)


def test_http_error_surfaces_as_gemini_error(tmp_path, monkeypatch):
    """A 4xx/5xx must be wrapped in GeminiImageError so the designer's
    soft-fallback to text-to-3D handles it identically to other backend
    failures — never crashes the cycle."""
    import urllib.error
    monkeypatch.setenv("GEMINI_IMAGE_API_KEY", "ga-test-123")

    class _ReadableHTTPError(urllib.error.HTTPError):
        def __init__(self):
            super().__init__(
                "https://example/", 429, "Too Many Requests", {}, None,
            )

        def read(self):
            return b'{"error":{"message":"rate limit exceeded"}}'

    def _raise(*_a, **_kw):
        raise _ReadableHTTPError()

    with patch("urllib.request.urlopen", side_effect=_raise):
        with pytest.raises(GeminiImageError) as exc:
            generate_reference_image(
                None, "test", job_id=9, assets_dir=str(tmp_path),
            )
    assert "429" in str(exc.value)


def test_nanobanana_dispatches_to_gemini_when_key_set(tmp_path, monkeypatch):
    """nanobanana.is_configured() and generate_reference_image() must
    both prefer the direct Gemini path when GEMINI_IMAGE_API_KEY is
    present, without requiring the higgsfield CLI."""
    from designer import nanobanana
    monkeypatch.setenv("GEMINI_IMAGE_API_KEY", "ga-test-123")
    # Pretend the CLI is missing so the only viable path is Gemini.
    monkeypatch.setattr(nanobanana, "_cli_available", lambda: False)
    monkeypatch.setattr(nanobanana, "_auth_ok", lambda: False)

    assert nanobanana.is_configured() is True

    payload = _gemini_response_with_image(_png_bytes())
    with patch(
        "urllib.request.urlopen",
        side_effect=_fake_urlopen(payload),
    ):
        path, backend_model = nanobanana.generate_reference_image(
            None, "test subject",
            job_id=99, assets_dir=str(tmp_path),
        )
    assert path == str(tmp_path / "99-ref.png")
    assert backend_model == "gemini-3.1-flash-image-preview"
    assert os.path.exists(path)
