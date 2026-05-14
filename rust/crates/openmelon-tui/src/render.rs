use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::llm::{Message, Role, ToolCall};

const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const RED: &str = "\x1b[31m";
const GREEN: &str = "\x1b[32m";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockKind {
    Assistant,
    Tool,
    Error,
}

#[derive(Debug, Clone)]
pub struct Block {
    pub kind: BlockKind,
    pub body: String,
}

pub fn divider(width: usize) -> String {
    let len = width.clamp(24, 100);
    format!("{}{}{}", DIM, "─".repeat(len), RESET)
}

pub fn history_rule(label: &str, width: usize) -> String {
    let width = width.clamp(28, 160);
    let text = format!(" {label} ");
    let remaining = width.saturating_sub(text.chars().count());
    if remaining < 4 {
        return format!("{DIM}── {label}{RESET}");
    }
    let left = remaining / 2;
    let right = remaining - left;
    format!(
        "{DIM}{}{}{}{RESET}",
        "─".repeat(left),
        text,
        "─".repeat(right)
    )
}

pub fn render_block(block: &Block, width: usize) -> String {
    let mut out = String::new();

    match block.kind {
        BlockKind::Assistant => {
            out.push_str(&render_markdown(&block.body, width));
        }
        BlockKind::Tool => {
            out.push_str(&render_prefixed(&block.body, &format!("{GREEN}● {RESET}")));
        }
        BlockKind::Error => {
            out.push_str(RED);
            out.push_str(&render_prefixed(&block.body, ""));
            out.push_str(RESET);
        }
    }

    out
}

#[derive(Debug, Clone, Copy)]
pub enum TranscriptMode {
    Styled,
    Plain,
}

pub fn render_history(messages: &[Message], width: usize, mode: TranscriptMode) -> String {
    if messages.is_empty() {
        return String::new();
    }
    let mut out = String::new();
    out.push('\n');
    push_line(
        &mut out,
        &history_rule(
            &format!("prior conversation ({} messages)", messages.len()),
            width,
        ),
    );

    let mut tool_names = std::collections::BTreeMap::<String, String>::new();
    let mut wrote = false;
    for message in messages {
        if let Some(block) = render_history_message(message, &mut tool_names, width, mode) {
            if wrote && !block.starts_with("  └") && !block.starts_with("└") {
                out.push('\n');
            }
            out.push_str(&block);
            if !block.ends_with('\n') {
                out.push('\n');
            }
            wrote = true;
        }
    }

    push_line(&mut out, &history_rule("continue below", width));
    out
}

pub fn render_plain_transcript(messages: &[Message], width: usize) -> String {
    render_history(messages, width, TranscriptMode::Plain)
}

fn render_history_message(
    message: &Message,
    tool_names: &mut std::collections::BTreeMap<String, String>,
    width: usize,
    mode: TranscriptMode,
) -> Option<String> {
    match message.role {
        Role::System => None,
        Role::User => Some(render_user_message(&message.content)),
        Role::Assistant => {
            let mut out = String::new();
            if !message.content.trim().is_empty() {
                out.push_str(&render_markdown_block(&message.content, " ", width, mode));
                out.push('\n');
            }
            for call in &message.tool_calls {
                if !call.id.is_empty() {
                    tool_names.insert(call.id.clone(), call.name.clone());
                }
                if call.name != "finish" {
                    out.push_str(&render_tool_call(call, mode));
                    out.push('\n');
                }
            }
            (!out.trim().is_empty()).then_some(out.trim_end().to_string())
        }
        Role::Tool => {
            let tool_name = tool_names
                .get(&message.tool_call_id)
                .map(String::as_str)
                .unwrap_or("");
            if tool_name == "finish" {
                Some(render_finish_result(&message.content, width, mode))
            } else {
                Some(render_tool_result(tool_name, &message.content, mode))
            }
        }
    }
}

pub fn render_user_message(content: &str) -> String {
    let mut out = String::new();
    let mut lines = content.lines();
    if let Some(first) = lines.next() {
        push_line(&mut out, &format!("> {first}"));
        for line in lines {
            push_line(&mut out, &format!("  {line}"));
        }
    } else {
        push_line(&mut out, ">");
    }
    out.trim_end().to_string()
}

