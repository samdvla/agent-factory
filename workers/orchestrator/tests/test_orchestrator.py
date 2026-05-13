import json
import os
from unittest.mock import patch

from orchestrator import agent as orch_agent
from orchestrator.agent import build_orchestrator_prompt


def test_prompt_includes_niche_seed():
    system, user = build_orchestrator_prompt()
    assert "niche_seed" in system
    assert "Etsy" in system


def test_prompt_returns_strings():
    system, user = build_orchestrator_prompt()
    assert isinstance(system, str)
    assert isinstance(user, str)
    assert "niche" in user.lower()


# --- niche memory tests ---


def _make_response_bytes(text: str, in_tokens: int = 100, out_tokens: int = 50) -> bytes:
    body = {
        "content": [{"type": "text", "text": text}],
        "usage": {"input_tokens": in_tokens, "output_tokens": out_tokens},
    }
    return json.dumps(body).encode("utf-8")


class _CapturingResp:
    def __init__(self, payload_bytes: bytes, captured: list[bytes]):
        self._payload = payload_bytes
        self._captured = captured

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self):
        return self._payload


def _capture_urlopen(payload_bytes: bytes, captured: list[bytes]):
    """Return a urlopen replacement that records the request body."""

    def _open(req, *a, **kw):
        try:
            captured.append(req.data)
        except Exception:
            captured.append(b"")
        return _CapturingResp(payload_bytes, captured)

    return _open


