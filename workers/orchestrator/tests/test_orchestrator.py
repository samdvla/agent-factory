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
