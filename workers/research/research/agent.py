import json
import os
import sys
import urllib.request
import urllib.error
from .protocol import Protocol

MODEL = "claude-sonnet-4-6"
# The brief now carries a paragraph-long design_direction PLUS the new
# ip_risk field. 1200 was getting tight — Haiku occasionally emitted multi-
# line strings or newline-in-string breakage that tripped the JSON parser
# ("Expecting ',' delimiter"). 2000 gives breathing room AND the loose
# parser now has a repair pass for the rest. Cost is negligible.
MAX_TOKENS = 2000

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


def _override_compatible_with_focus(override: str | None) -> bool:
    """Reject overrides that drifted back to the pre-3D-pivot world. See the
    designer worker's copy for the full rationale — mirrored here so each
    worker enforces it at load time, not just once via a hand-clean."""
    if not override:
        return True
    focus = os.environ.get("SHOP_FOCUS", "3d_only").strip().lower()
    if focus != "3d_only":
        return True
    s = override.lower()
    # For research specifically, an override that tells us to AVOID 3D STL or
    # PREFER planner/sticker niches is poison — it directly contradicts the
    # shop's product mix.
    stale_markers = (
        "avoid 3d print", "avoid 3d stl", "avoid stl",
        "favor variations of daily routine planners",
        "adhd routine", "adhd planner",
        "kiss-cut", "kiss cut", "sticker shop", "sticker-first",
        "viewbox", "svg markup",
        "printable wall art", "planner bundle",
    )
    return not any(m in s for m in stale_markers)


def _load_system_override(role: str) -> str | None:
    """Read ~/.agent-factory/prompts.json and return system_override for role, or None.

    Rejects overrides that fail _override_compatible_with_focus.
    """
    path = os.path.expanduser("~/.agent-factory/prompts.json")
    try:
        with open(path) as f:
            data = json.load(f)
        ov = data.get(role, {}).get("system_override")
        if isinstance(ov, str) and ov.strip():
            if not _override_compatible_with_focus(ov):
                print(
                    f"[research] rejecting stale {role}.system_override "
                    f"({len(ov)} chars, contains pre-3D-pivot markers); "
                    "falling back to built-in baseline",
                    file=sys.stderr, flush=True,
                )
                return None
            return ov
    except Exception:
        pass
    return None


def _load_operator_steers(role: str) -> list[str]:
    """Read operator standing instructions written from the ChatPanel Steer
    action. Returns [] when missing or malformed."""
    path = os.path.expanduser("~/.agent-factory/prompts.json")
    try:
        with open(path) as f:
            data = json.load(f)
        arr = data.get(role, {}).get("operator_steers")
        if isinstance(arr, list):
            return [s for s in arr if isinstance(s, str) and s.strip()]
    except Exception:
        pass
    return []


def _append_operator_steers(system_prompt: str, role: str) -> str:
    """Append operator standing instructions as the final block. Operator
    steers compose with and take precedence over the strategist-tuned
    override, because the last block in the system prompt gets the model's
    strongest attention."""
    steers = _load_operator_steers(role)
    if not steers:
        return system_prompt
    block = (
        "OPERATOR STANDING INSTRUCTIONS (operator-set, highest priority — "
        "apply to this job):\n"
        + "\n".join(f"- {s}" for s in steers)
    )
    return system_prompt.rstrip() + "\n\n" + block


def _load_rejection_avoid_list(limit: int = 12) -> list[dict]:
    """Read the rejection learning file written by Rust on every operator
    Reject action. Returns up to `limit` recent entries — each `{title, niche}`.
    Best-effort: missing or malformed file returns []."""
    path = os.path.expanduser("~/.agent-factory/rejections.json")
    try:
        with open(path) as f:
            data = json.load(f)
        arr = data.get("rejections")
        if not isinstance(arr, list):
            return []
        out: list[dict] = []
        for item in arr[:limit]:
            if not isinstance(item, dict):
                continue
            title = item.get("title")
            niche = item.get("niche")
            if isinstance(title, str) and title.strip():
                out.append({"title": title.strip(), "niche": niche if isinstance(niche, str) else None})
        return out
    except Exception:
        return []


