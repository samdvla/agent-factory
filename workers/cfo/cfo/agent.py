import json
import os
import random
import sys
import time
import urllib.error
import urllib.request

MODEL = "claude-opus-4-7"
MAX_TOKENS = 200

ANTHROPIC_BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")


def _retry_request(req: urllib.request.Request, timeout: int = 60, max_attempts: int = 5) -> str:
    """POST with exponential backoff. Retries on 5xx and URLError. Does NOT retry on 4xx.
    Returns the response body as utf-8 string. Raises on final failure.

    HTTP 529 is Anthropic's load-shedding signal — typical overload events
    last 30s-2min, so the legacy 1s/2s/4s schedule (~7s total) blew right
    through them and failed real jobs. 529 gets its own longer schedule
    (8s/15s/30s/60s/60s). Other 5xx + URLError keep the fast schedule.

    _retry_request: see workers/research/tests/test_research.py for behavior coverage.
    """
    import time as _time
    overload_delays = (8, 15, 30, 60, 60)
    fast_delays = (1, 2, 4, 8, 16)
    last_exc: Exception | None = None
    for attempt in range(max_attempts):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read().decode("utf-8")
        except urllib.error.HTTPError as e:
            last_exc = e
            # Capture the response body once; HTTPError\'s default
            # str() is just "HTTP Error N: Reason" and the actual
            # diagnostic lives in the body that Anthropic returns.
            try:
                _body = e.read().decode("utf-8", errors="replace")
                if _body:
                    e.msg = f"{e.msg}: {_body[:600]}"
            except Exception:
                pass
            if e.code == 529 and attempt < max_attempts - 1:
                delay = overload_delays[min(attempt, len(overload_delays) - 1)]
                print(
                    f"[retry] HTTP 529 (Anthropic overloaded) attempt "
                    f"{attempt+1}/{max_attempts}; sleeping {delay}s",
                    file=sys.stderr, flush=True,
                )
                _time.sleep(delay)
                continue
            if 500 <= e.code < 600 and attempt < max_attempts - 1:
                delay = fast_delays[min(attempt, len(fast_delays) - 1)]
                print(f"[retry] HTTP {e.code} attempt {attempt+1}/{max_attempts}; sleeping {delay}s", file=sys.stderr, flush=True)
                _time.sleep(delay)
                continue
            raise
        except urllib.error.URLError as e:
            last_exc = e
            if attempt < max_attempts - 1:
                delay = fast_delays[min(attempt, len(fast_delays) - 1)]
                print(f"[retry] URLError {e} attempt {attempt+1}/{max_attempts}; sleeping {delay}s", file=sys.stderr, flush=True)
                _time.sleep(delay)
                continue
            raise
    if last_exc:
        raise last_exc
    raise RuntimeError("retry: unreachable")

def _use_json_prefill() -> bool:
    """Anthropic's Messages API supports assistant prefill (seeding the
    assistant turn with "{" to force structured JSON output). Some bridge
    proxies normalize / strip the trailing assistant message and reject the
    request with HTTP 400. Default ON; flip OFF when ANTHROPIC_BASE_URL
    points at anything other than Anthropic's direct host."""
    import os as _os
    url = _os.environ.get("ANTHROPIC_BASE_URL", "").strip()
    if not url:
        return True
    return "api.anthropic.com" in url


def _messages_for_json_call(user_content: str) -> list[dict]:
    """Build the messages array for a JSON-emitting Anthropic call. Adds the
    assistant prefill only when the API supports it (direct Anthropic, not
    a bridge proxy)."""
    msgs: list[dict] = [{"role": "user", "content": user_content}]
    if _use_json_prefill():
        msgs.append({"role": "assistant", "content": "{"})
    return msgs



