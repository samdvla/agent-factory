"""End-to-end designer tests for the bundle generation path.

Mocks the same provider boundaries as test_designer.py (nanobanana,
tripo.generate_3d, meshy.generate_3d) so the tests run without any real
3D-gen credit. Covers:

  * Full bundle success: brief.bundle.items=[a, b, c] → 3 generations → 3
    asset_paths on the handoff.
  * Partial failure: 1 of 3 items fails → bundle still ships with 2 items.
  * Hard degrade: 2 of 3 items fail → degraded single (no asset_paths list).
  * Bundle disabled: BUNDLE_GENERATION_ENABLED=0 → single-item path.
  * Provider selection honours IMAGE_TO_3D_PROVIDER.
  * Bundle skipped when brief.bundle missing/None.
"""
from __future__ import annotations

import json
import urllib.request

from designer.agent import handle


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
            "palette": ["#888", "#aaa", "#ccc"],
            "dimensions": "28mm tabletop",
            "mockup_count": 1,
            "brief_for_image_gen": "egyptian altar deity bust",
        })}],
        "usage": {"input_tokens": 60, "output_tokens": 100},
    })


def _mock_urlopen_factory(responses):
    it = iter(responses)

    def _factory(req, timeout=None):
        return next(it)

    return _factory


def _bundle_brief(items, theme="egyptian altar trio"):
    return {
        "niche": "egyptian altar trio",
        "product_type": "stl_file",
        "ip_risk": "mythology",
        "design_direction": "stylized cartoon bust, hard-surface, 28mm",
        "keywords": ["stl", "egyptian", "altar"],
        "price_band_usd": [4, 12],
        "bundle": {"items": items, "shared_theme": theme},
    }


def test_bundle_three_items_all_succeed(tmp_path, monkeypatch):
    """Full bundle: 3 brief.bundle.items → 3 successful text-to-3D generations
    → asset.asset_paths has 3 entries, asset.bundle.items has 3 entries,
    listing handoff receives the multi-file asset."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.delenv("MESHY_API_KEY", raising=False)
    monkeypatch.setenv("IMAGE_TO_3D_PROVIDER", "tripo")
    monkeypatch.setenv("BUNDLE_GENERATION_ENABLED", "1")

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    calls = {"items": []}

    def fake_tripo_text(api_key, prompt, *, job_id, assets_dir, **kw):
        calls["items"].append({"job_id": job_id, "prompt": prompt})
        glb = str(tmp_path / f"{job_id}.glb")
        stl = str(tmp_path / f"{job_id}.stl")
        png = str(tmp_path / f"{job_id}.png")
        # Touch the files so any downstream code that stats them works.
        for p in (glb, stl, png):
            open(p, "wb").close()
        return glb, stl, png

    def fail_text_singleton(*a, **kw):
        raise AssertionError(
            "single-item text-to-3D must NOT run when bundle succeeds"
        )

    def fail_image_to_3d(*a, **kw):
        raise AssertionError(
            "image-to-3D must NOT run for bundle path (text-to-3D only)"
        )

    from designer import tripo as tripo_mod
    from designer import meshy as meshy_mod
    from designer import nanobanana as nano_mod

    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)
    monkeypatch.setattr(tripo_mod, "generate_3d_from_image", fail_image_to_3d)
    monkeypatch.setattr(meshy_mod, "generate_3d", fail_text_singleton)
    monkeypatch.setattr(meshy_mod, "generate_3d_from_image", fail_image_to_3d)
    monkeypatch.setattr(nano_mod, "is_configured", lambda: True)
    monkeypatch.setattr(nano_mod, "generate_reference_image", fail_image_to_3d)

    items = ["Anubis bust", "Bastet bust", "Ra bust"]
    result = handle("process_job", {
        "job_id": 50,
        "payload": {"brief": _bundle_brief(items)},
    })

    assert result["ok"] is True
    asset = result["asset"]
    # 3 generations ran, one per bundle item.
    assert len(calls["items"]) == 3
    # Sub-job ids are unique so files don't collide on disk.
    sub_ids = [c["job_id"] for c in calls["items"]]
    assert sub_ids == [5000, 5001, 5002]
    # Each prompt mentions the per-item name + the shared theme.
    for prompt, item in zip([c["prompt"] for c in calls["items"]], items):
        assert item in prompt
        assert "egyptian altar trio" in prompt
    # Multi-file plumbing.
    assert isinstance(asset.get("asset_paths"), list)
    assert len(asset["asset_paths"]) == 3
    assert all(p.endswith(".stl") for p in asset["asset_paths"])
    # Bundle metadata is preserved for the listing worker.
    assert isinstance(asset.get("bundle"), dict)
    assert len(asset["bundle"]["items"]) == 3
    assert {it["name"] for it in asset["bundle"]["items"]} == set(items)
    # Backward-compatible single fields point at the primary (first) item.
    assert asset["asset_path"] == asset["bundle"]["items"][0]["asset_path"]
    assert "bundle" in result["ticker_text"].lower()
    # Listing handoff sees the bundle.
    handoff_asset = result["handoff"]["payload"]["asset"]
    assert handoff_asset["asset_paths"] == asset["asset_paths"]


def test_bundle_partial_failure_still_ships(tmp_path, monkeypatch):
    """1 of 3 items fails → bundle ships with 2 items. Ensures one Tripo
    hiccup doesn't trash the entire cycle's work."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.setenv("BUNDLE_GENERATION_ENABLED", "1")

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    call_counter = {"n": 0}

    def fake_tripo_text(api_key, prompt, *, job_id, assets_dir, **kw):
        call_counter["n"] += 1
        if call_counter["n"] == 2:
            # Item 2 fails mid-bundle.
            from designer import tripo as tripo_mod
            raise tripo_mod.TripoError("Tripo task xyz timed out after 240s")
        glb = str(tmp_path / f"{job_id}.glb")
        stl = str(tmp_path / f"{job_id}.stl")
        png = str(tmp_path / f"{job_id}.png")
        for p in (glb, stl, png):
            open(p, "wb").close()
        return glb, stl, png

    from designer import tripo as tripo_mod
    from designer import nanobanana as nano_mod
    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)
    monkeypatch.setattr(nano_mod, "is_configured", lambda: False)

    items = ["Anubis bust", "Bastet bust", "Ra bust"]
    result = handle("process_job", {
        "job_id": 60,
        "payload": {"brief": _bundle_brief(items)},
    })

    assert result["ok"] is True
    asset = result["asset"]
    # Bundle gracefully degraded from 3 → 2 items.
    assert len(asset["asset_paths"]) == 2
    surviving_names = {it["name"] for it in asset["bundle"]["items"]}
    assert "Anubis bust" in surviving_names
    assert "Ra bust" in surviving_names
    assert "Bastet bust" not in surviving_names


