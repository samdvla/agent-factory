import json
from research.agent import (
    build_demand_brief_prompt,
    _infer_ip_risk,
    _normalize_brief,
)


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


def test_cycle_id_propagates(tmp_path, monkeypatch):
    """When inbound payload carries cycle_id, research echoes it into both
    the top-level result and the designer handoff payload. When absent, no
    cycle_id appears anywhere."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _capture_anthropic_system(monkeypatch)
    from research.agent import process_job

    cid = "abc123fixedhex456"
    result = process_job(7, {"niche_seed": "minimal art", "rationale": "trending", "cycle_id": cid})
    assert result["ok"] is True
    assert result.get("cycle_id") == cid
    assert result["handoff"]["payload"]["cycle_id"] == cid

    # Without cycle_id on input, nothing leaks downstream.
    result2 = process_job(8, {"niche_seed": "minimal art", "rationale": "trending"})
    assert result2["ok"] is True
    assert "cycle_id" not in result2


def test_infer_ip_risk_keyword_buckets():
    assert _infer_ip_risk("D&D goblin warrior mini") == "none"
    assert _infer_ip_risk("Naruto Uzumaki figurine") == "high"
    assert _infer_ip_risk("Star Wars stormtrooper helmet") == "high"
    assert _infer_ip_risk("Warhammer 40k space marine mini") == "high"
    assert _infer_ip_risk("Greek god Zeus bust") == "mythology"
    assert _infer_ip_risk("Cthulhu cosplay mask") == "mythology"
    assert _infer_ip_risk(None) == "none"
    assert _infer_ip_risk("") == "none"


def test_normalize_brief_backstops_ip_risk():
    """Model declares 'none' on an obvious franchise — backstop forces 'high'."""
    brief = {"niche": "Pikachu pendant", "ip_risk": "none"}
    _normalize_brief(brief)
    assert brief["ip_risk"] == "high"


def test_normalize_brief_respects_original_when_no_evidence():
    """Model says 'original' on a generic name — backstop has no evidence to
    override, so 'original' stands."""
    brief = {"niche": "Lunar Knight captain mini", "ip_risk": "original"}
    _normalize_brief(brief)
    assert brief["ip_risk"] == "original"


def test_normalize_brief_fills_missing_ip_risk():
    """Model omitted ip_risk entirely — we still produce a usable label."""
    brief = {"niche": "generic dragon mini"}
    _normalize_brief(brief)
    assert brief["ip_risk"] == "none"


def test_3d_system_prompt_mentions_ip_risk():
    """The 3D research system prompt must teach the model about ip_risk so
    the field gets populated honestly, not via heuristic fallback only."""
    system, _ = build_demand_brief_prompt(product_type_preference="stl_file")
    assert "ip_risk" in system.lower() or "IP_RISK" in system


# ────────────────────────────────────────────────────────────────────────
# Bundle normalization — phase 2 of the bundles-first push.
# ────────────────────────────────────────────────────────────────────────


def test_3d_system_prompt_mentions_bundles():
    """The 3D system prompt must teach the model how / when to emit bundles."""
    system, _ = build_demand_brief_prompt(product_type_preference="stl_file")
    assert "BUNDLE" in system or "bundle" in system
    # The schema must include the bundle field so the model knows it's an
    # available output slot.
    assert "bundle" in system


def test_normalize_bundle_passes_clean_bundle_through(monkeypatch):
    """A well-formed bundle on a 3D brief survives normalization."""
    monkeypatch.delenv("BUNDLE_GENERATION_ENABLED", raising=False)
    brief = {
        "niche": "egyptian altar trio",
        "product_type": "stl_file",
        "bundle": {
            "items": ["Anubis bust", "Bastet bust", "Ra bust"],
            "shared_theme": "egyptian altar",
        },
    }
    _normalize_brief(brief)
    assert isinstance(brief["bundle"], dict)
    assert brief["bundle"]["items"] == ["Anubis bust", "Bastet bust", "Ra bust"]
    assert brief["bundle"]["shared_theme"] == "egyptian altar"


def test_normalize_bundle_strips_when_2d():
    """2D product types never get bundles — bundles are about multi-file
    STL listings on Etsy + Cults3D. A 2D brief with a stray bundle field
    must be silently stripped."""
    brief = {
        "niche": "boho stickers",
        "product_type": "sticker",
        "bundle": {"items": ["a", "b", "c"]},
    }
    _normalize_brief(brief)
    assert brief["bundle"] is None


def test_normalize_bundle_strips_when_disabled(monkeypatch):
    """BUNDLE_GENERATION_ENABLED=0 must strip the bundle field entirely so
    the designer never burns Tripo/Meshy credits on bundle expansion."""
    monkeypatch.setenv("BUNDLE_GENERATION_ENABLED", "0")
    brief = {
        "niche": "egyptian altar trio",
        "product_type": "stl_file",
        "bundle": {"items": ["Anubis bust", "Bastet bust", "Ra bust"]},
    }
    _normalize_brief(brief)
    assert brief["bundle"] is None


def test_normalize_bundle_strips_too_short():
    """A 'bundle' of 1 item is just a single — must be stripped so the
    listing-side bundle copy doesn't get applied to a single-file listing."""
    brief = {
        "niche": "x",
        "product_type": "stl_file",
        "bundle": {"items": ["only one"]},
    }
    _normalize_brief(brief)
    assert brief["bundle"] is None


