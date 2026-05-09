import json
import sys
from typing import Any, Optional, TextIO


class Protocol:
    """Newline-delimited JSON-RPC 2.0 over stdio."""

    def __init__(self, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout):
        self.stdin = stdin
        self.stdout = stdout

    def read_message(self) -> Optional[dict]:
        line = self.stdin.readline()
        if not line:
            return None
        return json.loads(line)

    def send_response(self, request_id: Any, result: Any) -> None:
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def send_error(self, request_id: Any, code: int, message: str) -> None:
        self._write({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": code, "message": message},
        })

    def send_notification(self, method: str, params: Any) -> None:
        self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def _write(self, obj: dict) -> None:
        self.stdout.write(json.dumps(obj) + "\n")
        self.stdout.flush()


def run(handle) -> None:
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
                result = handle(method, {"job_id": job_id, "payload": payload})
                # Check for handoff before sending response
                handoff = result.pop("handoff", None) if isinstance(result, dict) else None
                if handoff:
                    notif: dict = {
                        "to_role": handoff["to_role"],
                        "payload": handoff["payload"],
                    }
                    if "delay_ms" in handoff:
                        notif["delay_ms"] = handoff["delay_ms"]
                    p.send_notification("enqueue_handoff", notif)
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
