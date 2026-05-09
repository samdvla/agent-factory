import json

from designer.agent import build_designer_prompt


def test_prompt_includes_asset_type():
    brief = {"niche": "minimalist wall art", "keywords": ["minimal", "art"], "price_band_usd": [5, 15]}
    system, user = build_designer_prompt(brief)
    assert "asset_type" in system
    assert "Designer" in system


def test_prompt_user_is_json_stringified_brief():
    brief = {"niche": "botanical prints", "keywords": ["botanical"], "price_band_usd": [8, 20]}
    system, user = build_designer_prompt(brief)
    parsed = json.loads(user)
    assert parsed["niche"] == "botanical prints"


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
                    "asset_type": "printable",
                    "style": "minimalist",
                    "palette": ["#000", "#fff", "#888"],
                    "dimensions": "8.5x11 inch printable, 300dpi",
                    "mockup_count": 2,
                    "brief_for_image_gen": "minimalist line art print",
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
    override_text = "TEST_OVERRIDE_DESIGNER " * 5
    (af_dir / "prompts.json").write_text(json.dumps({
        "designer": {"system_override": override_text},
    }))

    captured = _capture_anthropic_system(monkeypatch)
    from designer.agent import call_anthropic
    call_anthropic("k-test", {"niche": "x"})
    assert captured["body"]["system"] == override_text


def test_no_override_uses_default(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    captured = _capture_anthropic_system(monkeypatch)
    from designer.agent import call_anthropic
    call_anthropic("k-test", {"niche": "x"})
    default_system, _ = build_designer_prompt({"niche": "x"})
    assert captured["body"]["system"] == default_system
