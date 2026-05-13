"""Tests for the rater bot — formatting + storage logic only. We don't hit
Telegram's API here; the network path is covered by manual smoke."""

import json
import os
import sqlite3
import time
from pathlib import Path

import pytest

from rater_bot import bot, storage


# ---------- caption + keyboard formatting ----------

def _draft(**overrides):
    base = dict(
        local_listing_id=12345,
        title="Goblin Warrior Mini",
        etsy_url="https://etsy.com/listing/999",
        state="draft",
        published_at=1700000000,
        description="A chunky D&D goblin warrior with axe.",
        niche="dnd minis",
        price_usd=4.99,
        tags=["dnd", "goblin", "stl"],
        png_path=None,
        asset_path=None,
        public_file_url=None,
        cults3d_url=None,
    )
    base.update(overrides)
    return storage.DraftRecord(**base)


def test_caption_includes_title_niche_price_state():
    d = _draft()
    cap = bot.build_caption(d)
    assert "Goblin Warrior Mini" in cap
    assert "dnd minis" in cap
    assert "$4.99" in cap
    assert "draft" in cap
    assert "chunky D&amp;D goblin" in cap  # HTML escape applied


def test_caption_escapes_html_in_title():
    d = _draft(title="<script>alert(1)</script>")
    cap = bot.build_caption(d)
    assert "<script>" not in cap
    assert "&lt;script&gt;" in cap


def test_caption_truncates_long_description():
    d = _draft(description="x" * 500)
    cap = bot.build_caption(d)
    # truncated to 240 + "..."
    assert "x" * 237 + "..." in cap


def test_keyboard_has_five_star_buttons_with_listing_id():
    d = _draft()
    kb = bot.build_keyboard(d)
    rows = kb["inline_keyboard"]
    assert len(rows[0]) == 5
    for i, btn in enumerate(rows[0], start=1):
        assert btn["callback_data"] == f"rate:12345:{i}"


def test_keyboard_includes_viewer_link_only_when_public_url_present():
    d = _draft()
    kb = bot.build_keyboard(d)
    # No public file URL → no link row at all (no cults3d_url, no etsy URL)
    # We DO have an etsy_url in the default fixture though.
    link_row = kb["inline_keyboard"][1] if len(kb["inline_keyboard"]) > 1 else []
    assert any(b.get("text") == "Etsy" for b in link_row)
    assert not any(b.get("text") == "View 3D" for b in link_row)


def test_keyboard_with_public_url_includes_viewer():
    d = _draft(
        public_file_url="https://github.com/foo/bar/releases/download/x/model.stl",
        cults3d_url="https://cults3d.com/en/3d-model/figure",
    )
    kb = bot.build_keyboard(d)
    link_row = kb["inline_keyboard"][1]
    labels = [b["text"] for b in link_row]
    assert "View 3D" in labels
    assert "Cults3D" in labels
    assert "Etsy" in labels


def test_viewer_url_encodes_special_characters():
    url = bot.viewer_url("https://example.com/path?x=1&y=2")
    assert url.startswith("https://3dviewer.net/#model=")
    assert "%3F" in url  # ?
    assert "%26" in url  # &


# ---------- storage layer with a real (temp) SQLite ----------

def _make_db(tmp_path: Path) -> str:
    """Build a SQLite db with the same schema the Tauri app applies via
    sqlx migrations. We only need the tables this worker touches."""
    db = tmp_path / "db.sqlite"
    conn = sqlite3.connect(str(db))
    conn.executescript(
        """
        CREATE TABLE projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            goal TEXT,
            status TEXT
        );
        INSERT INTO projects (name, goal, status) VALUES ('default','sandbox','active');

        CREATE TABLE etsy_publishes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            local_listing_id INTEGER NOT NULL,
            etsy_listing_id INTEGER NOT NULL,
            state TEXT NOT NULL,
            title TEXT NOT NULL,
            url TEXT,
            published_at INTEGER NOT NULL,
            day TEXT NOT NULL
        );

        CREATE TABLE cults3d_publishes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            local_listing_id INTEGER NOT NULL,
            file_url TEXT,
            url TEXT
        );

        CREATE TABLE product_ratings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            local_listing_id INTEGER NOT NULL,
            stars INTEGER NOT NULL,
            note TEXT,
            source TEXT NOT NULL DEFAULT 'telegram',
            created_at INTEGER NOT NULL
        );

        CREATE TABLE telegram_postings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            local_listing_id INTEGER NOT NULL,
            chat_id INTEGER NOT NULL,
            message_id INTEGER NOT NULL,
            posted_at INTEGER NOT NULL,
            UNIQUE (project_id, local_listing_id)
        );
        """
    )
    conn.commit()
    conn.close()
    return str(db)


