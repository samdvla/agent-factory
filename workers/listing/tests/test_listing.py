import json

from listing.agent import (
    build_listing_prompt,
    validate_listing,
    _fixed_price,
    _augment_listing,
    AI_DISCLOSURE_TEXT,
    PRODUCT_MATERIALS,
    SINGLE_PRICE_USD,
)


def test_prompt_includes_title_constraint():
    brief = {"niche": "minimalist wall art"}
    asset = {"asset_type": "printable", "dimensions": "8.5x11 inch"}
    system, user = build_listing_prompt(brief, asset)
    assert "140" in system
    assert "13 tags" in system or "Exactly 13" in system


def test_fixed_price_single_is_flat():
    """Every single model ships at the flat single-model tier, regardless
    of brief band or product type."""
    assert _fixed_price({"asset_path": "/x.stl"}) == SINGLE_PRICE_USD
    assert _fixed_price({}) == SINGLE_PRICE_USD
    assert _fixed_price(None) == SINGLE_PRICE_USD


def test_fixed_price_ignores_brief_band():
    """Pricing is operator policy — a brief price band must not move it."""
    assert _fixed_price({"price_band_usd": [10, 50], "asset_path": "/x.stl"}) == SINGLE_PRICE_USD


def test_augment_listing_appends_ai_disclosure():
    listing = {"description": "Cute sticker design.", "materials": ["digital download"]}
    _augment_listing(listing, {"product_type": "sticker"})
    assert AI_DISCLOSURE_TEXT.strip() in listing["description"]
    assert listing["description"].startswith("Cute sticker design.")


def test_augment_listing_is_idempotent_on_disclosure():
    """Re-running augment must not append the disclosure paragraph twice."""
    listing = {"description": "Cute design.", "materials": []}
    _augment_listing(listing, {"product_type": "sticker"})
    _augment_listing(listing, {"product_type": "sticker"})
    assert listing["description"].count(AI_DISCLOSURE_TEXT.strip()) == 1


def test_augment_listing_overrides_materials_for_sticker():
    listing = {"description": "x", "materials": ["digital download"]}
    _augment_listing(listing, {"product_type": "sticker"})
    assert listing["materials"] == PRODUCT_MATERIALS["sticker"]


def test_augment_listing_leaves_materials_alone_when_product_type_unknown():
    listing = {"description": "x", "materials": ["whatever"]}
    _augment_listing(listing, {"product_type": "mystery_box"})
    assert listing["materials"] == ["whatever"]


def test_listing_prompt_includes_product_type_guidance():
    system, _ = build_listing_prompt({"product_type": "sticker"}, {})
    assert "sticker" in system.lower()
    assert "kiss-cut" in system.lower() or "vinyl" in system.lower()


def test_clamp_tags_truncates_at_word_boundary():
    """Tags >20 chars get truncated to the last word boundary so they
    publish cleanly. Etsy's 20-char tag limit is non-negotiable; the
    model sometimes ignores it under retry pressure."""
    from listing.agent import _clamp_tags_to_etsy
    out = _clamp_tags_to_etsy(["3D printable cosplay helmet", "short", "fantasy helmet 3D model"])
    assert out[0] == "3D printable cosplay"  # 20 chars, on word boundary
    assert out[1] == "short"
    assert out[2] == "fantasy helmet 3D"  # 17 chars, on word boundary
    assert all(len(t) <= 20 for t in out)


def test_clamp_tags_hard_slice_when_no_space():
    """Single very-long word with no spaces — hard slice at 20."""
    from listing.agent import _clamp_tags_to_etsy
    out = _clamp_tags_to_etsy(["supercalifragilisticexpialidocious"])
    assert len(out[0]) == 20