def _append_rejection_avoid_block(system_prompt: str) -> str:
    """Append an Avoid: block listing recently rejected niches/titles so the
    research model steers away from re-proposing them. No-op when the file
    is empty or missing."""
    entries = _load_rejection_avoid_list()
    if not entries:
        return system_prompt
    lines: list[str] = []
    for e in entries:
        niche = e.get("niche")
        title = e["title"]
        if niche:
            lines.append(f'- {niche} — "{title[:80]}"')
        else:
            lines.append(f'- "{title[:80]}"')
    block = (
        "AVOID — the operator already rejected these ideas. Pick a different "
        "niche AND a meaningfully different angle from each entry. Treat the "
        "list as forbidden territory, not a starting point:\n"
        + "\n".join(lines)
    )
    return system_prompt.rstrip() + "\n\n" + block


JSON_SHAPE = (
    "{\n"
    '  "niche": "<short specific niche, e.g. \'minimalist line art prints\' '
    "or 'D&D goblin warrior mini'>\",\n"
    '  "keywords": ["<10-15 SEO keywords>"],\n'
    '  "price_band_usd": [<low>, <high>],\n'
    '  "product_type": "<sticker|digital_print|mug|tee|poster|stl_file|3d_model>",\n'
    '  "design_direction": "<one-paragraph aesthetic / form playbook. For 2D: '
    'style anchors (flat-vector / risograph / line-art / Y2K / cottagecore), '
    'palette, typography, composition. For 3D: silhouette + form language '
    "(stylized vs. realistic, organic vs. geometric), key shapes, printability "
    'notes (no thin overhangs, supports-friendly), scale hints. Treat this as '
    "the prompt the Designer feeds to Tripo/Meshy verbatim.>\",\n"
    '  "ip_risk": "<none|mythology|original|high — set high ONLY when the '
    "niche references a copyrighted franchise (Naruto, Marvel, Star Wars, "
    "Pokemon, Disney, Genshin, etc.); mythology for public-domain gods/myths/"
    'folklore; original for our own coined characters; none otherwise>",\n'
    '  "competition": "<low|medium|high>",\n'
    '  "rationale": "<one sentence reasoning>"\n'
    "}"
)

# Trademark / franchise keywords that should force ip_risk=high if the model
# misclassifies. NOT a legal opinion — just a safety net for the publish gate.
# Keep these lowercase, whitespace-stripped tokens that we substring-match.
HIGH_IP_KEYWORDS = (
    "naruto", "sasuke", "goku", "vegeta", "luffy", "zoro", "ichigo",
    "demon slayer", "tanjiro", "nezuko", "jujutsu", "gojo", "yuji",
    "pokemon", "pikachu", "charizard", "eevee", "mewtwo",
    "marvel", "spider-man", "spiderman", "ironman", "iron man", "thor",
    "hulk", "captain america", "thanos", "deadpool", "wolverine",
    "x-men", "wanda", "loki", "doctor strange",
    "dc comics", "batman", "superman", "wonder woman", "joker", "harley quinn",
    "star wars", "yoda", "darth vader", "mandalorian", "grogu", "baby yoda",
    "stormtrooper", "kylo ren", "rey",
    "game of thrones", "daenerys", "jon snow", "tyrion", "targaryen",
    "house of the dragon",
    "harry potter", "hogwarts", "voldemort", "dumbledore", "hermione",
    "lord of the rings", "gandalf", "frodo", "aragorn",
    "disney", "mickey", "minnie", "elsa", "anna", "moana", "ariel",
    "stitch", "lilo", "winnie the pooh",
    "pixar", "buzz lightyear", "woody",
    "nintendo", "mario", "luigi", "zelda", "link", "kirby",
    "genshin", "honkai", "hoyoverse",
    "minecraft", "fortnite", "valorant", "league of legends",
    "warhammer", "games workshop", "space marine",  # GW is aggressive on STL DMCA
    "rick and morty", "spongebob", "simpsons", "family guy",
    "stranger things", "hawkins", "eleven",
    "breaking bad", "walter white",
)

