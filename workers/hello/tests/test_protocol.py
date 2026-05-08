import io
import json
from hello.protocol import Protocol

def test_protocol_reads_request_and_writes_response():
    stdin = io.StringIO(json.dumps({
        "jsonrpc": "2.0", "id": 1, "method": "ping", "params": {"x": 1}
    }) + "\n")
    stdout = io.StringIO()
    p = Protocol(stdin, stdout)
    msg = p.read_message()
    assert msg["method"] == "ping"
    p.send_response(1, {"echo": msg["params"]})
    line = stdout.getvalue().splitlines()[0]
    parsed = json.loads(line)
    assert parsed["id"] == 1
    assert parsed["result"]["echo"] == {"x": 1}

def test_protocol_emits_notification_with_no_id():
    stdout = io.StringIO()
    p = Protocol(io.StringIO(""), stdout)
    p.send_notification("event", {"kind": "started"})
    parsed = json.loads(stdout.getvalue().splitlines()[0])
    assert "id" not in parsed
    assert parsed["method"] == "event"
    assert parsed["params"]["kind"] == "started"
