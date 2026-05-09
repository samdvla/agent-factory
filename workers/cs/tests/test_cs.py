import json

from cs.agent import build_reply_prompt


def test_prompt_includes_message():
    s, u = build_reply_prompt("How do I download?")
    assert "download" in u.lower()


def test_listing_ref_appears_when_provided():
    _, u = build_reply_prompt("Question", listing_title="Boho Print Pack")
    assert "Boho Print Pack" in u


def _capture_anthropic_system(monkeypatch):
    captured: dict = {}

    class _Resp:
        def __enter__(self_inner):
            return self_inner

        def __exit__(self_inner, *a):
            return False

        def read(self_inner):
            return json.dumps({
                "content": [{"type": "text", "text": json.dumps({
                    "reply": "Thanks for reaching out!",
                    "escalate": False,
                    "category": "thank_you",
                })}],
                "usage": {"input_tokens": 1, "output_tokens": 1},
            }).encode("utf-8")

    def _fake_urlopen(req, timeout=110):
        captured["body"] = json.loads(req.data.decode("utf-8"))
        return _Resp()

    import urllib.request
    monkeypatch.setattr(urllib.request, "urlopen", _fake_urlopen)
    return captured


def test_override_replaces_system(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    af_dir = tmp_path / ".agent-factory"
    af_dir.mkdir()
    override_text = "TEST_OVERRIDE_CS " * 5
    (af_dir / "prompts.json").write_text(json.dumps({
        "cs": {"system_override": override_text},
    }))

    captured = _capture_anthropic_system(monkeypatch)
    from cs.agent import handle
    result = handle("process_job", {"payload": {"buyer_message": "hi"}})
    assert result["ok"] is True
    assert captured["body"]["system"] == override_text


def test_no_override_uses_default(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k-test")
    captured = _capture_anthropic_system(monkeypatch)
    from cs.agent import handle
    result = handle("process_job", {"payload": {"buyer_message": "hi"}})
    assert result["ok"] is True
    default_system, _ = build_reply_prompt("hi")
    assert captured["body"]["system"] == default_system
