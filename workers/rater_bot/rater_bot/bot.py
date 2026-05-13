"""Telegram rater bot — the operator-facing learning loop.

Posts every new Etsy draft to a private Telegram chat with:
  • the rendered preview photo (caption: title / niche / price / tags)
  • inline 1-5 star keyboard
  • a 3D-viewer deep-link (3dviewer.net loads the GitHub-hosted GLB/STL)
  • the STL/GLB attached as a downloadable document (fallback for mobile
    apps that handle STL natively)

When the operator taps a star, the rating + an optional reply-note are
saved to SQLite (product_ratings) AND ratings.jsonl (orchestrator
few-shot input). The orchestrator's next cycle picks niches that look
like high-rated drafts and avoids patterns from low-rated ones, closing
the human-in-the-loop teaching cycle without sales data.
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Optional
from urllib.parse import quote

import requests

from . import storage


TELEGRAM_API = "https://api.telegram.org"
CONFIG_FILENAME = "telegram.json"
DEFAULT_TICK_SECONDS = 10
DRAFTS_PER_TICK = 5
# 0 = post EVERY unposted draft in the db on first run (then dedup via
# telegram_postings on subsequent ticks). Override to e.g. 1800 if you
# only want drafts produced within the last 30 minutes — useful once the
# bot is steady-state and you don't want a re-run to re-flood the chat.
HISTORICAL_CUTOFF_SECONDS_DEFAULT = 0


# ---------- config ----------

def _config_path() -> str:
    return os.path.join(storage.data_dir(), CONFIG_FILENAME)


def load_config() -> Optional[dict]:
    """Read ~/.agent-factory/telegram.json. Returns None when missing so the
    caller can decide whether that's a soft-disable or a hard error."""
    p = _config_path()
    if not os.path.exists(p):
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        print(f"rater_bot: bad config at {p}: {e}", file=sys.stderr, flush=True)
        return None


# ---------- Telegram API ----------

def _api_url(token: str, method: str) -> str:
    return f"{TELEGRAM_API}/bot{token}/{method}"


def api_request(
    token: str, method: str, params: Optional[dict] = None, files: Optional[dict] = None
) -> dict:
    """Thin wrapper around Telegram Bot API. Returns the `result` field on
    success or raises RuntimeError with the description on failure. Long
    timeouts are accepted (getUpdates can hold the socket up to ~30s)."""
    url = _api_url(token, method)
    # 35s = Telegram's max long-poll timeout (30s) + 5s slack for the round-trip.
    timeout = 35 if files is None else 60
    resp = requests.post(url, data=params or {}, files=files, timeout=timeout)
    try:
        body = resp.json()
    except ValueError as e:
        raise RuntimeError(f"telegram {method}: non-JSON response: {e}") from e
    if not body.get("ok"):
        raise RuntimeError(
            f"telegram {method} failed: {body.get('description', body)}"
        )
    return body.get("result", {})


def verify_bot(token: str) -> dict:
    """Hit /getMe to confirm the token is valid before entering the loop."""
    return api_request(token, "getMe")


# ---------- message formatting ----------

def viewer_url(public_file_url: str) -> str:
    """3dviewer.net loads STL, GLB, OBJ from public HTTPS URLs and runs
    fully in-browser on phones — no app install needed. The encoded URL
    goes in the fragment so it's not subject to query-string corner cases."""
    return f"https://3dviewer.net/#model={quote(public_file_url, safe='')}"


def build_caption(d: storage.DraftRecord) -> str:
    """HTML-mode caption. Telegram's HTML parser is forgiving but a few
    characters (<, >, &) need escaping inside text nodes."""
    def esc(s: str) -> str:
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    parts: list[str] = [f"<b>{esc(d.title or '(untitled)')}</b>"]
    meta_bits: list[str] = []
    if d.niche:
        meta_bits.append(f"niche <code>{esc(d.niche)}</code>")
    if d.price_usd is not None:
        meta_bits.append(f"${d.price_usd:.2f}")
    meta_bits.append(d.state)
    parts.append(" · ".join(meta_bits))
    if d.description:
        snippet = d.description.strip().split("\n")[0]
        if len(snippet) > 240:
            snippet = snippet[:237] + "..."
        parts.append(esc(snippet))
    if d.tags:
        parts.append("tags: " + ", ".join(esc(t) for t in d.tags[:8]))
    return "\n\n".join(parts)