def _seed_outcomes(path: str, rows: list[dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")


def _orch_response_payload() -> bytes:
    return _make_response_bytes(json.dumps({
        "niche_seed": "wedding seating chart svg",
        "rationale": "high demand right now",
        "target_audience": "engaged couples planning DIY weddings",
    }))


def _extract_user_prompt(captured: list[bytes]) -> str:
    assert captured, "no request captured"
    body = json.loads(captured[0])
    msgs = body.get("messages") or []
    assert msgs, "no messages in body"
    return msgs[0]["content"]


def _extract_system_prompt(captured: list[bytes]) -> str:
    assert captured, "no request captured"
    body = json.loads(captured[0])
    return body.get("system") or ""


def _seed_prompts(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)


def test_niche_context_threaded_when_outcomes_present(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    outcomes_path = tmp_path / ".agent-factory" / "outcomes.jsonl"
    rows = [
        # Top niche: minimalist line art — avg ~$15
        {"ts": 1, "niche": "minimalist line art", "sales": 1, "revenue_usd": 14.0},
        {"ts": 2, "niche": "minimalist line art", "sales": 1, "revenue_usd": 16.0},
        {"ts": 3, "niche": "minimalist line art", "sales": 1, "revenue_usd": 15.0},
        # Mid: boho macrame — avg ~$8
        {"ts": 4, "niche": "boho macrame prints", "sales": 1, "revenue_usd": 8.0},
        {"ts": 5, "niche": "boho macrame prints", "sales": 1, "revenue_usd": 8.0},
        # Bottom: vintage typography — avg $1
        {"ts": 6, "niche": "vintage typography", "sales": 0, "revenue_usd": 1.0},
        {"ts": 7, "niche": "vintage typography", "sales": 0, "revenue_usd": 1.0},
        {"ts": 8, "niche": "vintage typography", "sales": 0, "revenue_usd": 1.0},
        {"ts": 9, "niche": "vintage typography", "sales": 0, "revenue_usd": 1.0},
        {"ts": 10, "niche": "vintage typography", "sales": 0, "revenue_usd": 1.0},
    ]
    _seed_outcomes(str(outcomes_path), rows)

    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    user_prompt = _extract_user_prompt(captured)
    assert "Recent shop performance:" in user_prompt
    assert "Top performers" in user_prompt
    assert "minimalist line art" in user_prompt
    assert "Underperformers" in user_prompt
    assert "vintage typography" in user_prompt


def test_falls_back_to_default_prompt_with_no_outcomes(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    # Do NOT create outcomes.jsonl.

    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 2})

    assert result["ok"] is True
    user_prompt = _extract_user_prompt(captured)
    assert "Recent shop performance" not in user_prompt
    assert "Top performers" not in user_prompt
    # Matches the existing prompt shape.
    assert "Pick the next niche to pursue" in user_prompt


def test_cycle_id_threaded(tmp_path, monkeypatch):
    """Orchestrator is head of pipeline — it generates a fresh cycle_id and
    threads it into both the result top-level and the research handoff."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 99, "payload": {}})

    assert result["ok"] is True
    assert "cycle_id" in result
    cid = result["cycle_id"]
    # uuid4().hex is 32 hex chars.
    assert isinstance(cid, str) and len(cid) >= 16
    # Each call generates a fresh id — caller-provided ids must be ignored.
    captured2: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured2)):
        result2 = orch_agent.handle("process_job", {"job_id": 100, "payload": {"cycle_id": "stale-prev"}})
    assert result2["cycle_id"] != "stale-prev"
    assert result2["cycle_id"] != cid
    # Handoff carries the same id as the top-level result.
    assert result["handoff"]["payload"]["cycle_id"] == cid


def test_3d_prompt_enumerates_all_character_pools_by_default(monkeypatch):
    """Default character_pool=all → 3D system prompt must enumerate every
    archetype tier so the orchestrator rotates across them instead of
    over-picking one."""
    monkeypatch.setenv("SHOP_FOCUS", "3d_only")
    monkeypatch.delenv("CHARACTER_POOL", raising=False)
    system, _ = build_orchestrator_prompt(target_product_type="stl_file")
    assert "ORIGINAL ANIME" in system
    assert "MYTHOLOGY" in system
    assert "OWN-UNIVERSE" in system
    assert "POPULAR-IP" in system
    assert "HIGH IP RISK" in system


def test_3d_prompt_restricts_to_single_pool(monkeypatch):
    """Setting CHARACTER_POOL=mythology should drop the other pool sections."""
    monkeypatch.setenv("SHOP_FOCUS", "3d_only")
    monkeypatch.setenv("CHARACTER_POOL", "mythology")
    system, _ = build_orchestrator_prompt(target_product_type="stl_file")
    assert "MYTHOLOGY" in system
    assert "ORIGINAL ANIME" not in system
    assert "POPULAR-IP" not in system


def test_3d_prompt_omits_popular_ip_when_excluded(monkeypatch):
    monkeypatch.setenv("SHOP_FOCUS", "3d_only")
    monkeypatch.setenv("CHARACTER_POOL", "original_anime")
    system, _ = build_orchestrator_prompt(target_product_type="stl_file")
    assert "ORIGINAL ANIME" in system
    assert "POPULAR-IP" not in system


def test_falls_back_when_too_few_outcomes(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    outcomes_path = tmp_path / ".agent-factory" / "outcomes.jsonl"
    rows = [
        {"ts": 1, "niche": "minimalist line art", "sales": 1, "revenue_usd": 10.0},
        {"ts": 2, "niche": "boho macrame prints", "sales": 1, "revenue_usd": 8.0},
        {"ts": 3, "niche": "vintage typography", "sales": 0, "revenue_usd": 1.0},
    ]
    _seed_outcomes(str(outcomes_path), rows)

    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 3})

    assert result["ok"] is True
    user_prompt = _extract_user_prompt(captured)
    assert "Recent shop performance" not in user_prompt
    assert "Pick the next niche to pursue" in user_prompt


# --- operator steer tests ---
#
# The orchestrator is the agent that actually picks the niche_seed each
# cycle. Research/designer/listing only elaborate on what the orchestrator
# hands them, so operator_steers MUST land on the orchestrator or they get
# silently overridden by the orchestrator's hardcoded category list.


def test_orchestrator_role_steer_appended_to_system_prompt(tmp_path, monkeypatch):
    """Steers saved under prompts.json['orchestrator']['operator_steers']
    appear as the final OPERATOR OVERRIDE block in the orchestrator's
    system prompt."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _seed_prompts(
        str(tmp_path / ".agent-factory" / "prompts.json"),
        {
            "orchestrator": {
                "operator_steers": [
                    "focus on superhero and supervillain archetypes this week",
                ],
            },
        },
    )
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    system_prompt = _extract_system_prompt(captured)
    assert "OPERATOR OVERRIDE" in system_prompt
    assert "superhero and supervillain" in system_prompt
    # Operator block must be LAST — last tokens carry strongest attention.
    assert system_prompt.rstrip().endswith("superhero and supervillain archetypes this week")


def test_research_steers_propagate_into_orchestrator_prompt(tmp_path, monkeypatch):
    """Back-compat path: users intuitively click Steer on Research when they
    mean 'find me ideas matching X'. Those steers must propagate up to the
    orchestrator (the agent that actually picks the niche) or they silently
    do nothing."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _seed_prompts(
        str(tmp_path / ".agent-factory" / "prompts.json"),
        {
            "research": {
                "operator_steers": [
                    "research popular superheros and supervillains like characters in the boys",
                ],
            },
        },
    )
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    system_prompt = _extract_system_prompt(captured)
    assert "OPERATOR OVERRIDE" in system_prompt
    assert "superheros and supervillains" in system_prompt


def test_no_steers_means_no_operator_override_block(tmp_path, monkeypatch):
    """Empty steer arrays / missing prompts.json must NOT inject an empty
    OPERATOR OVERRIDE block — keeps the prompt clean when nothing's set."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    system_prompt = _extract_system_prompt(captured)
    assert "OPERATOR OVERRIDE" not in system_prompt


# --- rejection-list tests ---
#
# When the operator clicks Reject on a draft, Rust writes the niche+title
# to ~/.agent-factory/rejections.json. Research already consumes this list,
# but research only ELABORATES on the orchestrator's pick — so without
# orchestrator also reading rejections, the operator sees variants of the
# direction they just rejected on the next cycle.


def _seed_rejections(path: str, entries: list[dict]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"rejections": entries}, f)


