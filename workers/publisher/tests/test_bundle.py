"""Publisher tests for bundle threading. The publisher itself doesn't make
upload calls — the Rust supervisor does — so these tests assert the SHAPE
of the data we hand to the supervisor + cfo. If asset_paths/bundle_size
shows up correctly here, the supervisor's multi-file upload path can fan
out the bundle to Etsy + Cults3D.
"""
from __future__ import annotations

import json
import os
import tempfile

from publisher.agent import handle


def _bundle_payload():
    return {
        "listing": {
            "title": "Egyptian Altar Trio STL | Anubis Bastet Ra | 3D Print",
            "description": "Three printable busts.",
            "price_usd": 13.20,
            "tags": ["stl", "egyptian", "altar"],
        },
        "asset": {
            "asset_type": "stl_file",
            "asset_path": "/tmp/a.stl",
            "asset_paths": ["/tmp/a.stl", "/tmp/b.stl", "/tmp/c.stl"],
            "glb_paths": ["/tmp/a.glb", "/tmp/b.glb", "/tmp/c.glb"],
            "preview_pngs": ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"],
            "bundle": {
                "items": [
                    {"name": "Anubis bust", "asset_path": "/tmp/a.stl"},
                    {"name": "Bastet bust", "asset_path": "/tmp/b.stl"},
                    {"name": "Ra bust", "asset_path": "/tmp/c.stl"},
                ],
                "shared_theme": "egyptian altar trio",
            },
        },
        "brief": {
            "niche": "egyptian altar trio",
            "product_type": "stl_file",
        },
    }


def test_bundle_asset_paths_thread_to_result():
    """Multi-file asset → result.asset_paths has all 3 entries + bundle_size=3."""
    with tempfile.TemporaryDirectory() as tmpdir:
        os.environ["AGENT_FACTORY_DATA"] = tmpdir
        result = handle("process_job", {"job_id": 1, "payload": _bundle_payload()})
        assert result["ok"] is True
        assert result["asset_paths"] == ["/tmp/a.stl", "/tmp/b.stl", "/tmp/c.stl"]
        assert result["bundle_size"] == 3
        # Back-compat asset_path is the first item (Rust supervisor still
        # reads it for single-file uploads on non-bundle listings).
        assert result["asset_path"] == "/tmp/a.stl"
        # Bundle metadata surfaced for supervisor templates.
        assert result["bundle"]["shared_theme"] == "egyptian altar trio"
        assert len(result["bundle"]["items"]) == 3


def test_bundle_threads_to_cfo_handoff():
    """Cfo needs bundle_size to count revenue correctly per file in COGS."""
    with tempfile.TemporaryDirectory() as tmpdir:
        os.environ["AGENT_FACTORY_DATA"] = tmpdir
        result = handle("process_job", {"job_id": 2, "payload": _bundle_payload()})
        cfo = result["handoff"]["payload"]
        assert cfo["asset_paths"] == ["/tmp/a.stl", "/tmp/b.stl", "/tmp/c.stl"]
        assert cfo["bundle_size"] == 3
        assert cfo["bundle"]["shared_theme"] == "egyptian altar trio"


def test_bundle_audit_record_includes_paths_and_size():
    """publisher_output.json must record asset_paths so the operator UI can
    show 'Bundle of 3' on every published listing without re-parsing the
    cfo payload."""
    with tempfile.TemporaryDirectory() as tmpdir:
        os.environ["AGENT_FACTORY_DATA"] = tmpdir
        handle("process_job", {"job_id": 3, "payload": _bundle_payload()})
        with open(os.path.join(tmpdir, "publisher_output.json")) as f:
            records = json.load(f)
        assert len(records) == 1
        rec = records[0]
        assert rec["asset_paths"] == ["/tmp/a.stl", "/tmp/b.stl", "/tmp/c.stl"]
        assert rec["bundle_size"] == 3


def test_single_listing_back_compat():
    """A single-file asset (no asset_paths, no bundle) must produce
    asset_paths=[primary], bundle_size=1. Locks the back-compat contract for
    every non-bundle listing — these still vastly outnumber bundles."""
    with tempfile.TemporaryDirectory() as tmpdir:
        os.environ["AGENT_FACTORY_DATA"] = tmpdir
        result = handle("process_job", {
            "job_id": 4,
            "payload": {
                "listing": {
                    "title": "Solo Dragon Mini STL",
                    "description": "single dragon",
                    "price_usd": 6.99,
                    "tags": ["stl"],
                },
                "asset": {
                    "asset_path": "/tmp/solo.stl",
                    "asset_type": "stl_file",
                },
                "brief": {"niche": "dragon mini", "product_type": "stl_file"},
            },
        })
        assert result["ok"] is True
        assert result["bundle_size"] == 1
        # asset_paths normalized to [single_path] so the supervisor can
        # always iterate without a None-check.
        assert result["asset_paths"] == ["/tmp/solo.stl"]
        # No bundle metadata to leak.
        assert "bundle" not in result


def test_ticker_text_mentions_bundle():
    """Operator UI ticker shows '(bundle of N)' so the live log makes the
    bundle path visible without drilling into the payload."""
    with tempfile.TemporaryDirectory() as tmpdir:
        os.environ["AGENT_FACTORY_DATA"] = tmpdir
        result = handle("process_job", {"job_id": 5, "payload": _bundle_payload()})
        assert "bundle of 3" in result["ticker_text"]


def test_ticker_text_omits_bundle_for_singles():
    """Single listings keep the legacy ticker text exactly."""
    with tempfile.TemporaryDirectory() as tmpdir:
        os.environ["AGENT_FACTORY_DATA"] = tmpdir
        result = handle("process_job", {
            "job_id": 6,
            "payload": {
                "listing": {"title": "Solo", "price_usd": 5.0, "tags": []},
                "asset": {"asset_path": "/tmp/x.stl"},
            },
        })
        assert "bundle" not in result["ticker_text"].lower()