def test_bundle_only_one_survives_degrades_to_single(tmp_path, monkeypatch):
    """2 of 3 items fail → cycle ships the 1 surviving item as a single-
    file listing rather than throw away the work."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.setenv("BUNDLE_GENERATION_ENABLED", "1")

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    call_counter = {"n": 0}

    def fake_tripo_text(api_key, prompt, *, job_id, assets_dir, **kw):
        from designer import tripo as tripo_mod
        call_counter["n"] += 1
        if call_counter["n"] in (1, 3):
            raise tripo_mod.TripoError("Tripo HTTP 500: server error")
        glb = str(tmp_path / f"{job_id}.glb")
        stl = str(tmp_path / f"{job_id}.stl")
        png = str(tmp_path / f"{job_id}.png")
        for p in (glb, stl, png):
            open(p, "wb").close()
        return glb, stl, png

    from designer import tripo as tripo_mod
    from designer import nanobanana as nano_mod
    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)
    monkeypatch.setattr(nano_mod, "is_configured", lambda: False)

    result = handle("process_job", {
        "job_id": 70,
        "payload": {"brief": _bundle_brief(
            ["Anubis bust", "Bastet bust", "Ra bust"]
        )},
    })

    assert result["ok"] is True
    asset = result["asset"]
    # Degraded path: NO asset_paths list (it's a single-file listing now).
    assert "asset_paths" not in asset or len(asset.get("asset_paths", [])) <= 1
    # Single asset_path still set.
    assert asset["asset_path"]
    assert "degraded" in result["ticker_text"].lower()


def test_bundle_disabled_falls_through_to_single(tmp_path, monkeypatch):
    """BUNDLE_GENERATION_ENABLED=0 → bundle expander never runs, designer
    falls through to the existing single-item path."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.setenv("BUNDLE_GENERATION_ENABLED", "0")

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    call_counter = {"n": 0}

    def fake_tripo_text(api_key, prompt, *, job_id, assets_dir, **kw):
        call_counter["n"] += 1
        glb = str(tmp_path / f"{job_id}.glb")
        stl = str(tmp_path / f"{job_id}.stl")
        png = str(tmp_path / f"{job_id}.png")
        for p in (glb, stl, png):
            open(p, "wb").close()
        return glb, stl, png

    from designer import tripo as tripo_mod
    from designer import nanobanana as nano_mod
    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)
    monkeypatch.setattr(nano_mod, "is_configured", lambda: False)

    result = handle("process_job", {
        "job_id": 80,
        "payload": {"brief": _bundle_brief(
            ["Anubis bust", "Bastet bust", "Ra bust"]
        )},
    })

    # Single-item path runs exactly once (the brief.bundle is bypassed).
    assert call_counter["n"] == 1
    assert result["ok"] is True
    asset = result["asset"]
    # No bundle metadata on the asset.
    assert "bundle" not in asset or not asset.get("bundle")
    assert "asset_paths" not in asset or len(asset.get("asset_paths", [])) == 1


