import json
import os
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
        # Only capture the FIRST call — that's the designer Sonnet call
        # these tests are asserting against. The 3D path may fire a follow-
        # up Haiku critique call (and a Sonnet revision if critique fails);
        # those use a different system prompt and would otherwise overwrite
        # the body we want to inspect.
        if "body" not in captured:
            captured["body"] = json.loads(req.data.decode("utf-8"))
        return _Resp()

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)
    return captured


def test_override_keeps_philosophy_and_reappends_schema(tmp_path, monkeypatch):
    """Strategist may overwrite the design-philosophy layer, but the
    JSON-schema contract must always survive. Regression for: 'designer
    job #N failed: Expecting property name enclosed in double quotes:
    line 1 column 2 (char 1)' — caused by an override that dropped the
    schema directive, letting Haiku emit prose after the prefilled '{'."""
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
    sent = captured["body"]["system"]
    assert override_text.strip() in sent, "philosophy override must be preserved"
    assert "asset_type" in sent, "schema must be re-appended even with override"
    assert "JSON only" in sent, "JSON-only directive must be re-appended even with override"


def test_override_with_3d_brief_uses_3d_schema(tmp_path, monkeypatch):
    """Override path must use the 3D schema (stl_file/3d_model) when the
    brief is 3D — otherwise the 2D enum sneaks back in and the downstream
    pipeline rejects the asset_type."""
    monkeypatch.setenv("HOME", str(tmp_path))
    af_dir = tmp_path / ".agent-factory"
    af_dir.mkdir()
    (af_dir / "prompts.json").write_text(json.dumps({
        "designer": {"system_override": "tune the philosophy"},
    }))

    captured = _capture_anthropic_system(monkeypatch)
    from designer.agent import call_anthropic
    call_anthropic("k-test", {"niche": "dragon mini", "product_type": "stl_file"})
    sent = captured["body"]["system"]
    assert "stl_file" in sent
    assert "printable | svg" not in sent, "2D enum must not leak into 3D path"


def test_no_override_uses_default(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    captured = _capture_anthropic_system(monkeypatch)
    from designer.agent import call_anthropic
    call_anthropic("k-test", {"niche": "x"})
    default_system, _ = build_designer_prompt({"niche": "x"})
    assert captured["body"]["system"] == default_system


def test_override_plus_3d_brief_appends_archetype_examples(tmp_path, monkeypatch):
    """When the strategist's system_override is active AND the brief is 3D,
    the matched archetype's worked examples MUST still land in the system
    prompt. Before this wire, override was nuclear and the archetype block
    was silently dropped — meaning all the prompt work was dead code in
    production where the override is always present."""
    monkeypatch.setenv("HOME", str(tmp_path))
    af_dir = tmp_path / ".agent-factory"
    af_dir.mkdir()
    override_text = "Designer override that emphasizes Skitarii-style detail. " * 8
    (af_dir / "prompts.json").write_text(json.dumps({
        "designer": {"system_override": override_text},
    }))

    captured = _capture_anthropic_system(monkeypatch)
    from designer.agent import call_anthropic
    # The niche "Skitarii cybernetic ranger" classifies as humanoid_character
    # and should pull in the upvoted Cyber-priestess + Radium Ranger
    # examples from the archetype block.
    call_anthropic("k-test", {
        "niche": "Skitarii cybernetic ranger warrior",
        "product_type": "stl_file",
    })
    sent = captured["body"]["system"]
    # 1. The override survives.
    assert "Skitarii-style detail" in sent
    # 2. The matched archetype's examples land too.
    assert "ARCHETYPE: humanoid character" in sent
    assert "Void-Cantor cyber-priestess" in sent, (
        "real upvoted Cyber-priestess brief must appear in override path"
    )
    # 3. Schema is still re-appended.
    assert "stl_file" in sent
    assert "JSON only" in sent


def test_override_plus_2d_brief_skips_archetype(tmp_path, monkeypatch):
    """2D briefs never go through the archetype router — verify the override
    path still drops the archetype block when the brief isn't 3D."""
    monkeypatch.setenv("HOME", str(tmp_path))
    af_dir = tmp_path / ".agent-factory"
    af_dir.mkdir()
    (af_dir / "prompts.json").write_text(json.dumps({
        "designer": {"system_override": "Designer override for 2D path."},
    }))

    captured = _capture_anthropic_system(monkeypatch)
    from designer.agent import call_anthropic
    call_anthropic("k-test", {"niche": "minimalist line art"})
    sent = captured["body"]["system"]
    assert "Designer override for 2D path." in sent
    assert "ARCHETYPE" not in sent


def test_drift_guard_rejects_stale_svg_override(tmp_path, monkeypatch):
    """Regression for: strategist re-wrote designer.system_override with a
    pre-3D-pivot SVG-sticker prompt; Designer's Haiku call then produced
    contradictory output and downstream Tripo cascades blew the supervisor
    timeout. Drift guard must reject any override with pre-pivot markers when
    SHOP_FOCUS=3d_only and fall back to the built-in 3D-aware baseline."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("SHOP_FOCUS", "3d_only")
    af_dir = tmp_path / ".agent-factory"
    af_dir.mkdir()
    stale_override = (
        "You are a sticker designer. Output valid SVG only. "
        "viewBox='0 0 400 400'. Kiss-cut vinyl sticker for an Etsy shop. " * 6
    )
    (af_dir / "prompts.json").write_text(json.dumps({
        "designer": {"system_override": stale_override},
    }))

    captured = _capture_anthropic_system(monkeypatch)
    from designer.agent import call_anthropic
    call_anthropic("k-test", {"niche": "cthulhu mini", "product_type": "stl_file"})
    sent = captured["body"]["system"]
    # The stale override must NOT have leaked into the Anthropic system prompt.
    assert "viewBox" not in sent
    assert "Kiss-cut vinyl" not in sent
    # The built-in 3D-aware baseline + 3D schema must be present.
    assert "3D-asset shop" in sent
    assert "stl_file" in sent


def test_drift_guard_lets_clean_3d_override_through(tmp_path, monkeypatch):
    """A 3D-aware override (no pre-pivot markers) must still apply normally."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("SHOP_FOCUS", "3d_only")
    af_dir = tmp_path / ".agent-factory"
    af_dir.mkdir()
    clean_override = (
        "Designer: emphasize iconic upright poses for altar figurine STLs. "
        "Stylization: stylized cartoon with hard surface accents. " * 6
    )
    (af_dir / "prompts.json").write_text(json.dumps({
        "designer": {"system_override": clean_override},
    }))

    captured = _capture_anthropic_system(monkeypatch)
    from designer.agent import call_anthropic
    call_anthropic("k-test", {"niche": "cthulhu mini", "product_type": "stl_file"})
    sent = captured["body"]["system"]
    assert "altar figurine STLs" in sent
    # Schema is still re-appended.
    assert "stl_file" in sent
    assert "JSON only" in sent


def test_brief_parse_ignores_trailing_prose(monkeypatch, tmp_path):
    """Sonnet sometimes appends an explanation after the JSON object. Job #670
    failed with `Extra data: line 9 column 1 (char 872)` because json.loads()
    refused to parse JSON-followed-by-text. The parser must tolerate it."""
    monkeypatch.setenv("HOME", str(tmp_path))
    asset_json = {
        "asset_type": "printable",
        "style": "boho",
        "palette": ["#a3", "#b2", "#c1"],
        "dimensions": "8.5x11",
        "mockup_count": 1,
        "brief_for_image_gen": "boho print",
    }
    raw_text = (
        "```json\n"
        + json.dumps(asset_json, indent=2)
        + "\n```\n\n"
        + "Here's a quick rationale for the choices above — boho palettes…"
    )

    class _Resp:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *a):
            return False

        def read(self_inner):
            return json.dumps({
                "content": [{"type": "text", "text": raw_text}],
                "usage": {"input_tokens": 1, "output_tokens": 1},
            }).encode("utf-8")

    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=60: _Resp())
    from designer.agent import call_anthropic
    parsed, _, _ = call_anthropic("k-test", {"niche": "boho"})
    assert parsed == asset_json