def test_normalize_bundle_caps_at_max():
    """Schema allows up to 6 items but the realistic ceiling is 6 — anything
    above gets truncated so we don't blow the Tripo/Meshy spend budget on
    a single cycle."""
    brief = {
        "niche": "modular dungeon set",
        "product_type": "stl_file",
        "bundle": {"items": [f"item{i}" for i in range(10)]},
    }
    _normalize_brief(brief)
    assert isinstance(brief["bundle"], dict)
    assert len(brief["bundle"]["items"]) == 6


def test_normalize_bundle_dedupes_items():
    """Duplicate item names sneak in if the model loses focus — dedup so
    designer doesn't generate the same item twice."""
    brief = {
        "niche": "x",
        "product_type": "stl_file",
        "bundle": {"items": ["wolf pendant", "Wolf Pendant", "raven pendant"]},
    }
    _normalize_brief(brief)
    assert isinstance(brief["bundle"], dict)
    # Deduped case-insensitively
    names_lower = [s.lower() for s in brief["bundle"]["items"]]
    assert len(names_lower) == len(set(names_lower))
    assert "wolf pendant" in names_lower
    assert "raven pendant" in names_lower


def test_normalize_bundle_fills_missing_theme():
    """When the model omits shared_theme, we fall back to the niche so the
    listing copy has something to render."""
    brief = {
        "niche": "egyptian altar trio",
        "product_type": "stl_file",
        "bundle": {"items": ["Anubis", "Bastet", "Ra"]},
    }
    _normalize_brief(brief)
    assert brief["bundle"]["shared_theme"] == "egyptian altar trio"


def test_normalize_bundle_none_when_missing():
    """No bundle on the brief → field gets set to None so downstream readers
    can rely on the key existing."""
    brief = {"niche": "x", "product_type": "stl_file"}
    _normalize_brief(brief)
    assert brief["bundle"] is None


def test_rejection_avoid_block_injects_into_system(tmp_path, monkeypatch):
    """When rejections.json is present, the system prompt sent to Anthropic
    must contain an AVOID block listing the rejected niches/titles."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    af_dir = tmp_path / ".agent-factory"
    af_dir.mkdir()
    (af_dir / "rejections.json").write_text(json.dumps({
        "rejections": [
            {"title": "Ugly goblin warrior STL", "niche": "dnd minis"},
            {"title": "Generic dragon bust", "niche": None},
        ]
    }))

    captured = _capture_anthropic_system(monkeypatch)
    from research.agent import call_anthropic
    call_anthropic("k-test")
    system = captured["body"]["system"]
    assert "AVOID" in system
    assert "dnd minis" in system
    assert "Ugly goblin warrior STL" in system
    assert "Generic dragon bust" in system


def test_rejection_avoid_block_no_file_is_noop(tmp_path, monkeypatch):
    """Missing rejections.json must NOT crash and must NOT inject an AVOID block."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    captured = _capture_anthropic_system(monkeypatch)
    from research.agent import call_anthropic
    call_anthropic("k-test")
    # The rejection-avoid block prefix is the unique marker (the bare word
    # "AVOID" also appears in the baseline as a section header for proven-
    # loser niches, so we need the prefix to discriminate).
    assert "AVOID — the operator already rejected" not in captured["body"]["system"]