def build_keyboard(d: storage.DraftRecord) -> dict:
    """Inline keyboard: star row (callback) + link row (URL buttons).
    Star callbacks carry the listing_id so re-rating doesn't need a
    server-side state machine — every tap is a fresh row."""
    star_row = [
        {"text": _stars(n), "callback_data": f"rate:{d.local_listing_id}:{n}"}
        for n in range(1, 6)
    ]
    link_row: list[dict] = []
    if d.public_file_url:
        link_row.append({"text": "View 3D", "url": viewer_url(d.public_file_url)})
    if d.cults3d_url:
        link_row.append({"text": "Cults3D", "url": d.cults3d_url})
    if d.etsy_url:
        link_row.append({"text": "Etsy", "url": d.etsy_url})
    rows = [star_row]
    if link_row:
        rows.append(link_row)
    return {"inline_keyboard": rows}


def _stars(n: int) -> str:
    """Compact label using the unicode black-star character. Single ★ for
    1, doubled for 2, etc. — gives the operator a visual sense of the
    button without making the keyboard 5x wider."""
    return ("★" * n) if n <= 5 else f"{n}★"


# ---------- sending ----------

def post_draft(token: str, chat_id: int, d: storage.DraftRecord) -> Optional[int]:
    """Send the rating prompt: photo + caption + keyboard, then attach the
    STL/GLB as a follow-up document. Returns the photo message_id on
    success (that's the one we get callbacks against)."""
    caption = build_caption(d)
    keyboard = build_keyboard(d)

    photo_msg_id: Optional[int] = None
    params = {
        "chat_id": chat_id,
        "caption": caption,
        "parse_mode": "HTML",
        "reply_markup": json.dumps(keyboard),
    }
    try:
        if d.png_path and os.path.exists(d.png_path):
            with open(d.png_path, "rb") as f:
                result = api_request(
                    token, "sendPhoto", params, files={"photo": (os.path.basename(d.png_path), f, "image/png")}
                )
        else:
            # No preview — fall back to a text message; user still gets
            # title + 3D viewer link, just no thumbnail.
            params["text"] = caption
            del params["caption"]
            result = api_request(token, "sendMessage", params)
        photo_msg_id = int(result.get("message_id", 0)) or None
    except Exception as e:
        print(f"rater_bot: post_draft photo failed for {d.local_listing_id}: {e}",
              file=sys.stderr, flush=True)
        return None

    # Best-effort STL/GLB attachment. Posting failures are non-fatal —
    # the photo + keyboard already let the operator rate.
    if d.asset_path and os.path.exists(d.asset_path) and photo_msg_id:
        try:
            size = os.path.getsize(d.asset_path)
            if size <= 50 * 1024 * 1024:  # Telegram Bot API document cap
                with open(d.asset_path, "rb") as f:
                    api_request(
                        token,
                        "sendDocument",
                        {
                            "chat_id": chat_id,
                            "reply_to_message_id": photo_msg_id,
                            "disable_notification": "true",
                        },
                        files={
                            "document": (
                                os.path.basename(d.asset_path),
                                f,
                                "application/octet-stream",
                            )
                        },
                    )
        except Exception as e:
            print(
                f"rater_bot: attach asset {d.asset_path} failed: {e}",
                file=sys.stderr, flush=True
            )

    return photo_msg_id


def edit_caption_with_rating(
    token: str, chat_id: int, message_id: int, base_caption: str, stars: int, note: Optional[str]
) -> None:
    """Update the photo caption after a rating lands so the operator can
    see what they recorded without scrolling. Keyboard is unchanged —
    re-rating is allowed by tapping a different star."""
    suffix = f"\n\n<b>Rated {_stars(stars)}</b>"
    if note:
        suffix += f" — “{note}”"
    else:
        suffix += " · reply to this message to add a note"
    caption = base_caption + suffix
    try:
        api_request(
            token,
            "editMessageCaption",
            {
                "chat_id": chat_id,
                "message_id": message_id,
                "caption": caption,
                "parse_mode": "HTML",
            },
        )
    except Exception as e:
        # Could be "message not modified" on a no-op edit — non-fatal.
        msg = str(e)
        if "message is not modified" not in msg.lower():
            print(f"rater_bot: editMessageCaption failed: {e}",
                  file=sys.stderr, flush=True)


# ---------- update processing ----------

