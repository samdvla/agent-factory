"""Design Strategist worker.

Runs periodically (or on demand). Reads recent designer outputs + the
sales/ratings outcomes, and asks Claude Sonnet to propose a tighter
designer system prompt. Writes the result to prompts.json as
`designer.system_override` — same mechanism the SI loop uses.

The shop pivoted to 3D-only (STL + GLB digital downloads) — so the
Designer's job is NOT to emit SVG markup; it's to write a structured
JSON brief that feeds Tripo / Meshy / Nano Banana Pro. The strategist
tunes the *philosophy* layer of that brief (subject framing, stylization,
printability, scale anchors). The schema is non-negotiable and re-appended
by the Designer worker regardless of the override — so the strategist
should never write SVG/viewBox/sticker-era instructions.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

MODEL = "claude-opus-4-7"
# Sized to comfortably emit a 10k-char `improved_system_prompt` + a ~500-char
# rationale + the JSON envelope (each is ~25% extra tokens after escaping).
# Observed in production: 4000 still cut a designer-tuning response mid-string
# at char 9831 ("Unterminated string starting at line 1 column 9831"), so we
# bump to 6000 for headroom AND added repair-on-truncate below so a future
# bump-needed event degrades gracefully instead of wasting the call.
MAX_TOKENS = 6000
ANTHROPIC_BASE_URL = os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com").rstrip("/")

# Minimum number of completed designer cycles before we'll attempt a tweak.
# Below this, there isn't enough signal; the strategist returns a no-op.
MIN_OUTCOMES = 3
TAIL_LIMIT = 30

# A safe size envelope for any prompt the strategist writes. Anything outside
# this band is rejected (likely a model hallucination or empty response) and
# the override is left untouched. Cap bumped from 10000 → 15000 to match the
# richer character-archetype designer baseline (which is ~9000 chars on its
# own with 8 lane definitions). Strategist is asked to aim for ≤14000 to
# leave headroom under the 15000 hard ceiling.
SYSTEM_MIN_LEN = 400
SYSTEM_MAX_LEN = 15000
SYSTEM_TARGET_MAX = 14000

# Bounds for the orchestrator strategist_notes payload. Notes are ADVISORY
# (appended to the orchestrator's user prompt), not a full prompt replacement
# like the designer override — so we want them tight and surgical, not long.
NOTES_MIN_LEN = 80
NOTES_MAX_LEN = 1500

# Recent-drafts window passed to the orchestrator meta-strategist. Larger
# than the strategist's outcome TAIL_LIMIT because the orchestrator needs
# anti-concentration signal, not just revenue signal.
ORCH_DRAFTS_TAIL_LIMIT = 25


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
            # Final attempt failed at the network layer (timeout, refused,
            # DNS). The raw URLError str() — "<urlopen error [Errno 60]
            # ...>" — means nothing to a user, so raise something actionable.
            _host = getattr(req, "host", "") or "the Claude API"
            raise ConnectionError(
                f"couldn't reach the Claude API at {_host} after "
                f"{max_attempts} tries ({e.reason}). Check your Anthropic API "
                f"key and internet connection — and if you set an Anthropic "
                f"bridge in Settings, make sure that bridge host is online."
            ) from e
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
        "PERSONA — You are the Design Strategist: a senior 3D-product "
        "strategist for the shop's autonomous Designer agent. You watch "
        "what sold and what bombed across Etsy + Cults3D + Sketchfab + "
        "MyMiniFactory + Gumroad, then refine the Designer's operating "
        "manual so the next cycle wins more often. You think two-to-three "
        "steps ahead: what brief produces a mesh that produces a listing "
        "that produces a sale. You are opinionated, terse, and surgical — "
        "you cut fluff and bake in only what changes behavior.\n\n"
        "Every cycle you read the most recent design outcomes AND draw on "
        "your knowledge of what sells in the 3D-print / collector / tabletop "
        "world, then propose a tighter system prompt for the Designer agent.\n\n"

        "WHAT THE DESIGNER ACTUALLY DOES — do not get this wrong:\n"
        " • Reads a Demand Brief from the research agent (niche + design "
        "direction + product_type = 'stl_file' or '3d_model').\n"
        " • Calls Claude Haiku to produce a STRUCTURED JSON BRIEF (not "
        "SVG, not markup) with fields: asset_type, style, palette, "
        "dimensions, mockup_count, brief_for_image_gen.\n"
        " • The brief_for_image_gen string is fed verbatim into Nano Banana "
        "Pro (image render) → Tripo or Meshy (image-to-3D mesh). The "
        "Designer never emits SVG, never has a viewBox, never produces "
        "thumbnails. Tripo/Meshy produce the GLB; we render thumbnails off "
        "the mesh separately.\n"
        " • The prompt you write IS the philosophy layer above that JSON "
        "schema. The schema is non-negotiable and re-appended by the worker "
        "every call — so focus on subject framing, stylization anchors, "
        "scale, printability, and what NOT to include.\n\n"

        "PRODUCT SCOPE (HARD RULE — operator-locked):\n"
        " The shop sells CHARACTER FIGURINES ONLY — humanoid, monster, "
        "creature, mascot, animal-as-character, robot, named-archetype 3D "
        "model. The override you write MUST keep the Designer producing only "
        "character sculpts. NEVER recommend dice towers, dice trays, candle "
        "holders, planters, canopic jars, jewelry, pendants, rings, terrain "
        "tiles, fidget toys, articulated mechanisms, or standalone props. "
        "If past outcomes show a dice tower or planter winning, that's "
        "STALE data from before the scope change — DO NOT cite it as a "
        "winner or carry it into the new override.\n\n"

        "FULL-BODY + NO-BASE (HARD RULE — operator-locked):\n"
        " Every character MUST be rendered FULL-BODY — no busts, no head-"
        "only, no waist-up, no floating-torso. AND no base/plinth/pedestal/"
        "stand of any kind. The character stands on its own feet (or sits / "
        "crouches / lies on its own form) — the mesh is the character ONLY, "
        "with nothing under it. The override you write MUST NOT contain the "
        "strings 'integral base', 'integral slotta-base', 'integral plinth', "
        "'on plinth', 'on pedestal', 'with base', 'with plinth', 'standing "
        "on integral', or 'optional integral base'. SCALE examples should "
        "always end with 'standing on own feet, no base' or equivalent. "
        "This is non-negotiable — the operator down-rates anything that "
        "ships with a base.\n\n"

        "Your goal: more sales of CHARACTER FIGURINES. The override you write must encode:\n"
        " • Subject + pose specificity for full-body characters (e.g. "
        "'goblin warrior, three-quarter stance, sword raised'; 'Bastet "
        "cat-goddess upright, ankh in raised hand, full-body figurine').\n"
        " • Character-archetype diversity across mythology, anime, sci-fi, "
        "fantasy, monsters, mascots — rotation requirement, never the same "
        "lane back-to-back.\n"
        " • Stylization anchors that print well — stylized cartoon, "
        "low-poly, semi-realistic, hard-surface geometric, organic flowing.\n"
        " • Printability constraints — no thin overhangs, support-friendly "
        "silhouette, single static mesh, full-body never bust-only.\n"
        " • Scale anchors — 28mm tabletop mini / 80mm desk figurine / "
        "150mm display piece — drives buyer expectations and matches the "
        "price band.\n"
        " • What to AVOID — no moving parts, no thin appendages, no "
        "copyrighted IP traits, no functional objects masquerading as "
        "character briefs.\n\n"

        "DIAGNOSE FROM THE OUTCOMES TABLE — distinguish three failure modes:\n"
        " • LOW VIEWS → niche/SEO problem (wrong tags, boring concept). "
        "Designer can help by making the rendered preview more arresting, "
        "but tag fixes belong to listing.\n"
        " • VIEWS BUT NO FAVORITES → the rendered mesh / preview doesn't "
        "pull. This is the Designer's PRIMARY signal. Fix: stronger silhouette, "
        "more iconic pose, clearer stylization anchor in brief_for_image_gen.\n"
        " • FAVORITES BUT NO SALES → price/listing/printability concerns. "
        "Tell the Designer to keep doing what's pulling favorites; the "
        "conversion fix lives elsewhere.\n"
        "Use the views/favorites columns to decide which mode dominates.\n\n"

        "ATTEND TO MARKETPLACE SIGNAL — outcomes may carry a `marketplace=` "
        "tag (etsy / cults3d / sketchfab / mmf / gumroad). Same model "
        "fanned out across all 5; different audiences live on each:\n"
        " • etsy / cults3d → gift-buyers + hobby printers (clean silhouettes, "
        "support-friendly meshes, 28mm-15cm print scale, $3-$15 price band)\n"
        " • sketchfab → indie game devs + AR/VR (cleaner topology, "
        "appealing turntable preview, lower poly OK)\n"
        " • mmf (MyMiniFactory) → tabletop mini collectors (28mm scale, "
        "support-friendly, base included)\n"
        " • gumroad → general digital-goods buyers (the preview render does "
        "all the work — no community trust, no search algorithm assist)\n"
        "If one marketplace consistently lags, the design has a fit problem "
        "for THAT audience — adjust framing in brief_for_image_gen.\n\n"

        "DRAW ON EXTERNAL KNOWLEDGE — what you know about CHARACTER FIGURINES:\n"
        " • What sells in the character-collectible / tabletop-mini space: "
        "mythology deity figurines (Egyptian, Norse, Greek, Hindu, Aztec, "
        "Celtic, Slavic, Shinto, Sumerian), eldritch humanoid avatars "
        "(Cthulhu / Deep One / cultist as full-body characters), anime / "
        "manga archetypes (samurai, mecha pilot, magical girl, shounen "
        "hero, idol, ninja), comic / superhero / vigilante archetypes, "
        "sci-fi (cyberpunk merc, space marine, android, mech pilot), "
        "fantasy (dragon-rider, druid, lich, orc warlord), monsters and "
        "creatures as hero figurines, mascots (animal-warriors, kid heroes, "
        "cute monsters), and original characters in coined universes.\n"
        " • Prompt patterns that produce printable 3D characters — concrete "
        "subject + full-body pose + single stylization anchor + scale + "
        "'support-friendly silhouette' / 'single static mesh' / 'fully "
        "sculpted finished character'.\n"
        " • Aesthetic codes by archetype: Lovecraftian humanoid → tentacle "
        "motifs ON THE BODY (face/limbs/hair), asymmetric organic forms; "
        "Norse → angular geometric armor, runic accents on fabric/skin; "
        "Egyptian deity → upright iconic full-body pose, hieroglyph relief "
        "on regalia; cyberpunk → neon-trim power armor, circuitry across "
        "chestplate; mascot → exaggerated chunky printable proportions.\n"
        " • Pricing reality — operator policy locks every sale to $3-$15. "
        "Single minis $4-$9, desk figurines $7-$12, large display $11-$15. "
        "Never write 'price-anchor toward $20-$30' or any value outside "
        "[$3, $15] — the publisher will silently clamp.\n\n"

        "Steal mercilessly from briefs and patterns that demonstrably sell. "
        "Synthesize, don't quote. Pick the 2-3 ideas that would most likely "
        "lift conversion for this 3D-only shop and bake them in.\n\n"

        "HARD RULES — the override must NEVER contain:\n"
        " • The strings 'SVG', 'viewBox', 'kiss-cut', 'sticker', 'thumbnail "
        "psychology', '200px', 'planner', 'printable wall art'. These are "
        "pre-pivot artifacts that will be rejected by the Designer at runtime.\n"
        " • Recommendations or examples involving non-character products: "
        "'dice tower', 'dice tray', 'candle holder', 'planter', 'canopic "
        "jar', 'pendant', 'ring', 'jewelry', 'terrain tile', 'modular tile', "
        "'fidget toy', 'flexi', 'articulated mechanism', 'standalone prop', "
        "'altar piece' (unless rephrased as a deity figurine), 'desk caddy', "
        "'organizer'. The shop is character-figurines-only.\n"
        " • Instructions to emit markup, fences, or anything other than JSON.\n"
        " • Price ceilings or floors outside [$3, $15] — that's listing's job, "
        "not design's.\n\n"

        "You are allowed to be opinionated and direct. The Designer uses "
        "Claude Haiku — assume it reads carefully and rewards precision. Bad "
        "designs come from vague briefs, not from a lack of words; remove "
        "fluff, keep what actually changes behavior.\n\n"

        "OUTPUT FORMAT — return JSON ONLY, no markdown fences:\n"
        "{\n"
        '  "improved_system_prompt": "<the new full system prompt for the Designer>",\n'
        '  "rationale": "<2-3 sentences: what you noticed, what you changed, expected effect>"\n'
        "}\n"
        f"The improved prompt must be between {SYSTEM_MIN_LEN} and {SYSTEM_MAX_LEN} characters, "
        f"and MUST NOT exceed {SYSTEM_TARGET_MAX} characters — leave a "
        f"{SYSTEM_MAX_LEN - SYSTEM_TARGET_MAX}-char buffer under the hard cap so "
        "small additions later don't blow the limit. Aim for 9000-12000 characters "
        "— enough to cover the 8 character-archetype lanes with concrete pose "
        "examples, without padding. Trim any section that doesn't materially "
        "change what gets generated.\n"
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
    body = text[start:]
    try:
        obj, _end = json.JSONDecoder().raw_decode(body)
    except json.JSONDecodeError as e:
        # Try a single repair pass: when Anthropic hits max_tokens mid-string,
        # the response ends inside an unterminated value (the symptom we
        # observed at char 9831). Close the open string and close any open
        # objects — we lose the tail of the last field but keep the rest.
        # Only kick in for the specific 'Unterminated string' error; other
        # decode errors propagate so we see real bugs.
        if "Unterminated string" not in str(e):
            raise
        repaired = _repair_truncated_json(body)
        try:
            obj, _end = json.JSONDecoder().raw_decode(repaired)
            print(
                f"[strategist] recovered truncated JSON ({len(body)} chars → "
                f"closed at char {len(repaired)}); response hit max_tokens "
                f"and was repaired",
                file=sys.stderr, flush=True,
            )
        except json.JSONDecodeError:
            # Repair didn't save us — surface the original error so the
            # outer caller's "bad response shape" handler kicks in.
            raise e
    if not isinstance(obj, dict):
        raise ValueError(f"strategist response was not an object: {type(obj).__name__}")
    return obj, tokens_in, tokens_out


def _repair_truncated_json(body: str) -> str:
    """Close the most-recently-opened string and any unclosed `{` / `[`.

    Used when an LLM response hit max_tokens mid-string. We can't recover
    the tail of the cut-off value, but we CAN close the JSON so the parser
    accepts what we have (the head of the truncated field plus everything
    before it). Caller decides whether the recovered payload is usable.

    The walker mirrors the orchestrator's `_collapse_newlines_in_strings`
    state machine: tracks in-string + escape state, then appends the
    closing characters needed to balance.
    """
    in_string = False
    escape = False
    stack: list[str] = []  # holds '{' or '['
    for c in body:
        if in_string:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_string = False
        else:
            if c == '"':
                in_string = True
            elif c == "{":
                stack.append("{")
            elif c == "[":
                stack.append("[")
            elif c == "}":
                if stack and stack[-1] == "{":
                    stack.pop()
            elif c == "]":
                if stack and stack[-1] == "[":
                    stack.pop()
    tail = ""
    if in_string:
        # An unescaped " ends the string. The character before us was
        # inside the value, so just close it.
        tail += '"'
    # Close any opens in reverse order.
    for opener in reversed(stack):
        tail += "}" if opener == "{" else "]"
    return body + tail


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}
    return process_job(params.get("job_id", 0), params.get("payload", {}))


def _read_recent_drafts(limit: int = ORCH_DRAFTS_TAIL_LIMIT) -> list[dict]:
    """Read the last N publisher records (drafts the pipeline already
    produced). Used by the orchestrator-tuning path to surface
    anti-concentration signal — distinct from the strategist's outcome
    feed which only contains items with actual sales."""
    p = os.path.join(_data_dir(), "publisher_output.json")
    if not os.path.exists(p):
        return []
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    return data[-limit:]


def build_orchestrator_notes_prompt(
    current_notes: str | None,
    outcomes: list[dict],
    recent_drafts: list[dict],
) -> tuple[str, str]:
    """Synthesis prompt for tuning the orchestrator (Strategy Lead).

    Unlike the designer-tuning path, this does NOT rewrite the orchestrator's
    full system prompt — the orchestrator's prompt is assembled dynamically
    each cycle (pool selection, product rotation, focus mode). Instead we
    produce a short ADVISORY note that the orchestrator appends to its user
    prompt as the last thing the model reads before picking a niche. This
    keeps the dynamic assembly intact while still giving the meta-strategist
    a high-attention slot.
    """
    cur = current_notes or "(no prior notes — the orchestrator is running on its built-in category list only)"
    drafts_summary = "(no recent drafts yet)"
    if recent_drafts:
        recent_niches = [d.get("niche") for d in recent_drafts[-10:] if d.get("niche")]
        if recent_niches:
            drafts_summary = "Last drafts: " + " | ".join(str(n) for n in recent_niches)

    system = (
        "PERSONA — You are the Strategy Lead's TUNER. The orchestrator (a "
        "Claude Opus call) picks ONE niche_seed per cycle and hands it down "
        "the pipeline. You don't rewrite its full system prompt — that's "
        "assembled dynamically each cycle. Instead you produce a SHORT "
        "advisory note that the orchestrator reads as the last thing before "
        "it decides. Your note becomes the LAST block in the orchestrator's "
        "user prompt (last tokens = strongest attention), so make every "
        "sentence pull weight on the decision.\n\n"
        "PRODUCT SCOPE (HARD RULE — operator-locked):\n"
        " The shop sells CHARACTER FIGURINES ONLY — humanoid, monster, "
        "creature, mascot, animal-as-character, robot, named-archetype 3D "
        "model. Your note MUST keep the orchestrator picking character "
        "niches. NEVER suggest dice towers, dice trays, candle holders, "
        "planters, canopic jars, jewelry, pendants, rings, terrain tiles, "
        "fidget toys, articulated mechanisms, or standalone props. If past "
        "outcomes show a non-character winner, that's STALE pre-scope-shift "
        "data — do NOT cite it as a winner. The variable to tune is WHAT "
        "KIND OF CHARACTER (anime, mythology, sci-fi, fantasy, monster, "
        "mascot, etc.), not whether to pivot back to objects.\n\n"

        "WHAT THE ORCHESTRATOR ALREADY SEES on its own:\n"
        " • A character-archetype universe (mythology deities, eldritch "
        "humanoids, anime archetypes, comic / superhero, sci-fi, fantasy, "
        "monsters / creatures, mascots, originals).\n"
        " • Recent outcomes bucketed into Top performers / Promising "
        "(traction but no sales) / Underperformers — read straight from "
        "outcomes.jsonl. Treat any non-character row as stale.\n"
        " • Recent drafts with over-concentrated theme words flagged.\n"
        " • Operator steers (highest-priority overrides) and rejections.\n"
        " • Live trend signals (Reddit / Google Trends / YouTube).\n\n"
        "WHAT YOUR NOTE SHOULD ADD on top of that:\n"
        " • Cross-niche patterns the orchestrator can't infer from a single "
        "outcome row — e.g. 'every mythology niche we shipped at 28mm "
        "stalled on conversion; the 80mm desk figurines converted. Bias "
        "scale up next cycle.'\n"
        " • Adjacency suggestions: when X sells well, what should we try "
        "NEXT — not what to copy.\n"
        " • Diagnoses of failure modes: if Promising niches are stacking up "
        "(traffic but no sales), that's a listing/price problem, not a "
        "niche-pick problem; the orchestrator should keep picking similar.\n"
        " • Bias instructions when one category is over-explored vs another "
        "starved (you can see this from outcome volume distribution).\n\n"
        "WHAT YOUR NOTE SHOULD NOT DO:\n"
        " • Reproduce the orchestrator's hardcoded category list.\n"
        " • Issue generic 'focus on what sells' advice — useless.\n"
        " • Pick a specific niche — that's the orchestrator's job.\n"
        " • Mention SVG, stickers, planners, or any pre-pivot product.\n"
        " • Recommend any non-character product (dice tower, candle holder, "
        "planter, pendant, jewelry, ring, terrain, fidget, articulated, "
        "standalone prop). The shop is character-figurines-only.\n"
        " • Exceed 1500 chars. Aim for 400-900 — surgical, not exhaustive.\n\n"
        "OUTPUT FORMAT — return JSON ONLY, no markdown fences:\n"
        "{\n"
        '  "strategist_notes": "<short paragraph or 3-5 bullet lines of '
        'tuning guidance>",\n'
        '  "rationale": "<2-3 sentences: what pattern you noticed, why this '
        'note moves the needle>"\n'
        "}\n"
        f"The notes must be between {NOTES_MIN_LEN} and {NOTES_MAX_LEN} chars."
    )

    user = (
        "Recent outcomes (most recent last):\n"
        f"{summarize_outcomes(outcomes)}\n\n"
        f"{drafts_summary}\n\n"
        "Current strategist_notes the orchestrator is reading:\n"
        f"---\n{cur}\n---\n\n"
        "Produce a fresh, surgical strategist_notes payload."
    )
    return system, user


def _process_orchestrator_tuning(job_id: int) -> dict:
    """Meta-strategist tick for the orchestrator. Reads outcomes + recent
    drafts, asks Claude for a short advisory note, writes it to
    prompts.json under `orchestrator.strategist_notes`. The orchestrator
    worker reads this on its next job."""
    outcomes = read_outcomes()
    if len(outcomes) < MIN_OUTCOMES:
        print(
            f"[strategist→orchestrator] job_id={job_id} only "
            f"{len(outcomes)} outcomes — need ≥{MIN_OUTCOMES}",
            file=sys.stderr, flush=True,
        )
        return {
            "ok": True,
            "ticker_text": f"strategist · orch tuning waiting ({len(outcomes)}/{MIN_OUTCOMES} outcomes)",
            "role_tweaked": None,
            "model": MODEL,
            "tokens_in": 0,
            "tokens_out": 0,
        }

    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {"ok": False, "error": "ANTHROPIC_API_KEY not set",
                "ticker_text": "strategist→orchestrator failed: no API key"}

    prompts = read_prompts()
    current_notes: str | None = None
    if isinstance(prompts.get("orchestrator"), dict):
        cur = prompts["orchestrator"].get("strategist_notes")
        if isinstance(cur, str):
            current_notes = cur
    recent_drafts = _read_recent_drafts()

    system, user = build_orchestrator_notes_prompt(current_notes, outcomes, recent_drafts)
    try:
        result, tokens_in, tokens_out = call_anthropic(api_key, system, user)
    except Exception as e:
        msg = str(e)
        print(f"[strategist→orchestrator] job_id={job_id} ANTHROPIC ERROR: {msg}",
              file=sys.stderr, flush=True)
        return {"ok": False, "error": msg,
                "ticker_text": f"strategist→orchestrator failed: {msg[:80]}"}

    notes = result.get("strategist_notes")
    rationale = result.get("rationale") or ""
    if not isinstance(notes, str):
        return {"ok": False, "error": "no strategist_notes in response",
                "ticker_text": "strategist→orchestrator: bad response shape"}
    if not (NOTES_MIN_LEN <= len(notes) <= NOTES_MAX_LEN):
        return {
            "ok": False,
            "error": f"notes length {len(notes)} outside [{NOTES_MIN_LEN},{NOTES_MAX_LEN}]",
            "ticker_text": "strategist→orchestrator rejected: bad length",
        }

    orch_section = prompts.get("orchestrator") if isinstance(prompts.get("orchestrator"), dict) else {}
    orch_section["strategist_notes"] = notes
    orch_section["last_strategist_rationale"] = rationale
    orch_section["last_strategist_ts"] = int(time.time())
    prompts["orchestrator"] = orch_section
    try:
        write_prompts(prompts)
    except Exception as e:
        return {"ok": False, "error": f"prompts write failed: {e}",
                "ticker_text": "strategist→orchestrator failed: write error"}

    print(
        f"[strategist→orchestrator] job_id={job_id} updated notes "
        f"({len(notes)} chars). rationale: {rationale[:120]}",
        file=sys.stderr, flush=True,
    )
    summary = rationale.strip() or "Tightened orchestrator notes based on recent outcomes."
    messages = [
        {
            "from": "strategist",
            "to": "orchestrator",
            "topic": "notes_update",
            "importance": "heads_up",
            "content": (
                f"Strategy Lead — refreshed your strategist_notes. They load on "
                f"your next niche-pick job.\n\n"
                f"Pattern across the last {len(outcomes)} outcomes: {summary}\n\n"
                f"Advisory only — operator steers still win in the prompt order."
            ),
        },
        {
            "from": "strategist",
            "to": "*",
            "topic": "notes_update",
            "importance": "info",
            "content": (
                f"Refreshed the Strategy Lead's notes off the last {len(outcomes)} outcomes. "
                f"Headline: {summary[:200]}"
            ),
        },
    ]
    return {
        "ok": True,
        "role_tweaked": "orchestrator",
        "rationale": rationale,
        "ticker_text": f"strategist → orchestrator: {rationale[:80]}",
        "model": MODEL,
        "tokens_in": tokens_in,
        "tokens_out": tokens_out,
        "messages": messages,
    }


def process_job(job_id: int, payload: dict) -> dict:
    # Dispatch by `target` field. Default "designer" preserves the original
    # behavior (the Rust loop alternates "designer" / "orchestrator" by
    # tick; old enqueues without `target` continue to tune the designer).
    target = "designer"
    if isinstance(payload, dict):
        t = payload.get("target")
        if isinstance(t, str) and t.strip():
            target = t.strip().lower()
    if target == "orchestrator":
        return _process_orchestrator_tuning(job_id)
    if target != "designer":
        return {"ok": False,
                "error": f"unknown strategist target: {target}",
                "ticker_text": f"strategist: unknown target {target}"}

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
    # Soft target: warn (and reject) when the model exceeded the 14000-char
    # target even if it stayed under the 15000 hard cap. Leaving the buffer
    # protects against tiny later additions blowing the cap and stalling the
    # next strategist tick on a bad re-tune.
    if len(improved) > SYSTEM_TARGET_MAX:
        return {
            "ok": False,
            "error": (
                f"improved prompt length {len(improved)} exceeded soft target "
                f"{SYSTEM_TARGET_MAX} (hard cap {SYSTEM_MAX_LEN}). Rejected to "
                "preserve buffer; the next tick will retry with a tighter draft."
            ),
            "ticker_text": "strategist rejected: over 14k buffer",
        }
    # Auto-scrub base/plinth/pedestal phrases that the LLM keeps re-injecting
    # despite the persona's HARD RULE. Rejecting + retrying every 15 min just
    # burns Opus credits without making progress (the model's "knowledge of
    # what sells" stubbornly remembers integral-base figurines). Instead we
    # accept the override but rewrite the offending phrases to operator-
    # approved alternatives, then validate the cleaned output. Reject only
    # when scrubbing would produce something incoherent (no sentences left).
    BANNED_BASE_REWRITES: list[tuple[str, str]] = [
        # Each pair: (banned substring, replacement). Case-insensitive match,
        # case-preserving replacement (we lowercase the haystack for matching
        # but write the canonical replacement back so the prompt stays legible).
        ("integral slotta-base", "no base — character on own feet"),
        ("integral slotta base", "no base — character on own feet"),
        ("optional integral base only if mid-action", "no base — character holds the pose on its own form"),
        ("optional integral base", "no base — character on own feet"),
        ("clean integral base", "no base"),
        ("integral base", "no base"),
        ("integral plinth", "no plinth"),
        ("with plinth", "with no plinth"),
        ("with base", "with no base"),
        ("on plinth", "no plinth"),
        ("on pedestal", "no pedestal"),
        ("standing on integral", "standing on own feet, no"),
        ("slotta-base", "no base"),
    ]
    cleaned = improved
    scrub_hits: list[str] = []
    for banned, replacement in BANNED_BASE_REWRITES:
        # Manual case-insensitive replace to preserve other casing in the prompt.
        idx = 0
        lower = cleaned.lower()
        while True:
            pos = lower.find(banned, idx)
            if pos == -1:
                break
            cleaned = cleaned[:pos] + replacement + cleaned[pos + len(banned):]
            lower = cleaned.lower()
            scrub_hits.append(banned)
            idx = pos + len(replacement)
    if scrub_hits:
        rationale = (
            f"{rationale.strip()} [auto-scrubbed banned phrases: "
            f"{', '.join(sorted(set(scrub_hits)))}]"
        )
        improved = cleaned
        # Re-validate length after scrubbing — the rewrites trim a few chars
        # each so we'd only fall under, never over the cap.
        if not (SYSTEM_MIN_LEN <= len(improved) <= SYSTEM_MAX_LEN):
            return {
                "ok": False,
                "error": (
                    f"after auto-scrubbing banned phrases, prompt length "
                    f"{len(improved)} fell outside [{SYSTEM_MIN_LEN},{SYSTEM_MAX_LEN}]. "
                    "Rejected; next tick will retry."
                ),
                "ticker_text": "strategist scrubbed but length out of range",
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
    outcome_count = len(read_outcomes())
    messages = [
        {
            "from": "strategist",
            "to": "designer",
            "topic": "prompt_update",
            "importance": "heads_up",
            "content": (
                f"Mara — refreshed your system prompt. It lands on your next job.\n\n"
                f"What changed, based on the last {outcome_count} outcomes: {summary}"
            ),
        },
        {
            "from": "strategist",
            "to": "*",
            "topic": "prompt_update",
            "importance": "info",
            "content": (
                f"Refreshed Mara's system prompt off the last {outcome_count} outcomes. "
                f"Headline: {summary[:200]}"
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