def test_rejections_inject_avoid_block(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _seed_rejections(
        str(tmp_path / ".agent-factory" / "rejections.json"),
        [
            {"title": "Lovecraftian Dice Tower STL | Cosmic Horror 3D",
             "niche": "Lovecraftian dice tower"},
            {"title": "Cthulhu Tentacle Dice Tray",
             "niche": "Cthulhu mythos dice tray"},
        ],
    )
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    system_prompt = _extract_system_prompt(captured)
    assert "AVOID" in system_prompt
    assert "Lovecraftian dice tower" in system_prompt
    assert "Cthulhu Tentacle Dice Tray" in system_prompt


def test_no_rejections_means_no_avoid_block(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    system_prompt = _extract_system_prompt(captured)
    # Pre-existing prompt may use the word "AVOID:" in its built-in
    # category list; the rejection block uses an em-dash variant. Assert
    # the rejection-block-specific phrasing is NOT present.
    assert "the operator already rejected these ideas" not in system_prompt


def test_malformed_rejections_file_is_noop(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    af_dir = tmp_path / ".agent-factory"
    af_dir.mkdir()
    (af_dir / "rejections.json").write_text("not json {")
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    system_prompt = _extract_system_prompt(captured)
    assert "the operator already rejected these ideas" not in system_prompt


# --- views/favorites bucketing tests ---


def test_promising_bucket_surfaces_traction_without_revenue(tmp_path, monkeypatch):
    """A niche with views but no sales must NOT be lumped into Underperformers —
    it's a listing/price problem, not niche death. The Promising bucket surfaces
    it as a retry-with-different-angle candidate."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    outcomes_path = tmp_path / ".agent-factory" / "outcomes.jsonl"
    rows = [
        # Earner: priced low but real revenue
        {"ts": 1, "niche": "rune wolf pendant", "sales": 1, "revenue_usd": 7.0, "views": 80, "favorites": 12},
        {"ts": 2, "niche": "rune wolf pendant", "sales": 1, "revenue_usd": 7.0, "views": 90, "favorites": 14},
        # Promising: heavy views, ZERO sales
        {"ts": 3, "niche": "tentacle dice tray", "sales": 0, "revenue_usd": 0.0, "views": 200, "favorites": 32},
        {"ts": 4, "niche": "tentacle dice tray", "sales": 0, "revenue_usd": 0.0, "views": 220, "favorites": 28},
        # Dead: zero views, zero sales
        {"ts": 5, "niche": "Christmas ornament bust", "sales": 0, "revenue_usd": 0.0, "views": 2, "favorites": 0},
        {"ts": 6, "niche": "Christmas ornament bust", "sales": 0, "revenue_usd": 0.0, "views": 1, "favorites": 0},
    ]
    _seed_outcomes(str(outcomes_path), rows)
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    user_prompt = _extract_user_prompt(captured)
    assert "Promising" in user_prompt
    assert "tentacle dice tray" in user_prompt
    # The earner appears in top performers with traction rendered
    assert "rune wolf pendant" in user_prompt
    # Traction columns render
    assert "v" in user_prompt  # views suffix
    assert "f" in user_prompt  # favorites suffix


def test_outcomes_without_traction_keep_legacy_top_bottom_shape(tmp_path, monkeypatch):
    """Outcomes with no views/favorites fields must NOT crash and must still
    produce the legacy top/underperformer rendering. Back-compat with the
    current schema in production (outcomes.jsonl has no traction fields yet)."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    outcomes_path = tmp_path / ".agent-factory" / "outcomes.jsonl"
    rows = [
        {"ts": 1, "niche": "minimalist line art", "sales": 1, "revenue_usd": 14.0},
        {"ts": 2, "niche": "minimalist line art", "sales": 1, "revenue_usd": 16.0},
        {"ts": 3, "niche": "boho macrame prints", "sales": 1, "revenue_usd": 8.0},
        {"ts": 4, "niche": "boho macrame prints", "sales": 1, "revenue_usd": 8.0},
        {"ts": 5, "niche": "vintage typography", "sales": 0, "revenue_usd": 1.0},
        {"ts": 6, "niche": "vintage typography", "sales": 0, "revenue_usd": 1.0},
    ]
    _seed_outcomes(str(outcomes_path), rows)
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    user_prompt = _extract_user_prompt(captured)
    assert "Top performers" in user_prompt
    assert "Underperformers" in user_prompt
    assert "Promising" not in user_prompt  # no traction data → no promising bullet


# --- strategist_notes (meta-strategist) tests ---


def test_strategist_notes_appended_to_user_prompt(tmp_path, monkeypatch):
    """When the meta-strategist has written orchestrator.strategist_notes
    into prompts.json, the orchestrator must append them to the user prompt
    as the LAST block before the final 'Pick the next niche' instruction."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    notes = (
        "Mythology niches are saturating — last 5 cycles averaged $0.50. "
        "Bias scale up: 80mm desk pieces are converting where 28mm minis stall."
    )
    _seed_prompts(
        str(tmp_path / ".agent-factory" / "prompts.json"),
        {"orchestrator": {"strategist_notes": notes}},
    )
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    user_prompt = _extract_user_prompt(captured)
    assert "STRATEGIST NOTES" in user_prompt
    assert "Mythology niches are saturating" in user_prompt
    # The notes block must precede the final 'Pick the next niche' line.
    pick_pos = user_prompt.find("Pick the next niche to pursue")
    notes_pos = user_prompt.find("STRATEGIST NOTES")
    assert notes_pos != -1 and pick_pos != -1 and notes_pos < pick_pos


def test_no_strategist_notes_means_no_block(tmp_path, monkeypatch):
    """Missing or empty strategist_notes must NOT inject the block."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    user_prompt = _extract_user_prompt(captured)
    assert "STRATEGIST NOTES" not in user_prompt


# --- trend signal tests ---


def test_trend_signals_inject_when_fetcher_returns_text(tmp_path, monkeypatch):
    """When the trend fetcher returns content, the user prompt gets a LIVE
    TREND SIGNALS block. Conftest disables trends by default; this test
    re-enables and stubs the fetcher to return a deterministic payload so
    no network call escapes."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    monkeypatch.setenv("ORCHESTRATOR_TREND_SIGNALS", "1")
    # Stub the package-level trends import so _fetch_trend_signals_text gets
    # a synthetic payload — never touches the network.
    monkeypatch.setattr(
        "orchestrator.trends.fetch_all_signals",
        lambda top_n=20: [
            {"title": "minecraft moss village build", "score": 87, "source": "reddit", "url": None},
            {"title": "ghibli totoro plushie", "score": 62, "source": "youtube", "url": None},
        ],
    )
    monkeypatch.setattr(
        "orchestrator.trends.format_for_prompt",
        lambda signals: "  [reddit ▲87] minecraft moss village build\n  [youtube ▲62] ghibli totoro plushie",
    )
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    user_prompt = _extract_user_prompt(captured)
    assert "LIVE TREND SIGNALS" in user_prompt
    assert "minecraft moss village build" in user_prompt
    assert "ghibli totoro plushie" in user_prompt


def test_trend_signals_disabled_when_env_var_zero(tmp_path, monkeypatch):
    """Conftest sets ORCHESTRATOR_TREND_SIGNALS=0 by default — the user prompt
    must NOT contain the trend block, and the fetcher must not be invoked."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    # Conftest has already set ORCHESTRATOR_TREND_SIGNALS=0.
    called = {"n": 0}

    def _explode(*a, **kw):
        called["n"] += 1
        raise AssertionError("fetch_all_signals must not run when env=0")

    monkeypatch.setattr("orchestrator.trends.fetch_all_signals", _explode)
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    user_prompt = _extract_user_prompt(captured)
    assert "LIVE TREND SIGNALS" not in user_prompt
    assert called["n"] == 0


def test_trend_signal_fetch_failure_is_silent(tmp_path, monkeypatch):
    """If the trend fetcher raises, the orchestrator must still complete the
    cycle. The prompt simply won't carry a trend block — best-effort."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    monkeypatch.setenv("ORCHESTRATOR_TREND_SIGNALS", "1")

    def _boom(*a, **kw):
        raise RuntimeError("simulated network failure")

    monkeypatch.setattr("orchestrator.trends.fetch_all_signals", _boom)
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    user_prompt = _extract_user_prompt(captured)
    assert "LIVE TREND SIGNALS" not in user_prompt


def test_orchestrator_and_research_steers_merge_and_dedupe(tmp_path, monkeypatch):
    """When both orchestrator and research carry steers, all unique entries
    appear (no duplicates if they happen to overlap)."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _seed_prompts(
        str(tmp_path / ".agent-factory" / "prompts.json"),
        {
            "orchestrator": {
                "operator_steers": ["pivot toward kitchen accessories"],
            },
            "research": {
                "operator_steers": [
                    "Pivot Toward Kitchen Accessories",  # case-diff duplicate
                    "also include pet memorial figurines",
                ],
            },
        },
    )
    captured: list[bytes] = []
    with patch("urllib.request.urlopen", side_effect=_capture_urlopen(_orch_response_payload(), captured)):
        result = orch_agent.handle("process_job", {"job_id": 1})

    assert result["ok"] is True
    system_prompt = _extract_system_prompt(captured)
    # Orchestrator's own steer wins the dedupe and appears first.
    assert system_prompt.count("kitchen accessories") == 1
    assert "pet memorial figurines" in system_prompt


# --- steer-image size cap tests ---

def _write_prompts(tmp_path, prompts: dict) -> None:
    af = tmp_path / ".agent-factory"
    af.mkdir(parents=True, exist_ok=True)
    (af / "prompts.json").write_text(json.dumps(prompts))


def test_oversize_steer_image_is_skipped(tmp_path, monkeypatch):
    """Anthropic caps each base64 image at 5 MB on the wire. Before this fix
    the orchestrator base64-encoded any size and HTTP 400'd on big steer
    refs (saw 6.5 MB → 5 MB cap blow-up in prod). Oversize images must be
    skipped with the steer's TEXT still applied via the system prompt."""
    monkeypatch.setenv("HOME", str(tmp_path))
    big_img = tmp_path / "huge.png"
    # 4 MB raw → ~5.3 MB base64 — over Anthropic's 5 MB image cap.
    big_img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * (4 * 1024 * 1024))
    _write_prompts(tmp_path, {
        "orchestrator": {
            "operator_steers": [
                {"text": "study this style", "image_paths": [str(big_img)]},
            ],
        },
    })

    result = orch_agent._build_user_content_with_steer_images(
        "PROMPT_BODY", roles=["orchestrator"]
    )
    # Every image was oversize → fall back to plain text (no multimodal
    # blocks), so the request body stays small and Anthropic-clean.
    assert result == "PROMPT_BODY"


def test_under_cap_steer_image_still_attaches(tmp_path, monkeypatch):
    """Sanity check the cap didn't break the happy path. An image under
    3.5 MB raw must still produce the multimodal content blocks."""
    monkeypatch.setenv("HOME", str(tmp_path))
    small_img = tmp_path / "small.png"
    small_img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 1024)
    _write_prompts(tmp_path, {
        "orchestrator": {
            "operator_steers": [
                {"text": "match this silhouette", "image_paths": [str(small_img)]},
            ],
        },
    })

    result = orch_agent._build_user_content_with_steer_images(
        "PROMPT_BODY", roles=["orchestrator"]
    )
    assert isinstance(result, list)
    image_blocks = [b for b in result if b.get("type") == "image"]
    assert len(image_blocks) == 1
    text_blocks = [b for b in result if b.get("type") == "text"]
    # Caption block + final user prompt.
    assert any("PROMPT_BODY" in b.get("text", "") for b in text_blocks)


def test_mixed_oversize_and_okay_steer_images(tmp_path, monkeypatch):
    """When one steer image is oversize and one is okay, the okay one must
    still attach. Otherwise a single bad attachment poisons the whole batch."""
    monkeypatch.setenv("HOME", str(tmp_path))
    big_img = tmp_path / "big.png"
    big_img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * (4 * 1024 * 1024))
    small_img = tmp_path / "small.png"
    small_img.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 1024)
    _write_prompts(tmp_path, {
        "orchestrator": {
            "operator_steers": [
                {"text": "skip me", "image_paths": [str(big_img)]},
                {"text": "use me", "image_paths": [str(small_img)]},
            ],
        },
    })

    result = orch_agent._build_user_content_with_steer_images(
        "PROMPT_BODY", roles=["orchestrator"]
    )
    assert isinstance(result, list)
    image_blocks = [b for b in result if b.get("type") == "image"]
    # Only the small image survives.
    assert len(image_blocks) == 1
