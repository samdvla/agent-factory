"""Listing-worker tests for the bundle path: fixed-tier pricing + description
augmentation. Verifies the listing correctly multi-files-aware:

  * Single-item asset (no bundle metadata) → flat single-model price.
  * Bundle asset (≥2 items) → fixed price from BUNDLE_PRICE_TABLE by count.
  * Bundle asset → description gets an enumerated "What's in this N-piece"
    block listing each item by name.
  * The augment is idempotent (handler retries don't duplicate the block).
"""
from __future__ import annotations

import json

import pytest

from listing.agent import (
    BUNDLE_PRICE_TABLE,
    SINGLE_PRICE_USD,
    _augment_bundle_copy,
    _bundle_item_names,
    _bundle_size,
    _fixed_price,
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


# --- _fixed_price tiers ------------------------------------------------------


def test_fixed_price_single_asset():
    """Single-item asset → flat single-model tier."""
    assert _fixed_price({"asset_path": "/x.stl"}) == SINGLE_PRICE_USD


def test_fixed_price_bundle_by_count():
    """Bundle price comes straight from the per-size table."""
    for n, expected in BUNDLE_PRICE_TABLE.items():
        asset = {"asset_paths": [f"/{i}.stl" for i in range(n)]}
        assert _fixed_price(asset) == expected


def test_fixed_price_five_bundle_is_12_99():
    asset = {"asset_paths": [f"/{i}.stl" for i in range(5)]}
    assert _fixed_price(asset) == 12.99


def test_fixed_price_out_of_range_bundle_falls_back_to_nearest():
    """Research caps bundles at 2-6, but a stray larger bundle must still
    price — fall back to the nearest defined tier (6 → $14.99)."""
    asset = {"asset_paths": [f"/{i}.stl" for i in range(9)]}
    assert _fixed_price(asset) == BUNDLE_PRICE_TABLE[6]


def test_fixed_price_ignores_brief_band():
    """Pricing is operator policy — the brief band must not affect it."""
    asset = {"asset_paths": ["/a.stl", "/b.stl", "/c.stl"]}
    assert _fixed_price(asset) == BUNDLE_PRICE_TABLE[3]


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


def test_handle_applies_bundle_price_and_copy(tmp_path, monkeypatch):
    """handle() end-to-end: model returns an arbitrary $5.00 price on a 3-item
    bundle → listing.price_usd is overwritten with the fixed 3-item tier
    ($7.99) → description contains the per-item enumeration block."""
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
    # Fixed 3-item bundle tier overrides the model's $5.00.
    assert listing["price_usd"] == 7.99
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
