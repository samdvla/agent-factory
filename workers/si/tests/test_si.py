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


def _seed_operator_feedback(tmp_path, by_role: dict) -> None:
    af = tmp_path / ".agent-factory"
    af.mkdir(parents=True, exist_ok=True)
    (af / "operator_feedback.json").write_text(json.dumps({"by_role": by_role}))


def test_operator_feedback_bypasses_outcomes_gate(tmp_path, monkeypatch):
    """A single operator rating must wake SI even with zero outcomes — the
    human is rating specific outputs and that signal shouldn't wait for the
    next sales batch."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _seed_operator_feedback(tmp_path, {
        "designer": [{"rating": "down", "note": "thumbnails too busy at small size"}],
    })

    new_system = (
        "You are the Designer. Simplify thumbnails for legibility at 200px — "
        "bold single subjects, two-color palettes, no fine line work that "
        "vanishes when rendered small. Return JSON only."
    )
    payload = _make_response_bytes(json.dumps({
        "role": "designer",
        "new_system": new_system,
        "reasoning": "operator flagged busy thumbnails — simplify",
    }))
    with patch("urllib.request.urlopen", _fake_urlopen(payload)):
        result = si_agent.process_job(99, {"trigger": "operator_rating"})

    assert result["ok"] is True
    assert result["role_tweaked"] == "designer"
    written = json.loads((tmp_path / ".agent-factory" / "prompts.json").read_text())
    assert written["designer"]["system_override"] == new_system
    # History entry should be tagged so the team can see this was a relay.
    history = written["_history"]
    assert history[-1]["role_tweaked"] == "designer"
    assert "operator feedback" in (history[-1].get("rationale") or "").lower()


def test_operator_feedback_surfaces_in_prompt():
    """Operator notes must appear verbatim in the user prompt SI sends so the
    model can cite them when rewriting the role's system_override."""
    feedback = {
        "designer": [
            {"rating": "down", "note": "thumbnails too busy at small size"},
            {"rating": "up", "note": "love the flat-vector risograph palette"},
        ],
        "research": [
            {"rating": "down", "note": "niche too narrow, broader audience next time"},
        ],
    }
    _system, user = si_agent.build_si_prompt(
        "(no outcomes yet)", {}, feedback
    )
    assert "thumbnails too busy at small size" in user
    assert "love the flat-vector risograph palette" in user
    assert "niche too narrow" in user
    assert "HIGHEST PRIORITY" in user


def _seed_telegram_ratings(tmp_path, ratings: list[dict]) -> None:
    af = tmp_path / ".agent-factory"
    af.mkdir(parents=True, exist_ok=True)
    path = af / "ratings.jsonl"
    with path.open("w") as f:
        for r in ratings:
            f.write(json.dumps(r) + "\n")


def test_publisher_feedback_remaps_to_listing(tmp_path, monkeypatch):
    """Publisher isn't a VALID_ROLE — its feedback is silently dropped before
    this fix. Re-route to listing (the agent that authored the copy) so
    Activity-tab thumbs on publisher cards actually mutate a prompt."""
    monkeypatch.setenv("HOME", str(tmp_path))
    _seed_operator_feedback(tmp_path, {
        "publisher": [
            {"rating": "down", "note": "do not use emojis"},
            {"rating": "up", "note": None},
        ],
    })
    by_role = si_agent._load_operator_feedback_by_role()
    assert "publisher" not in by_role
    assert "listing" in by_role
    notes = [e.get("note") for e in by_role["listing"]]
    assert "do not use emojis" in notes


