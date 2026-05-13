"""End-to-end integration test: designer → listing → publisher.

Walks a real bundle brief through every worker boundary the way the
supervisor would, asserting that:
  • Designer generates N bundle items (mesh quality gate runs on each).
  • Listing applies the bundle uplift and enumerates items in description.
  • Publisher threads asset_paths + bundle metadata to cfo + writes the
    Pinterest pin + records everything in the audit JSON.

The test mocks only the EXTERNAL boundaries (Anthropic, Tripo/Meshy) — every
worker's own logic runs for real.

This test lives in the designer venv because that's the only one with
trimesh AND Pillow available simultaneously. Listing/publisher modules are
imported via sys.path injection.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request

import pytest

# Inject the listing + publisher modules onto sys.path. Each worker is its
# own package — agent.py + protocol.py + (publisher only) pinterest_pin.py.
_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
_LISTING_PKG_PARENT = os.path.join(_REPO_ROOT, "workers", "listing")
_PUBLISHER_PKG_PARENT = os.path.join(_REPO_ROOT, "workers", "publisher")
for p in (_LISTING_PKG_PARENT, _PUBLISHER_PKG_PARENT):
    if p not in sys.path:
        sys.path.insert(0, p)


def _resp(payload: dict):
    class _Resp:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *a):
            return False

        def read(self_inner):
            return json.dumps(payload).encode("utf-8")

    return _Resp()


def _haiku_3d_response():
    return _resp({
        "content": [{"type": "text", "text": json.dumps({
            "asset_type": "stl_file",
            "style": "stylized cartoon",
            "palette": ["#aaa"],
            "dimensions": "28mm tabletop",
            "mockup_count": 1,
            "brief_for_image_gen": "egyptian altar deity bust",
        })}],
        "usage": {"input_tokens": 60, "output_tokens": 100},
    })


def _listing_tool_response(price: float):
    return _resp({
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": "claude-sonnet-4-6",
        "stop_reason": "tool_use",
        "content": [{
            "type": "tool_use",
            "id": "toolu_int_e2e",
            "name": "submit_listing",
            "input": {
                "title": "Egyptian Altar Bust Trio STL | Anubis Bastet Ra | 28mm",
                "tags": [f"tag{i}" for i in range(13)],
                "description": "Egyptian altar set — three printable busts for any collector. " * 6,
                "materials": ["STL file", "GLB file", "digital download"],
                "price_usd": price,
            },
        }],
        "usage": {"input_tokens": 80, "output_tokens": 120},
    })


def _make_test_glb(path: str) -> None:
    """Build a small healthy GLB so the mesh quality gate has real geometry."""
    import trimesh  # type: ignore
    mesh = trimesh.creation.icosphere(subdivisions=2)  # watertight, vol > 0
    mesh.export(path)


def test_full_pipeline_bundle_listing(tmp_path, monkeypatch):
    """Drive a 3-item bundle through designer → listing → publisher and
    verify the FINAL result carries: bundle_size=3, asset_paths=[3 stls],
    pinterest_pin_path written, bundle uplift applied to price."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.delenv("MESHY_API_KEY", raising=False)
    monkeypatch.setenv("IMAGE_TO_3D_PROVIDER", "tripo")
    monkeypatch.setenv("BUNDLE_GENERATION_ENABLED", "1")
    monkeypatch.setenv("PINTEREST_PIN_ENABLED", "1")

    # ---- Mock Anthropic in a way that satisfies both designer + listing ----
    # Designer's call comes first (Haiku JSON), then listing's call (Sonnet
    # tool_use). We queue both — the urlopen mock walks the queue in order.
    queue = [
        _haiku_3d_response(),
        _listing_tool_response(price=5.00),
    ]
    qi = iter(queue)

    def fake_urlopen(req, timeout=60):
        try:
            return next(qi)
        except StopIteration:
            # Any extra calls (e.g. tool-retry) get the listing response again.
            return _listing_tool_response(price=5.00)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)

    # ---- Mock Tripo/Meshy so we don't hit real APIs ----
    # generate_3d writes a real GLB to disk so the mesh quality gate has real
    # geometry to validate.
    from designer import tripo as tripo_mod
    from designer import meshy as meshy_mod
    from designer import nanobanana as nano_mod
    from designer.agent import handle as designer_handle

    def fake_tripo_text(api_key, prompt, *, job_id, assets_dir, **kw):
        os.makedirs(assets_dir, exist_ok=True)
        glb = os.path.join(assets_dir, f"{job_id}.glb")
        stl = os.path.join(assets_dir, f"{job_id}.stl")
        png = os.path.join(assets_dir, f"{job_id}.png")
        _make_test_glb(glb)
        # Mesh quality gate normally converts glb→stl + validates; we'd
        # rather run that for real. Skip by pre-writing the stl as well.
        import trimesh  # type: ignore
        trimesh.load(glb, force="mesh").export(stl, file_type="stl")
        # Tiny PNG placeholder for the renderer / pin source.
        from PIL import Image  # type: ignore
        Image.new("RGB", (256, 256), (180, 90, 40)).save(png, "PNG")
        return glb, stl, png

    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)
    monkeypatch.setattr(meshy_mod, "generate_3d", fake_tripo_text)
    monkeypatch.setattr(nano_mod, "is_configured", lambda: False)

    # ---- 1. Designer ----
    bundle_items = ["Anubis bust", "Bastet bust", "Ra bust"]
    designer_result = designer_handle("process_job", {
        "job_id": 500,
        "payload": {
            "brief": {
                "niche": "egyptian altar trio",
                "product_type": "stl_file",
                "ip_risk": "mythology",
                "design_direction": "stylized cartoon altar deity bust, 28mm",
                "keywords": ["stl", "egyptian", "altar"],
                "price_band_usd": [4, 8],
                "bundle": {
                    "items": bundle_items,
                    "shared_theme": "egyptian altar trio",
                },
            },
        },
    })

    assert designer_result["ok"] is True
    asset = designer_result["asset"]
    assert len(asset["asset_paths"]) == 3, (
        f"designer should produce 3 bundle items, got "
        f"{asset.get('asset_paths')!r}"
    )
    # Every STL exists on disk and is non-empty (mesh quality gate touched
    # them).
    for p in asset["asset_paths"]:
        assert os.path.exists(p), f"missing asset {p}"
        assert os.path.getsize(p) > 0, f"empty asset {p}"
    handoff_to_listing = designer_result["handoff"]["payload"]
    assert handoff_to_listing["asset"]["asset_paths"] == asset["asset_paths"]

    # ---- 2. Listing ----
    from listing.agent import handle as listing_handle  # noqa: E402

    listing_result = listing_handle("process_job", {
        "job_id": 500,
        "payload": handoff_to_listing,
    })
    assert listing_result["ok"] is True, (
        f"listing failed: {listing_result.get('error')!r}"
    )
    listing = listing_result["listing"]
    # Bundle uplift: $5 × 3 × 0.55 = $8.25
    assert listing["price_usd"] == 8.25
    desc = listing["description"]
    # Every bundle item name appears in the description.
    for name in bundle_items:
        assert name in desc, f"item {name!r} missing from description"
    handoff_to_publisher = listing_result["handoff"]["payload"]

    # ---- 3. Publisher ----
    from publisher.agent import handle as publisher_handle  # noqa: E402

    publisher_result = publisher_handle("process_job", {
        "job_id": 500,
        "payload": handoff_to_publisher,
    })
    assert publisher_result["ok"] is True
    assert publisher_result["bundle_size"] == 3
    assert publisher_result["asset_paths"] == asset["asset_paths"]
    # Pinterest pin written to disk.
    pin_path = publisher_result["pinterest_pin_path"]
    assert pin_path is not None, (
        "expected pinterest_pin_path to be set with a real preview image present"
    )
    assert os.path.exists(pin_path)
    # The audit record persists everything.
    with open(tmp_path / "publisher_output.json") as f:
        records = json.load(f)
    final = records[-1]
    assert final["asset_paths"] == asset["asset_paths"]
    assert final["bundle_size"] == 3
    assert final["pinterest_pin_path"] == pin_path
    # CFO handoff includes the bundle.
    cfo_payload = publisher_result["handoff"]["payload"]
    assert cfo_payload["asset_paths"] == asset["asset_paths"]
    assert cfo_payload["bundle"]["shared_theme"] == "egyptian altar trio"


