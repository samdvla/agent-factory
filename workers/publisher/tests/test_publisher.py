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


def test_asset_path_threaded_to_cfo():
    with tempfile.TemporaryDirectory() as tmpdir:
        os.environ["AGENT_FACTORY_DATA"] = tmpdir
        result = handle("process_job", {
            "job_id": 1,
            "payload": {
                "listing": {
                    "title": "Botanical Print Bundle",
                    "price_usd": 7.5,
                    "tags": ["botanical", "wall art"],
                    "description": "lush",
                },
                "asset": {
                    "brief_for_image_gen": "watercolor botanicals",
                    "asset_path": "/tmp/.agent-factory/assets/777.svg",
                },
                "brief": {"niche": "botanical wall art"},
            },
        })
        assert result["ok"] is True
        cfo_payload = result["handoff"]["payload"]
        assert cfo_payload["asset_path"] == "/tmp/.agent-factory/assets/777.svg"


def test_mock_etsy_record_includes_asset_path():
    with tempfile.TemporaryDirectory() as tmpdir:
        os.environ["AGENT_FACTORY_DATA"] = tmpdir
        result = handle("process_job", {
            "job_id": 2,
            "payload": {
                "listing": {
                    "title": "Minimalist Line Art",
                    "price_usd": 4.0,
                    "tags": ["minimal"],
                },
                "asset": {"asset_path": "/tmp/.agent-factory/assets/12.svg"},
            },
        })
        assert result["ok"] is True

        with open(os.path.join(tmpdir, "mock_etsy.json")) as f:
            records = json.load(f)
        assert len(records) == 1
        assert records[0]["asset_path"] == "/tmp/.agent-factory/assets/12.svg"

        # And again with no asset_path: record stores None.
        result2 = handle("process_job", {
            "job_id": 3,
            "payload": {
                "listing": {
                    "title": "Different Title",
                    "price_usd": 4.0,
                    "tags": [],
                },
                "asset": {},
            },
        })
        assert result2["ok"] is True
        with open(os.path.join(tmpdir, "mock_etsy.json")) as f:
            records = json.load(f)
        assert len(records) == 2
        # Find the new record by title
        new_rec = next(r for r in records if r["title"] == "Different Title")
        assert new_rec["asset_path"] is None
