from listing.agent import build_listing_prompt, validate_listing


def test_prompt_includes_title_constraint():
    brief = {"niche": "minimalist wall art"}
    asset = {"asset_type": "printable", "dimensions": "8.5x11 inch"}
    system, user = build_listing_prompt(brief, asset)
    assert "140" in system
    assert "13 tags" in system or "Exactly 13" in system


def test_validate_listing_ok():
    listing = {
        "title": "Beautiful Minimalist Wall Art Print | Digital Download",
        "tags": ["wall art", "printable", "minimalist", "digital", "download",
                 "home decor", "modern art", "boho", "gallery wall",
                 "instant download", "art print", "bedroom decor", "office art"],
        "description": "A lovely print.",
        "materials": ["digital download"],
        "price_usd": 5.99,
    }
    errors = validate_listing(listing)
    assert errors == []


def test_validate_listing_title_too_long():
    listing = {
        "title": "x" * 141,
        "tags": ["t"] * 13,
        "description": "desc",
        "materials": ["digital download"],
        "price_usd": 5.0,
    }
    errors = validate_listing(listing)
    assert any("title" in e for e in errors)


def test_validate_listing_wrong_tag_count():
    listing = {
        "title": "Short Title",
        "tags": ["only", "five", "tags", "here", "oops"],
        "description": "desc",
        "materials": ["digital download"],
        "price_usd": 5.0,
    }
    errors = validate_listing(listing)
    assert any("tags" in e for e in errors)
