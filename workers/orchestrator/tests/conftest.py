"""Test-wide fixtures for the orchestrator worker.

Disables live trend-signal fetching by default. The orchestrator now pulls
Reddit / Google Trends / YouTube on every job (best-effort), but tests
share `patch("urllib.request.urlopen", ...)` mocks that target only the
Anthropic call — a real trend fetch would either escape the mock and hit
the network, or get captured into the same `captured` list and break
assertions about which request body was sent first.

Tests that specifically want to exercise the trend path override this
fixture by setting ORCHESTRATOR_TREND_SIGNALS=1 explicitly.
"""
import pytest


@pytest.fixture(autouse=True)
def _disable_orchestrator_trend_fetch(monkeypatch):
    monkeypatch.setenv("ORCHESTRATOR_TREND_SIGNALS", "0")
