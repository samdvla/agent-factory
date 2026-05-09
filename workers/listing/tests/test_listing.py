import json

from listing.agent import build_listing_prompt, validate_listing


def test_prompt_includes_title_constraint():
    brief = {"niche": "minimalist wall art"}
    asset = {"asset_type": "printable", "dimensions": "8.5x11 inch"}
    system, user = build_listing_prompt(brief, asset)
    assert "140" in system
    assert "13 tags" in system or "Exactly 13" in system


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