# --- Archetype router + brief critique ---


def test_archetype_classifier_picks_anime_over_humanoid():
    """'anime warrior' must classify as anime_stylized, not humanoid — anime
    keywords come first in _ARCHETYPE_KEYWORDS for exactly this reason."""
    from designer.agent import _classify_archetype
    assert _classify_archetype({"niche": "anime warrior figurine"}) == "anime_stylized"


def test_archetype_classifier_catches_each_archetype():
    from designer.agent import _classify_archetype
    cases = {
        "anime_stylized": {"niche": "chibi magical girl mini"},
        "superhero": {"niche": "caped vigilante action figure"},
        "mecha_robot": {"niche": "mecha pilot battle suit"},
        "chibi_mascot": {"niche": "kawaii mascot plushie"},
        "deity_statue": {"niche": "egyptian god altar statue"},
        "creature": {"niche": "fantasy dragon mini"},
        "humanoid_character": {"niche": "fantasy dwarf paladin"},
        "generic": {"niche": "abstract collectible"},
        "generic": {},
    }
    for expected, brief in cases.items():
        assert _classify_archetype(brief) == expected, brief


def test_3d_prompt_swaps_in_creature_examples_for_dragon_brief(tmp_path, monkeypatch):
    """A dragon brief must put the creature archetype examples into the
    Sonnet prompt — wyvern example specifically, not goblin warrior."""
    monkeypatch.setenv("HOME", str(tmp_path))
    from designer.agent import build_designer_prompt
    system, _user = build_designer_prompt({"niche": "tabletop dragon mini", "product_type": "stl_file"})
    assert "ARCHETYPE: creature" in system
    assert "Coiled wyvern" in system
    # The goblin warrior example must NOT leak into the creature path.
    assert "Standing goblin warrior" not in system


