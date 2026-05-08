from .protocol import Protocol

def handle_process_job(params: dict) -> dict:
    payload = params.get("payload", {})
    msg = payload.get("msg", "")
    return {"echo": payload, "reply": f"hello, you said: {msg}"}

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
                result = handle_process_job(params)
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
