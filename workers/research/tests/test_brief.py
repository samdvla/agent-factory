import json
from research.agent import build_demand_brief_prompt


def test_prompt_includes_niche_field():
    system, user = build_demand_brief_prompt()
    assert "niche" in user
    assert "Etsy" in system


def test_prompt_returns_strings():
    system, user = build_demand_brief_prompt()
    assert isinstance(system, str)
    assert isinstance(user, str)
