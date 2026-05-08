use agent_factory_lib::worker::{Worker, WorkerEvent};
use serde_json::json;

// We invoke `python3` with -c so the test doesn't depend on workers/hello existing yet.
const ECHO_SCRIPT: &str = r#"
import sys, json
for line in sys.stdin:
    msg = json.loads(line)
    if "id" in msg:
        # request: respond
        rid = msg["id"]
        method = msg["method"]
        params = msg.get("params", {})
        resp = {"jsonrpc":"2.0","id":rid,"result":{"echo": params}}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
"#;

#[tokio::test]
async fn worker_request_response_round_trip() {
    let mut w = Worker::spawn("python3", &["-c", ECHO_SCRIPT]).await.expect("spawn");

    let resp = w.request("ping", json!({"x": 1})).await.expect("request");
    assert_eq!(resp["echo"]["x"], 1);

    w.shutdown().await.unwrap();
}

#[tokio::test]
async fn worker_emits_notifications_as_events() {
    const NOTIFY_SCRIPT: &str = r#"
import sys, json, time
sys.stdout.write(json.dumps({"jsonrpc":"2.0","method":"event","params":{"kind":"hello"}}) + "\n")
sys.stdout.flush()
for line in sys.stdin:
    msg = json.loads(line)
    if "id" in msg:
        sys.stdout.write(json.dumps({"jsonrpc":"2.0","id":msg["id"],"result":"ok"}) + "\n")
        sys.stdout.flush()
"#;
    let mut w = Worker::spawn("python3", &["-c", NOTIFY_SCRIPT]).await.expect("spawn");

    // First event should be the hello notification
    let evt = tokio::time::timeout(std::time::Duration::from_secs(2), w.next_event())
        .await
        .expect("timeout")
        .expect("event");
    match evt {
        WorkerEvent::Notification { method, params } => {
            assert_eq!(method, "event");
            assert_eq!(params["kind"], "hello");
        }
        _ => panic!("expected notification"),
    }
    w.shutdown().await.unwrap();
}
