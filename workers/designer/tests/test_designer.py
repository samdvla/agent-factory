import json
import urllib.error
import urllib.request

from designer.agent import build_designer_prompt, MODEL, SVG_MODEL, handle


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


# --- Slice G: real SVG asset generation ---


def _resp(payload: dict):
    """Build a context-manager-shaped fake HTTP response wrapping `payload` as JSON."""

    class _Resp:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *a):
            return False

        def read(self_inner):
            return json.dumps(payload).encode("utf-8")

    return _Resp()


def _haiku_response():
    return _resp({
        "content": [{"type": "text", "text": json.dumps({
            "asset_type": "printable",
            "style": "minimalist line art",
            "palette": ["#000000", "#ffffff", "#888888"],
            "dimensions": "8.5x11 inch printable, 300dpi",
            "mockup_count": 2,
            "brief_for_image_gen": "minimalist black line botanicals on cream",
        })}],
        "usage": {"input_tokens": 50, "output_tokens": 80},
    })


def _svg_response(svg_text: str, in_tokens: int = 200, out_tokens: int = 600):
    return _resp({
        "content": [{"type": "text", "text": svg_text}],
        "usage": {"input_tokens": in_tokens, "output_tokens": out_tokens},
    })


def _mock_urlopen_factory(responses):
    """Return a urlopen replacement that yields the given responses in sequence."""
    iter_responses = iter(responses)

    def _factory(req, timeout=None):
        return next(iter_responses)

    return _factory


def _job_params(job_id: int = 42):
    return {
        "job_id": job_id,
        "payload": {"brief": {"niche": "minimalist line art", "keywords": ["minimal"], "price_band_usd": [5, 15]}},
    }


def test_svg_call_saves_file_and_returns_path(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    svg = '<svg viewBox="0 0 800 800" xmlns="http://www.w3.org/2000/svg"><circle cx="400" cy="400" r="100"/></svg>'
    fake = _mock_urlopen_factory([_haiku_response(), _svg_response(svg, in_tokens=300, out_tokens=900)])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    result = handle("process_job", _job_params(42))

    assert result["ok"] is True
    asset_path = result["asset"]["asset_path"]
    assert asset_path is not None
    assert asset_path.startswith(str(tmp_path / "assets"))
    assert asset_path.endswith("42.svg")

    with open(asset_path) as f:
        assert f.read() == svg

    assert result["model"] == SVG_MODEL
    # Combined: Haiku 50/80 + Sonnet 300/900
    assert result["tokens_in"] == 350
    assert result["tokens_out"] == 980
    assert "svg ✓" in result["ticker_text"]
    # Hand-off should carry the asset_path through.
    assert result["handoff"]["payload"]["asset"]["asset_path"] == asset_path


def test_svg_invalid_output_falls_back_to_text_only(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    fake = _mock_urlopen_factory([
        _haiku_response(),
        _svg_response("not even close to svg content here"),
    ])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    result = handle("process_job", _job_params(101))

    assert result["ok"] is True
    assert result["asset"]["asset_path"] is None
    assert result["model"] == MODEL  # Haiku — Sonnet failed
    # Tokens come from the Haiku call only.
    assert result["tokens_in"] == 50
    assert result["tokens_out"] == 80
    assert "text only" in result["ticker_text"]
    # Pipeline still hands off.
    assert result["handoff"]["to_role"] == "listing"


def test_svg_call_failure_does_not_crash(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    call_count = {"n": 0}

    def _fake(req, timeout=None):
        call_count["n"] += 1
        if call_count["n"] == 1:
            return _haiku_response()
        raise urllib.error.URLError("network unreachable")

    monkeypatch.setattr(urllib.request, "urlopen", _fake)

    result = handle("process_job", _job_params(202))

    assert result["ok"] is True
    assert result["asset"]["asset_path"] is None
    assert result["model"] == MODEL
    assert result["tokens_in"] == 50
    assert result["tokens_out"] == 80
    assert result["handoff"]["to_role"] == "listing"


def test_svg_validation_rejects_no_drawing_elements(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    fake = _mock_urlopen_factory([
        _haiku_response(),
        _svg_response('<svg viewBox="0 0 800 800"></svg>'),
    ])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    result = handle("process_job", _job_params(303))

    assert result["ok"] is True
    assert result["asset"]["asset_path"] is None
    assert result["model"] == MODEL