pub fn render_tool_call(call: &ToolCall, mode: TranscriptMode) -> String {
    if call.name == "finish" {
        return String::new();
    }
    let name = match mode {
        TranscriptMode::Styled => format!("{BOLD}{}{RESET}", call.name),
        TranscriptMode::Plain => call.name.clone(),
    };
    let dot = match mode {
        TranscriptMode::Styled => format!("{GREEN}●{RESET}"),
        TranscriptMode::Plain => "●".to_string(),
    };
    let summary = tool_call_summary(call);
    if summary.is_empty() {
        format!("{dot} {name}")
    } else {
        let summary = match mode {
            TranscriptMode::Styled => format!("{DIM}{summary}{RESET}"),
            TranscriptMode::Plain => summary,
        };
        format!("{dot} {name}  {summary}")
    }
}

pub fn render_tool_result(tool_name: &str, content: &str, mode: TranscriptMode) -> String {
    let body = if let Some(err) = tool_error_message(content) {
        match mode {
            TranscriptMode::Styled => format!("{RED}└ error: {err}{RESET}"),
            TranscriptMode::Plain => format!("└ error: {err}"),
        }
    } else {
        format!("└ {}", tool_result_summary(tool_name, content))
    };
    format!("  {body}")
}

pub fn render_finish_result(content: &str, width: usize, mode: TranscriptMode) -> String {
    if let Some(err) = tool_error_message(content) {
        return match mode {
            TranscriptMode::Styled => format!(" {RED}error: {err}{RESET}"),
            TranscriptMode::Plain => format!(" error: {err}"),
        };
    }
    let Some(obj) = json_object_str(content) else {
        return render_markdown_block(content, " ", width, mode);
    };
    let mut out = String::new();
    let summary = string_field(&obj, "summary");
    if !summary.is_empty() {
        out.push_str(&render_markdown_block(&summary, " ", width, mode));
    }
    let artifacts = artifact_strings(&obj);
    if !artifacts.is_empty() {
        if !out.trim().is_empty() {
            out.push('\n');
        }
        for path in artifacts {
            push_line(&mut out, &format!(" artifact: {path}"));
        }
    }
    out.trim_end().to_string()
}

