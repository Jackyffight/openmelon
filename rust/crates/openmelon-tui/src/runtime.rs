use anyhow::{Context, Result};
use serde_json::Value;

use crate::llm::{ChatRequest, FinishReason, Message, OpenAIClient, Role, ToolCall, Usage};
use crate::render::{render_block, Block, BlockKind};
use crate::tools::{ToolEnv, ToolRegistry};

pub struct Runtime {
    pub llm: OpenAIClient,
    pub registry: ToolRegistry,
    pub env: ToolEnv,
    pub max_steps: usize,
    pub reasoning_effort: String,
}

pub struct RunInput {
    pub system_prompt: String,
    pub user_input: String,
    pub history: Vec<Message>,
}

pub struct RunResult {
    pub messages: Vec<Message>,
    pub steps: usize,
    pub finished: bool,
    pub finish_summary: String,
    pub finish_artifacts: Vec<String>,
}

impl Runtime {
    pub fn run(&self, input: RunInput) -> Result<RunResult> {
        let mut messages = if input.history.is_empty() {
            let mut seeded = Vec::new();
            if !input.system_prompt.trim().is_empty() {
                seeded.push(Message {
                    role: Role::System,
                    content: input.system_prompt,
                    tool_calls: Vec::new(),
                    tool_call_id: String::new(),
                });
            }
            seeded
        } else {
            input.history
        };
        if !input.user_input.trim().is_empty() {
            messages.push(Message {
                role: Role::User,
                content: input.user_input,
                tool_calls: Vec::new(),
                tool_call_id: String::new(),
            });
        }

        let mut result = RunResult {
            messages: Vec::new(),
            steps: 0,
            finished: false,
            finish_summary: String::new(),
            finish_artifacts: Vec::new(),
        };

        let max_steps = self.max_steps.max(1);
        for step in 0..max_steps {
            result.steps = step + 1;
            println!();
            println!("{}", crate::render::divider(88));
            println!(
                "turn {} -> {}:{}",
                step + 1,
                self.llm.provider(),
                self.llm.model()
            );

            let response = self
                .llm
                .chat(ChatRequest {
                    messages: messages.clone(),
                    tools: self.registry.specs(),
                    reasoning_effort: self.reasoning_effort.clone(),
                })
                .with_context(|| format!("runtime chat step {}", step + 1))?;

            if !response.message.content.trim().is_empty() {
                println!(
                    "{}",
                    render_block(
                        &Block {
                            kind: BlockKind::Assistant,
                            body: response.message.content.clone(),
                        },
                        88,
                    )
                );
            }
            render_usage(response.usage);

            let tool_calls = response.message.tool_calls.clone();
            messages.push(response.message);
            if tool_calls.is_empty() {
                result.finished = matches!(
                    response.finish_reason,
                    FinishReason::Stop | FinishReason::Other
                );
                result.messages = messages;
                return Ok(result);
            }

            for call in tool_calls {
                println!(
                    "{}",
                    render_block(
                        &Block {
                            kind: BlockKind::Tool,
                            body: format!("{} {}", call.name, one_line_json(&call.arguments)),
                        },
                        88,
                    )
                );
                let (content, dispatch_err) =
                    match self
                        .registry
                        .dispatch(&self.env, &call.name, call.arguments.clone())
                    {
                        Ok(value) => (value, None),
                        Err(err) => (
                            serde_json::json!({ "error": err.to_string() }),
                            Some(err.to_string()),
                        ),
                    };
                if let Some(err) = dispatch_err {
                    println!(
                        "{}",
                        render_block(
                            &Block {
                                kind: BlockKind::Error,
                                body: err,
                            },
                            88,
                        )
                    );
                } else if call.name == "finish" {
                    if let Some(summary) = content.get("summary").and_then(Value::as_str) {
                        result.finish_summary = summary.to_string();
                    }
                    if let Some(artifacts) = content.get("artifacts").and_then(Value::as_array) {
                        result.finish_artifacts = artifacts
                            .iter()
                            .filter_map(|v| v.as_str().map(ToString::to_string))
                            .collect();
                    }
                    println!(
                        "{}",
                        render_block(
                            &Block {
                                kind: BlockKind::Assistant,
                                body: result.finish_summary.clone(),
                            },
                            88,
                        )
                    );
                } else {
                    println!("  {}", summarize_tool_result(&call, &content));
                }

                messages.push(Message {
                    role: Role::Tool,
                    content: serde_json::to_string(&content)?,
                    tool_calls: Vec::new(),
                    tool_call_id: call.id,
                });

                if call.name == "finish" {
                    result.finished = true;
                    result.messages = messages;
                    return Ok(result);
                }
            }
        }

        result.messages = messages;
        Ok(result)
    }
}

fn render_usage(usage: Usage) {
    if usage.total_tokens > 0 {
        println!(
            "usage: prompt={} completion={} total={}",
            usage.prompt_tokens, usage.completion_tokens, usage.total_tokens
        );
    }
}

fn one_line_json(value: &Value) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "<invalid json>".to_string())
        .chars()
        .take(240)
        .collect()
}

fn summarize_tool_result(call: &ToolCall, value: &Value) -> String {
    if let Some(err) = value.get("error").and_then(Value::as_str) {
        return format!("error: {err}");
    }
    match call.name.as_str() {
        "generate_image" | "save_artifact" => value
            .get("path")
            .and_then(Value::as_str)
            .map(|path| format!("path: {path}"))
            .unwrap_or_else(|| "done".to_string()),
        "read_file" => value
            .get("content")
            .and_then(Value::as_str)
            .map(|text| format!("{} chars", text.chars().count()))
            .unwrap_or_else(|| "done".to_string()),
        _ => serde_json::to_string(value)
            .unwrap_or_else(|_| "done".to_string())
            .chars()
            .take(180)
            .collect(),
    }
}
