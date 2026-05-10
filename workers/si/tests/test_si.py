import io
import json
import os
from unittest.mock import patch

from si import agent as si_agent


def _make_response_bytes(text: str, in_tokens: int = 100, out_tokens: int = 50) -> bytes:
    body = {
        "content": [{"type": "text", "text": text}],
        "usage": {"input_tokens": in_tokens, "output_tokens": out_tokens},
    }
    return json.dumps(body).encode("utf-8")


def _fake_urlopen(payload_bytes: bytes):
    """Return a context manager that mimics urllib.request.urlopen()."""

    class _Resp:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *args):
            return False

        def read(self_inner):
            return payload_bytes

    return lambda *a, **kw: _Resp()


def _seed_outcomes(path: str, count: int, niche: str = "minimalist line art prints") -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for i in range(count):
            f.write(json.dumps({
                "ts": 1700000000 + i,
                "listing_id": 100 + i,
                "niche": niche,
                "sales": 1 + (i % 3),
                "revenue_usd": float(2 + i),
            }) + "\n")


def test_skip_when_too_few_outcomes(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    outcomes = tmp_path / ".agent-factory" / "outcomes.jsonl"
    _seed_outcomes(str(outcomes), 3)

    called = {"hit": False}

    def _boom(*args, **kwargs):
        called["hit"] = True
        raise AssertionError("anthropic should not be called when outcomes < 5")

    with patch("urllib.request.urlopen", side_effect=_boom):
        result = si_agent.process_job(1, {})

    assert called["hit"] is False
    assert result["ok"] is True
    assert result["ticker_text"] == "si · waiting for outcomes"
    assert result["role_tweaked"] is None


def test_atomic_write_round_trip(tmp_path):
    p = str(tmp_path / "prompts.json")
    data = {
        "designer": {"system_override": "x" * 100},
        "research": {"system_override": "abc " * 30},
    }
    si_agent.write_prompts(p, data)
    got = si_agent.read_prompts(p)
    assert got == data
    # Ensure no leftover .tmp files in the directory.
    leftover = [n for n in os.listdir(tmp_path) if n.endswith(".tmp")]
    assert leftover == []


def test_summarize_outcomes_groups_by_niche():
    outcomes = [
        {"niche": "boho macrame", "sales": 2, "revenue_usd": 10.0},
        {"niche": "boho macrame", "sales": 1, "revenue_usd": 5.0},
        {"niche": "minimalist line art", "sales": 3, "revenue_usd": 12.0},
        {"niche": "vintage typography", "sales": 0, "revenue_usd": 0.0},
    ]
    summary = si_agent.summarize_outcomes(outcomes)
    assert "boho macrame" in summary
    assert "minimalist line art" in summary
    assert "vintage typography" in summary
    assert "Total outcomes: 4" in summary


def test_invalid_response_skipped(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _seed_outcomes(str(tmp_path / ".agent-factory" / "outcomes.jsonl"), 6)

    bad_payload = _make_response_bytes("this is not JSON {{{ ")
    with patch("urllib.request.urlopen", _fake_urlopen(bad_payload)):
        result = si_agent.process_job(2, {})

    assert result["ok"] is True
    assert result["ticker_text"] == "si · skipped"
    assert result["role_tweaked"] is None
    # prompts.json should NOT have been written
    assert not os.path.exists(tmp_path / ".agent-factory" / "prompts.json")


def test_valid_response_writes_prompt(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _seed_outcomes(str(tmp_path / ".agent-factory" / "outcomes.jsonl"), 8)

    new_system = (
        "You are the Designer at an AI-run digital-products Etsy shop. "
        "Favor minimalist line-art aesthetics with high-contrast palettes. "
        "Return JSON only, no prose, no markdown."
    )
    payload = _make_response_bytes(json.dumps({
        "role": "designer",
        "new_system": new_system,
        "reasoning": "minimalist designs sold best last week",
    }))
    with patch("urllib.request.urlopen", _fake_urlopen(payload)):
        result = si_agent.process_job(3, {})

    assert result["ok"] is True
    assert result["role_tweaked"] == "designer"
    assert "tweaked" in result["ticker_text"]

    written = json.loads((tmp_path / ".agent-factory" / "prompts.json").read_text())
    assert written["designer"]["system_override"] == new_system


def test_null_role_proposal_no_change(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _seed_outcomes(str(tmp_path / ".agent-factory" / "outcomes.jsonl"), 7)

    payload = _make_response_bytes(json.dumps({
        "role": None,
        "new_system": "",
        "reasoning": "no signal yet",
    }))
    with patch("urllib.request.urlopen", _fake_urlopen(payload)):
        result = si_agent.process_job(4, {})

    assert result["ok"] is True
    assert result["role_tweaked"] is None
    assert result["ticker_text"] == "si · no change"
    assert not os.path.exists(tmp_path / ".agent-factory" / "prompts.json")


def test_read_outcomes_skips_malformed_lines(tmp_path):
    p = tmp_path / "outcomes.jsonl"
    p.write_text(
        json.dumps({"niche": "a", "sales": 1, "revenue_usd": 1.0}) + "\n"
        + "not json at all\n"
        + json.dumps({"niche": "b", "sales": 2, "revenue_usd": 2.0}) + "\n"
        + "\n"
    )
    out = si_agent.read_outcomes(str(p))
    assert len(out) == 2
    assert out[0]["niche"] == "a"
    assert out[1]["niche"] == "b"


def test_read_outcomes_tail_limit(tmp_path):
    p = tmp_path / "outcomes.jsonl"
    with open(p, "w") as f:
        for i in range(50):
            f.write(json.dumps({"niche": "x", "sales": 0, "revenue_usd": 0.0, "ts": i}) + "\n")
    out = si_agent.read_outcomes(str(p), limit=30)
    assert len(out) == 30
    # Should be the LAST 30
    assert out[0]["ts"] == 20
    assert out[-1]["ts"] == 49


def _seed_outcomes_pre_post(path: str, pre_revenues: list[float], post_revenues: list[float], tweak_ts: int) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lines = []
    for i, rev in enumerate(pre_revenues):
        lines.append(json.dumps({
            "ts": tweak_ts - len(pre_revenues) + i,
            "listing_id": 100 + i,
            "niche": "test niche",
            "sales": 1,
            "revenue_usd": float(rev),
        }))
    for i, rev in enumerate(post_revenues):
        lines.append(json.dumps({
            "ts": tweak_ts + 1 + i,
            "listing_id": 200 + i,
            "niche": "test niche",
            "sales": 1,
            "revenue_usd": float(rev),
        }))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def test_rollback_triggers_on_revenue_regression(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    outcomes_path = tmp_path / ".agent-factory" / "outcomes.jsonl"
    prompts_path = tmp_path / ".agent-factory" / "prompts.json"
    tweak_ts = 1000
    # 5 pre @ avg $10, 5 post @ avg $3 → 70% drop, well past 40% threshold.
    _seed_outcomes_pre_post(str(outcomes_path), [10, 10, 10, 10, 10], [3, 3, 3, 3, 3], tweak_ts)
    os.makedirs(prompts_path.parent, exist_ok=True)
    prompts_path.write_text(json.dumps({
        "_history": [
            {
                "ts": tweak_ts,
                "role_tweaked": "designer",
                "prior_overrides": {"designer": {}},
                "rationale": "earlier tweak",
            }
        ],
        "designer": {"system_override": "BAD_PROMPT_THAT_HURT"},
    }))

    called = {"hit": False}

    def _boom(*args, **kwargs):
        called["hit"] = True
        raise AssertionError("anthropic should NOT be called when rolling back")

    with patch("urllib.request.urlopen", side_effect=_boom):
        result = si_agent.process_job(10, {})

    assert called["hit"] is False
    assert result["ok"] is True
    assert result["role_tweaked"] == "rollback"
    assert "rollback" in result["ticker_text"]

    written = json.loads(prompts_path.read_text())
    # designer override should be gone (prior_overrides was {"designer": {}})
    assert "designer" not in written
    # _history should now have a single 'rollback' entry (popped + appended).
    assert isinstance(written.get("_history"), list)
    assert len(written["_history"]) == 1
    assert written["_history"][0]["role_tweaked"] == "rollback"
    # Provenance: prior_overrides reflects what we restored from.
    assert written["_history"][0]["prior_overrides"] == {"designer": {}}


def test_rollback_skipped_when_insufficient_post_outcomes(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    outcomes_path = tmp_path / ".agent-factory" / "outcomes.jsonl"
    prompts_path = tmp_path / ".agent-factory" / "prompts.json"
    tweak_ts = 1000
    # 5 pre but only 3 post — too few post-outcomes; rollback must skip.
    _seed_outcomes_pre_post(str(outcomes_path), [10, 10, 10, 10, 10], [1, 1, 1], tweak_ts)
    os.makedirs(prompts_path.parent, exist_ok=True)
    prompts_path.write_text(json.dumps({
        "_history": [
            {
                "ts": tweak_ts,
                "role_tweaked": "designer",
                "prior_overrides": {"designer": {}},
                "rationale": "earlier tweak",
            }
        ],
        "designer": {"system_override": "OVERRIDE_X" * 20},
    }))

    # Anthropic returns null → no change. Confirms rollback was skipped, normal flow ran.
    payload = _make_response_bytes(json.dumps({
        "role": None,
        "new_system": "",
        "reasoning": "still observing",
    }))
    with patch("urllib.request.urlopen", _fake_urlopen(payload)):
        result = si_agent.process_job(11, {})

    assert result["ok"] is True
    assert result["role_tweaked"] is None
    assert result["ticker_text"] == "si · no change"
    # Existing override and history intact.
    written = json.loads(prompts_path.read_text())
    assert written["designer"]["system_override"].startswith("OVERRIDE_X")
    assert len(written["_history"]) == 1
    assert written["_history"][0]["role_tweaked"] == "designer"


def test_rollback_skipped_when_revenue_within_tolerance(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    outcomes_path = tmp_path / ".agent-factory" / "outcomes.jsonl"
    prompts_path = tmp_path / ".agent-factory" / "prompts.json"
    tweak_ts = 1000
    # Pre $10 avg, post $7 avg → 30% drop, within 40% tolerance → no rollback.
    _seed_outcomes_pre_post(str(outcomes_path), [10, 10, 10, 10, 10], [7, 7, 7, 7, 7], tweak_ts)
    os.makedirs(prompts_path.parent, exist_ok=True)
    prompts_path.write_text(json.dumps({
        "_history": [
            {
                "ts": tweak_ts,
                "role_tweaked": "designer",
                "prior_overrides": {"designer": {}},
                "rationale": "earlier tweak",
            }
        ],
        "designer": {"system_override": "STILL_OK_OVERRIDE" * 8},
    }))

    payload = _make_response_bytes(json.dumps({
        "role": None,
        "new_system": "",
        "reasoning": "no signal",
    }))
    with patch("urllib.request.urlopen", _fake_urlopen(payload)):
        result = si_agent.process_job(12, {})

    assert result["ok"] is True
    assert result["role_tweaked"] is None
    written = json.loads(prompts_path.read_text())
    # Override preserved, history unchanged.
    assert written["designer"]["system_override"].startswith("STILL_OK_OVERRIDE")
    assert len(written["_history"]) == 1
    assert written["_history"][0]["role_tweaked"] == "designer"


def test_history_capped_at_5_entries(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _seed_outcomes(str(tmp_path / ".agent-factory" / "outcomes.jsonl"), 8)
    prompts_path = tmp_path / ".agent-factory" / "prompts.json"
    os.makedirs(prompts_path.parent, exist_ok=True)
    # 5 historic entries, all with ts FAR in the future so no rollback triggers
    # against the seeded outcomes (whose ts are ~1.7e9 small ints).
    far_future = 9_999_999_999
    starting_history = [
        {
            "ts": far_future + i,
            "role_tweaked": "research",
            "prior_overrides": {"research": {}},
            "rationale": f"entry {i}",
        }
        for i in range(5)
    ]
    prompts_path.write_text(json.dumps({"_history": list(starting_history)}))

    new_system = (
        "You are the Designer at an AI-run digital-products Etsy shop. "
        "Favor minimalist line-art aesthetics with high-contrast palettes. "
        "Return JSON only, no prose, no markdown."
    )
    payload = _make_response_bytes(json.dumps({
        "role": "designer",
        "new_system": new_system,
        "reasoning": "minimalist works",
    }))
    with patch("urllib.request.urlopen", _fake_urlopen(payload)):
        result = si_agent.process_job(13, {})

    assert result["ok"] is True
    assert result["role_tweaked"] == "designer"
    written = json.loads(prompts_path.read_text())
    history = written.get("_history")
    assert isinstance(history, list)
    assert len(history) == 5
    # Oldest dropped, newest entry is for designer.
    assert history[-1]["role_tweaked"] == "designer"
    # The entry with rationale 'entry 0' should be gone.
    assert not any(h.get("rationale") == "entry 0" for h in history)


def test_history_snapshot_records_prior_overrides(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _seed_outcomes(str(tmp_path / ".agent-factory" / "outcomes.jsonl"), 8)
    prompts_path = tmp_path / ".agent-factory" / "prompts.json"
    os.makedirs(prompts_path.parent, exist_ok=True)
    # Existing designer override → should be captured into history when overwritten.
    prompts_path.write_text(json.dumps({
        "designer": {"system_override": "OLD"},
    }))

    new_system = (
        "You are the Designer at an AI-run digital-products Etsy shop. "
        "Favor minimalist line-art aesthetics with high-contrast palettes. "
        "Return JSON only, no prose, no markdown."
    )
    payload = _make_response_bytes(json.dumps({
        "role": "designer",
        "new_system": new_system,
        "reasoning": "minimalist sells",
    }))
    with patch("urllib.request.urlopen", _fake_urlopen(payload)):
        result = si_agent.process_job(14, {})

    assert result["ok"] is True
    assert result["role_tweaked"] == "designer"
    written = json.loads(prompts_path.read_text())
    history = written.get("_history")
    assert isinstance(history, list)
    assert len(history) == 1
    assert history[0]["role_tweaked"] == "designer"
    assert history[0]["prior_overrides"] == {"designer": {"system_override": "OLD"}}
