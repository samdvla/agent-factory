import json
import os
import tempfile
from publisher.agent import handle


def test_publisher_creates_listing_id():
    with tempfile.TemporaryDirectory() as tmpdir:
        os.environ["AGENT_FACTORY_DATA"] = tmpdir
        result = handle("process_job", {
            "job_id": 1,
            "payload": {
                "listing": {
                    "title": "Beautiful Minimalist Wall Art | Digital Download",
                    "price_usd": 5.99,
                    "tags": ["wall art", "printable"],
                }
            }
        })
        assert result["ok"] is True
        assert isinstance(result["listing_id"], int)
        assert "publisher → cfo" in result["ticker_text"]
        assert result["handoff"]["to_role"] == "cfo"


def test_publisher_deterministic_id():
    with tempfile.TemporaryDirectory() as tmpdir:
        os.environ["AGENT_FACTORY_DATA"] = tmpdir
        params = {"job_id": 1, "payload": {"listing": {"title": "Test Title", "price_usd": 3.0}}}
        r1 = handle("process_job", params)
        r2 = handle("process_job", params)
        assert r1["listing_id"] == r2["listing_id"]
