import json
from research.agent import build_demand_brief_prompt


def test_prompt_includes_niche_field():
    system, user = build_demand_brief_prompt()
    assert "niche" in user
    assert "Etsy" in system


def test_prompt_returns_strings():
    system, user = build_demand_brief_prompt()
    assert isinstance(system, str)
    assert isinstance(user, str)


def test_seeded_prompt_includes_niche_string():
    """When niche_seed is provided, the user prompt must contain the seed text."""
    seed = "boho macrame wall art printables"
    rat = "trending 22% MoM on Pinterest"
    system, user = build_demand_brief_prompt(niche_seed=seed, rationale=rat)
    assert seed in user
    assert rat in user
    # System prompt unchanged
    assert "Etsy" in system


def test_unseeded_prompt_is_generic():
    """Without a seed the prompt falls back to the generic 'pick a niche' form."""
    system, user = build_demand_brief_prompt()
    # Must NOT contain seeded phrasing
    assert "strategy lead picked" not in user
    assert "niche" in user


def _capture_anthropic_system(monkeypatch):
    """Patch urllib.request.urlopen and capture the request body sent to Anthropic.

    Returns a dict that gets populated with the parsed body on the first call.
    """
    captured: dict = {}

    class _Resp:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *a):
            return False

        def read(self_inner):
            return json.dumps({
                "content": [{"type": "text", "text": json.dumps({
                    "niche": "test niche",
                    "keywords": ["a"] * 10,
                    "price_band_usd": [3, 8],
                    "competition": "low",
                    "rationale": "testing",
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
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    af_dir = tmp_path / ".agent-factory"
    af_dir.mkdir()
    override_text = "TEST_OVERRIDE_RESEARCH " * 5
    (af_dir / "prompts.json").write_text(json.dumps({
        "research": {"system_override": override_text},
    }))

    captured = _capture_anthropic_system(monkeypatch)
    from research.agent import call_anthropic
    call_anthropic("k-test")
    assert captured["body"]["system"] == override_text


def test_no_override_uses_default(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    captured = _capture_anthropic_system(monkeypatch)
    from research.agent import call_anthropic, build_demand_brief_prompt
    call_anthropic("k-test")
    default_system, _ = build_demand_brief_prompt()
    assert captured["body"]["system"] == default_system