def handle_callback_query(
    conn, token: str, project_id: int, chat_id: int, upd: dict
) -> None:
    cb = upd.get("callback_query") or {}
    cb_id = cb.get("id")
    data = cb.get("data") or ""
    message = cb.get("message") or {}
    message_id = int(message.get("message_id", 0))

    if not data.startswith("rate:"):
        if cb_id:
            api_request(token, "answerCallbackQuery", {"callback_query_id": cb_id})
        return
    try:
        _, lid_s, stars_s = data.split(":", 2)
        listing_id = int(lid_s)
        stars = int(stars_s)
    except (ValueError, IndexError):
        if cb_id:
            api_request(token, "answerCallbackQuery", {"callback_query_id": cb_id})
        return
    if stars < 1 or stars > 5:
        return

    storage.record_rating(conn, project_id, listing_id, stars)
    storage.append_rating_jsonl(_rating_jsonl_record(conn, project_id, listing_id, stars, note=None))

    if cb_id:
        try:
            api_request(
                token,
                "answerCallbackQuery",
                {"callback_query_id": cb_id, "text": f"Saved {_stars(stars)}"},
            )
        except Exception:
            pass

    # Rebuild the caption from scratch (fetching listing metadata again)
    # so the rating suffix replaces any prior one cleanly.
    drafts = storage.find_unposted_drafts(conn, project_id, limit=0)
    # We can't query for ALREADY-posted drafts via find_unposted_drafts.
    # Inline rebuild:
    record = _refetch_draft(conn, project_id, listing_id)
    if record is not None and message_id:
        edit_caption_with_rating(
            token, chat_id, message_id, build_caption(record), stars, note=None
        )


def handle_reply_message(
    conn, token: str, project_id: int, chat_id_expected: int, upd: dict
) -> None:
    """A reply to a tracked photo message = a note for that listing's most
    recent rating. We only accept replies that target a message we know
    about; everything else is silently ignored (user chatting with bot)."""
    msg = upd.get("message") or {}
    chat = msg.get("chat") or {}
    if int(chat.get("id", 0)) != chat_id_expected:
        return
    reply = msg.get("reply_to_message") or {}
    parent_id = int(reply.get("message_id", 0))
    if not parent_id:
        return
    text = (msg.get("text") or "").strip()
    if not text:
        return
    listing_id = storage.find_listing_by_message(
        conn, project_id, chat_id_expected, parent_id
    )
    if listing_id is None:
        return
    latest = storage.latest_rating_for_listing(conn, project_id, listing_id)
    if latest is None:
        # User wrote a note before tapping a star. Record a 0-star
        # placeholder so the note isn't lost? No — better UX is to nudge
        # them to rate first. Send a soft reply.
        try:
            api_request(
                token,
                "sendMessage",
                {
                    "chat_id": chat_id_expected,
                    "reply_to_message_id": parent_id,
                    "text": "Tap a star first, then your note will attach.",
                },
            )
        except Exception:
            pass
        return
    storage.update_rating_note(conn, int(latest["id"]), text)
    storage.append_rating_jsonl(
        _rating_jsonl_record(
            conn, project_id, listing_id, int(latest["stars"]), note=text
        )
    )
    record = _refetch_draft(conn, project_id, listing_id)
    if record is not None:
        edit_caption_with_rating(
            token,
            chat_id_expected,
            parent_id,
            build_caption(record),
            int(latest["stars"]),
            note=text,
        )


# ---------- helpers ----------

def _refetch_draft(conn, project_id: int, listing_id: int) -> Optional[storage.DraftRecord]:
    """Pull metadata for a SPECIFIC listing id (find_unposted_drafts filters
    by JOIN-IS-NULL, which doesn't help here). Mirrors the enrichment logic
    in storage.find_unposted_drafts."""
    row = conn.execute(
        """
        SELECT local_listing_id, title, url, state, published_at
        FROM etsy_publishes
        WHERE project_id = ? AND local_listing_id = ?
        ORDER BY id DESC LIMIT 1
        """,
        (project_id, listing_id),
    ).fetchone()
    if not row:
        return None
    d = storage.DraftRecord(
        local_listing_id=int(row["local_listing_id"]),
        title=row["title"] or "",
        etsy_url=row["url"],
        state=row["state"] or "draft",
        published_at=int(row["published_at"] or 0),
    )
    storage._enrich_from_publisher_output(d)
    storage._enrich_from_cults3d(conn, project_id, d)
    return d


