import json

from strategist.agent import (
    MIN_OUTCOMES,
    SYSTEM_MIN_LEN,
    SYSTEM_MAX_LEN,
    build_synthesis_prompt,
    process_job,
    summarize_outcomes,
)


def test_summarize_outcomes_compact_format():
    rows = [
        {"niche": "boho stickers", "sales": 3, "revenue_usd": 8.75},
        {"niche": "minimalist line art", "sales": 0, "revenue_usd": 0,
         "rationale": "too generic"},
    ]
    out = summarize_outcomes(rows)
    assert "boho stickers" in out
    assert "minimalist line art" in out
    assert "too generic" in out


def test_summarize_outcomes_empty():
    assert "no outcomes" in summarize_outcomes([])


def test_build_synthesis_prompt_includes_current_override():
    cur = "Current designer prompt text"
    system, user = build_synthesis_prompt(cur, [
        {"niche": "boho", "sales": 1, "revenue_usd": 4.0},
    ])
    assert "Design Strategist" in system
    # Strategist must understand we sell 3D files, not SVG stickers — the
    # prompt it writes is a JSON brief that feeds Tripo/Meshy.
    sys_l = system.lower()
    assert "stl" in sys_l and "glb" in sys_l
    assert "tripo" in sys_l or "meshy" in sys_l
    assert "brief_for_image_gen" in sys_l or "json brief" in sys_l
    assert cur in user


def test_build_synthesis_prompt_forbids_pre_pivot_terms():
    """The strategist must explicitly warn itself against writing pre-pivot
    artifacts (SVG, viewBox, kiss-cut, sticker, planner). If those leak back
    into the override, the Designer drift-guard rejects the override at
    load time and we lose the strategist's tuning entirely."""
    system, _ = build_synthesis_prompt(None, [])
    sys_l = system.lower()
    # Hard rules block names the forbidden tokens so Sonnet knows not to use
    # them in the override it produces.
    for forbidden in ("svg", "viewbox", "kiss-cut", "sticker", "planner"):
        assert forbidden in sys_l, f"strategist must call out '{forbidden}' as forbidden"


def test_build_synthesis_prompt_handles_no_override():
    system, user = build_synthesis_prompt(None, [])
    assert "no override" in user.lower()


def test_below_min_outcomes_returns_waiting(tmp_path, monkeypatch):
    """Strategist must not call Anthropic when there isn't enough signal."""
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    # Write fewer outcomes than threshold
    out_path = tmp_path / "outcomes.jsonl"
    out_path.write_text(json.dumps({"niche": "x", "sales": 0}) + "\n")
    result = process_job(7, {})
    assert result["ok"] is True
    assert result["role_tweaked"] is None
    assert "waiting" in result["ticker_text"].lower()
    assert result["tokens_in"] == 0


def test_above_min_outcomes_writes_override(tmp_path, monkeypatch):
    """When outcomes ≥ MIN_OUTCOMES and Anthropic returns a good payload,
    the override should land in prompts.json under designer.system_override."""
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    # Seed enough outcomes.
    out_path = tmp_path / "outcomes.jsonl"
    out_path.write_text("\n".join(
        json.dumps({"niche": f"n{i}", "sales": i, "revenue_usd": i * 2.0})
        for i in range(MIN_OUTCOMES + 1)
    ))
    new_prompt = "x" * (SYSTEM_MIN_LEN + 100)
    fake_response = {
        "improved_system_prompt": new_prompt,
        "rationale": "Tightened color guidance after seeing pastel underperform.",
    }

    class _Resp:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *a):
            return False

        def read(self_inner):
            return json.dumps({
                "content": [{"type": "text", "text": json.dumps(fake_response)}],
                "usage": {"input_tokens": 100, "output_tokens": 500},
            }).encode("utf-8")

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=60: _Resp())

    result = process_job(9, {})
    assert result["ok"] is True
    assert result["role_tweaked"] == "designer"
    assert result["tokens_in"] == 100

    prompts = json.loads((tmp_path / "prompts.json").read_text())
    assert prompts["designer"]["system_override"] == new_prompt
    assert "tightened" in prompts["designer"]["last_strategist_rationale"].lower()


def test_rejects_bad_length_override(tmp_path, monkeypatch):
    """A returned prompt below SYSTEM_MIN_LEN must be rejected and the
    on-disk override left untouched."""
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    out_path = tmp_path / "outcomes.jsonl"
    out_path.write_text("\n".join(
        json.dumps({"niche": f"n{i}", "sales": 1}) for i in range(MIN_OUTCOMES + 1)
    ))

    class _Resp:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *a):
            return False

        def read(self_inner):
            return json.dumps({
                "content": [{"type": "text", "text": json.dumps({
                    "improved_system_prompt": "too short",
                    "rationale": "tried",
                })}],
                "usage": {"input_tokens": 1, "output_tokens": 1},
            }).encode("utf-8")

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=60: _Resp())

    result = process_job(11, {})
    assert result["ok"] is False
    assert "outside" in result["error"]
    # No prompts.json should have been written.
    assert not (tmp_path / "prompts.json").exists()