MYTHOLOGY_KEYWORDS = (
    "greek god", "norse god", "egyptian god", "hindu god", "japanese god",
    "zeus", "thor god", "odin", "loki god", "anubis", "ra ", "horus",
    "athena", "aphrodite", "ares", "hades", "poseidon", "apollo", "artemis",
    "dionysus", "hermes god", "hercules", "achilles", "medusa", "minotaur",
    "kraken", "centaur", "pegasus", "phoenix",
    "yokai", "kitsune", "tengu", "oni ", "kappa", "tanuki",
    "cthulhu", "lovecraft", "yog-sothoth", "azathoth", "nyarlathotep",
    "arthurian", "king arthur", "excalibur", "merlin", "lancelot",
    "alice in wonderland", "cheshire cat", "mad hatter",
    "brothers grimm", "fairy tale",
    "aesop", "fable",
    "celtic", "druid", "viking",
    "anubis", "bastet", "sphinx",
)


def _infer_ip_risk(niche: str | None) -> str:
    """Heuristic backstop in case the model picks an obvious franchise but
    declares ip_risk='none'. Returns 'high' / 'mythology' / 'none' — 'original'
    can only be set by the model (we can't tell from text alone)."""
    if not isinstance(niche, str) or not niche.strip():
        return "none"
    n = niche.lower()
    for kw in HIGH_IP_KEYWORDS:
        if kw in n:
            return "high"
    for kw in MYTHOLOGY_KEYWORDS:
        if kw in n:
            return "mythology"
    return "none"

# Default product when the model omits product_type (older briefs, etc.).
# Stickers are the only POD product with positive margin at our $12 retail
# cap — see project-pod-integration memory for the economics.
DEFAULT_PRODUCT_TYPE = "sticker"
# stl_file = 3D-printable STL (Etsy digital download buyers, 3D printer crowd).
# 3d_model = GLB asset (game devs / web/AR, eventually CGTrader / Fab).
# Both routes are generated via the Tripo text-to-3D pipeline in the designer.
VALID_PRODUCT_TYPES = {
    "sticker", "digital_print", "mug", "tee", "poster",
    "stl_file", "3d_model",
}


def _normalize_product_type(brief: dict) -> None:
    """Mutate brief in-place so downstream workers always see a valid product_type."""
    pt = brief.get("product_type")
    if not isinstance(pt, str) or pt not in VALID_PRODUCT_TYPES:
        brief["product_type"] = DEFAULT_PRODUCT_TYPE


def _normalize_brief(brief: dict) -> None:
    """Backfill required brief fields so downstream code never KeyErrors when
    Claude truncates the JSON. We had a recurring 'competition' KeyError when
    MAX_TOKENS clipped the tail of the response — this guarantees a usable
    brief even if the model misbehaves."""
    if not isinstance(brief.get("niche"), str) or not brief["niche"].strip():
        brief["niche"] = "general printables"
    if not isinstance(brief.get("competition"), str):
        brief["competition"] = "medium"
    pb = brief.get("price_band_usd")
    if not (isinstance(pb, list) and len(pb) == 2 and all(isinstance(x, (int, float)) for x in pb)):
        brief["price_band_usd"] = [3, 15]
    if not isinstance(brief.get("keywords"), list):
        brief["keywords"] = []
    if not isinstance(brief.get("design_direction"), str):
        brief["design_direction"] = ""
    if not isinstance(brief.get("rationale"), str):
        brief["rationale"] = ""
    _normalize_product_type(brief)
    # IP-risk classification. The model self-declares, but we ALWAYS overlay
    # the keyword backstop afterwards — that way a forgotten classification
    # or an explicit 'none' on an obvious franchise still trips the publish
    # gate. We only let the model's claim through when our backstop says
    # 'none' (i.e. we have no evidence to override it).
    declared = brief.get("ip_risk")
    inferred = _infer_ip_risk(brief.get("niche"))
    valid = {"none", "mythology", "original", "high"}
    if isinstance(declared, str) and declared in valid:
        if inferred == "high" and declared != "high":
            brief["ip_risk"] = "high"
        else:
            brief["ip_risk"] = declared
    else:
        brief["ip_risk"] = inferred