def _parse_loose_json_object(text: str) -> dict:
    """Parse the first JSON object out of `text`, tolerating fences, trailing
    prose, and the most common Claude-emitted JSON breakage. Three layers:

      1. Strip leading markdown fences.
      2. raw_decode from the first '{' — handles trailing prose for free.
      3. On JSONDecodeError inside the JSON, attempt a small set of repairs
         (trailing-comma strip, newline-in-string normalization) and retry.

    Raises ValueError with a 240-char preview when no JSON exists at all, or
    when repair attempts still fail. Both the preview AND the failing
    parser-error location are logged to stderr so they show up in LiveLog.
    """
    s = text.strip()
    if s.startswith("```"):
        nl = s.find("\n")
        s = s[nl + 1 :] if nl != -1 else s
    start = s.find("{")
    if start == -1:
        preview = text.strip().replace("\n", " ")[:240]
        print(
            f"[parse] no JSON object found; first 240 chars of response: {preview!r}",
            file=sys.stderr, flush=True,
        )
        raise ValueError(
            f"no JSON object found in response (got prose). first 240 chars: {preview!r}"
        )
    body = s[start:]
    try:
        obj, _end = json.JSONDecoder().raw_decode(body)
    except json.JSONDecodeError as first_err:
        repaired = _repair_json_text(body)
        try:
            obj, _end = json.JSONDecoder().raw_decode(repaired)
            print(
                f"[parse] repaired JSON after initial error: {first_err}",
                file=sys.stderr, flush=True,
            )
        except json.JSONDecodeError as second_err:
            point = max(0, first_err.pos - 60)
            snippet = body[point : first_err.pos + 60].replace("\n", " ")
            print(
                f"[parse] JSON repair failed. first={first_err} second={second_err}; "
                f"body near pos {first_err.pos}: ...{snippet}...",
                file=sys.stderr, flush=True,
            )
            raise first_err
    if not isinstance(obj, dict):
        raise ValueError(f"expected JSON object, got {type(obj).__name__}")
    return obj


def _repair_json_text(text: str) -> str:
    """Best-effort repair of common Claude-emitted JSON breakage.

    Handles:
      • trailing commas before } or ]
      • CR/LF inside string values (replaced with single spaces)
      • lone backslashes that aren't starting a valid escape sequence
    Not a complete JSON5/json-repair; just covers the cases we've actually
    seen Haiku/Sonnet emit when the design_direction paragraph gets long.
    """
    import re as _re
    # 1. Strip trailing commas before } or ].
    out = _re.sub(r",(\s*[}\]])", r"\1", text)
    # 2. Normalize newlines inside string values: replace any \n that lives
    #    between an opening " and the next " on a different line with a space.
    #    Conservative — only triggers when we see a newline directly inside
    #    a string-typed value.
    def _collapse_newlines_in_strings(s: str) -> str:
        result = []
        i = 0
        in_string = False
        escape = False
        while i < len(s):
            c = s[i]
            if in_string:
                if escape:
                    result.append(c)
                    escape = False
                elif c == "\\":
                    result.append(c)
                    escape = True
                elif c == '"':
                    result.append(c)
                    in_string = False
                elif c in ("\n", "\r"):
                    result.append(" ")  # collapse newline inside string
                else:
                    result.append(c)
            else:
                result.append(c)
                if c == '"':
                    in_string = True
            i += 1
        return "".join(result)
    out = _collapse_newlines_in_strings(out)
    # 3. Fix lone backslashes that aren't starting a valid escape.
    out = _re.sub(r'\\(?!["\\/bfnrtu])', r"\\\\", out)
    return out


def _append_outcome(outcome: dict) -> None:
    """Append one JSON line to ~/.agent-factory/outcomes.jsonl. Failures are non-fatal."""
    try:
        data_dir = os.environ.get("AGENT_FACTORY_DATA", os.path.expanduser("~/.agent-factory"))
        os.makedirs(data_dir, exist_ok=True)
        path = os.path.join(data_dir, "outcomes.jsonl")
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(outcome) + "\n")
    except Exception as e:
        print(f"[cfo] WARN failed to append outcomes.jsonl: {e}", file=sys.stderr, flush=True)