def test_3d_prompt_uses_anime_examples_for_anime_brief(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    from designer.agent import build_designer_prompt
    system, _user = build_designer_prompt({
        "niche": "anime swordmaiden figurine",
        "product_type": "stl_file",
    })
    assert "ARCHETYPE: anime" in system
    # The anime block now uses the REAL upvoted swordmaiden brief from job
    # 2651 as Example 2 — the marker "swordmaiden warrior goddess" only
    # appears in that example, so it's a reliable signature.
    assert "swordmaiden warrior goddess" in system
    # The creature block must not leak into the anime path.
    assert "Coiled wyvern" not in system


def test_2d_brief_skips_archetype_block(tmp_path, monkeypatch):
    """The 2D path (stickers, prints) must not get the 3D archetype
    structure — the SVG pipeline downstream relies on the older shape."""
    monkeypatch.setenv("HOME", str(tmp_path))
    from designer.agent import build_designer_prompt
    system, _user = build_designer_prompt({"niche": "boho moon stickers"})
    assert "ARCHETYPE" not in system


def _critique_resp(passed: bool, issues=None):
    return _resp({
        "content": [{"type": "text", "text": json.dumps({
            "pass": passed,
            "issues": issues or [],
        })}],
        "usage": {"input_tokens": 80, "output_tokens": 40},
    })


def _designer_3d_resp(brief_text: str = "Standing dwarf paladin, three-quarter stance, warhammer raised. Stylized cartoon hard-surface armor. Matte single-color render, no PBR textures. 28mm tabletop scale, support-friendly silhouette, single static mesh. (negative: no thin spear, no floating cloak, no second figure, no background)"):
    return _resp({
        "content": [{"type": "text", "text": json.dumps({
            "asset_type": "stl_file",
            "style": "stylized cartoon",
            "palette": ["#aaa"],
            "dimensions": "28mm tabletop",
            "mockup_count": 1,
            "brief_for_image_gen": brief_text,
        })}],
        "usage": {"input_tokens": 60, "output_tokens": 100},
    })


def test_critique_passes_no_revision(tmp_path, monkeypatch):
    """Critique returns pass=true → no revision call, original asset returned."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("DESIGNER_CRITIQUE_DISABLED", raising=False)
    calls = []
    queue = iter([_designer_3d_resp(), _critique_resp(passed=True)])

    def fake_urlopen(req, timeout=60):
        body = json.loads(req.data.decode("utf-8"))
        calls.append(body["model"])
        return next(queue)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    from designer.agent import call_anthropic, MODEL, CRITIQUE_MODEL
    asset, _ti, _to = call_anthropic("k-test", {
        "niche": "dwarf paladin mini",
        "product_type": "stl_file",
    })
    assert calls == [MODEL, CRITIQUE_MODEL]
    assert "warhammer" in asset["brief_for_image_gen"]


def test_critique_fail_triggers_one_revision(tmp_path, monkeypatch):
    """Critique returns pass=false with issues → exactly one revision Sonnet
    call fires, and the asset is replaced with the revised brief."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("DESIGNER_CRITIQUE_DISABLED", raising=False)
    calls = []
    queue = iter([
        _designer_3d_resp("bad brief: a dragon AND a wolf"),
        _critique_resp(passed=False, issues=["multiple subjects", "missing pose"]),
        _designer_3d_resp("Coiled wyvern, head reared, wings folded. Stylized fantasy. Matte single-color. 12cm tabletop. support-friendly silhouette, single static mesh. (negative: no spread wings, no thin tongue, no background)"),
    ])
    revised_systems = []

    def fake_urlopen(req, timeout=60):
        body = json.loads(req.data.decode("utf-8"))
        calls.append(body["model"])
        if body["model"].startswith("claude-sonnet") and len(calls) > 1:
            revised_systems.append(body["system"])
        return next(queue)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    from designer.agent import call_anthropic, MODEL, CRITIQUE_MODEL
    asset, _ti, _to = call_anthropic("k-test", {
        "niche": "tabletop dragon mini",
        "product_type": "stl_file",
    })
    assert calls == [MODEL, CRITIQUE_MODEL, MODEL]
    assert len(revised_systems) == 1
    assert "CRITIQUE FROM PRIOR ATTEMPT" in revised_systems[0]
    assert "multiple subjects" in revised_systems[0]
    assert "Coiled wyvern" in asset["brief_for_image_gen"]


def test_critique_disabled_via_env(tmp_path, monkeypatch):
    """DESIGNER_CRITIQUE_DISABLED=1 → critique never runs, only the designer
    Sonnet call fires."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("DESIGNER_CRITIQUE_DISABLED", "1")
    calls = []
    queue = iter([_designer_3d_resp()])

    def fake_urlopen(req, timeout=60):
        body = json.loads(req.data.decode("utf-8"))
        calls.append(body["model"])
        return next(queue)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    from designer.agent import call_anthropic, MODEL
    call_anthropic("k-test", {"niche": "dragon mini", "product_type": "stl_file"})
    assert calls == [MODEL]


def test_critique_skipped_on_2d_briefs(tmp_path, monkeypatch):
    """The 2D path (sticker / digital print) must not invoke the critique —
    only one Anthropic call total."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("DESIGNER_CRITIQUE_DISABLED", raising=False)
    calls = []
    queue = iter([_haiku_response()])

    def fake_urlopen(req, timeout=60):
        body = json.loads(req.data.decode("utf-8"))
        calls.append(body["model"])
        return next(queue)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    from designer.agent import call_anthropic, MODEL
    call_anthropic("k-test", {"niche": "minimalist wall art"})
    assert calls == [MODEL]


def test_critique_fails_open_on_validator_error(tmp_path, monkeypatch):
    """If the critique call raises mid-flight, the original asset must still
    be returned — we don't want a validator outage to wedge the pipeline."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("DESIGNER_CRITIQUE_DISABLED", raising=False)
    state = {"n": 0}

    def fake_urlopen(req, timeout=60):
        state["n"] += 1
        if state["n"] == 1:
            return _designer_3d_resp()
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    from designer.agent import call_anthropic
    asset, _ti, _to = call_anthropic("k-test", {
        "niche": "dragon mini",
        "product_type": "stl_file",
    })
    # Designer brief survives despite the validator outage.
    assert "warhammer" in asset["brief_for_image_gen"] or "dragon" in asset["brief_for_image_gen"].lower()


# --- Specialist-assigned notification (designer → UI signal) ---


def test_specialist_role_map_covers_every_archetype():
    """The archetype → specialist_role map must have an entry for every
    archetype the classifier can emit. Missing one means a 3D brief in
    that category would silently produce no UI signal."""
    from designer.agent import (
        _ARCHETYPE_KEYWORDS, _ARCHETYPE_BLOCKS, _SPECIALIST_ROLE_BY_ARCHETYPE,
    )
    # Every archetype defined in keywords + blocks (including 'generic')
    # must appear in the specialist map.
    all_archetypes = set(_ARCHETYPE_KEYWORDS.keys()) | set(_ARCHETYPE_BLOCKS.keys())
    for a in all_archetypes:
        assert a in _SPECIALIST_ROLE_BY_ARCHETYPE, (
            f"archetype {a!r} missing from specialist map"
        )
    # Generic must explicitly map to None — "lead designer keeps it."
    assert _SPECIALIST_ROLE_BY_ARCHETYPE["generic"] is None


def test_3d_handle_emits_specialist_assigned_notification(tmp_path, monkeypatch, capsys):
    """When a 3D brief enters handle(), the worker must emit a JSON-RPC
    notification with kind=specialist_assigned + the matched specialist
    role id, BEFORE the long Sonnet/Tripo work begins. The frontend listens
    for this to animate the design → specialist handoff in real time."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    # Stub the actual Anthropic call so we don't try to hit the network.
    monkeypatch.setattr(urllib.request, "urlopen",
        lambda req, timeout=60: (_ for _ in ()).throw(RuntimeError("stubbed")))

    from designer.agent import handle
    # The handle is allowed to fail — we only care that the notification
    # fired BEFORE the failure.
    try:
        handle("process_job", {
            "job_id": 9001,
            "payload": {"brief": {
                "niche": "Skitarii cybernetic ranger",
                "product_type": "stl_file",
            }},
        })
    except Exception:
        pass
    out = capsys.readouterr().out
    # The notification is a single JSON line on stdout.
    assert '"specialist_assigned"' in out, out[:500]
    notif_line = next(line for line in out.splitlines() if "specialist_assigned" in line)
    parsed = json.loads(notif_line)
    assert parsed["method"] == "event"
    assert parsed["params"]["kind"] == "specialist_assigned"
    assert parsed["params"]["specialist_role"] == "humanoid_spec"
    assert parsed["params"]["archetype"] == "humanoid_character"
    assert parsed["params"]["designer_job_id"] == 9001


def test_2d_handle_does_not_emit_specialist_assigned(tmp_path, monkeypatch, capsys):
    """The 2D path has no specialists — must not emit the notification."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    monkeypatch.setattr(urllib.request, "urlopen",
        lambda req, timeout=60: (_ for _ in ()).throw(RuntimeError("stubbed")))
    from designer.agent import handle
    try:
        handle("process_job", {
            "job_id": 9002,
            "payload": {"brief": {"niche": "boho stickers"}},
        })
    except Exception:
        pass
    out = capsys.readouterr().out
    assert "specialist_assigned" not in out


def test_generic_archetype_does_not_emit_specialist(tmp_path, monkeypatch, capsys):
    """When the classifier can't find any archetype keyword (falls to
    'generic'), the lead designer keeps the brief — no specialist."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    monkeypatch.setattr(urllib.request, "urlopen",
        lambda req, timeout=60: (_ for _ in ()).throw(RuntimeError("stubbed")))
    from designer.agent import handle
    try:
        handle("process_job", {
            "job_id": 9003,
            "payload": {"brief": {
                "niche": "abstract zonal collectible",  # no keyword matches
                "product_type": "stl_file",
            }},
        })
    except Exception:
        pass
    out = capsys.readouterr().out
    assert "specialist_assigned" not in out


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


