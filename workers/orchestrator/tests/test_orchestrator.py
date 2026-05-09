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
