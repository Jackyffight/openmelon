use anyhow::{Context, Result};
use serde_json::Value;
use std::sync::mpsc;

use crate::llm::{ChatRequest, FinishReason, Message, OpenAIClient, Role, ToolCall, Usage};
use crate::render::{
    flush_markdown_buffer, render_finish_result, render_tool_call, render_tool_result,
    TranscriptMode,
};
use crate::session::Session;
use crate::tools::{ToolEnv, ToolRegistry};

pub struct Runtime {
    pub llm: OpenAIClient,
    pub registry: ToolRegistry,
    pub env: ToolEnv,
    pub max_steps: usize,
    pub reasoning_effort: String,
    pub drain_user_input: Option<Box<dyn FnMut() -> Vec<String> + Send>>,
    pub events: Option<mpsc::Sender<RuntimeEvent>>,
}

#[derive(Debug, Clone)]
pub enum RuntimeEvent {
    TurnStart {
        step: usize,
    },
    TextDelta(String),
    ToolCall(ToolCall),
    ToolResult {
        tool_name: String,
        content: String,
        error: Option<String>,
    },
    TurnEnd {
        step: usize,
        finish: FinishReason,
        usage: Usage,
    },
    QueuedInputApplied {
        count: usize,
    },
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
    pub fn run(&mut self, input: RunInput, session: &mut Session) -> Result<RunResult> {
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
            let drained = self.drain_user_input();
            if !drained.is_empty() {
                let count = drained.len();
                for text in drained {
                    messages.push(Message {
                        role: Role::User,
                        content: text,
                        tool_calls: Vec::new(),
                        tool_call_id: String::new(),
                    });
                }
                self.emit(RuntimeEvent::QueuedInputApplied { count });
            }
            self.emit(RuntimeEvent::TurnStart { step: step + 1 });
            session.append_event(
                "turn_start",
                serde_json::json!({
                    "step": step + 1,
                    "status": "started",
                }),
            )?;

            let mut markdown_buffer = String::new();
            let events_tx = self.events.clone();
            let response = self
                .llm
                .stream_chat(
                    ChatRequest {
                        messages: messages.clone(),
                        tools: self.registry.specs(),
                        reasoning_effort: self.reasoning_effort.clone(),
                    },
                    |delta| {
                        if let Some(tx) = &events_tx {
                            let _ = tx.send(RuntimeEvent::TextDelta(delta.to_string()));
                        } else {
                            markdown_buffer.push_str(delta);
                            flush_runtime_markdown(&mut markdown_buffer, false);
                        }
                    },
                )
                .with_context(|| format!("runtime chat step {}", step + 1))?;

            if self.events.is_none() {
                flush_runtime_markdown(&mut markdown_buffer, true);
            }
            session.append_event(
                "turn_response",
                serde_json::json!({
                    "step": step + 1,
                    "status": "received",
                    "detail": {
                        "finish": format!("{:?}", response.finish_reason),
                        "tool_calls": response.message.tool_calls.len(),
                        "usage": {
                            "prompt_tokens": response.usage.prompt_tokens,
                            "completion_tokens": response.usage.completion_tokens,
                            "total_tokens": response.usage.total_tokens,
                        }
                    }
                }),
            )?;

            let tool_calls = response.message.tool_calls.clone();
            let finish_reason = response.finish_reason;
            let usage = response.usage;
            messages.push(response.message);
            if tool_calls.is_empty() {
                self.emit(RuntimeEvent::TurnEnd {
                    step: step + 1,
                    finish: finish_reason,
                    usage,
                });
                result.finished = matches!(finish_reason, FinishReason::Stop | FinishReason::Other);
                result.messages = messages;
                return Ok(result);
            }

            for call in tool_calls {
                session.append_event(
                    "tool_call",
                    serde_json::json!({
                        "step": step + 1,
                        "tool": call.name,
                        "status": "started",
                        "detail": { "arguments": call.arguments },
                    }),
                )?;
                if call.name != "finish" {
                    if self.events.is_some() {
                        self.emit(RuntimeEvent::ToolCall(call.clone()));
                    } else {
                        flush_runtime_markdown(&mut markdown_buffer, true);
                        println!();
                        println!("{}", render_tool_call(&call, TranscriptMode::Styled));
                    }
                }
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
                    let content_for_render =
                        serde_json::json!({ "error": err.clone() }).to_string();
                    if self.events.is_some() {
                        self.emit(RuntimeEvent::ToolResult {
                            tool_name: call.name.clone(),
                            content: content_for_render.clone(),
                            error: Some(err.clone()),
                        });
                    } else {
                        println!(
                            "{}",
                            render_tool_result(
                                &call.name,
                                &content_for_render,
                                TranscriptMode::Styled,
                            )
                        );
                    }
                    session.append_event(
                        "tool_result",
                        serde_json::json!({
                            "step": step + 1,
                            "tool": call.name,
                            "status": "error",
                            "detail": { "error": err },
                        }),
                    )?;
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
                    let finish = serde_json::to_string(&content)?;
                    if self.events.is_some() {
                        self.emit(RuntimeEvent::ToolResult {
                            tool_name: call.name.clone(),
                            content: finish.clone(),
                            error: None,
                        });
                    } else {
                        let rendered = render_finish_result(&finish, 88, TranscriptMode::Styled);
                        if !rendered.trim().is_empty() {
                            println!("{rendered}");
                        }
                    }
                    session.append_event(
                        "tool_result",
                        serde_json::json!({
                            "step": step + 1,
                            "tool": call.name,
                            "status": "ok",
                            "detail": content,
                        }),
                    )?;
                } else {
                    let content_for_render = serde_json::to_string(&content)?;
                    if self.events.is_some() {
                        self.emit(RuntimeEvent::ToolResult {
                            tool_name: call.name.clone(),
                            content: content_for_render.clone(),
                            error: None,
                        });
                    } else {
                        println!(
                            "{}",
                            render_tool_result(
                                &call.name,
                                &content_for_render,
                                TranscriptMode::Styled,
                            )
                        );
                    }
                    session.append_event(
                        "tool_result",
                        serde_json::json!({
                            "step": step + 1,
                            "tool": call.name,
                            "status": if content.get("error").is_some() { "error" } else { "ok" },
                            "detail": content,
                        }),
                    )?;
                }

                messages.push(Message {
                    role: Role::Tool,
                    content: serde_json::to_string(&content)?,
                    tool_calls: Vec::new(),
                    tool_call_id: call.id,
                });

                if call.name == "finish" {
                    self.emit(RuntimeEvent::TurnEnd {
                        step: step + 1,
                        finish: finish_reason,
                        usage,
                    });
                    result.finished = true;
                    result.messages = messages;
                    return Ok(result);
                }
            }
            self.emit(RuntimeEvent::TurnEnd {
                step: step + 1,
                finish: finish_reason,
                usage,
            });
        }

        result.messages = messages;
        Ok(result)
    }

    fn drain_user_input(&mut self) -> Vec<String> {
        let Some(drain) = &mut self.drain_user_input else {
            return Vec::new();
        };
        drain()
            .into_iter()
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty())
            .collect()
    }

    fn emit(&self, event: RuntimeEvent) {
        if let Some(tx) = &self.events {
            let _ = tx.send(event);
        }
    }
}

fn flush_runtime_markdown(buffer: &mut String, force: bool) {
    let Some(rendered) = flush_markdown_buffer(buffer, force, 88, TranscriptMode::Styled) else {
        return;
    };
    if rendered.trim().is_empty() {
        return;
    }
    println!("{rendered}");
    println!();
    let _ = std::io::Write::flush(&mut std::io::stdout());
}
