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
