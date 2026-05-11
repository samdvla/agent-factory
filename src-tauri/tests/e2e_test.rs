use agent_factory_lib::{db, events::{EventBus, SupervisorEvent}, queue, supervisor};
use serde_json::json;
use tempfile::TempDir;

/// End-to-end test that exercises the full P0 stack:
/// db → queue → supervisor → real Python `hello` worker subprocess.
///
/// Requires `python3.11 -m hello` to resolve (installed via
/// `pip install --user -e workers/hello` in Python 3.11).
#[tokio::test]
async fn end_to_end_hello_agent_completes_a_job() {
    let tmp = TempDir::new().unwrap();
    let pool = db::open(&tmp.path().join("e2e.sqlite")).await.unwrap();
    let project_id: i64 = sqlx::query_scalar(
        "INSERT INTO projects (name, goal, status) VALUES ('test','sandbox','active') RETURNING id",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let bus = EventBus::new();
    let mut rx = bus.subscribe();

    let job_id = queue::enqueue(&pool, project_id, "hello", json!({"msg": "world"}))
        .await
        .unwrap();

    let handle = supervisor::start(
        pool.clone(),
        bus.clone(),
        vec![supervisor::AgentSpec {
            role: "hello".into(),
            program: "python3.11".into(),
            args: vec!["-m".into(), "hello".into()],
            env: vec![],
        }],
        project_id,
        f64::INFINITY,
    )
    .await
    .unwrap();

    let mut got = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Ok(evt)) =
            tokio::time::timeout(std::time::Duration::from_millis(500), rx.recv()).await
        {
            if let SupervisorEvent::JobCompleted {
                job_id: jid,
                result,
                ..
            } = evt
            {
                if jid == job_id {
                    assert_eq!(
                        result["reply"], "hello, you said: world",
                        "unexpected reply: {result}"
                    );
                    got = true;
                    break;
                }
            }
        }
    }

    handle.shutdown().await;

    assert!(got, "did not receive JobCompleted event within 15 s");
}