def test_orchestrator_feedback_remaps_to_research(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    _seed_operator_feedback(tmp_path, {
        "orchestrator": [{"rating": "down", "note": "same niche category twice"}],
    })
    by_role = si_agent._load_operator_feedback_by_role()
    assert "orchestrator" not in by_role
    assert "research" in by_role
    assert by_role["research"][0]["note"] == "same niche category twice"


def test_telegram_star_ratings_fan_out_to_designer_and_listing(tmp_path, monkeypatch):
    """Telegram star ratings live in ratings.jsonl and never reached SI
    before this fix. Stars 1-2 → down, 4-5 → up, 3 ignored. Each rating
    fans out to both designer and listing so the LLM can decide which to
    tweak based on which note pattern wins."""
    monkeypatch.setenv("HOME", str(tmp_path))
    _seed_telegram_ratings(tmp_path, [
        {"kind": "rating", "listing_id": 1, "stars": 1, "title": "bad mesh", "niche": "x"},
        {"kind": "rating", "listing_id": 2, "stars": 5, "title": "great", "niche": "y"},
        {"kind": "rating", "listing_id": 3, "stars": 3, "title": "meh", "niche": "z"},
    ])
    by_role = si_agent._load_operator_feedback_by_role()
    assert "designer" in by_role
    assert "listing" in by_role
    designer_ratings = [e["rating"] for e in by_role["designer"]]
    assert "down" in designer_ratings  # 1★
    assert "up" in designer_ratings    # 5★
    # 3★ ambiguous — must NOT appear
    assert len(designer_ratings) == 2
    assert by_role["designer"] == by_role["listing"]


def test_telegram_missing_jsonl_doesnt_crash(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    # No ratings.jsonl, no operator_feedback.json — both readers must be silent.
    assert si_agent._load_operator_feedback_by_role() == {}


def test_activity_and_telegram_signals_combine(tmp_path, monkeypatch):
    """Activity-tab feedback and Telegram ratings must layer cleanly —
    both visible to SI in the same cycle."""
    monkeypatch.setenv("HOME", str(tmp_path))
    _seed_operator_feedback(tmp_path, {
        "designer": [{"rating": "down", "note": "doesnt look complete"}],
    })
    _seed_telegram_ratings(tmp_path, [
        {"kind": "rating", "listing_id": 9, "stars": 1, "title": "ugly", "niche": "w"},
    ])
    by_role = si_agent._load_operator_feedback_by_role()
    designer_notes = [e.get("note") for e in by_role["designer"]]
    assert "doesnt look complete" in designer_notes
    # Telegram rating must coexist, not overwrite.
    assert any(n and "1★" in n for n in designer_notes)


def test_si_can_tune_cs_role(tmp_path, monkeypatch):
    """CS is now a valid SI target — operator feedback on customer-service
    replies must produce a CS prompt edit, not be silently dropped."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _seed_operator_feedback(tmp_path, {
        "cs": [{"rating": "down", "note": "replies sound robotic, more warmth"}],
    })

    new_system = (
        "You are the Customer Service agent. All replies should sound warm "
        "and human — open with empathy, never start with 'Hi! How can I help?'. "
        "Keep under 60 words. Return JSON only."
    )
    payload = _make_response_bytes(json.dumps({
        "role": "cs",
        "new_system": new_system,
        "reasoning": "operator: replies sound robotic",
    }))
    with patch("urllib.request.urlopen", _fake_urlopen(payload)):
        result = si_agent.process_job(101, {"trigger": "operator_rating"})

    assert result["ok"] is True
    assert result["role_tweaked"] == "cs"
    written = json.loads((tmp_path / ".agent-factory" / "prompts.json").read_text())
    assert written["cs"]["system_override"] == new_system


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


def test_tweak_preserves_operator_steers_and_strategist_metadata(tmp_path, monkeypatch):
    """Regression: SI used to overwrite the role dict wholesale, wiping the
    operator's standing instructions and the strategist's last-rationale
    metadata on every tweak. Merge semantics must keep both alive."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _seed_outcomes(str(tmp_path / ".agent-factory" / "outcomes.jsonl"), 8)
    prompts_path = tmp_path / ".agent-factory" / "prompts.json"
    os.makedirs(prompts_path.parent, exist_ok=True)
    prompts_path.write_text(json.dumps({
        "designer": {
            "system_override": "OLD",
            "operator_steers": ["make superhero figurines"],
            "last_strategist_rationale": "earlier rationale",
            "last_strategist_ts": 1700000000,
        },
    }))

    new_system = (
        "You are the Designer at an AI-run shop. Favor strong silhouettes. "
        "Return JSON only, no prose, no markdown."
    )
    payload = _make_response_bytes(json.dumps({
        "role": "designer",
        "new_system": new_system,
        "reasoning": "silhouettes convert better",
    }))
    with patch("urllib.request.urlopen", _fake_urlopen(payload)):
        result = si_agent.process_job(15, {})

    assert result["ok"] is True
    assert result["role_tweaked"] == "designer"
    written = json.loads(prompts_path.read_text())["designer"]
    assert written["system_override"] == new_system
    assert written["operator_steers"] == ["make superhero figurines"]
    assert written["last_strategist_rationale"] == "earlier rationale"
    assert written["last_strategist_ts"] == 1700000000


def test_rollback_preserves_operator_steers(tmp_path, monkeypatch):
    """Regression: rollback used to wholesale replace (or delete) the role
    dict, blowing away operator_steers. The revert must restore the prior
    system_override (or drop it) without touching unrelated sibling fields."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    outcomes_path = tmp_path / ".agent-factory" / "outcomes.jsonl"
    prompts_path = tmp_path / ".agent-factory" / "prompts.json"
    tweak_ts = 1000
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
        "designer": {
            "system_override": "BAD_PROMPT_THAT_HURT",
            "operator_steers": ["focus on dice towers"],
        },
    }))

    def _boom(*args, **kwargs):
        raise AssertionError("anthropic should NOT be called when rolling back")

    with patch("urllib.request.urlopen", side_effect=_boom):
        result = si_agent.process_job(16, {})

    assert result["role_tweaked"] == "rollback"
    written = json.loads(prompts_path.read_text())["designer"]
    # system_override should be gone (prior was {}), operator_steers must survive.
    assert "system_override" not in written
    assert written["operator_steers"] == ["focus on dice towers"]


def _seed_telegram_ratings_pre_post(
    path: str, pre_stars: list[int], post_stars: list[int], tweak_ts: int
) -> None:
    """Write ratings.jsonl with pre/post star samples spaced around tweak_ts.

    Mirrors _seed_outcomes_pre_post so the rating-rollback tests read clearly
    next to the existing revenue-rollback tests.
    """
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lines = []
    for i, s in enumerate(pre_stars):
        lines.append(json.dumps({
            "kind": "rating",
            "listing_id": 100 + i,
            "stars": int(s),
            "title": f"pre {i}",
            "rated_at": tweak_ts - len(pre_stars) + i,
        }))
    for i, s in enumerate(post_stars):
        lines.append(json.dumps({
            "kind": "rating",
            "listing_id": 200 + i,
            "stars": int(s),
            "title": f"post {i}",
            "rated_at": tweak_ts + 1 + i,
        }))
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")


def test_rating_rollback_fires_when_designer_stars_drop(tmp_path, monkeypatch):
    """With zero sales, revenue rollback can't fire. Star ratings must take
    its place when the tweak was to a role that affects listing quality."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    ratings_path = tmp_path / ".agent-factory" / "ratings.jsonl"
    prompts_path = tmp_path / ".agent-factory" / "prompts.json"
    tweak_ts = 2000
    # Pre avg = 4.33★, post avg = 1.33★ → 3★ drop, well past 0.75 threshold.
    _seed_telegram_ratings_pre_post(
        str(ratings_path), pre_stars=[4, 5, 4], post_stars=[1, 1, 2], tweak_ts=tweak_ts,
    )
    os.makedirs(prompts_path.parent, exist_ok=True)
    prompts_path.write_text(json.dumps({
        "_history": [
            {
                "ts": tweak_ts,
                "role_tweaked": "designer",
                "prior_overrides": {"designer": {}},
                "rationale": "earlier tweak that hurt quality",
            }
        ],
        "designer": {"system_override": "BAD_PROMPT_THAT_HURT_RATINGS"},
    }))

    def _boom(*args, **kwargs):
        raise AssertionError("anthropic should NOT be called when rolling back")

    with patch("urllib.request.urlopen", side_effect=_boom):
        result = si_agent.process_job(20, {})

    assert result["ok"] is True
    assert result["role_tweaked"] == "rollback"
    written = json.loads(prompts_path.read_text())
    assert "designer" not in written
    history = written["_history"]
    assert len(history) == 1
    assert history[0]["role_tweaked"] == "rollback"
    # Rationale must mention stars so a human auditing the loop can tell
    # which signal triggered the revert.
    assert "★" in history[0]["rationale"]


def test_rating_rollback_skipped_for_cs_tweak(tmp_path, monkeypatch):
    """CS doesn't author listings — Telegram star ratings can't be blamed on
    a CS tweak. Even with a big star drop, the cs override must NOT revert."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    ratings_path = tmp_path / ".agent-factory" / "ratings.jsonl"
    prompts_path = tmp_path / ".agent-factory" / "prompts.json"
    tweak_ts = 2000
    _seed_telegram_ratings_pre_post(
        str(ratings_path), pre_stars=[4, 5, 4], post_stars=[1, 1, 1], tweak_ts=tweak_ts,
    )
    # Need a small operator-feedback nudge to satisfy the outcomes gate so we
    # exercise the rollback path; otherwise SI returns "waiting for outcomes".
    _seed_operator_feedback(tmp_path, {
        "designer": [{"rating": "down", "note": "irrelevant"}],
    })
    os.makedirs(prompts_path.parent, exist_ok=True)
    prompts_path.write_text(json.dumps({
        "_history": [
            {
                "ts": tweak_ts,
                "role_tweaked": "cs",
                "prior_overrides": {"cs": {}},
                "rationale": "tweaked customer-service tone",
            }
        ],
        "cs": {"system_override": "CS_PROMPT_UNRELATED_TO_LISTING_QUALITY"},
    }))

    payload = _make_response_bytes(json.dumps({
        "role": None, "new_system": "", "reasoning": "no change",
    }))
    with patch("urllib.request.urlopen", _fake_urlopen(payload)):
        result = si_agent.process_job(21, {})

    # No rollback — the cs prompt must survive untouched.
    assert result["role_tweaked"] != "rollback"
    written = json.loads(prompts_path.read_text())
    assert written["cs"]["system_override"] == "CS_PROMPT_UNRELATED_TO_LISTING_QUALITY"


def test_rating_rollback_skipped_when_drop_too_small(tmp_path, monkeypatch):
    """A modest dip (e.g. 0.33★) is noise on a 5-point scale and must NOT
    trigger a revert — otherwise SI churns on natural rating variance."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    ratings_path = tmp_path / ".agent-factory" / "ratings.jsonl"
    prompts_path = tmp_path / ".agent-factory" / "prompts.json"
    tweak_ts = 2000
    # Pre 4.0, post 3.67 → 0.33★ drop, well below 0.75 threshold.
    _seed_telegram_ratings_pre_post(
        str(ratings_path), pre_stars=[4, 4, 4], post_stars=[4, 3, 4], tweak_ts=tweak_ts,
    )
    _seed_operator_feedback(tmp_path, {
        "designer": [{"rating": "up", "note": "looks good"}],
    })
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
        "designer": {"system_override": "GOOD_PROMPT"},
    }))

    payload = _make_response_bytes(json.dumps({
        "role": None, "new_system": "", "reasoning": "no change",
    }))
    with patch("urllib.request.urlopen", _fake_urlopen(payload)):
        result = si_agent.process_job(22, {})

    assert result["role_tweaked"] != "rollback"
    written = json.loads(prompts_path.read_text())
    assert written["designer"]["system_override"] == "GOOD_PROMPT"


