use std::time::Duration;

use anyhow::{bail, Context, Result};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};

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

    pub fn stream_chat(
        &self,
        request: ChatRequest,
        mut on_text: impl FnMut(&str),
    ) -> Result<ChatResponse> {
        if request.messages.is_empty() {
            bail!("stream chat requires at least one message");
        }

        let mut body = self.chat_body(&request);
        body["stream"] = Value::Bool(true);
        body["stream_options"] = serde_json::json!({ "include_usage": true });

        let url = format!("{}/v1/chat/completions", self.base_url);
        let mut req = self
            .client
            .post(url)
            .bearer_auth(&self.api_key)
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .header("user-agent", user_agent());
        if self.provider == "openrouter" {
            req = req
                .header(
                    "HTTP-Referer",
                    "https://github.com/eight-acres-lab/openmelon",
                )
                .header("X-Title", "openmelon");
        }

        let resp = req.json(&body).send().context("send stream chat request")?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().unwrap_or_default();
            bail!("llm[{}]: HTTP {}: {}", self.provider, status.as_u16(), text);
        }

        let mut text = String::new();
        let mut tool_calls: BTreeMap<usize, PartialToolCall> = BTreeMap::new();
        let mut finish_reason = FinishReason::Other;
        let mut usage = Usage::default();

        read_sse(resp, |event| {
            if event.data == "[DONE]" {
                return Ok(false);
            }
            let chunk: StreamChunkWire = serde_json::from_str(&event.data)
                .with_context(|| format!("parse stream chunk: {}", event.data))?;
            if let Some(u) = chunk.usage {
                usage = u.into();
            }
            let Some(choice) = chunk.choices.into_iter().next() else {
                return Ok(true);
            };
            if let Some(delta) = choice.delta.content {
                if !delta.is_empty() {
                    text.push_str(&delta);
                    on_text(&delta);
                }
            }
            for call in choice.delta.tool_calls.unwrap_or_default() {
                let entry = tool_calls.entry(call.index).or_default();
                if let Some(id) = call.id {
                    if !id.is_empty() {
                        entry.id = id;
                    }
                }
                if let Some(function) = call.function {
                    if let Some(name) = function.name {
                        if !name.is_empty() {
                            entry.name = name;
                        }
                    }
                    if let Some(arguments) = function.arguments {
                        entry.arguments.push_str(&arguments);
                    }
                }
            }
            if let Some(reason) = choice.finish_reason {
                finish_reason = map_finish_reason(&reason);
            }
            Ok(true)
        })?;

        let calls = tool_calls
            .into_values()
            .map(|partial| ToolCall {
                id: partial.id,
                name: partial.name,
                arguments: if partial.arguments.trim().is_empty() {
                    serde_json::json!({})
                } else {
                    serde_json::from_str(&partial.arguments)
                        .unwrap_or_else(|_| serde_json::json!({ "raw": partial.arguments }))
                },
            })
            .collect();

        Ok(ChatResponse {
            message: Message {
                role: Role::Assistant,
                content: text,
                tool_call_id: String::new(),
                tool_calls: calls,
            },
            finish_reason,
            usage,
        })
    }

    fn chat_body(&self, request: &ChatRequest) -> Value {
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
        body
    }
}

fn user_agent() -> String {
    format!(
        "openmelon-tui/{} ({}; {})",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
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

fn map_finish_reason(value: &str) -> FinishReason {
    match value {
        "stop" => FinishReason::Stop,
        "tool_calls" => FinishReason::ToolCalls,
        "length" => FinishReason::Length,
        _ => FinishReason::Other,
    }
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

#[derive(Debug, Default)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
}

struct SseEvent {
    data: String,
}

fn read_sse(
    response: reqwest::blocking::Response,
    mut on_event: impl FnMut(SseEvent) -> Result<bool>,
) -> Result<()> {
    let mut reader = BufReader::new(response);
    let mut line = String::new();
    let mut data = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            if !data.is_empty() {
                let _ = on_event(SseEvent { data })?;
            }
            return Ok(());
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            if !data.is_empty() {
                let keep_going = on_event(SseEvent { data: data.clone() })?;
                data.clear();
                if !keep_going {
                    return Ok(());
                }
            }
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("data:") {
            if !data.is_empty() {
                data.push('\n');
            }
            data.push_str(rest.trim());
        }
    }
}

#[derive(Debug, Deserialize)]
struct StreamChunkWire {
    #[serde(default)]
    choices: Vec<StreamChoiceWire>,
    usage: Option<UsageWire>,
}

#[derive(Debug, Deserialize)]
struct StreamChoiceWire {
    #[serde(default)]
    delta: StreamDeltaWire,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct StreamDeltaWire {
    content: Option<String>,
    tool_calls: Option<Vec<StreamToolCallWire>>,
}

#[derive(Debug, Deserialize)]
struct StreamToolCallWire {
    index: usize,
    id: Option<String>,
    function: Option<StreamToolCallFunctionWire>,
}

#[derive(Debug, Deserialize)]
struct StreamToolCallFunctionWire {
    name: Option<String>,
    arguments: Option<String>,
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
