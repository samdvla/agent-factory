use agent_factory_lib::{db, events::SupervisorEvent, queue, supervisor};
use serde_json::json;
use tempfile::TempDir;

const HELLO_AGENT_INLINE: &str = r#"
import sys, json
for line in sys.stdin:
    msg = json.loads(line)
    if "id" in msg and msg.get("method") == "process_job":
        rid = msg["id"]
        params = msg.get("params", {})
        result = {"echo": params.get("payload", {})}
        sys.stdout.write(json.dumps({"jsonrpc":"2.0","id":rid,"result":result}) + "\n")
        sys.stdout.flush()
"#;

#[tokio::test]
async fn supervisor_dispatches_one_job_to_hello_worker() {
    let tmp = TempDir::new().unwrap();
    let pool = db::open(&tmp.path().join("s.sqlite")).await.unwrap();
    let project_id: i64 = sqlx::query_scalar(
        "INSERT INTO projects (name, goal, status) VALUES ('test','t','active') RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let bus = agent_factory_lib::events::EventBus::new();
    let mut rx = bus.subscribe();

    // enqueue first so the job is ready before the supervisor starts
    let job_id = queue::enqueue(&pool, project_id, "hello", json!({"msg":"hi"}))
        .await
        .unwrap();

    // start supervisor with one inline agent
    let handle = supervisor::start(
        pool.clone(),
        bus.clone(),
        vec![supervisor::AgentSpec {
            role: "hello".into(),
            program: "python3".into(),
            args: vec!["-c".into(), HELLO_AGENT_INLINE.into()],
            env: vec![],
        }],
        project_id,
        agent_factory_lib::budget::BudgetCaps { hourly_usd: f64::INFINITY, daily_usd: f64::INFINITY, monthly_usd: f64::INFINITY },
    )
    .await
    .expect("start");

    // wait for job completion event (up to 10 s)
    let mut completed = None;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await {
            Ok(Ok(SupervisorEvent::JobCompleted {
                job_id: jid,
                result,
                ..
            })) => {
                completed = Some((jid, result));
                break;
            }
            Ok(Ok(_)) => continue, // other events (AgentStarted, etc.)
            Ok(Err(_)) => break,   // channel closed
            Err(_) => continue,    // timeout on this recv, loop again
        }
    }

    assert!(completed.is_some(), "job never completed within 10 s");
    let (jid, result) = completed.unwrap();
    assert_eq!(jid, job_id);
    assert_eq!(result["echo"]["msg"], "hi");

    handle.shutdown().await;
}
