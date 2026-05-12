import json

from listing.agent import (
    build_listing_prompt,
    validate_listing,
    _clamp_price,
    NEW_SHOP_PRICE_CEILING_USD,
)


def test_prompt_includes_title_constraint():
    brief = {"niche": "minimalist wall art"}
    asset = {"asset_type": "printable", "dimensions": "8.5x11 inch"}
    system, user = build_listing_prompt(brief, asset)
    assert "140" in system
    assert "13 tags" in system or "Exactly 13" in system


def test_clamp_price_caps_at_band_upper():
    brief = {"price_band_usd": [3, 8]}
    assert _clamp_price(25, brief) == 8.0


def test_clamp_price_caps_at_global_ceiling_when_no_band():
    brief = {"niche": "x"}
    assert _clamp_price(50, brief) == NEW_SHOP_PRICE_CEILING_USD


def test_clamp_price_lifts_below_band_lower():
    brief = {"price_band_usd": [5, 12]}
    assert _clamp_price(0.50, brief) == 5.0


def test_clamp_price_enforces_floor_when_band_lower_is_zero():
    brief = {"price_band_usd": [0, 12]}
    assert _clamp_price(0.50, brief) == 1.50


def test_clamp_price_passthrough_in_band():
    brief = {"price_band_usd": [3, 12]}
    assert _clamp_price(6.99, brief) == 6.99


def test_validate_listing_ok():
    listing = {
        "title": "Beautiful Minimalist Wall Art Print | Digital Download",
        "tags": ["wall art", "printable", "minimalist", "digital", "download",
                 "home decor", "modern art", "boho", "gallery wall",
                 "instant download", "art print", "bedroom decor", "office art"],
        "description": "A lovely print.",
        "materials": ["digital download"],
        "price_usd": 5.99,
    }
    errors = validate_listing(listing)
    assert errors == []


def test_validate_listing_title_too_long():
    listing = {
        "title": "x" * 141,
        "tags": ["t"] * 13,
        "description": "desc",
        "materials": ["digital download"],
        "price_usd": 5.0,
    }
    errors = validate_listing(listing)
    assert any("title" in e for e in errors)


def test_validate_listing_wrong_tag_count():
    listing = {
        "title": "Short Title",
        "tags": ["only", "five", "tags", "here", "oops"],
        "description": "desc",
        "materials": ["digital download"],
        "price_usd": 5.0,
    }
    errors = validate_listing(listing)
    assert any("tags" in e for e in errors)


def _capture_anthropic_system(monkeypatch):
    captured: dict = {}

    class _Resp:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *a):
            return False

        def read(self_inner):
            return json.dumps({
                "content": [{"type": "text", "text": json.dumps({
                    "title": "A short title",
                    "tags": ["t"] * 13,
                    "description": "desc",
                    "materials": ["digital download"],
                    "price_usd": 5.0,
                })}],
                "usage": {"input_tokens": 1, "output_tokens": 1},
            }).encode("utf-8")

    def _fake_urlopen(req, timeout=60):
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _Resp()

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)
    return captured


def test_override_replaces_system(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    af_dir = tmp_path / ".agent-factory"
    af_dir.mkdir()
    override_text = "TEST_OVERRIDE_LISTING " * 5
    (af_dir / "prompts.json").write_text(json.dumps({
        "listing": {"system_override": override_text},
    }))

    captured = _capture_anthropic_system(monkeypatch)
    from listing.agent import call_anthropic
    call_anthropic("k-test", {"niche": "x"}, {"asset_type": "printable"})
    assert captured["body"]["system"] == override_text


def test_no_override_uses_default(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    captured = _capture_anthropic_system(monkeypatch)
    from listing.agent import call_anthropic
    call_anthropic("k-test", {"niche": "x"}, {"asset_type": "printable"})
    default_system, _ = build_listing_prompt({"niche": "x"}, {"asset_type": "printable"})
    assert captured["body"]["system"] == default_system


def test_cycle_id_propagates(tmp_path, monkeypatch):
    """Listing echoes inbound cycle_id into result top-level and handoff."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _capture_anthropic_system(monkeypatch)
    from listing.agent import handle

    cid = "listing-cycle-deadbeef"
    result = handle("process_job", {
        "job_id": 9,
        "payload": {
            "brief": {"niche": "x"},
            "asset": {"asset_type": "printable"},
            "cycle_id": cid,
        },
    })
    assert result["ok"] is True
    assert result.get("cycle_id") == cid
    assert result["handoff"]["payload"]["cycle_id"] == cid
