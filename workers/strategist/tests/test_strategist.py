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


# --- orchestrator-tuning path (meta-strategist) ---
#
# Same worker, dispatched by payload.target. target="orchestrator" writes
# advisory `strategist_notes` into prompts.json under the orchestrator
# section. The notes are short (NOTES_MIN_LEN..NOTES_MAX_LEN), distinct
# from the designer's full system_override.


from strategist.agent import (  # noqa: E402
    NOTES_MIN_LEN,
    NOTES_MAX_LEN,
    build_orchestrator_notes_prompt,
    _collect_operator_steers,
)


def test_build_orchestrator_notes_prompt_mentions_orchestrator_responsibilities():
    """The synthesis prompt must teach the model what the orchestrator
    actually does (picks niche_seed) and what the model should AVOID
    producing (full prompt rewrites, generic advice, specific niches)."""
    system, user = build_orchestrator_notes_prompt(None, [], [])
    sys_l = system.lower()
    assert "niche_seed" in sys_l or "niche-seed" in sys_l
    assert "strategist_notes" in sys_l
    assert "advisory" in sys_l
    # No prompt-replacement framing.
    assert "improved_system_prompt" not in sys_l


def test_notes_prompt_enforces_operator_steer_supremacy():
    """The strategist must be told operator steers are law and it may never
    burn/override one, and the active steers must appear in the user prompt
    so it can actually comply."""
    steers = ["let's make semi nude very sexy anime girls full body"]
    system, user = build_orchestrator_notes_prompt(
        None, [], [], operator_steers=steers
    )
    sys_l = system.lower()
    # System teaches supremacy + the safety-routing escape hatch.
    assert "operator steers are law" in sys_l
    assert "never contradict" in sys_l or "must never" in sys_l
    assert "burn" in sys_l
    assert "mature_content" in sys_l or "sketchfab" in sys_l
    # The actual steer text is surfaced to the model.
    assert "sexy anime girls" in user.lower()
    assert "law" in user.lower()


def test_notes_prompt_handles_no_steers():
    """No active steers — the prompt still builds and says so."""
    system, user = build_orchestrator_notes_prompt(None, [], [], operator_steers=[])
    assert "none" in user.lower()


def test_collect_operator_steers_merges_roles_and_dedups():
    prompts = {
        "orchestrator": {"operator_steers": ["make anime girls", "  ", "make robots"]},
        "research": {"operator_steers": [
            {"text": "make anime girls", "image_paths": []},  # dup of orch
            {"text": "make dragons"},
        ]},
    }
    steers = _collect_operator_steers(prompts, ["orchestrator", "research"])
    assert steers == ["make anime girls", "make robots", "make dragons"]


def test_collect_operator_steers_empty_when_missing():
    assert _collect_operator_steers({}, ["orchestrator", "research"]) == []


def test_orchestrator_target_below_min_outcomes_returns_waiting(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    out_path = tmp_path / "outcomes.jsonl"
    out_path.write_text(json.dumps({"niche": "x", "sales": 0}) + "\n")
    result = process_job(7, {"target": "orchestrator"})
    assert result["ok"] is True
    assert result["role_tweaked"] is None
    assert "waiting" in result["ticker_text"].lower()


def test_orchestrator_target_writes_strategist_notes(tmp_path, monkeypatch):
    """When target=orchestrator and outcomes are sufficient, the notes land
    in prompts.json under orchestrator.strategist_notes."""
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    out_path = tmp_path / "outcomes.jsonl"
    out_path.write_text("\n".join(
        json.dumps({"niche": f"n{i}", "sales": i, "revenue_usd": i * 2.0})
        for i in range(MIN_OUTCOMES + 1)
    ))
    notes_payload = "n" * (NOTES_MIN_LEN + 50)
    fake_response = {
        "strategist_notes": notes_payload,
        "rationale": "Mythology niches saturating; bias scale up.",
    }

    class _Resp:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *a):
            return False

        def read(self_inner):
            return json.dumps({
                "content": [{"type": "text", "text": json.dumps(fake_response)}],
                "usage": {"input_tokens": 80, "output_tokens": 300},
            }).encode("utf-8")

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=60: _Resp())

    result = process_job(21, {"target": "orchestrator"})
    assert result["ok"] is True
    assert result["role_tweaked"] == "orchestrator"
    prompts = json.loads((tmp_path / "prompts.json").read_text())
    assert prompts["orchestrator"]["strategist_notes"] == notes_payload
    assert "mythology" in prompts["orchestrator"]["last_strategist_rationale"].lower()
    # Designer section must be untouched.
    assert "designer" not in prompts or "system_override" not in prompts.get("designer", {})


