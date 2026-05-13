"""Design Strategist worker.

Runs periodically (or on demand). Reads recent designer outputs + the
sales/ratings outcomes, and asks Claude Sonnet to propose a tighter
designer system prompt. Writes the result to prompts.json as
`designer.system_override` — same mechanism the SI loop uses.

The strategist is intentionally narrow: it only touches the designer
prompt, and it leans heavily on design psychology + sticker-specific
guidance. Its job is "make every design more likely to sell," not
copy-tuning or pricing.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

MODEL = "claude-sonnet-4-6"
MAX_TOKENS = 2500
ANTHROPIC_BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")

# Minimum number of completed designer cycles before we'll attempt a tweak.
# Below this, there isn't enough signal; the strategist returns a no-op.
MIN_OUTCOMES = 3
TAIL_LIMIT = 30

# A safe size envelope for any prompt the strategist writes. Anything outside
# this band is rejected (likely a model hallucination or empty response) and
# the override is left untouched.
SYSTEM_MIN_LEN = 400
SYSTEM_MAX_LEN = 5000


def _data_dir() -> str:
    return os.path.expanduser(
        os.environ.get("AGENT_FACTORY_DATA", "~/.agent-factory")
    )


def _outcomes_path() -> str:
    return os.path.join(_data_dir(), "outcomes.jsonl")


def _prompts_path() -> str:
    return os.path.join(_data_dir(), "prompts.json")


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



def read_outcomes(path: str | None = None, limit: int = TAIL_LIMIT) -> list[dict]:
    p = path if path is not None else _outcomes_path()
    if not os.path.exists(p):
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return []
    tail = lines[-limit:] if len(lines) > limit else lines
    out: list[dict] = []
    for line in tail:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                out.append(obj)
        except json.JSONDecodeError:
            continue
    return out


def read_prompts() -> dict:
    p = _prompts_path()
    if not os.path.exists(p):
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def write_prompts(prompts: dict) -> None:
    p = _prompts_path()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(prompts, f, indent=2)
    os.replace(tmp, p)


_MARKETPLACE_SOURCES = {
    "cults3d_publish": "cults3d",
    "sketchfab_publish": "sketchfab",
    "gumroad_publish": "gumroad",
    "mmf_publish": "mmf",
}


def summarize_outcomes(outcomes: list[dict]) -> str:
    """One-line per outcome: niche · sales · revenue · views/favorites · marketplace.
    Lets the model pattern-match four distinct failure modes:
      - no views: the niche/visual is wrong (boring concept, bad SEO)
      - views, no favorites: the thumbnail isn't pulling clicks
      - views + favorites, no sales: price/title/description is the blocker
      - listed everywhere, zero traction: niche has no demand on ANY platform
    """
    rows: list[str] = []
    for o in outcomes:
        niche = o.get("niche") or "?"
        sales = o.get("sales", "?")
        rev = o.get("revenue_usd", "?")
        views = o.get("views")
        favs = o.get("favorites")
        rationale = o.get("rationale") or ""
        source = (o.get("source") or "").strip()
        marketplace_label = _MARKETPLACE_SOURCES.get(source)
        impression = ""
        if views is not None or favs is not None:
            impression = f"  views={views}  favorites={favs}"
        marketplace_suffix = ""
        if marketplace_label:
            marketplace_suffix = f"  marketplace={marketplace_label}"
        rows.append(
            f"  · niche={niche!r}  sales={sales}  rev=${rev}{impression}{marketplace_suffix}  {rationale[:80]}"
        )
    return "\n".join(rows) if rows else "  (no outcomes yet)"


def build_synthesis_prompt(current_override: str | None, outcomes: list[dict]) -> tuple[str, str]:
    system = (
        "You are the Design Strategist for an AI-run Etsy shop. Every cycle "
        "you read the most recent design outcomes AND draw on your knowledge "
        "of what's currently working in the design world, then propose a "
        "tighter system prompt for the Designer agent.\n\n"

        "Your goal: more sales. The prompt you write IS the Designer agent's "
        "operating manual. It must encode:\n"
        " • Design psychology that drives clicks at thumbnail scale\n"
        " • Composition, color, and typography rules that survive contact "
        "with the rasterizer\n"
        " • Product-specific framing (currently sticker-first)\n"
        " • Hard structural rules (viewBox, shape count, no markdown)\n\n"

        "DIAGNOSE FROM THE OUTCOMES TABLE — distinguish three failure modes:\n"
        " • LOW VIEWS → niche/SEO problem (boring concept, wrong tags). "
        "Designer can help by making the thumbnail more arresting; tags + "
        "title fixes are the listing worker's job.\n"
        " • VIEWS BUT NO FAVORITES → thumbnail doesn't pull. This is the "
        "Designer's PRIMARY signal. Fix: stronger focal point, bolder "
        "color contrast, clearer subject at 200px scale.\n"
        " • FAVORITES BUT NO SALES → price/listing copy problem. Tell the "
        "Designer to keep doing what's pulling favorites; the conversion "
        "fix lives elsewhere.\n"
        "Use the views/favorites columns to decide which mode dominates "
        "before you rewrite the prompt.\n\n"

        "ATTEND TO MARKETPLACE SIGNAL — outcomes may carry a `marketplace=` "
        "tag (etsy / cults3d / sketchfab / mmf / gumroad). Same design "
        "fanned out across all 5; different audiences live on each:\n"
        " • etsy / cults3d → gift-buyers, hobby printers (clean silhouettes, "
        "printable scale)\n"
        " • sketchfab → indie game devs, AR/VR audiences (cleaner topology, "
        "appealing turntable preview)\n"
        " • mmf → mini collectors, tabletop (28mm scale, support-friendly)\n"
        " • gumroad → general digital-goods buyers (presentation-driven, "
        "thumbnail does all the work)\n"
        "If one marketplace consistently lags, the design has a fit problem "
        "for THAT audience — note it so the Designer can adjust framing.\n\n"

        "DRAW ON EXTERNAL DESIGN KNOWLEDGE — use what you know about:\n"
        " • Battle-tested prompt patterns from Midjourney / Stable Diffusion "
        "communities (style anchors like 'flat vector', 'risograph print', "
        "'editorial illustration', 'die-cut sticker on white background', etc.). "
        "These prompt-engineering tricks transfer to SVG instruction.\n"
        " • Current Etsy bestseller aesthetics: cottagecore, dark academia, "
        "Y2K revival, mid-century modern, mushroom/plant maximalism, "
        "minimalist line art, retro Americana, '90s anime nostalgia, mental-"
        "health-positive typography stickers, dog/cat breed portraits.\n"
        " • Visual trends from Pinterest / TikTok shop / r/MakeMeSuffer: what's "
        "going viral right now in the small-craft visual world.\n"
        " • Famous designer rules-of-thumb: Dieter Rams' ten, Aarron Walter's "
        "hierarchy of needs, Don Norman's affordances — apply them to stickers.\n\n"

        "Steal mercilessly from prompts and aesthetics that demonstrably sell. "
        "Synthesize, don't quote. Pick the 2–3 ideas that would most likely "
        "lift conversion for our cheap sub-$12 sticker shop and bake them in.\n\n"

        "You are allowed to be opinionated and direct. The Designer is a "
        "Sonnet model — assume it reads carefully and rewards precision. Bad "
        "designs come from vague prompts, not from a lack of words; remove "
        "fluff, keep what actually changes behavior.\n\n"

        "OUTPUT FORMAT — return JSON ONLY, no markdown fences:\n"
        "{\n"
        '  "improved_system_prompt": "<the new full system prompt for the Designer>",\n'
        '  "rationale": "<2-3 sentences: what you noticed, what you changed, expected effect>"\n'
        "}\n"
        f"The improved prompt must be between {SYSTEM_MIN_LEN} and {SYSTEM_MAX_LEN} characters.\n"
    )

    cur = current_override or "(no override — Designer is using its built-in baseline prompt)"
    user = (
        "Recent design outcomes (most recent last):\n"
        f"{summarize_outcomes(outcomes)}\n\n"
        "Current Designer system prompt override:\n"
        f"---\n{cur}\n---\n\n"
        "Propose a tighter, more sales-driven Designer system prompt."
    )
    return system, user


def call_anthropic(api_key: str, system: str, user: str) -> tuple[dict, int, int]:
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
    raw = _retry_request(req, timeout=90)
    response = json.loads(raw)
    text = response["content"][0]["text"].strip()
    # Restore the prefilled "{" assistant.content so the JSON parser
    # sees a complete object. We only prepend when the response
    # contains no "{" at all — fenced or wrapped mock responses
    # already carry their own brace and pass through untouched.
    if "{" not in text:
        text = "{" + text
    usage = response.get("usage", {})
    tokens_in = usage.get("input_tokens", 0)
    tokens_out = usage.get("output_tokens", 0)

    # Strip fences if present
    if text.startswith("```"):
        lines = text.split("\n")
        text = "\n".join(lines[1:-1]) if len(lines) > 2 else text
    # Robust JSON parse — locate first '{' and use raw_decode so trailing
    # rationale prose can't break us (same defense as designer + listing).
    start = text.find("{")
    if start == -1:
        raise ValueError("strategist response had no JSON object")
    obj, _end = json.JSONDecoder().raw_decode(text[start:])
    if not isinstance(obj, dict):
        raise ValueError(f"strategist response was not an object: {type(obj).__name__}")
    return obj, tokens_in, tokens_out


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}
    return process_job(params.get("job_id", 0), params.get("payload", {}))


def process_job(job_id: int, payload: dict) -> dict:
    outcomes = read_outcomes()
    if len(outcomes) < MIN_OUTCOMES:
        print(
            f"[strategist] job_id={job_id} only {len(outcomes)} outcomes — need ≥{MIN_OUTCOMES}",
            file=sys.stderr, flush=True,
        )
        return {
            "ok": True,
            "ticker_text": f"strategist · waiting ({len(outcomes)}/{MIN_OUTCOMES} outcomes)",
            "role_tweaked": None,
            "model": MODEL,
            "tokens_in": 0,
            "tokens_out": 0,
        }

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"ok": False, "error": "ANTHROPIC_API_KEY not set", "ticker_text": "strategist failed: no API key"}

    prompts = read_prompts()
    current_override: str | None = None
    if isinstance(prompts.get("designer"), dict):
        cur = prompts["designer"].get("system_override")
        if isinstance(cur, str):
            current_override = cur

    system, user = build_synthesis_prompt(current_override, outcomes)
    try:
        result, tokens_in, tokens_out = call_anthropic(api_key, system, user)
    except Exception as e:
        msg = str(e)
        print(f"[strategist] job_id={job_id} ANTHROPIC ERROR: {msg}", file=sys.stderr, flush=True)
        return {"ok": False, "error": msg, "ticker_text": f"strategist failed: {msg[:80]}"}

    improved = result.get("improved_system_prompt")
    rationale = result.get("rationale") or ""
    if not isinstance(improved, str):
        return {"ok": False, "error": "no improved_system_prompt in response",
                "ticker_text": "strategist failed: bad response shape"}
    if not (SYSTEM_MIN_LEN <= len(improved) <= SYSTEM_MAX_LEN):
        return {
            "ok": False,
            "error": f"improved prompt length {len(improved)} outside [{SYSTEM_MIN_LEN},{SYSTEM_MAX_LEN}]",
            "ticker_text": "strategist rejected: bad length",
        }

    # Write the new override to prompts.json. Designer will pick it up on
    # its next job.
    designer_section = prompts.get("designer") if isinstance(prompts.get("designer"), dict) else {}
    designer_section["system_override"] = improved
    designer_section["last_strategist_rationale"] = rationale
    designer_section["last_strategist_ts"] = int(time.time())
    prompts["designer"] = designer_section
    try:
        write_prompts(prompts)
    except Exception as e:
        return {"ok": False, "error": f"prompts write failed: {e}",
                "ticker_text": "strategist failed: write error"}

    print(
        f"[strategist] job_id={job_id} updated designer prompt ({len(improved)} chars). rationale: {rationale[:120]}",
        file=sys.stderr, flush=True,
    )
    # Conversation log: tell the rest of the floor what changed, and why.
    # Designer is the direct recipient; the broadcast keeps research / listing
    # aware that the playbook just shifted under them.
    summary = rationale.strip() or "Tightened designer prompt based on recent outcomes."
    messages = [
        {
            "from": "strategist",
            "to": "designer",
            "topic": "prompt_update",
            "importance": "heads_up",
            "content": (
                f"Updated your system prompt ({len(improved)} chars). "
                f"Why: {summary}"
            ),
        },
        {
            "from": "strategist",
            "to": "*",
            "topic": "prompt_update",
            "importance": "info",
            "content": (
                f"Designer playbook refreshed after {len(read_outcomes())} outcomes. "
                f"Headline: {summary[:160]}"
            ),
        },
    ]
    return {
        "ok": True,
        "role_tweaked": "designer",
        "rationale": rationale,
        "ticker_text": f"strategist → designer: {rationale[:80]}",
        "model": MODEL,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "messages": messages,
    }