def test_rejection_avoid_block_malformed_file_is_noop(tmp_path, monkeypatch):
    """Malformed rejections.json must NOT crash — the helper returns []."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    af_dir = tmp_path / ".agent-factory"
    af_dir.mkdir()
    (af_dir / "rejections.json").write_text("not json {")
    captured = _capture_anthropic_system(monkeypatch)
    from research.agent import call_anthropic
    call_anthropic("k-test")
    # The rejection-avoid block prefix is the unique marker (the bare word
    # "AVOID" also appears in the baseline as a section header for proven-
    # loser niches, so we need the prefix to discriminate).
    assert "AVOID — the operator already rejected" not in captured["body"]["system"]


def test_loose_json_handles_trailing_prose():
    """Regression test for the 2026-05-12 pipeline halt: Claude returned
    valid JSON followed by an explanatory paragraph. Bare json.loads raised
    'Extra data: line N col 1', the research worker crashed, designer never
    received a handoff, and only orchestrator + research avatars moved.
    The loose parser must ignore everything after the matching closing brace."""
    from research.agent import _parse_loose_json_object

    body = (
        '{"niche": "norse god bust", "keywords": ["thor"], '
        '"price_band_usd": [6, 12], "product_type": "stl_file", '
        '"design_direction": "heroic profile", "ip_risk": "mythology", '
        '"competition": "medium", "rationale": "demand exists"}\n\n'
        "This brief targets the tabletop mini market. Let me know if "
        "you want adjustments."
    )
    out = _parse_loose_json_object(body)
    assert out["niche"] == "norse god bust"
    assert out["ip_risk"] == "mythology"


def test_loose_json_repairs_newline_inside_string():
    """Regression for 'Expecting comma delimiter' from 2026-05-12 17:17:
    Haiku occasionally emits a string value with a literal newline mid-
    paragraph. The naive parser fails at the newline; the repair pass
    must collapse it into a space and parse cleanly."""
    from research.agent import _parse_loose_json_object

    body = (
        '{"niche": "test", "design_direction": "stylized cartoon mini\n'
        'with sweeping cape and dynamic pose", "competition": "low"}'
    )
    out = _parse_loose_json_object(body)
    assert out["niche"] == "test"
    assert "sweeping cape" in out["design_direction"]
    assert out["competition"] == "low"


def test_loose_json_repairs_trailing_comma():
    """Trailing commas before ] or } are common Claude breakage; the
    repair pass must strip them rather than re-raise."""
    from research.agent import _parse_loose_json_object

    body = '{"keywords": ["a", "b", "c",], "competition": "low",}'
    out = _parse_loose_json_object(body)
    assert out["keywords"] == ["a", "b", "c"]
    assert out["competition"] == "low"


def test_loose_json_handles_fence_and_trailing_prose():
    """Same regression but with a ```json fence wrapping the object."""
    from research.agent import _parse_loose_json_object

    body = (
        "```json\n"
        '{"niche": "yokai keychain", "keywords": [], "price_band_usd": [4, 8], '
        '"product_type": "stl_file", "design_direction": "x", '
        '"ip_risk": "mythology", "competition": "low", "rationale": "y"}\n'
        "```\n\n"
        "Hope this helps!"
    )
    out = _parse_loose_json_object(body)
    assert out["niche"] == "yokai keychain"


def test_normalize_brief_realism_forces_high_ip_risk():
    """Realism mode = real-person likeness or licensed character, so the
    publisher must hold the draft for operator approval. We enforce this
    by overriding ip_risk to 'high' regardless of what the model self-
    declared, mirroring the mature_content backstop pattern."""
    brief = {"niche": "lebron james figurine", "mode": "realism", "ip_risk": "none"}
    _normalize_brief(brief)
    assert brief["mode"] == "realism"
    assert brief["ip_risk"] == "high"


def test_normalize_brief_default_mode_is_creative():
    brief = {"niche": "wizard figurine"}
    _normalize_brief(brief)
    assert brief["mode"] == "creative"


def test_normalize_brief_invalid_mode_falls_back_to_creative():
    brief = {"niche": "x", "mode": "freestyle"}
    _normalize_brief(brief)
    assert brief["mode"] == "creative"


def test_normalize_brief_realism_subject_env_overrides_mode(monkeypatch):
    """Settings → Realism Mode writes the realism_subject secret; Tauri
    forwards it as REALISM_SUBJECT env. A non-empty env value flips the
    brief to realism mode regardless of what the model declared, and
    populates realism_subject so the designer's search query is the
    operator's choice (not the niche string)."""
    monkeypatch.setenv("REALISM_SUBJECT", "Lebron James")
    brief = {"niche": "athlete figurine", "mode": "creative"}
    _normalize_brief(brief)
    assert brief["mode"] == "realism"
    assert brief["ip_risk"] == "high"
    assert brief["realism_subject"] == "Lebron James"


def test_normalize_brief_empty_realism_subject_env_stays_creative(monkeypatch):
    monkeypatch.setenv("REALISM_SUBJECT", "   ")
    brief = {"niche": "wizard figurine"}
    _normalize_brief(brief)
    assert brief["mode"] == "creative"