def test_svg_invalid_output_short_circuits_pipeline(tmp_path, monkeypatch):
    """3D-only-shop contract: an asset-less designer result must NOT hand off
    to listing/publisher. We return ok=False with no handoff so the cycle
    stops cleanly instead of cascading "missing asset_path" errors through
    every marketplace fan-out."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")

    fake = _mock_urlopen_factory([
        _haiku_response(),
        _svg_response("not even close to svg content here"),
    ])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    result = handle("process_job", _job_params(101))

    assert result["ok"] is False
    assert "no asset produced" in result["error"]
    assert "handoff" not in result
    assert result["model"] == MODEL
    assert result["tokens_in"] == 50
    assert result["tokens_out"] == 80
    assert "CYCLE STOPPED" in result["ticker_text"]
    # A single critical message goes to *, no asset_ready message to listing.
    msg_topics = [m["topic"] for m in result["messages"]]
    assert msg_topics == ["asset_failed"]


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

    # Network failure during SVG generation → no asset → ok=False, no handoff.
    # The Haiku call still succeeded, so tokens/model from that pass come through.
    assert result["ok"] is False
    assert "no asset produced" in result["error"]
    assert "handoff" not in result
    assert result["model"] == MODEL
    assert result["tokens_in"] == 50
    assert result["tokens_out"] == 80


def test_cycle_id_propagates(tmp_path, monkeypatch):
    """Designer echoes the inbound cycle_id into its result, on both success and
    short-circuit paths. CFO needs cycle_id even on failed cycles to close P&L."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    cid = "designer-cycle-7777"
    # Use the failure path: Haiku asset + invalid SVG. Short-circuits with
    # ok=False — cycle_id must still come back so CFO can close the cycle.
    fake = _mock_urlopen_factory([
        _haiku_response(),
        _svg_response("not a valid svg"),
    ])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    params = {
        "job_id": 404,
        "payload": {
            "brief": {"niche": "test", "keywords": [], "price_band_usd": [1, 2]},
            "cycle_id": cid,
        },
    }
    result = handle("process_job", params)
    assert result["ok"] is False
    assert result.get("cycle_id") == cid
    assert "handoff" not in result


# ────────────────────────────────────────────────────────────────────────
# Phase 1.1-1.3 — image-to-3D pipeline routing
#
# These tests lock the contract: when the designer sees a character-style
# 3D brief AND Higgsfield CLI is configured (is_configured() returns True)
# AND an image-to-3D provider is wired, it MUST run nanobanana (Nano Banana
# Pro via Higgsfield CLI) → chosen provider instead of the text-to-3D path.
# The parallel marketplace work edits many of the same files, so the regression
# coverage matters.
# ────────────────────────────────────────────────────────────────────────


def test_call_anthropic_sends_assistant_prefill(tmp_path, monkeypatch):
    """Regression for the 2026-05-12 'Haiku returns markdown' incident:
    designer.call_anthropic MUST include an assistant turn with content='{'
    so the model is forced to continue with valid JSON. Without it Haiku
    occasionally returns a long-form product-strategy markdown document
    that has no JSON object anywhere."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")

    captured: dict = {}

    def _fake_urlopen(req, timeout=60):
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _haiku_response()

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)
    from designer.agent import call_anthropic
    call_anthropic("k-test", {"niche": "x"})

    msgs = captured["body"]["messages"]
    assert len(msgs) == 2, f"expected user + assistant prefill, got {msgs!r}"
    assert msgs[0]["role"] == "user"
    assert msgs[1]["role"] == "assistant"
    assert msgs[1]["content"] == "{", (
        f"assistant prefill must be exactly '{{', got {msgs[1]['content']!r}"
    )


def test_call_anthropic_skips_prefill_in_bridge_mode(tmp_path, monkeypatch):
    """Bridge proxies (ANTHROPIC_BASE_URL != api.anthropic.com) reject the
    trailing assistant 'role:assistant' turn with HTTP 400. Regression: when
    a bridge is configured, the prefill MUST be omitted so the bridge accepts
    the request. We still see correct JSON output via the loose parser."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    monkeypatch.setenv("ANTHROPIC_BASE_URL", "https://my-bridge.example.com")

    captured: dict = {}

    def _fake_urlopen(req, timeout=60):
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _haiku_response()

    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)
    from designer.agent import call_anthropic
    call_anthropic("k-test", {"niche": "x"})

    msgs = captured["body"]["messages"]
    assert len(msgs) == 1, (
        f"bridge mode must NOT include the assistant prefill turn; got {msgs!r}"
    )
    assert msgs[0]["role"] == "user"
    # No assistant message because the bridge would reject it.


def test_designer_prompt_branches_on_3d_product_type():
    """Regression for the 2026-05-12 'no JSON object found in response' crash:
    when product_type=stl_file briefs arrived under the legacy 2D prompt
    (enum: printable|svg|template|ebook), Haiku went off-script with prose.
    The 3D branch must surface stl_file / 3d_model in the schema, mention
    Tripo/Meshy/nanobanana so the model knows which generator the prompt
    feeds, and instruct 'JSON only'."""
    sys2d, _ = build_designer_prompt({"product_type": "sticker"})
    assert "printable | svg | template | ebook" in sys2d
    assert "stl_file" not in sys2d.split("asset_type")[1].split("\n")[0]

    sys3d, _ = build_designer_prompt({"product_type": "stl_file"})
    assert "stl_file" in sys3d
    assert "3d_model" in sys3d
    assert "JSON only" in sys3d
    # Either Tripo or Meshy must be referenced so the model treats the
    # output as a 3D-gen prompt, not a 2D image prompt.
    assert ("Tripo" in sys3d) or ("Meshy" in sys3d) or ("text-to-3D" in sys3d)