pub fn render_markdown_block(
    markdown: &str,
    prefix: &str,
    width: usize,
    mode: TranscriptMode,
) -> String {
    let body = match mode {
        TranscriptMode::Styled => render_markdown(markdown, width),
        TranscriptMode::Plain => strip_ansi(&render_markdown(markdown, width)),
    };
    body.lines()
        .map(|line| format!("{prefix}{line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn flush_markdown_buffer(
    buffer: &mut String,
    force: bool,
    width: usize,
    mode: TranscriptMode,
) -> Option<String> {
    if buffer.is_empty() {
        return None;
    }
    if !force && !has_stable_markdown_boundary(buffer) {
        return None;
    }
    let raw = buffer.trim_end_matches('\n').to_string();
    buffer.clear();
    if raw.trim().is_empty() {
        return None;
    }
    Some(render_markdown_block(&raw, " ", width, mode))
}

pub fn has_stable_markdown_boundary(raw: &str) -> bool {
    raw.trim_end_matches([' ', '\t']).ends_with("\n\n")
}

pub fn render_markdown(markdown: &str, _width: usize) -> String {
    let mut out = String::new();
    let mut in_code = false;

    for raw in markdown.lines() {
        let line = raw.trim_end();
        if let Some(rendered) = render_markdown_line(line, &mut in_code) {
            out.push_str(&rendered);
            out.push('\n');
        }
    }

    out.trim_end().to_string()
}

fn render_markdown_line(line: &str, in_code: &mut bool) -> Option<String> {
    if line.trim_start().starts_with("```") {
        *in_code = !*in_code;
        return None;
    }

    if *in_code {
        return Some(format!("{DIM}{}{}", render_prefixed(line, "    "), RESET));
    }

    if line.is_empty() {
        return Some(String::new());
    }

    if let Some(title) = heading_text(line) {
        return Some(format!("{BOLD}{}{}", strip_inline_marks(title), RESET));
    }

    if let Some(item) = list_item(line) {
        return Some(format!("- {}", strip_inline_marks(item)));
    }

    if let Some(quote) = line.strip_prefix("> ") {
        return Some(format!("{DIM}> {}{}", strip_inline_marks(quote), RESET));
    }

    Some(strip_inline_marks(line))
}

fn render_prefixed(text: &str, prefix: &str) -> String {
    text.lines()
        .map(|line| format!("{prefix}{line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn heading_text(line: &str) -> Option<&str> {
    let level = line.chars().take_while(|ch| *ch == '#').count();

    if !(1..=6).contains(&level) {
        return None;
    }

    let title = line[level..].trim_start();
    (!title.is_empty()).then_some(title)
}

fn list_item(line: &str) -> Option<&str> {
    line.strip_prefix("- ")
        .or_else(|| line.strip_prefix("* "))
        .or_else(|| line.strip_prefix("+ "))
}

fn strip_inline_marks(text: &str) -> String {
    text.replace("**", "").replace('`', "")
}

pub fn tool_call_summary(call: &ToolCall) -> String {
    let Some(obj) = call.arguments.as_object() else {
        return truncate_one_line(&call.arguments.to_string(), 120);
    };
    match call.name.as_str() {
        "generate_image" => join_summary_parts(&[
            string_field_value(obj.get("label")),
            string_field_value(obj.get("size")),
            short_field_value(obj.get("prompt"), 110),
            count_field_value(obj.get("reference_images"), "refs"),
        ]),
        "save_artifact" => join_summary_parts(&[
            string_field_value(obj.get("slug")),
            short_path(&string_field_value(obj.get("image_path"))),
        ]),
        "register_asset" => join_summary_parts(&[
            string_field_value(obj.get("space_id")),
            first_non_empty(&[
                string_field_value(obj.get("id")),
                string_field_value(obj.get("kind")),
            ]),
            short_field_value(obj.get("description"), 90),
        ]),
        "get_context_packet" => join_summary_parts(&[
            string_field_value(obj.get("space_id")),
            short_field_value(obj.get("query"), 100),
        ]),
        "bash" => join_summary_parts(&[
            short_field_value(obj.get("command"), 110),
            short_field_value(obj.get("description"), 80),
        ]),
        "read_file" | "get_character" | "get_reference" => first_non_empty(&[
            string_field_value(obj.get("path")),
            string_field_value(obj.get("slug")),
        ]),
        "search" | "list_spaces" | "list_characters" | "list_references" => {
            short_field_value(obj.get("query"), 100)
        }
        "create_space"
        | "activate_space"
        | "record_decision"
        | "record_feedback"
        | "record_memory_item"
        | "promote_memory_item"
        | "create_episode"
        | "update_asset_weight"
        | "record_compaction"
        | "compile_skill" => fallback_arg_summary(obj, &call.arguments),
        "finish" => short_field_value(obj.get("summary"), 110),
        _ => fallback_arg_summary(obj, &call.arguments),
    }
}

pub fn tool_result_summary(tool_name: &str, content: &str) -> String {
    if content.trim().is_empty() {
        return "(no output)".to_string();
    }
    if tool_name == "finish" {
        if let Some(obj) = json_object_str(content) {
            return join_summary_parts(&[
                truncate_one_line(&string_field(&obj, "summary"), 120),
                artifacts_count(&obj),
            ]);
        }
    }
    if let Some(obj) = json_object_str(content) {
        if let Some(summary) = tool_result_object_summary(tool_name, &obj) {
            return summary;
        }
        let path = string_field(&obj, "path");
        if !path.is_empty() {
            return match tool_name {
                "generate_image" => format!("saved {}", short_path(&path)),
                "save_artifact" => format!("artifact {}", short_path(&path)),
                _ => short_path(&path),
            };
        }
        let id = string_field(&obj, "id");
        if !id.is_empty() {
            return format!("ok {id}");
        }
        let summary = string_field(&obj, "summary");
        if !summary.is_empty() {
            return truncate_one_line(&summary, 140);
        }
        if let Some(ok) = obj.get("ok") {
            return format!("ok {ok}");
        }
    }
    if let Some(arr) = json_array_objects(content) {
        if matches!(
            tool_name,
            "search" | "list_spaces" | "list_characters" | "list_references"
        ) {
            return format!("{} item(s)", arr.len());
        }
        if let Some(first) = arr.first() {
            let path = string_field(first, "path");
            if !path.is_empty() {
                if arr.len() == 1 {
                    return format!("saved {}", short_path(&path));
                }
                return format!("saved {} files, first {}", arr.len(), short_path(&path));
            }
            let id = string_field(first, "id");
            if !id.is_empty() {
                if arr.len() == 1 {
                    return format!("ok {id}");
                }
                return format!("ok {} items, first {id}", arr.len());
            }
        }
    }
    truncate_one_line(content, 180)
}

fn tool_result_object_summary(
    tool_name: &str,
    obj: &serde_json::Map<String, Value>,
) -> Option<String> {
    match tool_name {
        "get_context_packet" => {
            let space_id = obj
                .get("space")
                .and_then(Value::as_object)
                .map(|space| string_field(space, "id"))
                .filter(|id| !id.is_empty())
                .or_else(|| {
                    let id = string_field(obj, "project_id");
                    (!id.is_empty()).then_some(id)
                })
                .unwrap_or_else(|| "context".to_string());
            let assets = array_len(obj.get("assets"));
            let decisions = array_len(obj.get("recent_decisions"));
            let feedback = array_len(obj.get("recent_feedback"));
            let episodes = array_len(obj.get("recent_episodes"));
            return Some(join_summary_parts(&[
                space_id,
                count_text(assets, "asset(s)"),
                count_text(episodes, "episode(s)"),
                count_text(decisions, "decision(s)"),
                count_text(feedback, "feedback"),
            ]));
        }
        "bash" => {
            let exit = obj
                .get("exit_code")
                .map(|value| string_field_value(Some(value)))
                .unwrap_or_default();
            let stdout_len = obj
                .get("stdout")
                .and_then(Value::as_str)
                .map(|s| s.chars().count())
                .unwrap_or(0);
            let stderr = obj
                .get("stderr")
                .and_then(Value::as_str)
                .map(truncate_error)
                .unwrap_or_default();
            let mut parts = vec![format!(
                "exit {}",
                if exit.is_empty() { "0" } else { &exit }
            )];
            if stdout_len > 0 {
                parts.push(format!("{stdout_len} stdout chars"));
            }
            if !stderr.is_empty() {
                parts.push(format!("stderr {stderr}"));
            }
            return Some(join_summary_parts(&parts));
        }
        "read_file" => {
            let path = string_field(obj, "path");
            let chars = obj
                .get("content")
                .and_then(Value::as_str)
                .map(|s| s.chars().count())
                .unwrap_or(0);
            return Some(join_summary_parts(&[
                short_path(&path),
                count_text(chars, "char(s)"),
            ]));
        }
        "create_space" => {
            return Some(join_summary_parts(&[
                string_field(obj, "id"),
                string_field(obj, "status"),
            ]));
        }
        "activate_space" => {
            let id = obj
                .get("space")
                .and_then(Value::as_object)
                .map(|space| string_field(space, "id"))
                .unwrap_or_default();
            return Some(join_summary_parts(&["active".to_string(), id]));
        }
        "record_decision" | "promote_memory_item" => {
            return Some(join_summary_parts(&[
                string_field(obj, "id"),
                short_field_value(obj.get("decision"), 100),
            ]));
        }
        "record_feedback" => {
            return Some(join_summary_parts(&[
                string_field(obj, "id"),
                string_field(obj, "signal"),
            ]));
        }
        "record_memory_item" => {
            return Some(join_summary_parts(&[
                string_field(obj, "id"),
                string_field(obj, "kind"),
                string_field(obj, "status"),
            ]));
        }
        "create_episode" => {
            return Some(join_summary_parts(&[
                string_field(obj, "id"),
                string_field(obj, "status"),
            ]));
        }
        "update_asset_weight" => {
            return Some(join_summary_parts(&[
                string_field(obj, "id"),
                string_field(obj, "status"),
                obj.get("weight")
                    .map(|value| string_field_value(Some(value)))
                    .unwrap_or_default(),
            ]));
        }
        "record_compaction" => {
            return Some(join_summary_parts(&[
                string_field(obj, "id"),
                short_field_value(obj.get("summary"), 100),
            ]));
        }
        "compile_skill" => {
            return Some(join_summary_parts(&[
                string_field(obj, "skill"),
                count_text(
                    obj.get("prompt")
                        .and_then(Value::as_str)
                        .map(|s| s.chars().count())
                        .unwrap_or(0),
                    "prompt chars",
                ),
            ]));
        }
        _ => {}
    }
    None
}

pub fn tool_error_message(content: &str) -> Option<String> {
    let obj = json_object_str(content)?;
    let err = obj.get("error")?;
    let msg = string_field_value(Some(err));
    (!msg.is_empty()).then_some(msg)
}

fn json_object_str(content: &str) -> Option<serde_json::Map<String, Value>> {
    serde_json::from_str::<Value>(content)
        .ok()
        .and_then(|value| value.as_object().cloned())
}

fn json_array_objects(content: &str) -> Option<Vec<serde_json::Map<String, Value>>> {
    serde_json::from_str::<Value>(content)
        .ok()
        .and_then(|value| value.as_array().cloned())
        .map(|items| {
            items
                .into_iter()
                .filter_map(|value| value.as_object().cloned())
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty())
}

fn string_field(obj: &serde_json::Map<String, Value>, key: &str) -> String {
    string_field_value(obj.get(key))
}

fn string_field_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(v)) => v.to_string(),
        Some(other) => other.to_string(),
        None => String::new(),
    }
}

fn short_field_value(value: Option<&Value>, limit: usize) -> String {
    truncate_one_line(&string_field_value(value), limit)
}

fn count_field_value(value: Option<&Value>, label: &str) -> String {
    match value {
        Some(Value::Array(items)) if !items.is_empty() => format!("{} {label}", items.len()),
        _ => String::new(),
    }
}

fn array_len(value: Option<&Value>) -> usize {
    value.and_then(Value::as_array).map(Vec::len).unwrap_or(0)
}

fn count_text(count: usize, label: &str) -> String {
    if count == 0 {
        String::new()
    } else {
        format!("{count} {label}")
    }
}

fn fallback_arg_summary(obj: &serde_json::Map<String, Value>, raw: &Value) -> String {
    for key in [
        "name",
        "id",
        "title",
        "space_id",
        "query",
        "path",
        "command",
        "summary",
        "description",
    ] {
        let value = short_field_value(obj.get(key), 100);
        if !value.is_empty() {
            return value;
        }
    }
    truncate_one_line(&raw.to_string(), 120)
}

fn artifact_strings(obj: &serde_json::Map<String, Value>) -> Vec<String> {
    match obj.get("artifacts") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| string_field_value(Some(item)))
            .filter(|item| !item.is_empty())
            .collect(),
        _ => Vec::new(),
    }
}

