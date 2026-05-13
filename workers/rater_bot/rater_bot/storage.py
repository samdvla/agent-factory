"""SQLite + JSONL persistence for the rater bot.

The bot shares the Tauri app's SQLite database (path discovered from
~/.agent-factory/db_path.txt, written by the Tauri app on startup). It only
INSERTs into tables it owns (product_ratings, telegram_postings) and READs
from supervisor-owned tables (etsy_publishes, cults3d_publishes, projects).

Ratings are mirrored to ~/.agent-factory/ratings.jsonl so the orchestrator
worker (which uses jsonl-only access patterns, never touches SQLite) can
fold them into its few-shot context.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import dataclass
from typing import Optional


DEFAULT_DATA_DIR = os.path.expanduser("~/.agent-factory")


def data_dir() -> str:
    return os.environ.get("AGENT_FACTORY_DATA", DEFAULT_DATA_DIR)


def db_path() -> str:
    """Resolve the SQLite db path. Priority: env override → db_path.txt →
    error. db_path.txt is written by the Tauri app on startup."""
    override = os.environ.get("AGENT_FACTORY_DB")
    if override:
        return override
    p = os.path.join(data_dir(), "db_path.txt")
    if not os.path.exists(p):
        raise FileNotFoundError(
            f"{p} not found — start the Tauri app at least once so it writes "
            "the db path, or set AGENT_FACTORY_DB."
        )
    with open(p, "r", encoding="utf-8") as f:
        path = f.read().strip()
    if not path:
        raise ValueError(f"{p} is empty")
    return path


def connect(path: Optional[str] = None) -> sqlite3.Connection:
    """Open a connection to the shared SQLite db. WAL mode means we can
    safely read + write concurrently with the Tauri side."""
    conn = sqlite3.connect(path or db_path(), timeout=10.0)
    conn.row_factory = sqlite3.Row
    # Match Tauri's pragmas so we don't fight the writer.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@dataclass
class DraftRecord:
    """Everything the bot needs to post one draft for rating."""
    local_listing_id: int
    title: str
    etsy_url: Optional[str]
    state: str
    published_at: int
    # Joined from publisher_output.json
    description: str = ""
    niche: Optional[str] = None
    price_usd: Optional[float] = None
    tags: list[str] = None  # type: ignore[assignment]
    png_path: Optional[str] = None
    asset_path: Optional[str] = None
    # Joined from cults3d_publishes (public hosted URL → 3D viewer link)
    public_file_url: Optional[str] = None
    cults3d_url: Optional[str] = None

    def __post_init__(self) -> None:
        if self.tags is None:
            self.tags = []


def get_default_project_id(conn: sqlite3.Connection) -> int:
    """The Tauri app always ensures a 'default' project on startup. The
    bot uses the same one."""
    row = conn.execute(
        "SELECT id FROM projects WHERE name = 'default' LIMIT 1"
    ).fetchone()
    if not row:
        raise RuntimeError(
            "No 'default' project — start the Tauri app at least once."
        )
    return int(row["id"])


def find_unposted_drafts(
    conn: sqlite3.Connection,
    project_id: int,
    limit: int = 3,
    min_published_at: int = 0,
) -> list[DraftRecord]:
    """Return the newest drafts that haven't been posted to Telegram yet.
    Caps at `limit` per call so a backlog of hundreds doesn't spam the
    chat in one tick. min_published_at filters out historical rows so a
    fresh-install bot doesn't post the whole history."""
    rows = conn.execute(
        """
        SELECT ep.local_listing_id, ep.title, ep.url, ep.state, ep.published_at
        FROM etsy_publishes ep
        LEFT JOIN telegram_postings tp
            ON tp.project_id = ep.project_id
            AND tp.local_listing_id = ep.local_listing_id
        WHERE ep.project_id = ?
          AND tp.id IS NULL
          AND ep.state IN ('draft', 'active')
          AND ep.published_at >= ?
        ORDER BY ep.id DESC
        LIMIT ?
        """,
        (project_id, min_published_at, limit),
    ).fetchall()

    drafts: list[DraftRecord] = []
    for r in rows:
        d = DraftRecord(
            local_listing_id=int(r["local_listing_id"]),
            title=r["title"] or "",
            etsy_url=r["url"],
            state=r["state"] or "draft",
            published_at=int(r["published_at"] or 0),
        )
        _enrich_from_publisher_output(d)
        _enrich_from_cults3d(conn, project_id, d)
        drafts.append(d)
    # Oldest-first so the chat reads in chronological order.
    drafts.reverse()
    return drafts