def build_demand_brief_prompt(
    niche_seed: str | None = None,
    rationale: str | None = None,
    product_type_preference: str | None = None,
    trend_signals_text: str | None = None,
) -> tuple[str, str]:
    focus = os.environ.get("SHOP_FOCUS", "3d_only").strip().lower()
    is_3d = focus == "3d_only" or product_type_preference in {"stl_file", "3d_model"}

    if is_3d:
        system = (
            "PERSONA — You are a Market Research Analyst at an AI-run "
            "3D-asset shop selling STL + GLB digital downloads on Etsy and "
            "Cults3D. You have deep familiarity with bestseller patterns "
            "for 3D printables: you know what consistently sells (Egyptian "
            "/ Norse / Lovecraftian altar figurines, themed jewelry "
            "pendants, modular D&D terrain, articulated fidget toys) and "
            "what bleeds money (generic skeleton warriors, unbranded dice "
            "towers, Christmas ornaments, anything 2D). You pick niches "
            "like a sniper — one specific, defensible niche per cycle. "
            "No hedging. No broad categories.\n\n"
            "Your job: pick ONE niche the shop can win AND hand the "
            "Designer a Tripo-ready design_direction it copies verbatim. "
            "Return JSON only, no prose, no markdown fences.\n\n"

            "PRODUCT_TYPE rules:\n"
            "  • 'stl_file' (default) for 3D-printable buyers — tabletop "
            "minis, jewelry pendants, decor, cosplay, keychains, dice "
            "towers, terrain tiles, altar figurines.\n"
            "  • '3d_model' ONLY when the niche is explicitly game-asset / "
            "AR (Sketchfab buyers, indie dev props).\n\n"

            "PRICE_BAND_USD — operator policy locks every digital sale to "
            "$3-$15 (publisher silently clamps anything outside). Pick a "
            "band that fits the niche AND fits the range:\n"
            "  • single minis $4-$9\n"
            "  • jewelry pendants $3-$7\n"
            "  • desk decor $7-$12\n"
            "  • cosplay/props $10-$15\n"
            "  • dice towers $8-$15\n"
            "  • modular terrain tiles $6-$12\n\n"

            "DESIGN_DIRECTION — this field is THE Designer's input to "
            "Nano Banana Pro → Tripo/Meshy. Write it using this formula "
            "(front-load subject + adjectives — early tokens carry more "
            "weight in both Nano Banana and Tripo):\n"
            "  [Subject + pose] · [Single stylization anchor] · "
            "[Material/surface] · [Scale anchor in real units] · "
            "[Printability constraints] · (negative: 3-5 excludes)\n\n"

            "Stylization anchors (pick ONE per brief): stylized cartoon | "
            "semi-realistic | low-poly | organic flowing | hard-surface "
            "geometric | sculptural realism. Don't stack.\n\n"

            "Example design_direction strings (length: 30-70 words):\n"
            "  ✓ \"Standing dwarf warrior in three-quarter stance, hammer "
            "resting on shoulder. Stylized cartoon with hard-surface "
            "plate armor. Matte single-color, no PBR. 28mm tabletop mini "
            "scale, circular base, single static mesh. (negative: no thin "
            "axe blade, no floating beard, no second figure, no "
            "background)\"\n"
            "  ✓ \"Pendant of a stylized Norse runic wolf head, "
            "front-facing, jaw closed. Hard-surface geometric, deep "
            "engraved runes around the edge. Wearable pendant size "
            "(35mm), flat back, hollow-printable. (negative: no chain, "
            "no gemstones, no second motif, no painted detail)\"\n\n"

            "Anti-patterns Designer can't recover from — DO NOT request:\n"
            "  ✗ Multiple subjects in one brief.\n"
            "  ✗ Non-physical effects (smoke, glow, sparkles, magic "
            "energy) — Tripo can't model these.\n"
            "  ✗ Named copyrighted IP (Naruto, Pikachu, Spider-Man, "
            "Yoda, Mickey) — use generic archetype descriptions.\n"
            "  ✗ Long thin features (sword blades, hair strands, "
            "butterfly antennae) without explicit support hints — Tripo "
            "drops them.\n"
            "  ✗ Vague adjectives (\"beautiful\", \"amazing\", \"epic\") "
            "— burn tokens, add no geometry signal.\n\n"

            "KEYWORDS — focus on Etsy + Cults3D search behavior. Mix:\n"
            "  • Format tags ('STL file', 'STL', '3D print', '3D model', "
            "'digital download').\n"
            "  • Niche-specific terms (\"deep one altar figurine\", "
            "\"egyptian deity STL\").\n"
            "  • Audience tags ('dnd', 'tabletop', 'cosplay', 'gift', "
            "'collector', 'altar').\n"
            "  • 13 total tags max — Etsy hard caps at 13.\n\n"

            "IP_RISK — classify honestly. The cycle ends here for HIGH-"
            "risk briefs (no design / no listing) unless operator approves:\n"
            "  • 'high' — copyrighted franchise (Naruto, Marvel, Star "
            "Wars, Pokemon, Disney, Genshin, Warhammer, Game of Thrones, "
            "MCU, Studio Ghibli). Fan-art counts.\n"
            "  • 'mythology' — public-domain gods, myths, folklore, fairy "
            "tales (Greek, Norse, yokai, Cthulhu/Lovecraft, Arthurian, "
            "Alice in Wonderland, Egyptian, Aztec).\n"
            "  • 'original' — brand-new character we're coining.\n"
            "  • 'none' — generic object/prop with no character attached "
            "(dice tower, modular terrain, pendant motif).\n\n"

            "PROVEN SELLERS (use as tiebreakers when picking niches):\n"
            "  • Egyptian / Norse / Lovecraftian altar figurines ($20-$25 "
            "average — but clamp at $15).\n"
            "  • D&D minis with strong silhouette (dwarves, beholders, "
            "owlbears, mind flayers).\n"
            "  • Articulated fidget toys (snakes, scorpions, dragons).\n"
            "  • Modular terrain tile sets (mushroom forest, dungeon "
            "stone, sci-fi station).\n"
            "  • Jewelry pendants tied to mythology (Norse rune wolves, "
            "Egyptian ankh, Cthulhu sigil).\n\n"

            "AVOID (proven losers): seasonal/holiday (Christmas ornaments), "
            "generic skeleton warriors, generic single dice tower without "
            "themed brand, anything 2D (planners, stickers, printables) — "
            "those are pre-pivot."
        )
    else:
        system = (
            "You are a Market Research Analyst at an AI-run digital products Etsy shop. "
            "Your job is to identify a profitable niche AND lay down the design direction "
            "the Designer agent will inherit. Return a structured JSON Demand Brief. "
            "Be concise and specific. Only return valid JSON, no prose, no markdown.\n\n"

            "For product_type, pick the physical format that fits the niche best — "
            "default to 'sticker' for cheap impulse-buy designs (best margin on a new shop), "
            "'digital_print' for downloadable wall art, 'mug'/'tee'/'poster' for everything else.\n\n"

            "For design_direction, lean on what you already know about the prompt-engineering "
            "patterns that work in the AI-art world (Midjourney style anchors, Stable Diffusion "
            "modifier stacks, Etsy bestseller aesthetics for this niche). Steal mercilessly — "
            "if 'flat vector, pastel risograph, soft grain' is the proven pattern for boho "
            "stickers, say so. The Designer reads this verbatim and uses it to shape the SVG, "
            "so be opinionated and concrete: name the style, the palette, the composition idea."
        )
    pt_clause = ""
    if product_type_preference and product_type_preference in VALID_PRODUCT_TYPES:
        pt_clause = (
            f"\n\nIMPORTANT: The Strategy Lead has chosen product_type='{product_type_preference}' "
            "for this cycle (market-coverage rotation). Use exactly that value "
            "in the brief and pick a niche that fits that format naturally."
        )
    trend_block = ""
    if trend_signals_text and trend_signals_text.strip():
        trend_block = (
            "\n\nLIVE TREND SIGNALS (Reddit hot posts, Google Trends, YouTube — "
            "raw scrape, score is normalized 0-100 within source):\n"
            f"{trend_signals_text}\n\n"
            "Mine these for niche ideas the average Etsy seller hasn't reacted "
            "to yet — but filter ruthlessly: skip celebrity gossip, current "
            "events, brand/IP names (HIGH legal risk), and anything that "
            "doesn't translate to a printable/displayable 3D object. The signal "
            "is in the underlying CATEGORIES (e.g. if mythology, dinosaurs, "
            "Halloween, dnd, a TV-show genre, or a hobby keeps appearing — "
            "that's the lane). DO NOT just regurgitate a trending term as the "
            "niche.\n"
        )

    if niche_seed:
        seed_text = niche_seed
        rat_text = rationale or "no rationale provided"
        user = (
            f'The strategy lead picked this niche to pursue: "{seed_text}" — rationale: "{rat_text}". '
            f"Build a Demand Brief for it.{pt_clause}{trend_block} "
            f"Return JSON only with the shape {JSON_SHAPE}"
        )
    else:
        user = (
            "Generate a Demand Brief for an Etsy shop."
            f"{pt_clause}{trend_block} "
            "Pick a niche that's currently in demand. "
            f"Return JSON only with this exact shape:\n{JSON_SHAPE}"
        )
    return system, user