def test_loose_parser_surfaces_response_preview():
    """Diagnostic regression: when the model returns prose (no '{'), the
    raised error must include a preview of what was actually said. The
    original 'no JSON object found in response' message was too opaque to
    debug from the alert tray."""
    from designer.agent import _parse_loose_json_object
    try:
        _parse_loose_json_object("Sure, here's the brief: it's a 3D model of a cat.")
    except ValueError as e:
        msg = str(e)
        assert "no JSON object found" in msg
        assert "Sure, here" in msg, f"expected response preview in error, got: {msg!r}"


def test_loose_parser_recovers_truncated_brief():
    """Regression: alert tray was showing 'Unterminated string starting at:
    line 7 column 26 (char NNN)' across designer jobs #2163-#2196 — every
    brief_for_image_gen value was getting cut off mid-string because the
    AAA-game-asset detail target made Claude write longer briefs than the
    old 600-token cap could fit. The parser must salvage the truncated
    response (close the open quote + brace) rather than fail the whole job."""
    from designer.agent import _parse_loose_json_object
    truncated = (
        '{\n'
        '  "niche": "fantasy figurines",\n'
        '  "design_direction": "stylized realism",\n'
        '  "asset": {\n'
        '    "asset_type": "stl",\n'
        '    "asset_name": "Bull-headed warrior",\n'
        '    "brief_for_image_gen": "Bull-headed warrior deity, heroic upright stance, '
        'massive crescent-blade glaive raised in one hand, off-hand clutching a glyph-tablet'
        # NOTE: response cuts off here — no closing quote, no closing }
    )
    obj = _parse_loose_json_object(truncated)
    # Outer object recovered; the head of brief_for_image_gen survived
    assert obj["niche"] == "fantasy figurines"
    assert obj["asset"]["asset_name"] == "Bull-headed warrior"
    assert "Bull-headed warrior deity" in obj["asset"]["brief_for_image_gen"]


def test_image_to_3d_provider_defaults_to_tripo(monkeypatch):
    from designer.agent import _image_to_3d_provider

    monkeypatch.delenv("IMAGE_TO_3D_PROVIDER", raising=False)
    assert _image_to_3d_provider() == "tripo"
    monkeypatch.setenv("IMAGE_TO_3D_PROVIDER", "meshy")
    assert _image_to_3d_provider() == "meshy"
    monkeypatch.setenv("IMAGE_TO_3D_PROVIDER", "TRIPO")  # case-insensitive
    assert _image_to_3d_provider() == "tripo"
    monkeypatch.setenv("IMAGE_TO_3D_PROVIDER", "garbage")  # unknown → tripo
    assert _image_to_3d_provider() == "tripo"


def _haiku_3d_response():
    """Designer's first call returns the asset description; for 3D briefs we
    just need any well-formed JSON to thread into the 3D branch."""
    return _resp({
        "content": [{"type": "text", "text": json.dumps({
            "asset_type": "stl_file",
            "style": "stylized cartoon mini",
            "palette": ["#888", "#aaa", "#ccc"],
            "dimensions": "28mm tabletop",
            "mockup_count": 1,
            "brief_for_image_gen": "shonen swordsman, sword raised, dynamic pose",
        })}],
        "usage": {"input_tokens": 60, "output_tokens": 100},
    })


def _character_brief_params(job_id: int = 555):
    return {
        "job_id": job_id,
        "payload": {
            "brief": {
                "niche": "anime swordsman figurine",
                "product_type": "stl_file",
                "ip_risk": "original",
                "design_direction": "shonen-style warrior, stylized, 28mm",
                "keywords": ["anime", "figurine", "stl"],
                "price_band_usd": [6, 12],
            }
        },
    }


def test_designer_routes_to_image_to_3d_when_eligible(tmp_path, monkeypatch):
    """Character brief + Higgsfield CLI configured + tripo key →
    nanobanana → tripo image-to-3D path runs, asset_path points at the
    produced STL, model tag reflects the image-to-3d provider."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.delenv("MESHY_API_KEY", raising=False)
    monkeypatch.setenv("IMAGE_TO_3D_PROVIDER", "tripo")

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    calls: dict = {"nano": 0, "tripo_img": 0, "tripo_text": 0, "meshy_any": 0}
    ref_path = str(tmp_path / "555-ref.png")
    glb_path = str(tmp_path / "555.glb")
    stl_path = str(tmp_path / "555.stl")
    png_path = str(tmp_path / "555.png")

    def fake_nano(api_key, prompt, *, job_id, assets_dir, **kw):
        calls["nano"] += 1
        # Mirror the production tuple shape: (path, backend_model). Tests
        # don't care which backend ran but the agent code unpacks both.
        return ref_path, "gemini-3-pro-image-preview"

    def fake_tripo_img(api_key, image_path, *, job_id, assets_dir, **kw):
        calls["tripo_img"] += 1
        return glb_path, stl_path, png_path

    def fake_tripo_text(*a, **kw):
        calls["tripo_text"] += 1
        raise AssertionError("text-to-3D path should NOT run when image route is eligible")

    def fake_meshy_any(*a, **kw):
        calls["meshy_any"] += 1
        raise AssertionError("meshy should NOT run when provider=tripo")

    from designer import nanobanana as nano_mod
    from designer import tripo as tripo_mod
    from designer import meshy as meshy_mod

    monkeypatch.setattr(nano_mod, "is_configured", lambda: True)
    monkeypatch.setattr(nano_mod, "generate_reference_image", fake_nano)
    monkeypatch.setattr(tripo_mod, "generate_3d_from_image", fake_tripo_img)
    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)
    monkeypatch.setattr(meshy_mod, "generate_3d_from_image", fake_meshy_any)
    monkeypatch.setattr(meshy_mod, "generate_3d", fake_meshy_any)

    result = handle("process_job", _character_brief_params(555))

    assert result["ok"] is True
    assert calls["nano"] == 1
    assert calls["tripo_img"] == 1
    assert calls["tripo_text"] == 0
    assert calls["meshy_any"] == 0
    assert result["asset"]["asset_path"] == stl_path
    assert result["asset"]["glb_path"] == glb_path
    assert result["asset"]["preview_png"] == png_path
    # `model` is the Claude model that wrote the brief — token-priced.
    # The 3D provider charge lives in provider_calls so the supervisor
    # bills it at the flat per-call rate instead of mis-applying the
    # Claude token rate to a non-token model.
    assert result["model"] == MODEL
    provider_models = [c["model"] for c in result["provider_calls"]]
    assert "tripo-image-to-3d" in provider_models
    assert "gemini-3-pro-image-preview" in provider_models


def test_designer_routes_to_meshy_image_when_provider_meshy(tmp_path, monkeypatch):
    """Same as above but provider=meshy → Meshy image-to-3D runs, Tripo
    image-to-3D does not."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("MESHY_API_KEY", "m-test")
    monkeypatch.delenv("TRIPO_API_KEY", raising=False)
    monkeypatch.setenv("IMAGE_TO_3D_PROVIDER", "meshy")

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    calls = {"nano": 0, "meshy_img": 0, "tripo_any": 0}
    ref_path = str(tmp_path / "777-ref.png")
    glb_path = str(tmp_path / "777.glb")
    stl_path = str(tmp_path / "777.stl")
    png_path = str(tmp_path / "777.png")

    def fake_nano(api_key, prompt, *, job_id, assets_dir, **kw):
        calls["nano"] += 1
        # Mirror the production tuple shape: (path, backend_model). Tests
        # don't care which backend ran but the agent code unpacks both.
        return ref_path, "gemini-3-pro-image-preview"

    def fake_meshy_img(api_key, image_path, *, job_id, assets_dir, **kw):
        calls["meshy_img"] += 1
        # 4-tuple: (glb, stl, png, mesh_task_id) — task_id lets the
        # designer chain rigging via input_task_id.
        return glb_path, stl_path, png_path, "fake-meshy-task"

    def fake_tripo_any(*a, **kw):
        calls["tripo_any"] += 1
        raise AssertionError("tripo should NOT run when provider=meshy without tripo key")

    from designer import nanobanana as nano_mod
    from designer import meshy as meshy_mod
    from designer import tripo as tripo_mod
    monkeypatch.setattr(nano_mod, "is_configured", lambda: True)
    monkeypatch.setattr(nano_mod, "generate_reference_image", fake_nano)
    monkeypatch.setattr(meshy_mod, "generate_3d_from_image", fake_meshy_img)
    monkeypatch.setattr(tripo_mod, "generate_3d_from_image", fake_tripo_any)
    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_any)
    monkeypatch.setattr(meshy_mod, "generate_3d", fake_tripo_any)

    result = handle("process_job", _character_brief_params(777))

    assert result["ok"] is True
    assert calls["nano"] == 1
    assert calls["meshy_img"] == 1
    assert calls["tripo_any"] == 0
    assert result["model"] == MODEL
    provider_models = [c["model"] for c in result["provider_calls"]]
    assert "meshy-image-to-3d" in provider_models