def _enrich_from_publisher_output(d: DraftRecord) -> None:
    """publisher_output.json carries description / tags / niche / price /
    local asset paths. Loaded lazily and best-effort — missing fields stay
    on their defaults."""
    path = os.path.join(data_dir(), "publisher_output.json")
    if not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as f:
            records = json.load(f)
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(records, list):
        return
    rec = None
    for r in reversed(records):
        if not isinstance(r, dict):
            continue
        if r.get("listing_id") == d.local_listing_id:
            rec = r
            break
    if rec is None:
        return
    d.description = str(rec.get("description") or "")
    d.niche = rec.get("niche") if isinstance(rec.get("niche"), str) else None
    price = rec.get("price_usd")
    if isinstance(price, (int, float)):
        d.price_usd = float(price)
    raw_tags = rec.get("tags")
    if isinstance(raw_tags, list):
        d.tags = [t for t in raw_tags if isinstance(t, str)]
    # asset_path = primary STL/GLB; asset_paths = bundle members.
    asset_path = rec.get("asset_path")
    if isinstance(asset_path, str) and asset_path:
        d.asset_path = asset_path
    # Pinterest pin is the PNG-er-y preview; prefer that. Otherwise look
    # for any companion .png next to asset_path.
    pin_path = rec.get("pinterest_pin_path")
    if isinstance(pin_path, str) and pin_path and os.path.exists(pin_path):
        d.png_path = pin_path
    elif d.asset_path:
        candidate = os.path.splitext(d.asset_path)[0] + ".png"
        if os.path.exists(candidate):
            d.png_path = candidate


def _enrich_from_cults3d(
    conn: sqlite3.Connection, project_id: int, d: DraftRecord
) -> None:
    """Cults3D publish row carries the GitHub-hosted public file_url (used
    for the 3dviewer.net deep link) and the public Cults3D listing URL
    (which embeds its own 3D viewer). Either may be missing if Cults3D
    publish hasn't run yet or is disabled."""
    row = conn.execute(
        """
        SELECT file_url, url
        FROM cults3d_publishes
        WHERE project_id = ? AND local_listing_id = ?
        ORDER BY id DESC LIMIT 1
        """,
        (project_id, d.local_listing_id),
    ).fetchone()
    if row:
        d.public_file_url = row["file_url"]
        d.cults3d_url = row["url"]


def record_posting(
    conn: sqlite3.Connection,
    project_id: int,
    local_listing_id: int,
    chat_id: int,
    message_id: int,
) -> None:
    """Mark a draft as 'we posted this' so we never double-post it. UNIQUE
    on (project_id, local_listing_id) means a second insert is a silent
    no-op via INSERT OR IGNORE."""
    conn.execute(
        """
        INSERT OR IGNORE INTO telegram_postings
            (project_id, local_listing_id, chat_id, message_id, posted_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (project_id, local_listing_id, chat_id, message_id, int(time.time())),
    )
    conn.commit()


def find_listing_by_message(
    conn: sqlite3.Connection, project_id: int, chat_id: int, message_id: int
) -> Optional[int]:
    """Reverse lookup: when a Telegram callback / reply targets a message,
    figure out which draft it's for."""
    row = conn.execute(
        """
        SELECT local_listing_id FROM telegram_postings
        WHERE project_id = ? AND chat_id = ? AND message_id = ?
        """,
        (project_id, chat_id, message_id),
    ).fetchone()
    return int(row["local_listing_id"]) if row else None


def record_rating(
    conn: sqlite3.Connection,
    project_id: int,
    local_listing_id: int,
    stars: int,
    note: Optional[str] = None,
) -> int:
    """Insert a new rating row. Re-rating is allowed — each tap is a fresh
    row; the latest-by-created_at wins for few-shot purposes. Returns the
    new row id so the caller can update notes against it later."""
    cur = conn.execute(
        """
        INSERT INTO product_ratings
            (project_id, local_listing_id, stars, note, source, created_at)
        VALUES (?, ?, ?, ?, 'telegram', ?)
        """,
        (project_id, local_listing_id, int(stars), note, int(time.time())),
    )
    conn.commit()
    return int(cur.lastrowid or 0)


def update_rating_note(conn: sqlite3.Connection, rating_id: int, note: str) -> None:
    conn.execute(
        "UPDATE product_ratings SET note = ? WHERE id = ?",
        (note, rating_id),
    )
    conn.commit()


def latest_rating_for_listing(
    conn: sqlite3.Connection, project_id: int, local_listing_id: int
) -> Optional[sqlite3.Row]:
    return conn.execute(
        """
        SELECT id, stars, note, created_at FROM product_ratings
        WHERE project_id = ? AND local_listing_id = ?
        ORDER BY id DESC LIMIT 1
        """,
        (project_id, local_listing_id),
    ).fetchone()


def append_rating_jsonl(record: dict) -> None:
    """Mirror a rating event to ~/.agent-factory/ratings.jsonl. The
    orchestrator reads this file (same pattern as outcomes.jsonl) so the
    few-shot loop doesn't need SQLite access."""
    path = os.path.join(data_dir(), "ratings.jsonl")
    os.makedirs(data_dir(), exist_ok=True)
    line = json.dumps(record, ensure_ascii=False)
    with open(path, "a", encoding="utf-8") as f:
        f.write(line + "\n")