def _fetch_trend_signals_text() -> str:
    """Best-effort: pull live trend signals and format them for the prompt.
    Never raises — if every source fails we return '' and the brief just
    runs without external signal."""
    try:
        from .trends import fetch_all_signals, format_for_prompt
        signals = fetch_all_signals(top_n=25)
        return format_for_prompt(signals) if signals else ""
    except Exception as e:
        print(f"[trends] composite fetch failed: {e}", file=sys.stderr, flush=True)
        return ""


def call_anthropic(
    api_key: str,
    niche_seed: str | None = None,
    rationale: str | None = None,
    product_type_preference: str | None = None,
) -> dict:
    trend_signals_text = _fetch_trend_signals_text()
    system_prompt, user_prompt = build_demand_brief_prompt(
        niche_seed=niche_seed,
        rationale=rationale,
        product_type_preference=product_type_preference,
        trend_signals_text=trend_signals_text,
    )
    override = _load_system_override("research")
    if override:
        system_prompt = override
    system_prompt = _append_operator_steers(system_prompt, "research")
    system_prompt = _append_rejection_avoid_block(system_prompt)

    body = json.dumps({
        "model": MODEL,
        "max_tokens": MAX_TOKENS,
        "system": system_prompt,
                "messages": _messages_for_json_call(user_prompt),
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

    raw = _retry_request(req, timeout=60)

    response = json.loads(raw)
    text = response["content"][0]["text"]
    # Restore the prefilled "{" assistant.content so the JSON parser
    # sees a complete object. We only prepend when the response
    # contains no "{" at all — fenced or wrapped mock responses
    # already carry their own brace and pass through untouched.
    if "{" not in text:
        text = "{" + text
    usage = response.get("usage", {})
    tokens_in = usage.get("input_tokens", 0)
    tokens_out = usage.get("output_tokens", 0)

    brief = _parse_loose_json_object(text)
    _normalize_brief(brief)
    return brief, tokens_in, tokens_out


def handle(method: str, params: dict) -> dict:
    if method != "process_job":
        return {"ok": False, "error": f"unknown method {method}"}

    job_id = params.get("job_id", 0)
    payload = params.get("payload", {})
    return process_job(job_id, payload)


def process_job(job_id: int, payload: dict) -> dict:
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        msg = "ANTHROPIC_API_KEY not set — cannot call Anthropic"
        print(f"[research] ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"research failed: {msg}",
        }

    niche_seed: str | None = payload.get("niche_seed") or None
    rationale: str | None = payload.get("rationale") or None
    product_type_preference: str | None = payload.get("product_type_preference") or None
    # cycle_id is the chain identifier the orchestrator generated at the head
    # of this pipeline run. We propagate it but never invent one — a missing
    # cycle_id means this job was kicked off outside the pipeline, and we want
    # the supervisor to skip P&L attribution for it.
    cycle_id = payload.get("cycle_id") if isinstance(payload, dict) else None
    if niche_seed:
        print(f"[research] job_id={job_id} seeded niche={niche_seed!r} calling Anthropic model={MODEL}", file=sys.stderr, flush=True)
    else:
        print(f"[research] job_id={job_id} calling Anthropic model={MODEL} (no seed)", file=sys.stderr, flush=True)
    try:
        brief, tokens_in, tokens_out = call_anthropic(
            api_key,
            niche_seed=niche_seed,
            rationale=rationale,
            product_type_preference=product_type_preference,
        )
        # If orchestrator dictated a product_type, force it onto the brief
        # so the model can't quietly override the rotation pick.
        if product_type_preference in VALID_PRODUCT_TYPES:
            brief["product_type"] = product_type_preference
        # Defensive .get() — _normalize_brief filled these but be explicit.
        comp = brief.get("competition", "medium")
        pb = brief.get("price_band_usd") or [3, 15]
        ticker_text = (
            f"niche: {brief.get('niche', '?')} · {comp} comp "
            f"· ${pb[0]}-{pb[1]} · {brief.get('product_type', '?')}"
        )
        print(f"[research] job_id={job_id} done in={tokens_in} out={tokens_out}", file=sys.stderr, flush=True)
        handoff_payload: dict = {"brief": brief}
        if cycle_id:
            handoff_payload["cycle_id"] = cycle_id
        # Conversation log: hand the designer a short, opinionated brief and
        # broadcast the same headline so listing / strategist can react.
        design_direction = brief.get("design_direction") or ""
        keywords = brief.get("keywords") or []
        kw_line = ", ".join(keywords[:8]) if isinstance(keywords, list) else ""
        ip_risk = brief.get("ip_risk", "none")
        risk_tag = f" [ip_risk={ip_risk}]" if ip_risk != "none" else ""
        designer_msg = (
            f"New brief: niche='{brief['niche']}' · product={brief['product_type']}"
            f"{risk_tag}.\n"
            f"Design direction: {design_direction.strip()[:600]}\n"
            f"Keywords to bake into the visual: {kw_line}"
        )
        floor_msg = (
            f"Picked niche '{brief.get('niche', '?')}'{risk_tag} ({comp} comp, "
            f"${pb[0]}-{pb[1]}, {brief.get('product_type', '?')}). "
            f"Direction: {design_direction.strip()[:160]}"
        )
        messages = [
            {
                "from": "research",
                "to": "designer",
                "topic": "design_brief",
                "importance": "heads_up",
                "content": designer_msg,
            },
            {
                "from": "research",
                "to": "*",
                "topic": "design_brief",
                "importance": "info",
                "content": floor_msg,
            },
        ]
        result: dict = {
            "ok": True,
            "brief": brief,
            "ticker_text": ticker_text,
            "model": MODEL,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "handoff": {
                "to_role": "designer",
                "payload": handoff_payload,
            },
            "messages": messages,
        }
        if cycle_id:
            result["cycle_id"] = cycle_id
        return result
    except Exception as e:
        msg = str(e)
        print(f"[research] job_id={job_id} ERROR: {msg}", file=sys.stderr, flush=True)
        return {
            "ok": False,
            "error": msg,
            "ticker_text": f"research failed: {msg}",
        }


def run() -> None:
    p = Protocol()
    p.send_notification("event", {"kind": "started"})
    while True:
        msg = p.read_message()
        if msg is None:
            break
        rid = msg.get("id")
        method = msg.get("method")
        params = msg.get("params", {})
        try:
            if method == "process_job":
                job_id = params.get("job_id", 0)
                payload = params.get("payload", {})
                result = process_job(job_id, payload)
                # Check for handoff before sending response
                handoff = result.pop("handoff", None) if isinstance(result, dict) else None
                if handoff:
                    p.send_notification("enqueue_handoff", {
                        "to_role": handoff["to_role"],
                        "payload": handoff["payload"],
                    })
                if rid is not None:
                    p.send_response(rid, result)
            elif method == "ping":
                if rid is not None:
                    p.send_response(rid, {"ok": True})
            else:
                if rid is not None:
                    p.send_error(rid, -32601, f"method not found: {method}")
        except Exception as e:
            if rid is not None:
                p.send_error(rid, -32000, str(e))
