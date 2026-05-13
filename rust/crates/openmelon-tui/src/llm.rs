use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: Role,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub content: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tool_call_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tool {
    pub name: String,
    pub description: String,
    pub parameters: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinishReason {
    Stop,
    ToolCalls,
    Length,
    Other,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Debug, Clone)]
pub struct ChatRequest {
    pub messages: Vec<Message>,
    pub tools: Vec<Tool>,
    pub reasoning_effort: String,
}

#[derive(Debug, Clone)]
pub struct ChatResponse {
    pub message: Message,
    pub finish_reason: FinishReason,
    pub usage: Usage,
}

#[derive(Debug, Clone)]
pub struct OpenAIClient {
    provider: String,
    api_key: String,
    base_url: String,
    model: String,
    client: Client,
}

impl OpenAIClient {
    pub fn new(provider: &str, api_key: String, base_url: String, model: String) -> Result<Self> {
        if provider == "anthropic" {
            bail!("anthropic is not implemented in the Rust runtime yet; use openai or openrouter");
        }
        if api_key.trim().is_empty() {
            bail!("no API key for {provider}; run openmelon setup or configure credentials");
        }
        if model.trim().is_empty() {
            bail!("no LLM model configured");
        }
        let base_url = match (provider, base_url.trim()) {
            (_, url) if !url.is_empty() => url.trim_end_matches('/').to_string(),
            ("openrouter", _) => "https://openrouter.ai/api".to_string(),
            _ => "https://api.openai.com".to_string(),
        };
        Ok(Self {
            provider: provider.to_string(),
            api_key,
            base_url,
            model,
            client: Client::builder()
                .timeout(Duration::from_secs(180))
                .build()?,
        })
    }

    pub fn provider(&self) -> &str {
        &self.provider
    }

    pub fn model(&self) -> &str {
        &self.model
    }

    pub fn chat(&self, request: ChatRequest) -> Result<ChatResponse> {
        if request.messages.is_empty() {
            bail!("chat requires at least one message");
        }

        let wire_messages = request
            .messages
            .iter()
            .map(to_wire_message)
            .collect::<Vec<_>>();
        let wire_tools = request
            .tools
            .iter()
            .map(|tool| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": tool.name,
                        "description": tool.description,
                        "parameters": tool.parameters,
                    }
                })
            })
            .collect::<Vec<_>>();

        let mut body = serde_json::json!({
            "model": self.model,
            "messages": wire_messages,
            "temperature": 0.7,
        });
        if !wire_tools.is_empty() {
            body["tools"] = Value::Array(wire_tools);
        }
        if let Some(effort) = normalize_reasoning_effort(&request.reasoning_effort) {
            body["reasoning_effort"] = Value::String(effort.to_string());
        }

        let url = format!("{}/v1/chat/completions", self.base_url);
        let mut req = self
            .client
            .post(url)
            .bearer_auth(&self.api_key)
            .header("content-type", "application/json")
            .header("user-agent", user_agent());
        if self.provider == "openrouter" {
            req = req
                .header(
                    "HTTP-Referer",
                    "https://github.com/eight-acres-lab/openmelon",
                )
                .header("X-Title", "openmelon");
        }

        let resp = req.json(&body).send().context("send chat request")?;
        let status = resp.status();
        let text = resp.text().context("read chat response")?;
        if !status.is_success() {
            bail!("llm[{}]: HTTP {}: {}", self.provider, status.as_u16(), text);
        }
        let parsed: ChatResponseWire =
            serde_json::from_str(&text).with_context(|| format!("parse chat response: {text}"))?;
        let choice = parsed
            .choices
            .into_iter()
            .next()
            .context("no choices in response")?;

        Ok(ChatResponse {
            message: from_wire_message(choice.message),
            finish_reason: map_finish_reason(&choice.finish_reason),
            usage: parsed.usage.unwrap_or_default().into(),
        })
    }
}

fn user_agent() -> String {
    format!(
        "openmelon-rust-tui/0.1.0 ({} {}; {})",
        std::env::consts::OS,
        std::env::consts::ARCH,
        std::env::var("TERM_PROGRAM").unwrap_or_else(|_| "terminal".to_string())
    )
}

fn normalize_reasoning_effort(value: &str) -> Option<&str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "none" => Some("none"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        _ => None,
    }
}

fn to_wire_message(message: &Message) -> Value {
    let role = match message.role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    };
    let mut out = serde_json::json!({
        "role": role,
    });
    if !message.content.is_empty() {
        out["content"] = Value::String(message.content.clone());
    }
    if !message.tool_call_id.is_empty() {
        out["tool_call_id"] = Value::String(message.tool_call_id.clone());
    }
    if !message.tool_calls.is_empty() {
        out["tool_calls"] = Value::Array(
            message
                .tool_calls
                .iter()
                .map(|call| {
                    serde_json::json!({
                        "id": call.id,
                        "type": "function",
                        "function": {
                            "name": call.name,
                            "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".to_string()),
                        }
                    })
                })
                .collect(),
        );
    }
    out
}

fn from_wire_message(wire: MessageWire) -> Message {
    Message {
        role: match wire.role.as_str() {
            "system" => Role::System,
            "user" => Role::User,
            "tool" => Role::Tool,
            _ => Role::Assistant,
        },
        content: wire.content.unwrap_or_default(),
        tool_call_id: wire.tool_call_id.unwrap_or_default(),
        tool_calls: wire
            .tool_calls
            .unwrap_or_default()
            .into_iter()
            .map(|call| ToolCall {
                id: call.id,
                name: call.function.name,
                arguments: serde_json::from_str(&call.function.arguments)
                    .unwrap_or_else(|_| serde_json::json!({ "raw": call.function.arguments })),
            })
            .collect(),
    }
}

fn map_finish_reason(value: &str) -> FinishReason {
    match value {
        "stop" => FinishReason::Stop,
        "tool_calls" => FinishReason::ToolCalls,
        "length" => FinishReason::Length,
        _ => FinishReason::Other,
    }
}

#[derive(Debug, Deserialize)]
struct ChatResponseWire {
    choices: Vec<ChoiceWire>,
    usage: Option<UsageWire>,
}

#[derive(Debug, Deserialize)]
struct ChoiceWire {
    message: MessageWire,
    #[serde(default)]
    finish_reason: String,
}

#[derive(Debug, Deserialize)]
struct MessageWire {
    role: String,
    content: Option<String>,
    tool_calls: Option<Vec<ToolCallWire>>,
    tool_call_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ToolCallWire {
    id: String,
    function: ToolCallFunctionWire,
}

#[derive(Debug, Deserialize)]
struct ToolCallFunctionWire {
    name: String,
    arguments: String,
}

#[derive(Debug, Deserialize, Default)]
struct UsageWire {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    completion_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
}

impl From<UsageWire> for Usage {
    fn from(value: UsageWire) -> Self {
        Self {
            prompt_tokens: value.prompt_tokens,
            completion_tokens: value.completion_tokens,
            total_tokens: value.total_tokens,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assistant_tool_call_round_trips_to_openai_wire() {
        let msg = Message {
            role: Role::Assistant,
            content: String::new(),
            tool_call_id: String::new(),
            tool_calls: vec![ToolCall {
                id: "call_1".to_string(),
                name: "finish".to_string(),
                arguments: serde_json::json!({"summary":"done"}),
            }],
        };

        let wire = to_wire_message(&msg);
        assert_eq!(wire["tool_calls"][0]["function"]["name"], "finish");
        assert_eq!(
            wire["tool_calls"][0]["function"]["arguments"],
            "{\"summary\":\"done\"}"
        );
    }
}
