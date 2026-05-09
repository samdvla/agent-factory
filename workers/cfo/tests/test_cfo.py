from cfo.agent import handle


def test_cfo_closes_pipeline():
    result = handle("process_job", {
        "job_id": 1,
        "payload": {"listing_id": 12345, "price_usd": 5.99},
    })
    assert result["ok"] is True
    assert result["listing_id"] == 12345
    assert "sales_w1" in result
    assert "gross_usd" in result
    assert "net_usd" in result
    assert "cfo" in result["ticker_text"]
    # No handoff — pipeline closes here
    assert "handoff" not in result


def test_cfo_handles_missing_price():
    result = handle("process_job", {
        "job_id": 2,
        "payload": {"listing_id": 99, "price_usd": None},
    })
    assert result["ok"] is True
    assert isinstance(result["gross_usd"], float)