def test_find_unposted_drafts_returns_only_new_drafts(tmp_path, monkeypatch):
    db = _make_db(tmp_path)
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("AGENT_FACTORY_DB", db)

    now = int(time.time())
    conn = storage.connect()
    project_id = storage.get_default_project_id(conn)

    conn.executemany(
        "INSERT INTO etsy_publishes (project_id, local_listing_id, etsy_listing_id, state, title, url, published_at, day) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01')",
        [
            (project_id, 100, 9001, "draft", "A", None, now - 60),
            (project_id, 101, 9002, "draft", "B", None, now - 30),
            (project_id, 102, 9003, "active", "C", None, now - 10),
        ],
    )
    conn.commit()

    # Cutoff = now - 120 → all three drafts qualify.
    drafts = storage.find_unposted_drafts(conn, project_id, limit=10, min_published_at=now - 120)
    titles = sorted(d.title for d in drafts)
    assert titles == ["A", "B", "C"]

    # Mark B as posted, find_unposted should now skip it.
    storage.record_posting(conn, project_id, 101, 555, 999)
    drafts = storage.find_unposted_drafts(conn, project_id, limit=10, min_published_at=now - 120)
    titles = sorted(d.title for d in drafts)
    assert titles == ["A", "C"]

    # Tighter cutoff: skip A (60s old).
    drafts = storage.find_unposted_drafts(conn, project_id, limit=10, min_published_at=now - 40)
    titles = sorted(d.title for d in drafts)
    assert titles == ["C"]


def test_record_rating_and_lookup(tmp_path, monkeypatch):
    db = _make_db(tmp_path)
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("AGENT_FACTORY_DB", db)

    conn = storage.connect()
    project_id = storage.get_default_project_id(conn)

    rid = storage.record_rating(conn, project_id, 42, 5, note=None)
    assert rid > 0
    row = storage.latest_rating_for_listing(conn, project_id, 42)
    assert row is not None
    assert int(row["stars"]) == 5
    assert row["note"] is None

    storage.update_rating_note(conn, rid, "love it")
    row = storage.latest_rating_for_listing(conn, project_id, 42)
    assert row["note"] == "love it"

    # Re-rating creates a new row, takes precedence.
    rid2 = storage.record_rating(conn, project_id, 42, 2, note=None)
    assert rid2 > rid
    row = storage.latest_rating_for_listing(conn, project_id, 42)
    assert int(row["stars"]) == 2


def test_find_listing_by_message_roundtrip(tmp_path, monkeypatch):
    db = _make_db(tmp_path)
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    monkeypatch.setenv("AGENT_FACTORY_DB", db)

    conn = storage.connect()
    project_id = storage.get_default_project_id(conn)

    storage.record_posting(conn, project_id, 77, 555, 1234)
    found = storage.find_listing_by_message(conn, project_id, 555, 1234)
    assert found == 77

    miss = storage.find_listing_by_message(conn, project_id, 555, 9999)
    assert miss is None


def test_append_rating_jsonl_writes_line(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    storage.append_rating_jsonl({"listing_id": 1, "stars": 5, "note": "yes"})
    storage.append_rating_jsonl({"listing_id": 2, "stars": 1, "note": "no"})

    path = os.path.join(str(tmp_path), "ratings.jsonl")
    with open(path) as f:
        lines = [json.loads(l) for l in f if l.strip()]
    assert len(lines) == 2
    assert lines[0]["listing_id"] == 1
    assert lines[1]["stars"] == 1


def test_publisher_output_enrichment(tmp_path, monkeypatch):
    monkeypatch.setenv("AGENT_FACTORY_DATA", str(tmp_path))
    payload = [
        {
            "listing_id": 555,
            "title": "Pendant",
            "description": "Botanical leaf pendant STL.",
            "niche": "jewelry stl",
            "price_usd": 6.5,
            "tags": ["pendant", "jewelry"],
            "asset_path": "/tmp/nope.stl",
        }
    ]
    (tmp_path / "publisher_output.json").write_text(json.dumps(payload))

    d = storage.DraftRecord(
        local_listing_id=555,
        title="",
        etsy_url=None,
        state="draft",
        published_at=0,
    )
    storage._enrich_from_publisher_output(d)
    assert d.niche == "jewelry stl"
    assert d.price_usd == 6.5
    assert d.tags == ["pendant", "jewelry"]
    assert d.description.startswith("Botanical")
