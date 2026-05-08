use agent_factory_lib::llm::{LlmRouter, Tier, CompleteRequest};

#[tokio::test]
async fn routes_haiku_request_and_parses_token_usage() {
    let mut server = mockito::Server::new_async().await;
    let mock = server.mock("POST", "/v1/messages")
        .match_header("x-api-key", "test-key")
        .match_header("anthropic-version", "2023-06-01")
        .with_status(200)
        .with_header("content-type", "application/json")
        .with_body(r#"{
            "id": "msg_1",
            "model": "claude-haiku-4-5-20251001",
            "content": [{"type":"text","text":"hi back"}],
            "usage": {"input_tokens": 12, "output_tokens": 7}
        }"#)
        .create_async()
        .await;

    let router = LlmRouter::new("test-key", &server.url());
    let resp = router.complete(CompleteRequest {
        tier: Tier::Haiku,
        system: "you are helpful".into(),
        messages: vec![("user".into(), "hi".into())],
        max_tokens: 64,
    }).await.expect("complete");

    assert_eq!(resp.text, "hi back");
    assert_eq!(resp.tokens_in, 12);
    assert_eq!(resp.tokens_out, 7);
    assert_eq!(resp.model, "claude-haiku-4-5-20251001");
    mock.assert_async().await;
}

#[tokio::test]
async fn maps_tiers_to_correct_model_ids() {
    use agent_factory_lib::llm::Tier;
    assert_eq!(Tier::Haiku.model_id(), "claude-haiku-4-5-20251001");
    assert_eq!(Tier::Sonnet.model_id(), "claude-sonnet-4-6");
    assert_eq!(Tier::Opus.model_id(), "claude-opus-4-7");
}