def test_orchestrator_target_rejects_bad_notes_length(tmp_path, monkeypatch):
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
                    "strategist_notes": "too short",
                    "rationale": "tried",
                })}],
                "usage": {"input_tokens": 1, "output_tokens": 1},
            }).encode("utf-8")

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=60: _Resp())

    result = process_job(33, {"target": "orchestrator"})
    assert result["ok"] is False
    assert "outside" in result["error"]
    # prompts.json must not exist — bad-length reject leaves disk clean.
    assert not (tmp_path / "prompts.json").exists()


def test_unknown_target_rejected(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    result = process_job(99, {"target": "publisher"})
    assert result["ok"] is False
    assert "unknown" in result["error"].lower()


# --- JSON repair on max_tokens truncation ---
#
# Anthropic responses that hit max_tokens mid-string produce
# "Unterminated string starting at line 1 column N" from json.JSONDecoder.
# The repair pass closes the open string + any open braces so we recover
# the head of the partial response instead of wasting the call.


from strategist.agent import (  # noqa: E402
    _repair_truncated_json,
    call_anthropic,
)


def test_repair_truncated_json_closes_open_string_and_object():
    """Simulate the exact failure mode: response truncated mid-value of
    improved_system_prompt. Repair must close the string and the object."""
    truncated = (
        '{"improved_system_prompt": "You are the Designer. Be precise.\\n'
        'Subject + pose specificity helps the model produce printable'
    )
    fixed = _repair_truncated_json(truncated)
    # Must produce parseable JSON.
    obj = json.loads(fixed)
    assert isinstance(obj, dict)
    assert obj["improved_system_prompt"].startswith("You are the Designer.")


def test_repair_truncated_json_handles_nested_objects():
    truncated = '{"a": {"b": "value with no close'
    fixed = _repair_truncated_json(truncated)
    obj = json.loads(fixed)
    assert obj["a"]["b"].startswith("value with no close")


def test_repair_truncated_json_noop_on_complete_payload():
    """Already-closed JSON should round-trip unchanged."""
    complete = '{"a": 1, "b": "two"}'
    assert _repair_truncated_json(complete) == complete


def test_call_anthropic_recovers_from_truncated_response(monkeypatch):
    """End-to-end: call_anthropic must call the repair when the LLM cuts off
    mid-string. The recovered object should still have the head of the
    truncated field."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    # Simulate Anthropic response with an unterminated string — max_tokens
    # fired mid-prompt. The "{" prefill makes the body start at the
    # second character so we drop it like production does.
    truncated_text = (
        '{"improved_system_prompt": "You are the Designer at an AI-run shop. '
        + "x" * 100  # padding so the truncation is obviously mid-string
    )

    class _Resp:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *a):
            return False

        def read(self_inner):
            return json.dumps({
                "content": [{"type": "text", "text": truncated_text}],
                "usage": {"input_tokens": 100, "output_tokens": 3000},
            }).encode("utf-8")

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=60: _Resp())

    obj, tin, tout = call_anthropic("k-test", "sys", "user")
    assert isinstance(obj, dict)
    assert obj["improved_system_prompt"].startswith("You are the Designer")
    assert tin == 100
    assert tout == 3000