def _build_buyer_prompt(
    brief: dict,
    asset_brief: str,
    title: str,
    description: str,
    tags: list,
    price_usd: float,
    asset_path: str | None = None,
) -> tuple[str, str]:
    system = (
        "You simulate a panel of typical Etsy shoppers browsing digital downloads. "
        "Given a product, estimate how many week-1 sales it would realistically get. "
        "Typical fresh listings: 0-3 sales/week. Strong listings (great niche fit, "
        "polished title, accurate tags, fair price): 3-7. Exceptional: 7-10. Be honest — "
        "weak products should get 0. Output JSON only with shape: "
        '{"sales": <int 0-10>, "rationale": "<one sentence>"}.'
    )
    if asset_path:
        asset_line = f"<svg saved at {asset_path}>"
    else:
        asset_line = "(no asset attached — text-only)"
    user = (
        f"Niche: {brief.get('niche', 'unknown')}\n"
        f"Competition: {brief.get('competition', 'unknown')}\n"
        f"Asset description: {asset_brief or '(none)'}\n"
        f"Asset: {asset_line}\n"
        f"Listing title: {title}\n"
        f"Tags: {', '.join(tags or [])}\n"
        f"Price: ${price_usd}\n"
        f"Description: {description[:600]}\n\n"
        "Estimate week-1 sales. JSON only."
    )
    return system, user


