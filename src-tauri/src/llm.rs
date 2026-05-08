use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    Haiku,
    Sonnet,
    Opus,
}

impl Tier {
    pub fn model_id(&self) -> &'static str {
        match self {
            Tier::Haiku => "claude-haiku-4-5-20251001",
            Tier::Sonnet => "claude-sonnet-4-6",
            Tier::Opus => "claude-opus-4-7",
        }
    }
}

#[derive(Debug, Clone)]
pub struct CompleteRequest {
    pub tier: Tier,
    pub system: String,
    pub messages: Vec<(String, String)>, // (role, content)
    pub max_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompleteResponse {
    pub text: String,
    pub tokens_in: u64,
    pub tokens_out: u64,
    pub model: String,
}

pub struct LlmRouter {
    api_key: String,
    base_url: String,
    client: reqwest::Client,
}

impl LlmRouter {
    pub fn new(api_key: &str, base_url: &str) -> Self {
        Self {
            api_key: api_key.to_string(),
            base_url: base_url.trim_end_matches('/').to_string(),
            client: reqwest::Client::new(),
        }
    }

    pub fn anthropic() -> Self {
        let key = std::env::var("ANTHROPIC_API_KEY").unwrap_or_default();
        Self::new(&key, "https://api.anthropic.com")
    }

    pub async fn complete(&self, req: CompleteRequest) -> anyhow::Result<CompleteResponse> {
        let body = serde_json::json!({
            "model": req.tier.model_id(),
            "max_tokens": req.max_tokens,
            "system": [
                {
                    "type": "text",
                    "text": req.system,
                    "cache_control": {"type": "ephemeral"}
                }
            ],
            "messages": req.messages.iter().map(|(role, content)| {
                serde_json::json!({"role": role, "content": content})
            }).collect::<Vec<_>>()
        });

        let resp = self.client
            .post(format!("{}/v1/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?
            .error_for_status()?;

        let payload: serde_json::Value = resp.json().await?;

        let text = payload["content"]
            .as_array()
            .and_then(|arr| arr.iter().find(|b| b["type"] == "text"))
            .and_then(|b| b["text"].as_str())
            .unwrap_or("")
            .to_string();
        let tokens_in = payload["usage"]["input_tokens"].as_u64().unwrap_or(0);
        let tokens_out = payload["usage"]["output_tokens"].as_u64().unwrap_or(0);
        let model = payload["model"].as_str().unwrap_or("").to_string();

        Ok(CompleteResponse { text, tokens_in, tokens_out, model })
    }
}
