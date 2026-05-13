"""Trend-signal fetchers consumed by the orchestrator AND the research
worker. KEEP IN SYNC with workers/research/research/trends.py — this file
is a verbatim copy because the two workers don't share a Python package
(no workers/common/ today). If you tweak the API/fields/format here,
mirror the change in research/research/trends.py and vice versa.

The orchestrator uses these signals to bias its niche-pick toward what
is currently hot; research uses them to elaborate on the picked niche.
Fetching twice per cycle (once each) is wasteful but harmless — both
fetchers tolerate failures and run within their own timeout budgets.

Each fetcher is best-effort: returns an empty list on any error so the
research agent never fails because one source is down. All sources are
optional — the research agent still produces a brief without them.

Sources:
  * Reddit  — public .json endpoints, no auth required
  * Google Trends — pytrends (unofficial but stable), no key
  * YouTube — Data API v3, needs YOUTUBE_API_KEY env var

A "signal" is the dict shape:
    {"title": str, "score": int|float, "source": str, "url": str|None}

`score` is a normalized 0..100 within source so the research model can
compare a Reddit upvote count to a YouTube view count without us having to.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from typing import Any

DEFAULT_TIMEOUT = 12
USER_AGENT = "agent-factory/1.0 (3d-asset trend scanner)"


def _http_json(url: str, headers: dict[str, str] | None = None) -> Any:
    h = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _normalize_scores(items: list[dict], score_key: str) -> list[dict]:
    if not items:
        return items
    raw = [float(it.get(score_key, 0) or 0) for it in items]
    hi = max(raw) if raw else 0.0
    if hi <= 0:
        for it in items:
            it["score"] = 0
        return items
    for it, r in zip(items, raw):
        it["score"] = round((r / hi) * 100, 1)
    return items


# ── Reddit ─────────────────────────────────────────────────────────────────

DEFAULT_SUBREDDITS = [
    "3Dprinting",
    "PrintedMinis",
    "functionalprint",
    "Etsy",
    "EtsySellers",
    "DnD",
    "Warhammer40k",
    "halloween",
    "christmas",
]


def fetch_reddit_hot(subreddits: list[str] | None = None, per_sub: int = 5) -> list[dict]:
    """Pull the hottest posts from each subreddit. No auth needed.

    Returns up to `per_sub * len(subreddits)` signals, score-normalized
    against the highest upvote count seen across all of them.
    """
    subs = subreddits or DEFAULT_SUBREDDITS
    out: list[dict] = []
    for sub in subs:
        try:
            url = f"https://www.reddit.com/r/{sub}/hot.json?limit={per_sub}"
            data = _http_json(url)
            children = data.get("data", {}).get("children", []) or []
            for c in children:
                d = c.get("data", {}) or {}
                title = (d.get("title") or "").strip()
                if not title:
                    continue
                ups = int(d.get("ups", 0) or 0)
                permalink = d.get("permalink") or ""
                full_url = f"https://www.reddit.com{permalink}" if permalink else None
                out.append({
                    "title": title,
                    "ups": ups,
                    "source": f"reddit:r/{sub}",
                    "url": full_url,
                })
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, KeyError) as e:
            print(f"[trends] reddit r/{sub} failed: {e}", file=sys.stderr, flush=True)
            continue
        # Reddit rate-limits at ~60 req/min for anon; 9 subs × 1 call = fine.
        time.sleep(0.25)
    return _normalize_scores(out, "ups")


# ── Google Trends (via pytrends if installed; else trends export fallback) ──

def fetch_google_trends_now(geo: str = "US") -> list[dict]:
    """Daily trending searches for the given geo. Uses pytrends if installed;
    otherwise falls back to the public Trends RSS export."""
    try:
        from pytrends.request import TrendReq  # type: ignore
        pt = TrendReq(hl="en-US", tz=360, timeout=(5, 10))
        df = pt.trending_searches(pn="united_states" if geo == "US" else geo.lower())
        out: list[dict] = []
        # pytrends returns a single-column DataFrame; iterate rows.
        for i, row in df.iterrows():
            title = str(row[0]).strip()
            if not title:
                continue
            # Order is the score signal — first = hottest. Convert to 100..0.
            out.append({
                "title": title,
                "rank": i,
                "source": f"google_trends:{geo}",
                "url": f"https://trends.google.com/trends/explore?q={urllib.parse.quote(title)}",
            })
        if out:
            hi = max(o["rank"] for o in out) or 1
            for o in out:
                o["score"] = round((1.0 - o["rank"] / hi) * 100, 1)
        return out
    except ImportError:
        pass
    except Exception as e:
        print(f"[trends] pytrends failed, falling back: {e}", file=sys.stderr, flush=True)
    # Fallback: the public daily-trends RSS feed (no auth, no pytrends).
    # Endpoint moved in 2024-2025: was /trends/trendingsearches/daily/rss,
    # now /trending/rss.
    try:
        feed_url = f"https://trends.google.com/trending/rss?geo={geo}"
        req = urllib.request.Request(feed_url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=DEFAULT_TIMEOUT) as resp:
            xml = resp.read().decode("utf-8", errors="replace")
        # Crude title extraction (avoid pulling lxml). Titles are inside
        # <title>...</title>; first one is the feed title — skip it.
        import re
        titles = re.findall(r"<title>([^<]+)</title>", xml)
        # Drop the feed-level title and any with <![CDATA[]] wrappers.
        titles = [t.strip() for t in titles[1:] if t.strip()]
        out = []
        for i, t in enumerate(titles[:25]):
            out.append({
                "title": t,
                "rank": i,
                "source": f"google_trends:{geo}",
                "url": f"https://trends.google.com/trends/explore?q={urllib.parse.quote(t)}",
            })
        if out:
            hi = max(o["rank"] for o in out) or 1
            for o in out:
                o["score"] = round((1.0 - o["rank"] / hi) * 100, 1)
        return out
    except (urllib.error.URLError, urllib.error.HTTPError, Exception) as e:
        print(f"[trends] google_trends RSS failed: {e}", file=sys.stderr, flush=True)
        return []


# ── YouTube Data API v3 ────────────────────────────────────────────────────

def fetch_youtube_trending(
    api_key: str | None = None,
    region_code: str = "US",
    max_results: int = 15,
    category_id: str | None = None,
) -> list[dict]:
    """Most-popular videos for the region. Needs a Google Cloud API key with
    YouTube Data API v3 enabled. Returns [] on missing key (silent skip)."""
    key = api_key or os.environ.get("YOUTUBE_API_KEY") or ""
    if not key:
        return []
    try:
        params = {
            "part": "snippet,statistics",
            "chart": "mostPopular",
            "regionCode": region_code,
            "maxResults": str(max_results),
            "key": key,
        }
        if category_id:
            params["videoCategoryId"] = category_id
        url = "https://www.googleapis.com/youtube/v3/videos?" + urllib.parse.urlencode(params)
        data = _http_json(url)
        out: list[dict] = []
        for item in data.get("items", []) or []:
            sn = item.get("snippet") or {}
            stats = item.get("statistics") or {}
            title = (sn.get("title") or "").strip()
            if not title:
                continue
            views = int(stats.get("viewCount", 0) or 0)
            vid = item.get("id")
            out.append({
                "title": title,
                "views": views,
                "source": f"youtube:{region_code}",
                "url": f"https://www.youtube.com/watch?v={vid}" if vid else None,
            })
        return _normalize_scores(out, "views")
    except (urllib.error.URLError, urllib.error.HTTPError, ValueError, KeyError) as e:
        print(f"[trends] youtube failed: {e}", file=sys.stderr, flush=True)
        return []


# ── Composite ──────────────────────────────────────────────────────────────

def fetch_all_signals(
    reddit_subs: list[str] | None = None,
    youtube_api_key: str | None = None,
    geo: str = "US",
    top_n: int = 30,
) -> list[dict]:
    """Pull from every enabled source and return the top-N strongest signals
    across all of them. Each enabled source contributes proportionally.

    Sources are toggled by env var: TRENDS_REDDIT, TRENDS_GOOGLE,
    TRENDS_YOUTUBE — set to "0" to disable. Default = all on.
    """
    def _enabled(name: str) -> bool:
        v = os.environ.get(name, "1").strip().lower()
        return v not in {"0", "false", "no"}

    all_signals: list[dict] = []
    if _enabled("TRENDS_REDDIT"):
        all_signals.extend(fetch_reddit_hot(reddit_subs))
    if _enabled("TRENDS_GOOGLE"):
        all_signals.extend(fetch_google_trends_now(geo))
    if _enabled("TRENDS_YOUTUBE"):
        all_signals.extend(fetch_youtube_trending(youtube_api_key, geo))

    # De-dup by lowercased title; keep the highest score.
    seen: dict[str, dict] = {}
    for s in all_signals:
        key = s["title"].lower()
        prev = seen.get(key)
        if prev is None or s.get("score", 0) > prev.get("score", 0):
            seen[key] = s
    deduped = list(seen.values())
    deduped.sort(key=lambda s: float(s.get("score", 0) or 0), reverse=True)
    return deduped[:top_n]


def format_for_prompt(signals: list[dict], max_chars: int = 1800) -> str:
    """Compact one-line-per-signal rendering that fits inside an LLM prompt
    without consuming the whole context. Truncates if it would exceed
    `max_chars`."""
    if not signals:
        return "(no live trend signals)"
    lines: list[str] = []
    used = 0
    for s in signals:
        title = s.get("title", "").strip().replace("\n", " ")
        score = s.get("score", 0)
        source = s.get("source", "?")
        line = f"  · [{source} {score}] {title}"
        if used + len(line) + 1 > max_chars:
            break
        lines.append(line)
        used += len(line) + 1
    return "\n".join(lines)