def _call_buyer_panel(
    api_key: str,
    brief: dict,
    asset_brief: str,
    title: str,
    description: str,
    tags: list,
    price_usd: float,
    asset_path: str | None = None,
) -> tuple[int, str, int, int] | None:
    """Returns (sales, rationale, tokens_in, tokens_out) on success, None on any failure."""
    try:
        system, user = _build_buyer_prompt(
            brief, asset_brief, title, description, tags, price_usd, asset_path
        )
        body = json.dumps({
            "model": MODEL,
            "max_tokens": MAX_TOKENS,
            "system": system,
                        "messages": _messages_for_json_call(user),
        }).encode("utf-8")
        req = urllib.request.Request(
            f"{ANTHROPIC_BASE_URL}/v1/messages",
            data=body,
            headers={
                "x-api-key": api_key,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            method="POST",
        )
        raw = _retry_request(req, timeout=30)
        response = json.loads(raw)
        text = response["content"][0]["text"]
        # Restore the prefilled "{" assistant.content so the JSON parser
        # sees a complete object. We only prepend when the response
        # contains no "{" at all — fenced or wrapped mock responses
        # already carry their own brace and pass through untouched.
        if "{" not in text:
            text = "{" + text
        result = _parse_loose_json_object(text)
        sales = int(result.get("sales", 0))
        sales = max(0, min(10, sales))  # clamp 0-10
        rationale = str(result.get("rationale", ""))[:200]
        usage = response.get("usage", {})
        return sales, rationale, usage.get("input_tokens", 0), usage.get("output_tokens", 0)
    except Exception as e:
        print(f"[cfo] buyer panel call failed, falling back to gaussian: {e}", file=sys.stderr, flush=True)
        return None


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}

    job_id = params.get("job_id", 0)
    payload = params.get("payload", {})
    listing_id = payload.get("listing_id")
    cycle_id = payload.get("cycle_id") if isinstance(payload, dict) else None
    price = payload.get("price_usd", 4.0)
    if price is None:
        price = 4.0
    niche = payload.get("niche")
    title = payload.get("title", "") or ""
    description = payload.get("description", "") or ""
    tags = payload.get("tags") or []
    asset_brief = payload.get("asset_brief", "") or ""
    asset_path = payload.get("asset_path")
    if not isinstance(asset_path, str) or not asset_path:
        asset_path = None
    brief = payload.get("brief") or {}
    if not isinstance(brief, dict):
        brief = {}

    # Sandbox-gated. Outside sandbox the buyer panel is a SIMULATION that
    # invents week-1 sales — historically that simulated revenue propagated
    # all the way to the topbar Revenue/Net pill, making the floor look
    # profitable when nothing had actually sold. In Live mode we want every
    # dollar shown to trace back to a real Etsy receipt, so we bypass the
    # panel entirely and emit a zero-sales close. Real sales arrive later
    # via the etsy_receipt poller, which updates `actual_revenue_usd` on
    # the same cycle row.
    sandbox_mode = (os.environ.get("UI_SANDBOX_MODE", "") or "").lower() == "true"

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    panel_result = None
    if sandbox_mode and api_key:
        panel_result = _call_buyer_panel(
            api_key, brief, asset_brief, title, description, tags, price, asset_path
        )

    rationale = ""
    tokens_in = 0
    tokens_out = 0
    used_sonnet = False

    if panel_result is not None:
        sales, rationale, tokens_in, tokens_out = panel_result
        used_sonnet = True
    elif sandbox_mode:
        # Sandbox fallback when the panel API call failed or no key is set.
        # Same shape as the panel result so the rest of the pipeline works.
        sales = max(0, int(random.gauss(1.2, 1.0)))
    else:
        # Live mode: no simulated sales. CFO becomes a pass-through that
        # closes the cycle with $0 estimated revenue; the etsy poller will
        # later overlay `actual_revenue_usd` once buyers actually pay.
        sales = 0

    gross = round(sales * price, 2)
    fees = round(gross * 0.065 + sales * 0.20, 2)  # 6.5% + $0.20/listing
    net = round(gross - fees, 2)

    print(
        f"[cfo] job_id={job_id} listing_id={listing_id} sales={sales} gross=${gross} net=${net} sonnet={used_sonnet}",
        file=sys.stderr,
        flush=True,
    )

    # Record outcome for the SI loop, but only when we have a real signal
    # to feed it. In Live mode (sandbox=false) we don't generate fake
    # sales numbers and writing zeros here would teach SI that every
    # listing flops, polluting the learning loop. The etsy_receipt
    # ingestor writes real-sale outcomes to the same JSONL when buyers
    # actually pay.
    if sandbox_mode:
        outcome = {
            "ts": int(time.time()),
            "listing_id": listing_id,
            "niche": niche,
            "sales": sales,
            "revenue_usd": gross,
        }
        if used_sonnet and rationale:
            outcome["rationale"] = rationale
        _append_outcome(outcome)

    if used_sonnet:
        ticker_text = (
            f"cfo · listing #{listing_id}: {sales} sales · gross ${gross} · net ${net}"
            f" · {rationale[:60]}"
        )
    else:
        ticker_text = f"cfo · listing #{listing_id}: {sales} sales · gross ${gross} · net ${net}"

    result: dict = {
        "ok": True,
        "listing_id": listing_id,
        "sales_w1": sales,
        "gross_usd": gross,
        "fees_usd": fees,
        "net_usd": net,
        "ticker_text": ticker_text,
        # Kick off the next product cycle after a 60 s cooldown. The next
        # cycle starts fresh, so we intentionally do NOT thread cycle_id
        # into the orchestrator handoff payload — orchestrator regenerates.
        "handoff": {
            "to_role": "orchestrator",
            "payload": {
                "trigger": "cfo_close",
                "prev_listing_id": listing_id,
                "prev_net_usd": net,
            },
            "delay_ms": 60_000,
        },
    }
    # Thread cycle_id through so the supervisor can close the cycle and
    # distribute wealth. Only set when present on the inbound payload — a
    # missing cycle_id means this job ran outside the pipeline.
    if cycle_id:
        result["cycle_id"] = cycle_id

    # Only include model/token fields when Sonnet was actually used — supervisor
    # gates BudgetSpent emission on all three being present.
    if used_sonnet:
        result["model"] = MODEL
        result["tokens_in"] = tokens_in
        result["tokens_out"] = tokens_out
        result["rationale"] = rationale

    return result
