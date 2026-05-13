"""Pinterest pin generator tests.

Module-level tests use Pillow to build a tiny source PNG, run the pin
renderer, and confirm the output dimensions / file existence / content
sanity. End-to-end tests run handle() with a real on-disk source so the
audit record + handoff carry pinterest_pin_path through.
"""
from __future__ import annotations

import json
import os
import tempfile

from PIL import Image

from publisher import pinterest_pin
from publisher.agent import handle


def _write_source_png(path: str, color=(40, 120, 200)) -> None:
    """Build a 512×512 solid-color source PNG."""
    img = Image.new("RGB", (512, 512), color)
    img.save(path, "PNG")


def test_generate_pin_writes_2x3_image(tmp_path):
    src = str(tmp_path / "src.png")
    _write_source_png(src)
    out = str(tmp_path / "pin.png")
    result = pinterest_pin.generate_pin(src, "Egyptian Altar Trio STL", out)
    assert result == out
    assert os.path.exists(out)
    img = Image.open(out).convert("RGB")
    assert img.size == (pinterest_pin.PIN_WIDTH, pinterest_pin.PIN_HEIGHT)
    assert img.size == (1000, 1500)


def test_generate_pin_handles_missing_source(tmp_path):
    """No source → no pin (best-effort): returns None and does NOT raise."""
    out = str(tmp_path / "pin.png")
    result = pinterest_pin.generate_pin(
        str(tmp_path / "nonexistent.png"),
        "anything",
        out,
    )
    assert result is None
    assert not os.path.exists(out)


def test_generate_pin_includes_title_overlay(tmp_path):
    """Title band sits at bottom 1/4. Sanity check: the bottom 300 rows have
    significantly more dark pixels than the top half (band is semi-opaque
    dark slab). Confirms the band rendered without being too font-dependent."""
    src = str(tmp_path / "src.png")
    _write_source_png(src, color=(245, 245, 245))  # light source
    out = str(tmp_path / "pin.png")
    pinterest_pin.generate_pin(src, "Test Title For Pin", out)

    img = Image.open(out).convert("RGB")
    pixels = img.load()
    top_dark = 0
    bot_dark = 0
    for y in range(50, 200):  # top quadrant sample
        for x in range(0, 1000, 4):
            r, g, b = pixels[x, y]
            if r + g + b < 200:
                top_dark += 1
    for y in range(1200, 1450):  # bottom band sample
        for x in range(0, 1000, 4):
            r, g, b = pixels[x, y]
            if r + g + b < 200:
                bot_dark += 1
    # The band makes the bottom WAY darker than the top.
    assert bot_dark > top_dark * 3


def test_derive_pin_path_is_deterministic(tmp_path):
    p1 = pinterest_pin.derive_pin_path("/x/asset.stl", 42, str(tmp_path))
    p2 = pinterest_pin.derive_pin_path("/y/different.stl", 42, str(tmp_path))
    # Path is per-job-id, not per-asset — same job always gets the same pin.
    assert p1 == p2
    assert p1.endswith("42_pinterest.png")
    assert "assets" in p1


def test_pin_long_title_wraps_to_multiple_lines(tmp_path):
    """Long titles get word-wrapped to ≤4 lines so they fit the band."""
    src = str(tmp_path / "src.png")
    _write_source_png(src)
    out = str(tmp_path / "pin.png")
    long_title = (
        "Egyptian Altar Bust Trio STL | Anubis Bastet Ra | 28mm Tabletop "
        "Mini 3D Print Lovecraftian Cosmic Horror Bundle"
    )
    result = pinterest_pin.generate_pin(src, long_title, out)
    assert result == out
    # File exists and is non-trivial — wrap logic didn't crash on the long
    # string.
    assert os.path.getsize(out) > 5000


# --- handle() integration ----------------------------------------------------


def _payload_with_preview(preview_path: str, asset_path: str = "/tmp/x.stl") -> dict:
    return {
        "listing": {
            "title": "Dragon Mini STL | Fantasy 3D Print | 28mm Tabletop",
            "description": "A printable dragon",
            "price_usd": 6.99,
            "tags": ["stl", "dragon"],
        },
        "asset": {
            "asset_path": asset_path,
            "preview_png": preview_path,
            "preview_pngs": [preview_path],
        },
        "brief": {"niche": "dragon mini", "product_type": "stl_file"},
    }


def test_handle_generates_pin_when_preview_present(tmp_path, monkeypatch):
    """End-to-end: publisher.handle() with a real preview PNG on disk →
    pin gets written to the assets dir + path threaded through result +
    audit record."""
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.delenv("PINTEREST_PIN_ENABLED", raising=False)
    src = str(tmp_path / "preview.png")
    _write_source_png(src)

    result = handle("process_job", {
        "job_id": 99,
        "payload": _payload_with_preview(src),
    })
    assert result["ok"] is True
    pin = result["pinterest_pin_path"]
    assert pin is not None
    assert os.path.exists(pin)
    assert pin.endswith("99_pinterest.png")

    # Audit record carries it too.
    with open(tmp_path / "publisher_output.json") as f:
        records = json.load(f)
    assert records[-1]["pinterest_pin_path"] == pin


def test_handle_skips_pin_when_no_preview(tmp_path, monkeypatch):
    """No preview_png on the asset → no pin gets generated. publisher
    still ships the listing — pin is a nice-to-have, not required."""
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    result = handle("process_job", {
        "job_id": 100,
        "payload": {
            "listing": {"title": "No Preview", "price_usd": 5, "tags": []},
            "asset": {"asset_path": "/tmp/nope.stl"},
        },
    })
    assert result["ok"] is True
    assert result["pinterest_pin_path"] is None


def test_handle_skips_pin_when_disabled(tmp_path, monkeypatch):
    """PINTEREST_PIN_ENABLED=0 → never call the renderer even with a valid
    preview. Operator escape hatch."""
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("PINTEREST_PIN_ENABLED", "0")
    src = str(tmp_path / "preview.png")
    _write_source_png(src)
    result = handle("process_job", {
        "job_id": 101,
        "payload": _payload_with_preview(src),
    })
    assert result["ok"] is True
    assert result["pinterest_pin_path"] is None


def test_handle_uses_first_existing_preview_png(tmp_path, monkeypatch):
    """preview_pngs may list paths that don't exist anymore (mid-cycle file
    cleanup, race conditions). Generator must pick the FIRST extant file
    instead of crashing on the missing one."""
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    real_preview = str(tmp_path / "real.png")
    _write_source_png(real_preview)
    payload = {
        "listing": {
            "title": "Pick First Real Preview",
            "description": "x",
            "price_usd": 6.0,
            "tags": [],
        },
        "asset": {
            "asset_path": "/tmp/x.stl",
            "preview_pngs": [
                str(tmp_path / "missing1.png"),
                str(tmp_path / "missing2.png"),
                real_preview,
            ],
        },
    }
    result = handle("process_job", {"job_id": 102, "payload": payload})
    assert result["ok"] is True
    assert result["pinterest_pin_path"] is not None
    assert os.path.exists(result["pinterest_pin_path"])
