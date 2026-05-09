import random
import sys


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}

    job_id = params.get("job_id", 0)
    payload = params.get("payload", {})
    listing_id = payload.get("listing_id")
    price = payload.get("price_usd", 4.0)
    if price is None:
        price = 4.0

    # Simulate week 1 sales: 0-3 units typical for a fresh listing.
    sales = max(0, int(random.gauss(1.2, 1.0)))
    gross = round(sales * price, 2)
    fees = round(gross * 0.065 + sales * 0.20, 2)  # 6.5% + $0.20/listing
    net = round(gross - fees, 2)

    print(
        f"[cfo] job_id={job_id} listing_id={listing_id} sales={sales} gross=${gross} net=${net}",
        file=sys.stderr,
        flush=True,
    )

    return {
        "ok": True,
        "listing_id": listing_id,
        "sales_w1": sales,
        "gross_usd": gross,
        "fees_usd": fees,
        "net_usd": net,
        "ticker_text": f"cfo · listing #{listing_id}: {sales} sales · gross ${gross} · net ${net}",
        # No further handoff — this closes the pipeline.
    }
