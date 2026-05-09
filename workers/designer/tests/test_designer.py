from designer.agent import build_designer_prompt


def test_prompt_includes_asset_type():
    brief = {"niche": "minimalist wall art", "keywords": ["minimal", "art"], "price_band_usd": [5, 15]}
    system, user = build_designer_prompt(brief)
    assert "asset_type" in system
    assert "Designer" in system


def test_prompt_user_is_json_stringified_brief():
    import json
    brief = {"niche": "botanical prints", "keywords": ["botanical"], "price_band_usd": [8, 20]}
    system, user = build_designer_prompt(brief)
    parsed = json.loads(user)
    assert parsed["niche"] == "botanical prints"