def test_handle_silently_truncates_long_tags(tmp_path, monkeypatch):
    """End-to-end: the model returns 21-char tags, the worker truncates
    them silently rather than failing the job, and Etsy gets clean
    ≤20-char tags. Regression for stress-test failure #17 where the
    cosplay-helmet listing kept getting rejected on long tags."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    inp = _valid_tool_input()
    inp["tags"] = [
        "3D printable cosplay helmet",  # 27 chars
        "fantasy mask STL file",         # 21 chars
    ] + [f"ok-tag-{i}" for i in range(11)]
    _capture_anthropic_system(monkeypatch, responses=[_tool_use_response(inp)])
    from listing.agent import handle
    result = handle("process_job", {
        "job_id": 5,
        "payload": {"brief": {"niche": "x"}, "asset": {"asset_type": "printable"}},
    })
    assert result["ok"] is True
    tags = result["listing"]["tags"]
    assert all(len(t) <= 20 for t in tags)
    assert tags[0] == "3D printable cosplay"  # truncated at word boundary
    assert tags[1] == "fantasy mask STL"      # truncated at word boundary


def test_validate_listing_ok():
    listing = {
        "title": "Beautiful Minimalist Wall Art Print | Digital Download",
        "tags": ["wall art", "printable", "minimalist", "digital", "download",
                 "home decor", "modern art", "boho", "gallery wall",
                 "instant download", "art print", "bedroom decor", "office art"],
        "description": "A lovely print.",
        "materials": ["digital download"],
        "price_usd": 5.99,
    }
    errors = validate_listing(listing)
    assert errors == []


def test_validate_listing_title_too_long():
    listing = {
        "title": "x" * 141,
        "tags": ["t"] * 13,
        "description": "desc",
        "materials": ["digital download"],
        "price_usd": 5.0,
    }
    errors = validate_listing(listing)
    assert any("title" in e for e in errors)


def test_validate_listing_wrong_tag_count():
    listing = {
        "title": "Short Title",
        "tags": ["only", "five", "tags", "here", "oops"],
        "description": "desc",
        "materials": ["digital download"],
        "price_usd": 5.0,
    }
    errors = validate_listing(listing)
    assert any("tags" in e for e in errors)


def _valid_tool_input() -> dict:
    """A submit_listing input that passes the hard validator. Tests reuse
    this so a tweak to validation rules only needs editing in one place."""
    return {
        "title": "A short title that fits easily under 140 chars",
        "tags": [f"tag{i}" for i in range(13)],
        "description": "Long enough description. " * 12,  # ~290 chars
        "materials": ["digital download"],
        "price_usd": 5.0,
    }


def _tool_use_response(input_dict: dict, tool_id: str = "toolu_test_1") -> dict:
    return {
        "id": "msg_test",
        "type": "message",
        "role": "assistant",
        "model": "claude-haiku-4-5-20251001",
        "stop_reason": "tool_use",
        "content": [
            {
                "type": "tool_use",
                "id": tool_id,
                "name": "submit_listing",
                "input": input_dict,
            }
        ],
        "usage": {"input_tokens": 1, "output_tokens": 1},
    }


def _capture_anthropic_system(monkeypatch, *, responses: list[dict] | None = None):
    """Mock Anthropic to return queued forced-tool_use responses. Captures
    every outbound body so tests can introspect retries. Default queue is
    a single valid response."""
    if responses is None:
        responses = [_tool_use_response(_valid_tool_input())]
    captured: dict = {"bodies": []}
    queue = list(responses)

    class _Resp:
        def __init__(self, payload: dict): self._payload = payload
        def __enter__(self_inner): return self_inner
        def __exit__(self_inner, *a): return False
        def read(self_inner): return json.dumps(self_inner._payload).encode("utf-8")

    def _fake_urlopen(req, timeout=60):
        captured["bodies"].append(json.loads(req.data.decode("utf-8")))
        # Last queued response replays if the worker calls more times than
        # the queue length — keeps single-response setups working.
        payload = queue.pop(0) if len(queue) > 1 else queue[0]
        return _Resp(payload)

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)
    # Back-compat alias: legacy tests read captured["body"] as the FIRST
    # request body.
    captured["body"] = None  # populated lazily on first request
    class _Dict(dict):
        def __getitem__(self_inner, k):
            if k == "body":
                return self_inner["bodies"][0] if self_inner["bodies"] else None
            return dict.__getitem__(self_inner, k)
    return _Dict(captured)


def test_override_replaces_system(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    af_dir = tmp_path / ".agent-factory"
    af_dir.mkdir()
    override_text = "TEST_OVERRIDE_LISTING " * 5
    (af_dir / "prompts.json").write_text(json.dumps({
        "listing": {"system_override": override_text},
    }))

    captured = _capture_anthropic_system(monkeypatch)
    from listing.agent import call_anthropic
    call_anthropic("k-test", {"niche": "x"}, {"asset_type": "printable"})
    assert captured["body"]["system"] == override_text


def test_no_override_uses_default(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    captured = _capture_anthropic_system(monkeypatch)
    from listing.agent import call_anthropic
    call_anthropic("k-test", {"niche": "x"}, {"asset_type": "printable"})
    default_system, _ = build_listing_prompt({"niche": "x"}, {"asset_type": "printable"})
    assert captured["body"]["system"] == default_system


def test_call_anthropic_uses_tool_calling(tmp_path, monkeypatch):
    """Regression for 'Expecting property name enclosed in double quotes:
    line 1 column 2 (char 1)' crash on listing job #1180. Anthropic tool
    calling validates the output against the schema server-side, so the
    response is always a well-formed dict — no client-side JSON parsing
    is involved in the success path. Lock that contract."""
    monkeypatch.setenv("HOME", str(tmp_path))
    captured = _capture_anthropic_system(monkeypatch)
    from listing.agent import call_anthropic
    data, _, _ = call_anthropic("k-test", {"niche": "x"}, {"asset_type": "printable"})

    # The outbound request must declare the tool + force its use.
    body = captured["body"]
    tools = body.get("tools") or []
    assert len(tools) == 1
    assert tools[0]["name"] == "submit_listing"
    assert "title" in tools[0]["input_schema"]["properties"]
    assert tools[0]["input_schema"]["properties"]["tags"]["minItems"] == 13
    assert tools[0]["input_schema"]["properties"]["tags"]["maxItems"] == 13
    assert tools[0]["input_schema"]["properties"]["title"]["maxLength"] == 140
    assert body.get("tool_choice", {}).get("name") == "submit_listing"

    # No assistant prefill / json-mode hack should sneak in alongside tool use.
    msgs = body.get("messages") or []
    assert all(m["role"] != "assistant" for m in msgs)

    # The dict returned is exactly the tool's `input`, no JSON parsing.
    assert data["title"].startswith("A short title")
    assert len(data["tags"]) == 13
    assert data["price_usd"] == 5.0


def test_retry_corrects_invalid_tool_input(tmp_path, monkeypatch):
    """Anthropic treats input_schema as a strong hint, not a hard validator,
    so the worker hard-validates the tool input and sends corrective
    tool_result feedback to the model. First response: title too long.
    Second response: valid. Worker should succeed on attempt #2 and the
    second request body must include a tool_result entry referencing the
    first attempt's tool_use_id."""
    monkeypatch.setenv("HOME", str(tmp_path))

    bad = _valid_tool_input()
    bad["title"] = "x" * 200  # >140 chars triggers the validator
    good = _valid_tool_input()

    captured = _capture_anthropic_system(monkeypatch, responses=[
        _tool_use_response(bad, tool_id="toolu_first"),
        _tool_use_response(good, tool_id="toolu_second"),
    ])
    from listing.agent import call_anthropic
    data, _, _ = call_anthropic("k-test", {"niche": "x"}, {"asset_type": "printable"})

    assert data["title"] == good["title"]
    assert len(captured["bodies"]) == 2
    second_msgs = captured["bodies"][1]["messages"]
    # Should now have 3 turns: user, assistant (tool_use echo), user (tool_result).
    assert [m["role"] for m in second_msgs] == ["user", "assistant", "user"]
    tool_result = next(
        b for b in second_msgs[-1]["content"] if b.get("type") == "tool_result"
    )
    assert tool_result["tool_use_id"] == "toolu_first"
    assert tool_result["is_error"] is True
    assert "140" in tool_result["content"]