def test_designer_text_to_3d_honors_tripo_preference(tmp_path, monkeypatch):
    """Higgsfield CLI not configured → text-to-3D path. Both Meshy +
    Tripo keys present, IMAGE_TO_3D_PROVIDER=tripo → text-to-3D MUST
    pick Tripo. The setting governs both image-to-3D and text-to-3D so
    the user's 'I want Tripo' preference applies everywhere."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("MESHY_API_KEY", "m-test")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.setenv("IMAGE_TO_3D_PROVIDER", "tripo")

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    calls = {"nano": 0, "meshy_text": 0, "tripo_text": 0, "image_any": 0}
    glb_path = str(tmp_path / "888.glb")
    stl_path = str(tmp_path / "888.stl")
    png_path = str(tmp_path / "888.png")

    def fake_nano(*a, **kw):
        calls["nano"] += 1
        raise AssertionError("nanobanana must not run when CLI not configured")

    def fake_tripo_text(api_key, prompt, *, job_id, assets_dir, **kw):
        calls["tripo_text"] += 1
        return glb_path, stl_path, png_path

    def fake_meshy_text(*a, **kw):
        calls["meshy_text"] += 1
        raise AssertionError("meshy text path should not run when tripo is preferred + available")

    def fake_image(*a, **kw):
        calls["image_any"] += 1
        raise AssertionError("image-to-3D path must not run when CLI not configured")

    from designer import nanobanana as nano_mod
    from designer import meshy as meshy_mod
    from designer import tripo as tripo_mod
    monkeypatch.setattr(nano_mod, "is_configured", lambda: False)
    monkeypatch.setattr(nano_mod, "generate_reference_image", fake_nano)
    monkeypatch.setattr(meshy_mod, "generate_3d", fake_meshy_text)
    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)
    monkeypatch.setattr(meshy_mod, "generate_3d_from_image", fake_image)
    monkeypatch.setattr(tripo_mod, "generate_3d_from_image", fake_image)

    result = handle("process_job", _character_brief_params(888))

    assert result["ok"] is True
    assert calls["nano"] == 0
    assert calls["tripo_text"] == 1
    assert calls["meshy_text"] == 0
    assert calls["image_any"] == 0
    assert result["model"] == MODEL
    assert [c["model"] for c in result["provider_calls"]] == ["tripo-text-to-model"]


def test_designer_text_to_3d_hard_fails_when_preferred_key_missing(tmp_path, monkeypatch):
    """Provider selection is EXCLUSIVE: when IMAGE_TO_3D_PROVIDER=tripo but
    TRIPO_API_KEY isn't set, the designer must NOT silently swap to Meshy
    (even when Meshy is fully configured). The operator pays per provider —
    a silent swap burns credits on a service they didn't pick. Cycle fails
    cleanly with a clear "TRIPO_API_KEY missing" signal instead.
    """
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("MESHY_API_KEY", "m-test")
    monkeypatch.delenv("TRIPO_API_KEY", raising=False)
    monkeypatch.setenv("IMAGE_TO_3D_PROVIDER", "tripo")

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    calls = {"meshy": 0, "tripo": 0}

    def fake_meshy_text(*a, **kw):
        calls["meshy"] += 1
        raise AssertionError("meshy must NOT be silently used when tripo was selected")

    def fake_tripo_text(*a, **kw):
        calls["tripo"] += 1
        raise AssertionError("tripo must not run when its key is missing")

    from designer import nanobanana as nano_mod
    from designer import meshy as meshy_mod
    from designer import tripo as tripo_mod
    monkeypatch.setattr(nano_mod, "is_configured", lambda: False)
    monkeypatch.setattr(meshy_mod, "generate_3d", fake_meshy_text)
    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)

    result = handle("process_job", _character_brief_params(889))
    # Cycle aborts cleanly — no asset produced, neither provider was called.
    assert result["ok"] is False
    assert calls["meshy"] == 0
    assert calls["tripo"] == 0
    # Error message must surface the actual misconfiguration.
    err = (result.get("error") or "") + " " + (result.get("ticker_text") or "")
    assert "TRIPO_API_KEY" in err


def test_designer_falls_through_when_nanobanana_fails(tmp_path, monkeypatch):
    """nanobanana raises → designer recovers via text-to-3D rather than
    failing the whole job. Locks the resilience contract."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.delenv("MESHY_API_KEY", raising=False)

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    glb_path = str(tmp_path / "999.glb")
    stl_path = str(tmp_path / "999.stl")
    png_path = str(tmp_path / "999.png")
    calls = {"tripo_text": 0}

    def explode_nano(*a, **kw):
        raise RuntimeError("safety blocked")

    def fake_tripo_text(api_key, prompt, *, job_id, assets_dir, **kw):
        calls["tripo_text"] += 1
        return glb_path, stl_path, png_path

    from designer import nanobanana as nano_mod
    from designer import tripo as tripo_mod
    monkeypatch.setattr(nano_mod, "is_configured", lambda: True)
    monkeypatch.setattr(nano_mod, "generate_reference_image", explode_nano)
    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)

    result = handle("process_job", _character_brief_params(999))

    assert result["ok"] is True
    assert calls["tripo_text"] == 1
    assert result["asset"]["asset_path"] == stl_path
    assert result["model"] == MODEL
    assert [c["model"] for c in result["provider_calls"]] == ["tripo-text-to-model"]


