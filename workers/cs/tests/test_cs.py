from cs.agent import build_reply_prompt


def test_prompt_includes_message():
    s, u = build_reply_prompt("How do I download?")
    assert "download" in u.lower()


def test_listing_ref_appears_when_provided():
    _, u = build_reply_prompt("Question", listing_title="Boho Print Pack")
    assert "Boho Print Pack" in u