def _rating_jsonl_record(conn, project_id: int, listing_id: int, stars: int, note: Optional[str]) -> dict:
    """Shape matched to outcomes.jsonl (niche + listing_id + title) so the
    orchestrator's few-shot reader can fold both feeds together. `stars`
    + `note` are the new fields; rated_at lets readers age-weight."""
    d = _refetch_draft(conn, project_id, listing_id)
    return {
        "kind": "rating",
        "listing_id": listing_id,
        "niche": d.niche if d else None,
        "title": d.title if d else None,
        "stars": int(stars),
        "note": note,
        "rated_at": int(time.time()),
    }


# ---------- main loop ----------

def run() -> int:
    config = load_config()
    if config is None:
        print(
            f"rater_bot: no config at {_config_path()} — write a telegram.json "
            "with bot_token + chat_id and re-run.",
            file=sys.stderr, flush=True,
        )
        return 2
    if config.get("enabled", True) is False:
        print("rater_bot: disabled in config", file=sys.stderr, flush=True)
        return 0
    token = str(config.get("bot_token") or "").strip()
    chat_id_raw = config.get("chat_id")
    if not token or chat_id_raw is None:
        print("rater_bot: telegram.json missing bot_token or chat_id",
              file=sys.stderr, flush=True)
        return 2
    try:
        chat_id = int(chat_id_raw)
    except (TypeError, ValueError):
        print(f"rater_bot: chat_id must be int, got {chat_id_raw!r}",
              file=sys.stderr, flush=True)
        return 2

    try:
        me = verify_bot(token)
    except Exception as e:
        print(f"rater_bot: getMe failed: {e}", file=sys.stderr, flush=True)
        return 3
    print(
        f"rater_bot: connected as @{me.get('username')} (id={me.get('id')}), "
        f"target chat_id={chat_id}",
        file=sys.stderr, flush=True,
    )

    conn = storage.connect()
    project_id = storage.get_default_project_id(conn)
    try:
        cutoff_sec = int(
            os.environ.get("RATER_BOT_HISTORICAL_CUTOFF_SECONDS")
            or HISTORICAL_CUTOFF_SECONDS_DEFAULT
        )
    except ValueError:
        cutoff_sec = HISTORICAL_CUTOFF_SECONDS_DEFAULT
    cutoff = int(time.time()) - cutoff_sec if cutoff_sec > 0 else 0
    if cutoff_sec > 0:
        print(
            f"rater_bot: filtering drafts older than {cutoff_sec}s (set via env)",
            file=sys.stderr, flush=True,
        )
    else:
        print(
            "rater_bot: backfilling all unposted drafts (set "
            "RATER_BOT_HISTORICAL_CUTOFF_SECONDS to filter)",
            file=sys.stderr, flush=True,
        )

    last_update_id = 0
    while True:
        try:
            # 1. Scan for new drafts and post them.
            drafts = storage.find_unposted_drafts(
                conn, project_id, limit=DRAFTS_PER_TICK, min_published_at=cutoff
            )
            for d in drafts:
                msg_id = post_draft(token, chat_id, d)
                if msg_id:
                    storage.record_posting(conn, project_id, d.local_listing_id, chat_id, msg_id)
                    print(
                        f"rater_bot: posted listing {d.local_listing_id} "
                        f"(message_id={msg_id})",
                        file=sys.stderr, flush=True,
                    )
                else:
                    # Post failed — record anyway with message_id=0 so we
                    # don't loop on the same failing record. Operator can
                    # delete the row later if they want to retry.
                    storage.record_posting(conn, project_id, d.local_listing_id, chat_id, 0)

            # 2. Long-poll Telegram for callbacks + replies.
            try:
                updates = api_request(
                    token,
                    "getUpdates",
                    {
                        "offset": last_update_id + 1,
                        "timeout": DEFAULT_TICK_SECONDS,
                        "allowed_updates": json.dumps(["message", "callback_query"]),
                    },
                )
            except Exception as e:
                print(f"rater_bot: getUpdates error: {e}",
                      file=sys.stderr, flush=True)
                time.sleep(3)
                continue

            for upd in updates or []:
                last_update_id = max(last_update_id, int(upd.get("update_id") or 0))
                if "callback_query" in upd:
                    handle_callback_query(conn, token, project_id, chat_id, upd)
                elif "message" in upd:
                    handle_reply_message(conn, token, project_id, chat_id, upd)
        except KeyboardInterrupt:
            print("rater_bot: shutdown requested", file=sys.stderr, flush=True)
            return 0
        except Exception as e:
            print(f"rater_bot: loop error: {e}", file=sys.stderr, flush=True)
            time.sleep(5)
