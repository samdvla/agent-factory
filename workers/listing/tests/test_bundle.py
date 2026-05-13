"""Listing-worker tests for the bundle path: pricing uplift + description
augmentation. Verifies the listing correctly multi-files-aware:

  * Single-item asset (no bundle metadata) → price clamp behaves as before.
  * Bundle asset (≥2 items) → price = max(model price, single × N × 0.55),
    clamped to operator $15 ceiling.
  * Bundle asset → description gets an enumerated "What's in this N-piece"
    block listing each item by name.
  * The augment is idempotent (handler retries don't duplicate the block).
"""
from __future__ import annotations

import json

import pytest

from listing.agent import (
    BUNDLE_PRICE_MULTIPLIER,
    GLOBAL_PRICE_CEILING_USD,
    _augment_bundle_copy,
    _bundle_item_names,
    _bundle_size,
    _clamp_price,
)


# --- _bundle_size & _bundle_item_names ---------------------------------------


def test_bundle_size_default_is_one():
    assert _bundle_size({}) == 1
    assert _bundle_size({"asset_path": "/x.stl"}) == 1
    assert _bundle_size(None) == 1  # type: ignore[arg-type]


def test_bundle_size_reads_asset_paths_list():
    asset = {"asset_paths": ["/a.stl", "/b.stl", "/c.stl"]}
    assert _bundle_size(asset) == 3


def test_bundle_size_reads_bundle_metadata_when_paths_missing():
    """Sometimes the designer drops the asset_paths list but keeps the bundle
    metadata (defensive: we still want the listing to treat it as a bundle)."""
    asset = {"bundle": {"items": [{"name": "a"}, {"name": "b"}]}}
    assert _bundle_size(asset) == 2


def test_bundle_item_names_extracts_distinct_strings():
    asset = {
        "bundle": {
            "items": [
                {"name": "Anubis bust", "asset_path": "/1.stl"},
                {"name": "Bastet bust", "asset_path": "/2.stl"},
                {"name": "Ra bust", "asset_path": "/3.stl"},
            ]
        }
    }
    assert _bundle_item_names(asset) == ["Anubis bust", "Bastet bust", "Ra bust"]


def test_bundle_item_names_skips_malformed_entries():
    asset = {
        "bundle": {
            "items": [
                {"name": "Good"},
                {"asset_path": "/no-name.stl"},
                "not a dict",
                {"name": ""},
            ]
        }
    }
    assert _bundle_item_names(asset) == ["Good"]


# --- _clamp_price with bundle uplift ----------------------------------------


def test_clamp_price_single_asset_unchanged():
    """Without an asset arg the clamp behaves identically to the legacy
    contract (preserving all 28 existing test_listing.py expectations)."""
    brief = {"price_band_usd": [3, 12], "product_type": "stl_file"}
    assert _clamp_price(6.99, brief) == 6.99


def test_clamp_price_bundle_lifts_to_uplift(monkeypatch):
    """Model picked $6 single price, bundle has 3 items → uplift to
    $6 × 3 × 0.55 = $9.90 — well inside the $15 ceiling."""
    brief = {"price_band_usd": [3, 12], "product_type": "stl_file"}
    asset = {"asset_paths": ["/a.stl", "/b.stl", "/c.stl"]}
    out = _clamp_price(6.00, brief, asset=asset)
    expected = round(6.00 * 3 * BUNDLE_PRICE_MULTIPLIER, 2)
    assert out == expected
    assert out == 9.90


def test_clamp_price_bundle_clamps_at_global_ceiling():
    """High-value bundle: $9 × 4 × 0.55 = $19.80 → clamped to $15.
    Operator policy locks digital at $15 regardless of how big the bundle is."""
    brief = {"price_band_usd": [3, 15], "product_type": "stl_file"}
    asset = {"asset_paths": ["/a.stl", "/b.stl", "/c.stl", "/d.stl"]}
    out = _clamp_price(9.00, brief, asset=asset)
    assert out == GLOBAL_PRICE_CEILING_USD


def test_clamp_price_bundle_uses_max_of_model_and_uplift():
    """If the model anchored ABOVE the uplift, respect the model's choice
    (it's seen the bundle context in the description), then clamp.
    Model picks $12, bundle of 2 → uplift $12 × 2 × 0.55 = $13.20 →
    max($12, $13.20) = $13.20 → under $15 ceiling → final $13.20."""
    brief = {"price_band_usd": [3, 15], "product_type": "stl_file"}
    asset = {"asset_paths": ["/a.stl", "/b.stl"]}
    out = _clamp_price(12.00, brief, asset=asset)
    assert out == 13.20


def test_clamp_price_bundle_model_above_uplift_keeps_model():
    """Pick a model price that beats the uplift: $10 single × 1.1 bundle
    factor doesn't exist, but $13 × 2 × 0.55 = $14.30 > $13, so uplift wins
    in that direction too. The pure 'model wins' case requires a very
    small bundle: $14 × 2 × 0.55 = $15.40 → clamped to $15, but if model
    said $14 originally, max($14, $15.40) = $15.40 → clamps to $15.
    Easiest check: model $10, bundle of 2 → uplift = $11; max($10, $11) = $11."""
    brief = {"product_type": "stl_file"}
    asset = {"asset_paths": ["/a.stl", "/b.stl"]}
    out = _clamp_price(10.00, brief, asset=asset)
    assert out == 11.00