def test_designer_skips_text_fallback_when_image3d_timed_out(tmp_path, monkeypatch):
    """Image-to-3D provider was QUEUED (raised 'timed out after Ns') → the
    designer must NOT cascade into a second 240s text-to-3D poll. Cascading
    would risk tripping the supervisor's outer 900s timeout when both
    providers are backed up. The cycle ends cleanly with no asset and the
    next cycle gets a fresh slot at the provider."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.delenv("MESHY_API_KEY", raising=False)
    monkeypatch.setenv("IMAGE_TO_3D_PROVIDER", "tripo")

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    ref_path = str(tmp_path / "1001-ref.png")
    calls = {"nano": 0, "tripo_img": 0, "tripo_text": 0}

    def fake_nano(api_key, prompt, *, job_id, assets_dir, **kw):
        calls["nano"] += 1
        # Mirror the production tuple shape: (path, backend_model). Tests
        # don't care which backend ran but the agent code unpacks both.
        return ref_path, "gemini-3-pro-image-preview"

    from designer import tripo as tripo_mod

    def fake_tripo_img(*a, **kw):
        calls["tripo_img"] += 1
        raise tripo_mod.TripoError("Tripo task abc123 timed out after 240s")

    def fake_tripo_text(*a, **kw):
        calls["tripo_text"] += 1
        raise AssertionError(
            "text-to-3D must NOT run after image-to-3D timeout — would "
            "double the wait and risk the supervisor outer timeout"
        )

    from designer import nanobanana as nano_mod
    monkeypatch.setattr(nano_mod, "is_configured", lambda: True)
    monkeypatch.setattr(nano_mod, "generate_reference_image", fake_nano)
    monkeypatch.setattr(tripo_mod, "generate_3d_from_image", fake_tripo_img)
    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)

    result = handle("process_job", _character_brief_params(1001))

    assert calls["nano"] == 1
    assert calls["tripo_img"] == 1
    assert calls["tripo_text"] == 0
    # Cycle ends with no asset (3D-only shop hard-fails when nothing made it
    # to disk) so the cycle gets a clean abort instead of being killed by
    # the supervisor mid-poll.
    assert result["ok"] is False
    assert "no asset" in result.get("error", "").lower()


def test_classify_3d_provider_failure_credits():
    from designer.agent import _classify_3d_provider_failure
    msg = _classify_3d_provider_failure(
        'Meshy POST https://api.meshy.ai/openapi/v2/text-to-3d HTTP 402: {"code":"insufficient_credits"}'
    )
    assert msg is not None
    assert "Meshy" in msg and "credit" in msg.lower()


def test_classify_3d_provider_failure_tripo_zero_balance():
    # Tripo rejects zero-balance task submits with HTTP 403 + code:2010,
    # not the expected 402. Make sure the body-text match wins over the
    # generic 403 branch so the UI says "out of credits" not "forbidden".
    from designer.agent import _classify_3d_provider_failure
    msg = _classify_3d_provider_failure(
        "Tripo POST https://api.tripo3d.ai/v2/openapi/task HTTP 403: "
        "{\"code\":2010,\"message\":\"You don't have enough credit to create this task\","
        "\"suggestion\":\"Please purchase more credit\"}"
    )
    assert msg is not None
    assert "Tripo" in msg and "credit" in msg.lower()
    assert "forbidden" not in msg.lower()


def test_classify_3d_provider_failure_auth():
    from designer.agent import _classify_3d_provider_failure
    msg = _classify_3d_provider_failure(
        'Tripo POST https://api.tripo3d.ai/v2/openapi/task HTTP 401: {"code":"unauthorized"}'
    )
    assert msg is not None
    assert "Tripo" in msg and "401" in msg


def test_classify_3d_provider_failure_rate_limit():
    from designer.agent import _classify_3d_provider_failure
    msg = _classify_3d_provider_failure(
        'Meshy GET https://api.meshy.ai/... HTTP 429: rate_limit_exceeded'
    )
    assert msg is not None
    assert "rate-limited" in msg or "rate limit" in msg.lower()


def test_classify_3d_provider_failure_unknown_returns_none():
    from designer.agent import _classify_3d_provider_failure
    # Random python traceback shouldn't trip the matcher.
    assert _classify_3d_provider_failure("KeyError: 'glb_url'") is None


def test_designer_credit_failure_surfaces_friendly_message(tmp_path, monkeypatch):
    """Tripo returns HTTP 402 → the designer's hard-fail message must be the
    classified 'out of credits' string (not the wrapped 'no asset produced
    (...)') so the supervisor → UI alert reads cleanly. Locks in the user's
    ask: 'how would we know if i ran out of api credits'."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.delenv("MESHY_API_KEY", raising=False)
    monkeypatch.setenv("IMAGE_TO_3D_PROVIDER", "tripo")

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    from designer import nanobanana as nano_mod
    from designer import tripo as tripo_mod

    def fake_nano(*a, **kw):
        # Nano import succeeds but nb_available will be False — character-
        # brief gate prevents image-to-3D, so we go straight to text-to-3D.
        return str(tmp_path / "ref.png")

    def fake_tripo_text(*a, **kw):
        raise tripo_mod.TripoError(
            'Tripo POST https://api.tripo3d.ai/v2/openapi/task '
            'HTTP 402: {"code":40006,"message":"insufficient_credits"}'
        )

    monkeypatch.setattr(nano_mod, "is_configured", lambda: False)
    monkeypatch.setattr(nano_mod, "generate_reference_image", fake_nano)
    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)

    result = handle("process_job", _character_brief_params(2002))

    assert result["ok"] is False
    err = result.get("error", "")
    assert "Tripo" in err
    assert "credit" in err.lower()
    # Must NOT be the legacy generic wrapping when classification succeeded.
    assert "no asset produced" not in err
    # The ticker line includes the friendly message verbatim so users see
    # the cause without having to open the alert details.
    assert "credit" in result.get("ticker_text", "").lower()


