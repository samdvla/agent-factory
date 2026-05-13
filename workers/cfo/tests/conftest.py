import pytest


@pytest.fixture(autouse=True)
def _sandbox_mode_on(monkeypatch):
    # CFO's buyer-panel simulator only runs when UI_SANDBOX_MODE=true.
    # Every test here exercises that simulator, so default to sandbox-on
    # rather than threading the env var through each test individually.
    # A test that wants to exercise the Live (non-sandbox) path can
    # `monkeypatch.setenv("UI_SANDBOX_MODE", "false")` itself.
    monkeypatch.setenv("UI_SANDBOX_MODE", "true")