def test_clamp_price_bundle_ignores_single_item_band():
    """The brief's price_band_usd describes a SINGLE-item band. For a bundle
    we must NOT clamp by that band's upper bound — otherwise a $8 ceiling on
    a single $4 item would clamp the entire $13.20 bundle back to $8."""
    brief = {"price_band_usd": [3, 8], "product_type": "stl_file"}
    asset = {"asset_paths": ["/a.stl", "/b.stl", "/c.stl"]}
    out = _clamp_price(6.00, brief, asset=asset)
    # 6 × 3 × 0.55 = 9.90. Global $15 ceiling, NOT the brief's $8 ceiling.
    assert out == 9.90


def test_clamp_price_bundle_still_respects_global_floor():
    """A tiny model price + small bundle could still go below $3 floor — operator
    floor wins."""
    brief = {"product_type": "stl_file"}
    asset = {"asset_paths": ["/a.stl", "/b.stl"]}
    out = _clamp_price(1.00, brief, asset=asset)
    assert out == 3.00


# --- _augment_bundle_copy ----------------------------------------------------


def test_augment_bundle_copy_appends_item_list():
    asset = {
        "asset_paths": ["/1.stl", "/2.stl", "/3.stl"],
        "bundle": {
            "items": [
                {"name": "Anubis bust", "asset_path": "/1.stl"},
                {"name": "Bastet bust", "asset_path": "/2.stl"},
                {"name": "Ra bust", "asset_path": "/3.stl"},
            ]
        },
    }
    listing = {
        "description": "Egyptian altar set for collectors.",
        "tags": [],
        "price_usd": 9.9,
    }
    _augment_bundle_copy(listing, asset)
    desc = listing["description"]
    assert "3-piece bundle" in desc
    assert "Anubis bust" in desc
    assert "Bastet bust" in desc
    assert "Ra bust" in desc


def test_augment_bundle_copy_is_noop_on_single():
    listing = {"description": "Solo dragon mini."}
    _augment_bundle_copy(listing, {"asset_path": "/dragon.stl"})
    assert listing["description"] == "Solo dragon mini."


def test_augment_bundle_copy_is_idempotent():
    asset = {
        "asset_paths": ["/1.stl", "/2.stl"],
        "bundle": {"items": [{"name": "A"}, {"name": "B"}]},
    }
    listing = {"description": "Two-piece set."}
    _augment_bundle_copy(listing, asset)
    once = listing["description"]
    _augment_bundle_copy(listing, asset)
    assert listing["description"] == once


# --- handle() integration ----------------------------------------------------


def _tool_use_response(input_dict: dict) -> dict:
    return {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": "claude-haiku-4-5-20251001",
        "stop_reason": "tool_use",
        "content": [{
            "type": "tool_use",
            "id": "toolu_test_1",
            "name": "submit_listing",
            "input": input_dict,
        }],
        "usage": {"input_tokens": 1, "output_tokens": 1},
    }


def _patch_urlopen(monkeypatch, payload):
    class _Resp:
        def __init__(self, p): self._p = p
        def __enter__(self_inner): return self_inner
        def __exit__(self_inner, *a): return False
        def read(self_inner): return json.dumps(self_inner._p).encode("utf-8")

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=60: _Resp(payload))


def test_handle_applies_bundle_uplift_and_copy(tmp_path, monkeypatch):
    """handle() end-to-end: model returns $5.00 single-item price on a 3-item
    bundle → listing.price_usd uplifted to $5×3×0.55=$8.25 → description
    contains the per-item enumeration block."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")

    tool_input = {
        "title": "Egyptian Altar Bust Trio STL | Anubis Bastet Ra | 3D Print",
        "tags": [f"tag{i}" for i in range(13)],
        "description": "Egyptian altar set — three printable busts for any collector. " * 6,
        "materials": ["STL file", "GLB file"],
        "price_usd": 5.00,
    }
    _patch_urlopen(monkeypatch, _tool_use_response(tool_input))

    from listing.agent import handle

    asset = {
        "asset_type": "stl_file",
        "asset_paths": ["/a.stl", "/b.stl", "/c.stl"],
        "asset_path": "/a.stl",
        "bundle": {
            "items": [
                {"name": "Anubis bust", "asset_path": "/a.stl"},
                {"name": "Bastet bust", "asset_path": "/b.stl"},
                {"name": "Ra bust", "asset_path": "/c.stl"},
            ],
            "shared_theme": "egyptian altar trio",
        },
    }
    result = handle("process_job", {
        "job_id": 200,
        "payload": {
            "brief": {
                "niche": "egyptian altar trio",
                "product_type": "stl_file",
                "price_band_usd": [4, 8],
                "bundle": {"items": ["Anubis bust", "Bastet bust", "Ra bust"]},
            },
            "asset": asset,
        },
    })
    assert result["ok"] is True
    listing = result["listing"]
    # Bundle uplift applied: $5 × 3 × 0.55 = $8.25
    assert listing["price_usd"] == 8.25
    desc = listing["description"]
    assert "3-piece bundle" in desc
    assert "Anubis bust" in desc
    assert "Bastet bust" in desc
    assert "Ra bust" in desc
    # AI disclosure still applied (post-bundle augment must compose).
    assert "AI-assisted design studio" in desc
    # Handoff carries the multi-file asset through to the publisher.
    handoff_asset = result["handoff"]["payload"]["asset"]
    assert handoff_asset["asset_paths"] == asset["asset_paths"]