fn artifacts_count(obj: &serde_json::Map<String, Value>) -> String {
    let count = artifact_strings(obj).len();
    if count == 0 {
        String::new()
    } else {
        format!("{count} artifact(s)")
    }
}

fn join_summary_parts(parts: &[String]) -> String {
    parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" · ")
}

fn first_non_empty(parts: &[String]) -> String {
    parts
        .iter()
        .find(|part| !part.trim().is_empty())
        .cloned()
        .unwrap_or_default()
}

fn short_path(path: &str) -> String {
    let path = path.trim();
    if path.is_empty() {
        return String::new();
    }
    let path = PathBuf::from(path);
    let base = path
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    let dir = path
        .parent()
        .and_then(Path::file_name)
        .and_then(|v| v.to_str())
        .unwrap_or_default();
    if dir.is_empty() {
        base.to_string()
    } else {
        format!("{dir}/{base}")
    }
}

fn truncate_one_line(value: &str, limit: usize) -> String {
    let line = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= limit {
        return line;
    }
    let mut out = line.chars().take(limit).collect::<String>();
    out.push('…');
    out
}

fn truncate_error(value: &str) -> String {
    truncate_one_line(value, 80)
}

fn push_line(out: &mut String, line: &str) {
    out.push_str(line);
    out.push('\n');
}

