use agent_factory_lib::secrets;

#[test]
fn set_get_delete_roundtrip() {
    let key = "test_anthropic_api_key";
    secrets::set(key, "sk-test-123").expect("set");
    let v = secrets::get(key).expect("get");
    assert_eq!(v, Some("sk-test-123".to_string()));
    secrets::delete(key).expect("delete");
    let v = secrets::get(key).expect("get after delete");
    assert_eq!(v, None);
}
