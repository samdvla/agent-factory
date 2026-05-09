import json
import os
import urllib.error
import urllib.request

import pytest

from cfo.agent import handle


def test_cfo_closes_pipeline(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    result = handle("process_job", {
        "job_id": 1,
        "payload": {"listing_id": 12345, "price_usd": 5.99, "niche": "test niche"},
    })
    assert result["ok"] is True
    assert result["listing_id"] == 12345
    assert "sales_w1" in result
    assert "gross_usd" in result
    assert "net_usd" in result
    assert "cfo" in result["ticker_text"]
    # CFO now enqueues the next orchestrator cycle via a delayed handoff
    assert "handoff" in result
    assert result["handoff"]["to_role"] == "orchestrator"
    assert result["handoff"]["delay_ms"] == 60_000


def test_cfo_handles_missing_price(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    result = handle("process_job", {
        "job_id": 2,
        "payload": {"listing_id": 99, "price_usd": None},
    })
    assert result["ok"] is True
    assert isinstance(result["gross_usd"], float)


def test_outcomes_appended(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    result = handle("process_job", {
        "job_id": 3,
        "payload": {
            "listing_id": 4242,
            "price_usd": 7.50,
            "niche": "boho macrame",
        },
    })
    assert result["ok"] is True

    outcomes_path = tmp_path / "outcomes.jsonl"
    assert outcomes_path.exists()
    lines = outcomes_path.read_text().strip().splitlines()
    assert len(lines) == 1
    record = json.loads(lines[0])
    assert record["listing_id"] == 4242
    assert record["niche"] == "boho macrame"
    assert "sales" in record
    assert "revenue_usd" in record
    assert "ts" in record


def test_outcomes_failure_does_not_crash(tmp_path, monkeypatch):
    # Point the data dir at a path whose parent is a regular file — makedirs() will fail.
    blocker = tmp_path / "blocker"
    blocker.write_text("not a directory")
    bad_dir = blocker / "subdir"
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(bad_dir))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    result = handle("process_job", {
        "job_id": 4,
        "payload": {"listing_id": 99, "price_usd": 4.0, "niche": "x"},
    })
    # Even though writing outcomes.jsonl failed, cfo must still succeed.
    assert result["ok"] is True
    assert result["listing_id"] == 99


# --- Slice F: simulated buyer panel ---

def _fake_urlopen_factory(text: str, in_tokens: int = 80, out_tokens: int = 30):
    """Build a fake urlopen that returns a Sonnet-shaped response with `text` content."""

    class _Resp:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *args):
            return False

        def read(self_inner):
            body = {
                "content": [{"type": "text", "text": text}],
                "usage": {"input_tokens": in_tokens, "output_tokens": out_tokens},
            }
            return json.dumps(body).encode("utf-8")

    def _fake(*args, **kwargs):
        return _Resp()

    return _fake


def _full_payload(listing_id: int = 7777) -> dict:
    return {
        "listing_id": listing_id,
        "price_usd": 6.0,
        "niche": "minimalist line art",
        "title": "Minimalist Line Art Print Bundle",
        "description": "Beautiful set of digital downloads.",
        "tags": ["wall art", "minimalist", "line art", "printable"],
        "asset_brief": "Three minimal black-line botanicals on cream background",
        "brief": {"niche": "minimalist line art", "competition": "moderate"},
    }


def test_buyer_panel_called_when_api_key_set(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")

    fake = _fake_urlopen_factory(json.dumps({"sales": 5, "rationale": "strong niche fit"}))
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    result = handle("process_job", {"job_id": 10, "payload": _full_payload()})

    assert result["ok"] is True
    assert result["sales_w1"] == 5
    assert result["model"] == "claude-sonnet-4-6"
    assert result["tokens_in"] == 80
    assert result["tokens_out"] == 30
    assert "strong niche fit" in result["ticker_text"]
    assert result["rationale"] == "strong niche fit"


def test_falls_back_to_gauss_on_call_failure(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")

    def _boom(*args, **kwargs):
        raise urllib.error.URLError("network unreachable")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)

    result = handle("process_job", {"job_id": 11, "payload": _full_payload(8888)})

    assert result["ok"] is True
    assert isinstance(result["sales_w1"], int)
    assert "model" not in result
    assert "tokens_in" not in result
    assert "tokens_out" not in result

    outcomes_path = tmp_path / "outcomes.jsonl"
    assert outcomes_path.exists()
    record = json.loads(outcomes_path.read_text().strip().splitlines()[0])
    assert "rationale" not in record


def test_falls_back_when_no_api_key(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

    def _boom(*args, **kwargs):
        raise AssertionError("urlopen must not be called when ANTHROPIC_API_KEY missing")

    monkeypatch.setattr(urllib.request, "urlopen", _boom)

    result = handle("process_job", {"job_id": 12, "payload": _full_payload(9999)})

    assert result["ok"] is True
    assert "model" not in result


def test_clamps_sales_to_0_10(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")

    fake = _fake_urlopen_factory(json.dumps({"sales": 99, "rationale": "exceptional"}))
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    result = handle("process_job", {"job_id": 13, "payload": _full_payload(1010)})

    assert result["ok"] is True
    assert result["sales_w1"] == 10


def test_outcomes_includes_rationale_when_sonnet_succeeded(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")

    fake = _fake_urlopen_factory(json.dumps({"sales": 4, "rationale": "tags align with niche"}))
    monkeypatch.setattr(urllib.request, "urlopen", fake)

    result = handle("process_job", {"job_id": 14, "payload": _full_payload(2020)})
    assert result["ok"] is True

    outcomes_path = tmp_path / "outcomes.jsonl"
    assert outcomes_path.exists()
    record = json.loads(outcomes_path.read_text().strip().splitlines()[0])
    assert "rationale" in record
    assert record["rationale"] == "tags align with niche"