fn strip_ansi(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' && chars.peek() == Some(&'[') {
            let _ = chars.next();
            for c in chars.by_ref() {
                if c.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_renderer_preserves_blocks() {
        let rendered = render_markdown("# Title\n\n- one\n- two", 40);

        assert!(rendered.contains("Title"));
        assert!(rendered.contains("- one"));
        assert!(rendered.contains("- two"));
    }

    #[test]
    fn tool_block_indents_body_after_marker() {
        let rendered = render_block(
            &Block {
                kind: BlockKind::Tool,
                body: "tool output".to_string(),
            },
            40,
        );

        assert!(rendered.contains("● "));
        assert!(rendered.contains("tool output"));
    }

    #[test]
    fn tool_call_renderer_matches_go_semantics() {
        let call = ToolCall {
            id: "call-1".to_string(),
            name: "save_artifact".to_string(),
            arguments: serde_json::json!({
                "slug": "ep-002-mothers-day",
                "image_path": "/home/wangzhi.wit/bigone/.openmelon/artifacts/ep-002-mothers-day/20260512-032739/image.png",
                "sha256": "should-not-leak-into-ui",
            }),
        };

        let rendered = render_tool_call(&call, TranscriptMode::Plain);

        assert!(rendered.contains("● save_artifact"));
        assert!(rendered.contains("ep-002-mothers-day"));
        assert!(rendered.contains("20260512-032739/image.png"));
        assert!(!rendered.contains("sha256"));
        assert!(!rendered.contains('{'));
    }

    #[test]
    fn tool_result_renderer_summarizes_artifacts() {
        let rendered = render_tool_result(
            "save_artifact",
            r#"{"path":"/home/wangzhi.wit/bigone/outputs/ep-002/20260512-032739/image.png","sha256":"abc"}"#,
            TranscriptMode::Plain,
        );

        assert_eq!(rendered, "  └ artifact 20260512-032739/image.png");
    }

    #[test]
    fn finish_result_renders_as_assistant_text() {
        let rendered = render_finish_result(
            r#"{"summary":"Done with **three** images.","artifacts":["/tmp/a.png"]}"#,
            88,
            TranscriptMode::Plain,
        );

        assert!(rendered.contains(" Done with three images."));
        assert!(rendered.contains(" artifact: /tmp/a.png"));
        assert!(!rendered.contains("tool finish"));
    }

    #[test]
    fn history_renderer_maps_tool_ids_and_skips_finish_call() {
        let history = vec![
            Message {
                role: Role::User,
                content: "继续".to_string(),
                tool_calls: Vec::new(),
                tool_call_id: String::new(),
            },
            Message {
                role: Role::Assistant,
                content: String::new(),
                tool_calls: vec![
                    ToolCall {
                        id: "call-save".to_string(),
                        name: "save_artifact".to_string(),
                        arguments: serde_json::json!({
                            "slug": "ep-002",
                            "image_path": "/home/wangzhi.wit/bigone/outputs/ep-002/page-1.png",
                        }),
                    },
                    ToolCall {
                        id: "call-finish".to_string(),
                        name: "finish".to_string(),
                        arguments: serde_json::json!({"summary":"ok"}),
                    },
                ],
                tool_call_id: String::new(),
            },
            Message {
                role: Role::Tool,
                content: r#"{"path":"/home/wangzhi.wit/bigone/outputs/ep-002/page-1.png"}"#
                    .to_string(),
                tool_calls: Vec::new(),
                tool_call_id: "call-save".to_string(),
            },
            Message {
                role: Role::Tool,
                content: r#"{"summary":"完成","artifacts":["/tmp/page-1.png"]}"#.to_string(),
                tool_calls: Vec::new(),
                tool_call_id: "call-finish".to_string(),
            },
        ];

        let rendered = render_history(&history, 88, TranscriptMode::Plain);

        assert!(rendered.contains("prior conversation (4 messages)"));
        assert!(rendered.contains("> 继续"));
        assert!(rendered.contains("● save_artifact"));
        assert!(rendered.contains("└ artifact ep-002/page-1.png"));
        assert!(rendered.contains(" 完成"));
        assert!(rendered.contains("continue below"));
        assert!(!rendered.contains("● finish"));
        assert!(!rendered.contains("sha256"));
    }

    #[test]
    fn context_and_bash_results_have_product_summaries() {
        let context = render_tool_result(
            "get_context_packet",
            r#"{"project_id":"bigone","space":{"id":"restaurant-daily-comics"},"assets":[{},{}],"recent_episodes":[{}],"recent_decisions":[{},{}],"recent_feedback":[{}],"canon":"long text"}"#,
            TranscriptMode::Plain,
        );
        let bash = render_tool_result(
            "bash",
            r#"{"exit_code":0,"stdout":"abc\n","stderr":"","approved_via":"user-approved"}"#,
            TranscriptMode::Plain,
        );

        assert_eq!(
            context,
            "  └ restaurant-daily-comics · 2 asset(s) · 1 episode(s) · 2 decision(s) · 1 feedback"
        );
        assert_eq!(bash, "  └ exit 0 · 4 stdout chars");
        assert!(!context.contains("canon"));
        assert!(!bash.contains("approved_via"));
    }

    #[test]
    fn markdown_buffer_waits_for_stable_boundary() {
        let mut buffer = "hello".to_string();

        assert!(flush_markdown_buffer(&mut buffer, false, 88, TranscriptMode::Plain).is_none());
        buffer.push_str("\n\n");
        let rendered = flush_markdown_buffer(&mut buffer, false, 88, TranscriptMode::Plain)
            .expect("stable block");

        assert_eq!(rendered, " hello");
        assert!(buffer.is_empty());
    }
}