def test_designer_does_not_cascade_to_text_when_mesh_fails_with_image(tmp_path, monkeypatch):
    """Image-to-3D errored for a NON-timeout reason (auth, bad payload,
    network) AFTER the reference image was rendered → per the image-first
    3D policy the designer must NOT silently fall back to text-to-3D.
    Text-to-3D would only regress quality on the same intent. Surface a
    hard mesh failure so the operator sees the underlying provider issue.
    Text-to-3D remains the fallback ONLY when image generation itself
    failed (see test_designer_falls_back_to_text_to_3d_when_nano_blocked)."""
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    monkeypatch.setenv("TRIPO_API_KEY", "t-test")
    monkeypatch.delenv("MESHY_API_KEY", raising=False)
    monkeypatch.setenv("IMAGE_TO_3D_PROVIDER", "tripo")

    fake = _mock_urlopen_factory([_haiku_3d_response()])
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    ref_path = str(tmp_path / "1002-ref.png")
    calls = {"nano": 0, "tripo_img": 0, "tripo_text": 0}

    def fake_nano(api_key, prompt, *, job_id, assets_dir, **kw):
        calls["nano"] += 1
        return ref_path, "gemini-3-pro-image-preview"

    from designer import tripo as tripo_mod

    def fake_tripo_img(*a, **kw):
        calls["tripo_img"] += 1
        raise tripo_mod.TripoError("HTTP 400: bad payload format")

    def fake_tripo_text(*a, **kw):
        calls["tripo_text"] += 1
        raise AssertionError(
            "text-to-3D must NOT run when image rendered + mesh failed "
            "— image-first 3D policy"
        )

    from designer import nanobanana as nano_mod
    monkeypatch.setattr(nano_mod, "is_configured", lambda: True)
    monkeypatch.setattr(nano_mod, "generate_reference_image", fake_nano)
    monkeypatch.setattr(tripo_mod, "generate_3d_from_image", fake_tripo_img)
    monkeypatch.setattr(tripo_mod, "generate_3d", fake_tripo_text)

    result = handle("process_job", _character_brief_params(1002))

    assert calls["nano"] == 1
    assert calls["tripo_img"] == 1
    assert calls["tripo_text"] == 0
    # 3D-only shop hard-fails when nothing made it to disk.
    assert result["ok"] is False
    assert "no asset" in result.get("error", "").lower()


# ────────────────────────────────────────────────────────────────────────
# Phase 1.4 — multi-angle preview renderer
# ────────────────────────────────────────────────────────────────────────


def _make_test_glb(path: str) -> None:
    """Build a small but non-degenerate GLB so the renderer has real geometry
    to chew through. Uses trimesh's primitive builders so we don't ship a
    binary fixture into the repo."""
    import trimesh  # type: ignore
    mesh = trimesh.creation.icosphere(subdivisions=2)  # ~320 triangles
    mesh.export(path)


def test_render_angles_writes_n_pngs_with_real_content(tmp_path):
    """End-to-end: build a GLB, render the default 5 angles, confirm each
    PNG exists, is non-trivial (>1KB), and the pixel data is not all the
    same background colour (i.e. the mesh actually appeared)."""
    from designer import preview as _preview
    from PIL import Image  # type: ignore

    glb = tmp_path / "smoke.glb"
    _make_test_glb(str(glb))

    paths = _preview.render_angles(
        str(glb),
        output_dir=str(tmp_path),
        job_id=42,
        resolution=256,  # small for test speed; production uses 1024
    )
    assert len(paths) == 5
    seen_hashes = set()
    for p in paths:
        assert os.path.exists(p), f"missing {p}"
        size = os.path.getsize(p)
        assert size > 1024, f"{p} suspiciously small ({size}B)"
        img = Image.open(p).convert("RGB")
        assert img.size == (256, 256)
        # Confirm something rendered: count non-background pixels.
        import numpy as np  # type: ignore
        arr = np.array(img)
        bg = np.array(_preview._BG_RGB, dtype=np.uint8)
        non_bg = np.any(arr != bg, axis=-1).sum()
        assert non_bg > 100, f"{p} renders ~empty ({non_bg} non-bg pixels)"
        # Each angle should produce a meaningfully different image (no
        # accidental identical renders from a broken rotation matrix).
        h = hash(arr.tobytes())
        seen_hashes.add(h)
    assert len(seen_hashes) == 5, "two angles produced identical pixels"


def test_try_render_angles_swallows_missing_file(tmp_path):
    """try_render_angles must never raise — callers rely on the soft-fail
    contract to keep the publishing pipeline running even on a bad mesh."""
    from designer import preview as _preview

    out = _preview.try_render_angles(
        str(tmp_path / "does-not-exist.glb"),
        output_dir=str(tmp_path),
        job_id=99,
    )
    assert out == []


def test_try_render_angles_swallows_degenerate_mesh(tmp_path):
    """A single-vertex 'mesh' is degenerate; the wrapper must return empty
    rather than propagate PreviewError."""
    import trimesh  # type: ignore
    from designer import preview as _preview

    bad = tmp_path / "flat.glb"
    # An empty mesh that should round-trip through trimesh without faces.
    mesh = trimesh.Trimesh(vertices=[[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces=[])
    mesh.export(str(bad))
    out = _preview.try_render_angles(str(bad), output_dir=str(tmp_path), job_id=11)
    assert out == []


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

    # Empty SVG fails validation → no asset → short-circuit.
    assert result["ok"] is False
    assert "no asset produced" in result["error"]
    assert "handoff" not in result
    assert result["model"] == MODEL