def test_full_pipeline_single_listing_back_compat(tmp_path, monkeypatch):
    """Same flow but with no bundle field on the brief → single-item path
    runs end-to-end. Locks the back-compat contract: every non-bundle
    listing must still pass through the new code unchanged."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.delenv("MESHY_API_KEY", raising=False)
    monkeypatch.setenv("BUNDLE_GENERATION_ENABLED", "1")
    monkeypatch.setenv("PINTEREST_PIN_ENABLED", "1")

    queue = [_haiku_3d_response(), _listing_tool_response(price=6.99)]
    qi = iter(queue)
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=60: next(qi))

    from designer import tripo as tripo_mod
    from designer import meshy as meshy_mod
    from designer import nanobanana as nano_mod
    from designer.agent import handle as designer_handle

    def fake_tripo_text(api_key, prompt, *, job_id, assets_dir, **kw):
        os.makedirs(assets_dir, exist_ok=True)
        glb = os.path.join(assets_dir, f"{job_id}.glb")
        stl = os.path.join(assets_dir, f"{job_id}.stl")
        png = os.path.join(assets_dir, f"{job_id}.png")
        _make_test_glb(glb)
        import trimesh  # type: ignore
        trimesh.load(glb, force="mesh").export(stl, file_type="stl")
        from PIL import Image  # type: ignore
        Image.new("RGB", (256, 256), (90, 140, 200)).save(png, "PNG")
        return glb, stl, png

    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)
    monkeypatch.setattr(meshy_mod, "generate_3d", fake_tripo_text)
    monkeypatch.setattr(nano_mod, "is_configured", lambda: False)

    designer_result = designer_handle("process_job", {
        "job_id": 600,
        "payload": {
            "brief": {
                "niche": "solo dragon mini",
                "product_type": "stl_file",
                "ip_risk": "none",
                "design_direction": "solo dragon mini",
                "keywords": ["dragon", "stl"],
                "price_band_usd": [4, 9],
                # NO bundle field
            },
        },
    })
    assert designer_result["ok"] is True
    asset = designer_result["asset"]
    # Single-item path: no asset_paths list or list of length 1.
    assert "asset_paths" not in asset or len(asset.get("asset_paths", [])) <= 1
    assert "bundle" not in asset or not asset.get("bundle")

    from listing.agent import handle as listing_handle  # noqa: E402
    listing_result = listing_handle(
        "process_job",
        {"job_id": 600, "payload": designer_result["handoff"]["payload"]},
    )
    assert listing_result["ok"] is True
    # No bundle uplift — model price comes through after the legacy clamp.
    assert listing_result["listing"]["price_usd"] == 6.99

    from publisher.agent import handle as publisher_handle  # noqa: E402
    publisher_result = publisher_handle(
        "process_job",
        {"job_id": 600, "payload": listing_result["handoff"]["payload"]},
    )
    assert publisher_result["ok"] is True
    assert publisher_result["bundle_size"] == 1
    assert "bundle" not in publisher_result
    assert publisher_result["pinterest_pin_path"] is not None


def test_full_pipeline_bundle_partial_failure(tmp_path, monkeypatch):
    """Designer hits 1 Tripo failure mid-bundle → bundle ships with 2 of 3
    items → listing prices the surviving pair → publisher records bundle
    of 2. Locks the resilience contract under partial provider failures."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.setenv("BUNDLE_GENERATION_ENABLED", "1")
    monkeypatch.setenv("PINTEREST_PIN_ENABLED", "1")

    queue = [_haiku_3d_response(), _listing_tool_response(price=6.00)]
    qi = iter(queue)
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=60: next(qi))

    from designer import tripo as tripo_mod
    from designer import meshy as meshy_mod
    from designer import nanobanana as nano_mod
    from designer.agent import handle as designer_handle

    call_n = {"n": 0}

    def fake_tripo_text(api_key, prompt, *, job_id, assets_dir, **kw):
        call_n["n"] += 1
        if call_n["n"] == 2:
            raise tripo_mod.TripoError("Tripo HTTP 500: transient server error")
        os.makedirs(assets_dir, exist_ok=True)
        glb = os.path.join(assets_dir, f"{job_id}.glb")
        stl = os.path.join(assets_dir, f"{job_id}.stl")
        png = os.path.join(assets_dir, f"{job_id}.png")
        _make_test_glb(glb)
        import trimesh  # type: ignore
        trimesh.load(glb, force="mesh").export(stl, file_type="stl")
        from PIL import Image  # type: ignore
        Image.new("RGB", (256, 256), (200, 100, 60)).save(png, "PNG")
        return glb, stl, png

    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)
    monkeypatch.setattr(meshy_mod, "generate_3d", fake_tripo_text)
    monkeypatch.setattr(nano_mod, "is_configured", lambda: False)

    designer_result = designer_handle("process_job", {
        "job_id": 700,
        "payload": {
            "brief": {
                "niche": "egyptian altar trio",
                "product_type": "stl_file",
                "design_direction": "stylized cartoon altar bust, 28mm",
                "keywords": ["stl"],
                "price_band_usd": [4, 8],
                "bundle": {
                    "items": ["Anubis", "Bastet", "Ra"],
                    "shared_theme": "egyptian altar",
                },
            },
        },
    })
    assert designer_result["ok"] is True
    asset = designer_result["asset"]
    # Bundle gracefully degraded from 3 → 2 items.
    assert len(asset["asset_paths"]) == 2

    from listing.agent import handle as listing_handle  # noqa: E402
    listing_result = listing_handle(
        "process_job",
        {"job_id": 700, "payload": designer_result["handoff"]["payload"]},
    )
    assert listing_result["ok"] is True
    # Bundle uplift: $6 × 2 × 0.55 = $6.60
    assert listing_result["listing"]["price_usd"] == pytest.approx(6.60, abs=0.01)

    from publisher.agent import handle as publisher_handle  # noqa: E402
    publisher_result = publisher_handle(
        "process_job",
        {"job_id": 700, "payload": listing_result["handoff"]["payload"]},
    )
    assert publisher_result["ok"] is True
    assert publisher_result["bundle_size"] == 2
    assert "bundle of 2" in publisher_result["ticker_text"]
