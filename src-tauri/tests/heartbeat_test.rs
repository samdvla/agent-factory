use agent_factory_lib::heartbeat::HeartbeatTracker;
use std::time::Duration;

#[tokio::test]
async fn ping_then_quick_check_is_alive() {
    let mut t = HeartbeatTracker::new(Duration::from_millis(100), 4);
    t.ping("designer");
    assert!(t.is_alive("designer"));
}

#[tokio::test]
async fn no_ping_for_4_intervals_marks_dead() {
    let mut t = HeartbeatTracker::new(Duration::from_millis(50), 4);
    t.ping("designer");
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(!t.is_alive("designer"));
}

#[tokio::test]
async fn stale_workers_returns_only_dead_ones() {
    let mut t = HeartbeatTracker::new(Duration::from_millis(50), 4);
    t.ping("alpha");
    tokio::time::sleep(Duration::from_millis(250)).await;
    t.ping("beta");
    let stale = t.stale_workers();
    assert_eq!(stale, vec!["alpha".to_string()]);
}