def test_rating_rollback_skipped_when_insufficient_post_ratings(tmp_path, monkeypatch):
    """Need at least RATING_ROLLBACK_WINDOW post-tweak ratings before any
    rollback decision — otherwise one noisy 1★ would revert a fresh tweak."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    ratings_path = tmp_path / ".agent-factory" / "ratings.jsonl"
    prompts_path = tmp_path / ".agent-factory" / "prompts.json"
    tweak_ts = 2000
    # 3 pre, only 1 post — below window. Even though the one post is 1★, no rollback.
    _seed_telegram_ratings_pre_post(
        str(ratings_path), pre_stars=[5, 5, 5], post_stars=[1], tweak_ts=tweak_ts,
    )
    _seed_operator_feedback(tmp_path, {
        "designer": [{"rating": "down", "note": "irrelevant nudge to bypass gate"}],
    })
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
        "designer": {"system_override": "TWEAK_THAT_NEEDS_MORE_DATA"},
    }))

    payload = _make_response_bytes(json.dumps({
        "role": None, "new_system": "", "reasoning": "no change",
    }))
    with patch("urllib.request.urlopen", _fake_urlopen(payload)):
        result = si_agent.process_job(23, {})

    assert result["role_tweaked"] != "rollback"
    written = json.loads(prompts_path.read_text())
    assert written["designer"]["system_override"] == "TWEAK_THAT_NEEDS_MORE_DATA"


def test_revenue_rollback_still_preferred_when_sales_exist(tmp_path, monkeypatch):
    """When real sales data exists, the revenue rollback path must win —
    star ratings are the fallback for the cold-start window, not the primary."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    outcomes_path = tmp_path / ".agent-factory" / "outcomes.jsonl"
    ratings_path = tmp_path / ".agent-factory" / "ratings.jsonl"
    prompts_path = tmp_path / ".agent-factory" / "prompts.json"
    tweak_ts = 3000
    # Revenue clearly regressed → revenue rollback should fire and own the
    # rationale (mentioned in $, not ★).
    _seed_outcomes_pre_post(
        str(outcomes_path), [10, 10, 10, 10, 10], [3, 3, 3, 3, 3], tweak_ts,
    )
    _seed_telegram_ratings_pre_post(
        str(ratings_path), pre_stars=[4, 4, 4], post_stars=[4, 4, 4], tweak_ts=tweak_ts,
    )
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
        "designer": {"system_override": "PROMPT_THAT_HURT_REVENUE"},
    }))

    def _boom(*args, **kwargs):
        raise AssertionError("anthropic should NOT be called when rolling back")

    with patch("urllib.request.urlopen", side_effect=_boom):
        result = si_agent.process_job(24, {})

    assert result["role_tweaked"] == "rollback"
    written = json.loads(prompts_path.read_text())
    assert "designer" not in written
    history = written["_history"]
    # Rationale is the revenue one (uses $, not ★).
    assert "$" in history[0]["rationale"]
    assert "★" not in history[0]["rationale"]