def test_retry_exhaustion_raises_with_token_accounting(tmp_path, monkeypatch):
    """If the model keeps emitting invalid tool input, raise ListingCallError
    after MAX_TOOL_RETRIES — and the exception MUST carry tokens_in/
    tokens_out so the supervisor's budget tracker records the burned tokens
    even on failure. Otherwise a stuck retry loop would silently bypass the
    hourly/daily/monthly cost caps."""
    monkeypatch.setenv("HOME", str(tmp_path))
    bad = _valid_tool_input()
    bad["tags"] = ["only", "five", "tags", "here", "oops"]
    _capture_anthropic_system(monkeypatch, responses=[
        _tool_use_response(bad, tool_id=f"toolu_{i}") for i in range(5)
    ])
    from listing.agent import call_anthropic, ListingCallError
    import pytest
    with pytest.raises(ListingCallError, match="schema validation after") as exc_info:
        call_anthropic("k-test", {"niche": "x"}, {"asset_type": "printable"})
    # Each of 3 attempts contributed 1 input + 1 output token in the fixture.
    assert exc_info.value.tokens_in == 3
    assert exc_info.value.tokens_out == 3


def test_handle_includes_tokens_on_failure(tmp_path, monkeypatch):
    """handle() must propagate the failed call's token usage to the
    supervisor so the budget ledger reflects the spend. Otherwise a
    chronic listing failure could blow through the cost cap."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    bad = _valid_tool_input()
    bad["tags"] = ["only", "five", "tags"]  # persistent bad
    _capture_anthropic_system(monkeypatch, responses=[
        _tool_use_response(bad, tool_id=f"toolu_{i}") for i in range(5)
    ])
    from listing.agent import handle
    result = handle("process_job", {
        "job_id": 99,
        "payload": {"brief": {"niche": "x"}, "asset": {"asset_type": "printable"}},
    })
    assert result["ok"] is False
    assert result["tokens_in"] == 3
    assert result["tokens_out"] == 3
    assert "model" in result


def test_call_anthropic_raises_when_tool_block_missing(tmp_path, monkeypatch):
    """If the bridge ever strips tool fields and the model falls back to a
    text reply, raise a clear error rather than silently returning garbage."""
    monkeypatch.setenv("HOME", str(tmp_path))

    class _Resp:
        def __enter__(self_inner): return self_inner
        def __exit__(self_inner, *a): return False
        def read(self_inner):
            return json.dumps({
                "stop_reason": "end_turn",
                "content": [{"type": "text", "text": "{...some text instead of tool_use..."}],
                "usage": {"input_tokens": 1, "output_tokens": 1},
            }).encode("utf-8")

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", lambda req, timeout=60: _Resp())

    from listing.agent import call_anthropic, ListingCallError
    import pytest
    with pytest.raises(ListingCallError, match="submit_listing tool_use block"):
        call_anthropic("k-test", {"niche": "x"}, {"asset_type": "printable"})


def test_cycle_id_propagates(tmp_path, monkeypatch):
    """Listing echoes inbound cycle_id into result top-level and handoff."""
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    _capture_anthropic_system(monkeypatch)
    from listing.agent import handle

    cid = "listing-cycle-deadbeef"
    result = handle("process_job", {
        "job_id": 9,
        "payload": {
            "brief": {"niche": "x"},
            "asset": {"asset_type": "printable"},
            "cycle_id": cid,
        },
    })
    assert result["ok"] is True
    assert result.get("cycle_id") == cid
    assert result["handoff"]["payload"]["cycle_id"] == cid
