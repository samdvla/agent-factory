import json
import os

from cfo.agent import handle


def test_cfo_closes_pipeline(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
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
    result = handle("process_job", {
        "job_id": 2,
        "payload": {"listing_id": 99, "price_usd": None},
    })
    assert result["ok"] is True
    assert isinstance(result["gross_usd"], float)


def test_outcomes_appended(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
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

    result = handle("process_job", {
        "job_id": 4,
        "payload": {"listing_id": 99, "price_usd": 4.0, "niche": "x"},
    })
    # Even though writing outcomes.jsonl failed, cfo must still succeed.
    assert result["ok"] is True
    assert result["listing_id"] == 99