def test_bundle_missing_falls_through_to_single(tmp_path, monkeypatch):
    """No bundle field on the brief → single-item path runs unchanged.
    Locks the back-compat contract."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.setenv("BUNDLE_GENERATION_ENABLED", "1")

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    def fake_tripo_text(api_key, prompt, *, job_id, assets_dir, **kw):
        glb = str(tmp_path / f"{job_id}.glb")
        stl = str(tmp_path / f"{job_id}.stl")
        png = str(tmp_path / f"{job_id}.png")
        for p in (glb, stl, png):
            open(p, "wb").close()
        return glb, stl, png

    from designer import tripo as tripo_mod
    from designer import nanobanana as nano_mod
    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)
    monkeypatch.setattr(nano_mod, "is_configured", lambda: False)

    brief = {
        "niche": "single dragon mini",
        "product_type": "stl_file",
        "ip_risk": "none",
        "design_direction": "single dragon mini",
        "keywords": ["dragon"],
        "price_band_usd": [4, 12],
        # NO bundle field
    }
    result = handle("process_job", {
        "job_id": 90,
        "payload": {"brief": brief},
    })

    assert result["ok"] is True
    asset = result["asset"]
    assert "bundle" not in asset or not asset.get("bundle")


def test_bundle_uses_meshy_when_provider_is_meshy(tmp_path, monkeypatch):
    """IMAGE_TO_3D_PROVIDER=meshy + no TRIPO_API_KEY → bundle path picks Meshy."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.delenv("TRIPO_API_KEY", raising=False)
    monkeypatch.setenv("MESHY_API_KEY", "m-test")
    monkeypatch.setenv("IMAGE_TO_3D_PROVIDER", "meshy")
    monkeypatch.setenv("BUNDLE_GENERATION_ENABLED", "1")

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    calls = {"meshy": 0, "tripo": 0}

    def fake_meshy_text(api_key, prompt, *, job_id, assets_dir, **kw):
        calls["meshy"] += 1
        glb = str(tmp_path / f"{job_id}.glb")
        stl = str(tmp_path / f"{job_id}.stl")
        png = str(tmp_path / f"{job_id}.png")
        for p in (glb, stl, png):
            open(p, "wb").close()
        return glb, stl, png

    def explode_tripo(*a, **kw):
        calls["tripo"] += 1
        raise AssertionError("tripo must not run when provider=meshy")

    from designer import tripo as tripo_mod
    from designer import meshy as meshy_mod
    from designer import nanobanana as nano_mod
    monkeypatch.setattr(meshy_mod, "generate_3d", fake_meshy_text)
    monkeypatch.setattr(tripo_mod, "generate_3d", explode_tripo)
    monkeypatch.setattr(nano_mod, "is_configured", lambda: False)

    result = handle("process_job", {
        "job_id": 100,
        "payload": {"brief": _bundle_brief(["a", "b"])},
    })

    assert result["ok"] is True
    assert calls["meshy"] == 2
    assert calls["tripo"] == 0


def test_bundle_max_items_caps_generation(tmp_path, monkeypatch):
    """BUNDLE_MAX_ITEMS=2 truncates a 4-item bundle to 2 items so the
    Tripo bill stays bounded per cycle."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.setenv("BUNDLE_GENERATION_ENABLED", "1")
    monkeypatch.setenv("BUNDLE_MAX_ITEMS", "2")

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    calls = {"n": 0}

    def fake_tripo_text(api_key, prompt, *, job_id, assets_dir, **kw):
        calls["n"] += 1
        glb = str(tmp_path / f"{job_id}.glb")
        stl = str(tmp_path / f"{job_id}.stl")
        png = str(tmp_path / f"{job_id}.png")
        for p in (glb, stl, png):
            open(p, "wb").close()
        return glb, stl, png

    from designer import tripo as tripo_mod
    from designer import nanobanana as nano_mod
    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)
    monkeypatch.setattr(nano_mod, "is_configured", lambda: False)

    result = handle("process_job", {
        "job_id": 110,
        "payload": {"brief": _bundle_brief(["a", "b", "c", "d"])},
    })
    assert result["ok"] is True
    assert calls["n"] == 2
    assert len(result["asset"]["asset_paths"]) == 2
