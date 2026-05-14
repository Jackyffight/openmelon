use std::collections::VecDeque;
use std::io::{self, Read, Write};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use super::{
    build_project_system_prompt, effective_bash_mode, empty_as_auto, empty_as_none,
    render_compaction_draft, App,
};
use crate::config::{load_user_config, resolve_provider};
use crate::image::ImageGenerator;
use crate::llm::{Message, OpenAIClient};
use crate::project::{set_project_default, set_project_setting};
use crate::render::{
    history_rule, render_finish_result, render_markdown, render_plain_transcript,
    render_tool_result, render_user_message, tool_call_summary, TranscriptMode,
};
use crate::runtime::{RunInput, RunResult, Runtime, RuntimeEvent};
use crate::session::{load_events, Session};
use crate::tools::{channel_approval_fn, ApprovalDecision, ApprovalRequest, ToolEnv, ToolRegistry};

const RESET: &str = "\x1b[0m";
const BOLD: &str = "\x1b[1m";
const DIM: &str = "\x1b[2m";
const RED: &str = "\x1b[31m";
const GREEN: &str = "\x1b[32m";
const CYAN: &str = "\x1b[36m";
const CLEAR: &str = "\x1b[2J\x1b[H";
const HIDE_CURSOR: &str = "\x1b[?25l";
const SHOW_CURSOR: &str = "\x1b[?25h";

const SLASH_COMMANDS: &[(&str, &str)] = &[
    ("/help", "show this list of commands"),
    ("/status", "show project/model status"),
    ("/history", "render conversation history"),
    ("/clear", "clear in-memory history"),
    ("/session", "show current session"),
    ("/save", "save history as JSONL"),
    ("/copy", "copy transcript via OSC52"),
    ("/events", "show recent session events"),
    ("/model", "switch LLM model"),
    ("/model-image", "switch image model"),
    ("/settings", "change settings"),
    ("/skill", "apply a skillplus package"),
    ("/space", "show creative space summary"),
    ("/compact", "print compaction draft"),
    ("/exit", "exit"),
];

const LLM_PRESETS: &[&str] = &[
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "openai/gpt-5.5",
    "anthropic/claude-sonnet-4.5",
    "google/gemini-3-pro-preview",
];

const IMAGE_PRESETS: &[&str] = &[
    "gpt-image-1",
    "openai/gpt-image-1",
    "google/gemini-2.5-flash-image-preview",
];

const BASH_ROWS: &[(&str, &str, &str)] = &[
    ("strict", "Strict", "Every bash command requires approval."),
    (
        "auto",
        "Auto-judge",
        "Read-only commands can run; write commands require approval.",
    ),
    (
        "trusted",
        "Trusted (dangerous)",
        "Run bash commands without asking. Use only in throwaway projects.",
    ),
];

const REASONING_ROWS: &[(&str, &str, &str)] = &[
    ("", "Auto", "Use OpenMelon's model-aware default."),
    ("medium", "Medium", "Balanced reasoning depth."),
    (
        "high",
        "High",
        "Deeper reasoning for planning and tool-heavy work.",
    ),
    ("xhigh", "XHigh", "Maximum reasoning hint when supported."),
];

pub fn run(mut app: App) -> Result<()> {
    let mut session = app.create_session("interactive REPL")?;
    let mut state = TuiState::new(&app, &session);
    state.history = app.initial_history.clone();

    let mut term = TerminalGuard::enter()?;
    state.resize(term.size());
    state.append_launch_history(&app);
    state.render(&mut term)?;
    let mut input = InputDecoder::default();

    let mut worker: Option<WorkerHandle> = None;
    let mut last_tick = Instant::now();
    loop {
        if let Some(handle) = worker.as_mut() {
            state.drain_worker(handle, &mut app, &mut session)?;
            if state.exit_after_worker {
                break;
            }
            if handle.finished {
                worker = None;
                if let Some(next) = state.pending_inputs.pop_front() {
                    state.pending_count = state.pending_inputs.len();
                    state.mark_dirty();
                    state.submit(next, &mut app, &mut session, &mut worker)?;
                }
            }
        }

        if let Some((req, reply)) = state.approval_rx.as_ref().and_then(|rx| rx.try_recv().ok()) {
            state.approval = Some(PendingApproval {
                request: req,
                reply: Some(reply),
                cursor: 0,
                scroll: 0,
            });
            state.mark_dirty();
        }

        if last_tick.elapsed() >= Duration::from_millis(250) {
            state.tick();
            last_tick = Instant::now();
        }

        state.resize(term.size());
        if state.dirty {
            state.render(&mut term)?;
        }

        let mut should_exit = false;
        if input_ready(Duration::from_millis(40))? {
            for key in input.read_keys()? {
                match key {
                    Key::None => {}
                    Key::CtrlD => {
                        if state.running {
                            state.exit_after_worker = true;
                            state.mark_dirty();
                        } else {
                            should_exit = true;
                            break;
                        }
                    }
                    key => {
                        if state.handle_key(key, &mut app, &mut session, &mut worker)? {
                            should_exit = true;
                            break;
                        }
                    }
                }
            }
        }
        if should_exit {
            break;
        }
        if state.dirty {
            state.render(&mut term)?;
        }
    }

    term.leave()?;
    eprintln!();
    eprintln!("session saved at {}", session.dir.display());
    eprintln!("to resume:    openmelon resume {}", session.id);
    Ok(())
}

struct TuiState {
    width: usize,
    height: usize,
    transcript: Vec<TranscriptBlock>,
    streaming: String,
    scroll: usize,
    anchored_bottom: bool,
    input: String,
    cursor: usize,
    input_history: Vec<String>,
    history_cursor: Option<usize>,
    history_draft: String,
    palette_visible: bool,
    palette_cursor: usize,
    pending_inputs: VecDeque<String>,
    pending_count: usize,
    running: bool,
    activity: String,
    run_started: Option<Instant>,
    prompt_tokens: u64,
    completion_tokens: u64,
    history: Vec<Message>,
    persisted_up_to: usize,
    active_skill: String,
    last_ctrl_c: Option<Instant>,
    provider: String,
    model: String,
    reasoning_effort: String,
    image_provider: String,
    image_model: String,
    bash_mode: String,
    approval_tx: mpsc::Sender<(ApprovalRequest, mpsc::Sender<ApprovalDecision>)>,
    approval_rx: Option<mpsc::Receiver<(ApprovalRequest, mpsc::Sender<ApprovalDecision>)>>,
    approval: Option<PendingApproval>,
    exit_after_worker: bool,
    header_identity: String,
    dirty: bool,
    overlay: Overlay,
}

struct PendingApproval {
    request: ApprovalRequest,
    reply: Option<mpsc::Sender<ApprovalDecision>>,
    cursor: usize,
    scroll: usize,
}

struct WorkerHandle {
    events_rx: mpsc::Receiver<RuntimeEvent>,
    done_rx: mpsc::Receiver<WorkerDone>,
    pending_tx: mpsc::Sender<String>,
    finished: bool,
}

struct WorkerDone {
    result: Result<RunResult, String>,
}

#[derive(Clone)]
enum TranscriptBlock {
    Raw(String),
    Markdown(String),
    Rule(String),
    ToolCall { name: String, summary: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Overlay {
    None,
    ModelSelect { image: bool, cursor: usize },
    ModelCustom { image: bool },
    Settings { cursor: usize },
}

#[derive(Debug, Clone, Copy)]
enum ScrollSnap {
    Backward,
    Forward,
}

#[derive(Debug, Clone)]
struct TranscriptLine {
    text: String,
    block_start: bool,
}

impl TuiState {
    fn new(app: &App, session: &Session) -> Self {
        let (approval_tx, approval_rx) = mpsc::channel();
        let mut state = Self {
            width: 88,
            height: 24,
            transcript: Vec::new(),
            streaming: String::new(),
            scroll: 0,
            anchored_bottom: true,
            input: String::new(),
            cursor: 0,
            input_history: Vec::new(),
            history_cursor: None,
            history_draft: String::new(),
            palette_visible: false,
            palette_cursor: 0,
            pending_inputs: VecDeque::new(),
            pending_count: 0,
            running: false,
            activity: String::new(),
            run_started: None,
            prompt_tokens: 0,
            completion_tokens: 0,
            history: Vec::new(),
            persisted_up_to: app.initial_history.len(),
            active_skill: String::new(),
            last_ctrl_c: None,
            provider: app.provider.clone(),
            model: app.model.clone(),
            reasoning_effort: app.reasoning_effort.clone(),
            image_provider: app.image_provider.clone(),
            image_model: app.image_model.clone(),
            bash_mode: effective_bash_mode(&app.workspace.project.settings.bash_permission_mode),
            approval_tx,
            approval_rx: Some(approval_rx),
            approval: None,
            exit_after_worker: false,
            header_identity: app.workspace.project.name.clone(),
            dirty: true,
            overlay: Overlay::None,
        };
        state.append_raw(format!("{DIM}session {}{RESET}", session.id));
        if let Some(resumed) = &app.resumed_from {
            state.append_raw(format!("{DIM}resumed from {resumed}{RESET}"));
        }
        state.append_raw(format!(
            "{DIM}Type a request and press Enter. /help for commands. Esc clears input. Ctrl+C twice exits.{RESET}"
        ));
        state.append_raw(String::new());
        state
    }

    fn append_launch_history(&mut self, app: &App) {
        if app.initial_history.is_empty() {
            return;
        }
        self.append_rule(format!(
            "prior conversation ({} messages)",
            app.initial_history.len()
        ));
        self.append_rendered_history(&app.initial_history);
        self.append_rule("continue below");
        self.append_raw(String::new());
    }

    fn append_rendered_history(&mut self, messages: &[Message]) {
        let mut tool_names = std::collections::BTreeMap::<String, String>::new();
        for msg in messages {
            match msg.role {
                crate::llm::Role::System => {}
                crate::llm::Role::User => {
                    self.append_raw(render_user_message(&msg.content));
                    self.append_raw(String::new());
                }
                crate::llm::Role::Assistant => {
                    if !msg.content.trim().is_empty() {
                        self.append_markdown(msg.content.clone());
                    }
                    for call in &msg.tool_calls {
                        if !call.id.is_empty() {
                            tool_names.insert(call.id.clone(), call.name.clone());
                        }
                        if call.name != "finish" {
                            self.append_tool_call(&call.name, tool_call_summary(call));
                        }
                    }
                }
                crate::llm::Role::Tool => {
                    let name = tool_names
                        .get(&msg.tool_call_id)
                        .map(String::as_str)
                        .unwrap_or("");
                    if name == "finish" {
                        let rendered =
                            render_finish_result(&msg.content, self.width, TranscriptMode::Styled);
                        if !rendered.trim().is_empty() {
                            self.append_raw(rendered);
                        }
                    } else {
                        self.append_raw(render_tool_result(
                            name,
                            &msg.content,
                            TranscriptMode::Styled,
                        ));
                    }
                    self.append_raw(String::new());
                }
            }
        }
    }

    fn resize(&mut self, (width, height): (usize, usize)) {
        let width = width.max(20);
        let height = height.max(8);
        if self.width != width || self.height != height {
            self.width = width;
            self.height = height;
            if self.anchored_bottom {
                self.scroll = usize::MAX;
            }
            self.mark_dirty();
        }
    }

    fn tick(&mut self) {
        if self.running {
            self.mark_dirty();
        }
    }

    fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    fn append_raw(&mut self, text: String) {
        self.transcript.push(TranscriptBlock::Raw(text));
        self.follow_bottom();
        self.mark_dirty();
    }

    fn append_rule(&mut self, label: impl Into<String>) {
        self.transcript.push(TranscriptBlock::Rule(label.into()));
        self.follow_bottom();
        self.mark_dirty();
    }

    fn append_tool_call(&mut self, name: impl Into<String>, summary: impl Into<String>) {
        self.transcript.push(TranscriptBlock::ToolCall {
            name: name.into(),
            summary: summary.into(),
        });
        self.follow_bottom();
        self.mark_dirty();
    }

    fn append_markdown(&mut self, text: String) {
        if !text.trim().is_empty() {
            self.transcript.push(TranscriptBlock::Markdown(text));
            self.follow_bottom();
            self.mark_dirty();
        }
    }

    fn append_error(&mut self, text: impl Into<String>) {
        self.append_raw(format!("{RED}{}{RESET}", text.into()));
    }

    fn follow_bottom(&mut self) {
        if self.anchored_bottom {
            self.scroll = usize::MAX;
        }
    }

    fn render(&mut self, term: &mut TerminalGuard) -> Result<()> {
        let mut out = String::new();
        out.push_str(CLEAR);
        out.push_str(HIDE_CURSOR);

        let header = self.header_line();
        out.push_str(&fit_line(&header, self.width));
        out.push('\n');

        let overlay_lines = self.overlay_lines();
        let palette_lines = if matches!(self.overlay, Overlay::None) {
            self.palette_lines()
        } else {
            Vec::new()
        };
        let input_lines = if matches!(self.overlay, Overlay::None) {
            self.input_lines()
        } else {
            Vec::new()
        };
        let status_lines = self.status_lines();
        let approval_lines = self.approval_lines();
        let overlay_count = overlay_lines.len()
            + palette_lines.len()
            + input_lines.len()
            + status_lines.len()
            + approval_lines.len();
        let viewport_height = self.height.saturating_sub(1 + overlay_count).max(1);
        let transcript_lines = self.transcript_lines();
        let max_scroll = transcript_lines.len().saturating_sub(viewport_height);
        if self.scroll == usize::MAX || self.anchored_bottom {
            self.scroll = max_scroll;
        } else {
            self.scroll = self.scroll.min(max_scroll);
            self.scroll = snap_scroll_to_block_start(&transcript_lines, self.scroll);
        }
        let visible = transcript_lines
            .iter()
            .skip(self.scroll)
            .take(viewport_height)
            .collect::<Vec<_>>();
        let pad_top = if self.anchored_bottom && visible.len() < viewport_height {
            viewport_height - visible.len()
        } else {
            0
        };
        for _ in 0..pad_top {
            out.push('\n');
        }
        for line in visible {
            out.push_str(&fit_line(&line.text, self.width));
            out.push('\n');
        }
        let used = pad_top
            + transcript_lines
                .len()
                .saturating_sub(self.scroll)
                .min(viewport_height);
        for _ in used..viewport_height {
            out.push('\n');
        }
        for line in palette_lines
            .iter()
            .chain(approval_lines.iter())
            .chain(overlay_lines.iter())
            .chain(input_lines.iter())
            .chain(status_lines.iter())
        {
            out.push_str(&fit_line(line, self.width));
            out.push('\n');
        }
        term.write_all(out.as_bytes())?;
        term.flush()?;
        self.dirty = false;
        Ok(())
    }

    fn header_line(&self) -> String {
        let mut parts = vec![
            format!("{BOLD}openmelon{RESET}"),
            self.header_identity.clone(),
            format!("{}:{}", self.provider, self.model),
            format!("reasoning {}", empty_as_auto(&self.reasoning_effort)),
        ];
        if !self.image_model.is_empty() {
            parts.push(format!(
                "img {}:{}",
                empty_as_none(&self.image_provider),
                self.image_model
            ));
        }
        if self.pending_count > 0 {
            parts.push(format!("{} pending", self.pending_count));
        }
        parts.join(" · ")
    }

    fn status_lines(&self) -> Vec<String> {
        let mut left = if self.running {
            let elapsed = self
                .run_started
                .map(|t| format_elapsed(t.elapsed()))
                .unwrap_or_default();
            format!(
                "{} · {} · {} in / {} out",
                if self.activity.is_empty() {
                    "Thinking"
                } else {
                    &self.activity
                },
                elapsed,
                short_int(self.prompt_tokens),
                short_int(self.completion_tokens)
            )
        } else {
            "Ready".to_string()
        };
        if self.pending_count > 0 {
            left.push_str(&format!(" · {} pending", self.pending_count));
        }
        let right = "esc clear · ctrl+c twice quit · pgup/pgdn scroll";
        vec![join_status_line(&left, right, self.width)]
    }

    fn palette_lines(&self) -> Vec<String> {
        if !self.palette_visible {
            return Vec::new();
        }
        let filtered = self.filtered_commands();
        if filtered.is_empty() {
            return vec![format!("{DIM}  (no matching commands){RESET}")];
        }
        filtered
            .into_iter()
            .take(8)
            .enumerate()
            .map(|(idx, (name, help))| {
                if idx == self.palette_cursor {
                    format!("{CYAN}› {name}{RESET} {DIM}{help}{RESET}")
                } else {
                    format!("  {name} {DIM}{help}{RESET}")
                }
            })
            .collect()
    }

    fn overlay_lines(&self) -> Vec<String> {
        match &self.overlay {
            Overlay::None => Vec::new(),
            Overlay::ModelSelect { image, cursor } => self.selector_lines(*image, *cursor),
            Overlay::ModelCustom { image } => {
                let title = if *image {
                    "Custom image model id"
                } else {
                    "Custom LLM model id"
                };
                vec![
                    format!("{BOLD}{title}{RESET}"),
                    format!(
                        "{DIM}Type a provider-specific model id, then Enter. Esc cancels.{RESET}"
                    ),
                    String::new(),
                    format!(
                        "{CYAN}›{RESET} {}",
                        render_input_with_cursor(&self.input, self.cursor)
                    ),
                ]
            }
            Overlay::Settings { cursor } => self.settings_lines(*cursor),
        }
    }

    fn selector_lines(&self, image: bool, cursor: usize) -> Vec<String> {
        let rows = selector_rows(image);
        let current = if image {
            &self.image_model
        } else {
            &self.model
        };
        let mut lines = Vec::new();
        let title = if image {
            "Select image model"
        } else {
            "Select LLM model"
        };
        let desc = if image {
            "Switch the model used by generate_image. Persists to project.json."
        } else {
            "Switch the model used by this and future turns. Persists to project.json."
        };
        lines.push(format!("{BOLD}{title}{RESET}"));
        lines.push(format!("{DIM}{desc}{RESET}"));
        lines.push(String::new());
        for (idx, row) in rows.iter().enumerate() {
            let marker = if idx == cursor {
                format!("{CYAN}›{RESET}")
            } else {
                " ".to_string()
            };
            let num = format!("{}.", idx + 1);
            let label = if row.is_empty() { "Custom..." } else { row };
            let check = if !row.is_empty() && current.contains(row) {
                " ✓"
            } else {
                ""
            };
            let line = if idx == cursor {
                format!("{marker} {CYAN}{num} {label}{check}{RESET}")
            } else {
                format!("{marker} {num} {label}{check}")
            };
            lines.push(line);
        }
        lines.push(String::new());
        lines.push(format!(
            "{DIM}Enter confirm · Esc cancel · 1-N shortcut{RESET}"
        ));
        lines
    }

    fn settings_lines(&self, cursor: usize) -> Vec<String> {
        let rows = settings_rows();
        let bash = self.bash_mode.as_str();
        let reasoning = self.reasoning_effort.as_str();
        let mut lines = vec![
            format!("{BOLD}Settings{RESET}"),
            format!("{DIM}Persists to project.json.{RESET}"),
            String::new(),
        ];
        let mut n = 0usize;
        for (idx, row) in rows.iter().enumerate() {
            match row {
                SettingsRow::Section(title) => lines.push(format!("{BOLD}{title}{RESET}")),
                SettingsRow::Choice {
                    kind,
                    value,
                    title,
                    desc,
                } => {
                    n += 1;
                    let active = match *kind {
                        "bash" => value == &bash,
                        "reasoning" => value == &reasoning,
                        _ => false,
                    };
                    let marker = if idx == cursor {
                        format!("{CYAN}›{RESET}")
                    } else {
                        " ".to_string()
                    };
                    let check = if active { " ✓" } else { "" };
                    let title = if idx == cursor {
                        format!("{CYAN}{n}. {title}{check}{RESET}")
                    } else {
                        format!("{n}. {title}{check}")
                    };
                    lines.push(format!("{marker} {title}"));
                    lines.push(format!("    {DIM}{desc}{RESET}"));
                }
            }
        }
        lines.push(String::new());
        lines.push(format!(
            "{DIM}Enter set · Esc close · ↑/↓ select · 1-7 shortcut{RESET}"
        ));
        lines
    }

    fn approval_lines(&self) -> Vec<String> {
        let Some(approval) = &self.approval else {
            return Vec::new();
        };
        let max_body = (self.height / 3).clamp(4, 10);
        let mut body = vec![format!("Reason:  {}", approval.request.description)];
        body.extend(wrap_text(
            &format!("Command: {}", approval.request.command),
            self.width.saturating_sub(4),
        ));
        if !approval.request.binary.is_empty() {
            body.push(format!("Binary:  {}", approval.request.binary));
        }
        let max_scroll = body.len().saturating_sub(max_body);
        let scroll = approval.scroll.min(max_scroll);
        let mut lines = vec![
            history_rule("approval required", self.width),
            format!("{BOLD}Do you want to proceed?{RESET}"),
        ];
        for line in body.iter().skip(scroll).take(max_body) {
            lines.push(format!("  {line}"));
        }
        if max_scroll > 0 {
            lines.push(format!(
                "{DIM}  showing {}-{} of {} · PgUp/PgDn scroll{RESET}",
                scroll + 1,
                (scroll + max_body).min(body.len()),
                body.len()
            ));
        }
        let opts = if approval.request.binary.is_empty() {
            ["Yes", "No", ""]
        } else {
            ["Yes", "Always", "No"]
        };
        let row = opts
            .iter()
            .filter(|item| !item.is_empty())
            .enumerate()
            .map(|(idx, item)| {
                if idx == approval.cursor {
                    format!("{CYAN}[{item}]{RESET}")
                } else {
                    format!("[{item}]")
                }
            })
            .collect::<Vec<_>>()
            .join(" ");
        lines.push(format!("  {row}"));
        lines.push(history_rule("end approval", self.width));
        lines
    }

    fn input_lines(&self) -> Vec<String> {
        let width = self.width.saturating_sub(4).max(1);
        let text = if self.input.is_empty() {
            format!("\x1b[7m \x1b[0m{DIM}Ask OpenMelon{RESET}")
        } else {
            render_input_with_cursor(&self.input, self.cursor)
        };
        let mut lines = wrap_text(&text, width);
        if lines.is_empty() {
            lines.push(String::new());
        }
        for (idx, line) in lines.iter_mut().enumerate() {
            if idx == 0 {
                *line = format!("{CYAN}›{RESET} {line}");
            } else {
                *line = format!("  {line}");
            }
        }
        lines
    }

    fn transcript_lines(&self) -> Vec<TranscriptLine> {
        let mut out = Vec::new();
        for block in &self.transcript {
            match block {
                TranscriptBlock::Raw(text) => {
                    if text.is_empty() {
                        push_transcript_block(&mut out, vec![String::new()]);
                    } else {
                        let mut lines = Vec::new();
                        for line in text.lines() {
                            lines.extend(wrap_text_with_indent(line, self.width));
                        }
                        push_transcript_block(&mut out, lines);
                    }
                }
                TranscriptBlock::Markdown(text) => {
                    let rendered = render_markdown(text, self.width);
                    let mut lines = Vec::new();
                    for line in rendered.lines() {
                        lines.extend(wrap_text_with_indent(&format!(" {line}"), self.width));
                    }
                    push_transcript_block(&mut out, lines);
                }
                TranscriptBlock::Rule(label) => {
                    push_transcript_block(&mut out, vec![history_rule(label, self.width)]);
                }
                TranscriptBlock::ToolCall { name, summary } => {
                    push_transcript_block(
                        &mut out,
                        render_tool_call_lines(name, summary, self.width),
                    );
                }
            }
        }
        if !self.streaming.trim().is_empty() {
            let rendered = render_markdown(&self.streaming, self.width);
            let mut lines = Vec::new();
            for line in rendered.lines() {
                lines.extend(wrap_text_with_indent(&format!(" {line}"), self.width));
            }
            push_transcript_block(&mut out, lines);
        }
        out
    }

    fn handle_key(
        &mut self,
        key: Key,
        app: &mut App,
        session: &mut Session,
        worker: &mut Option<WorkerHandle>,
    ) -> Result<bool> {
        if self.approval.is_some() {
            self.handle_approval_key(key);
            self.mark_dirty();
            return Ok(false);
        }
        if !matches!(self.overlay, Overlay::None) {
            return self.handle_overlay_key(key, app);
        }
        match key {
            Key::CtrlC => {
                if !self.input.is_empty() {
                    self.record_history(self.input.clone());
                    self.input.clear();
                    self.cursor = 0;
                    self.palette_visible = false;
                    self.mark_dirty();
                    return Ok(false);
                }
                if self
                    .last_ctrl_c
                    .is_some_and(|t| t.elapsed() < Duration::from_secs(2))
                {
                    return Ok(true);
                }
                self.last_ctrl_c = Some(Instant::now());
                self.append_raw(format!("{DIM}Press Ctrl+C again within 2s to quit.{RESET}"));
            }
            Key::Esc => {
                if self.palette_visible {
                    self.palette_visible = false;
                } else if !self.input.is_empty() {
                    self.record_history(self.input.clone());
                    self.input.clear();
                    self.cursor = 0;
                }
            }
            Key::Enter => {
                if self.palette_visible && !self.input.contains(char::is_whitespace) {
                    if let Some((name, _)) =
                        self.filtered_commands().get(self.palette_cursor).copied()
                    {
                        self.record_history(name.to_string());
                        self.input.clear();
                        self.cursor = 0;
                        self.palette_visible = false;
                        if self.running {
                            self.queue_pending(name.to_string(), session, worker.as_ref());
                        } else {
                            self.submit(name.to_string(), app, session, worker)?;
                        }
                        self.mark_dirty();
                        return Ok(false);
                    }
                }
                let text = self.input.trim().to_string();
                if text.is_empty() {
                    return Ok(false);
                }
                self.record_history(text.clone());
                self.input.clear();
                self.cursor = 0;
                self.palette_visible = false;
                if self.running {
                    self.queue_pending(text, session, worker.as_ref());
                } else {
                    self.submit(text, app, session, worker)?;
                }
            }
            Key::ShiftEnter | Key::AltEnter | Key::CtrlJ => self.insert_char('\n'),
            Key::Backspace => self.backspace(),
            Key::Delete => self.delete(),
            Key::Left => self.move_left(),
            Key::Right => self.move_right(),
            Key::Home => self.cursor = 0,
            Key::End if self.input.is_empty() => {
                self.anchored_bottom = true;
                self.scroll = usize::MAX;
            }
            Key::End => self.cursor = self.input.len(),
            Key::Up if self.palette_visible => {
                if self.palette_cursor > 0 {
                    self.palette_cursor -= 1;
                }
            }
            Key::Down if self.palette_visible => {
                let len = self.filtered_commands().len();
                if self.palette_cursor + 1 < len {
                    self.palette_cursor += 1;
                }
            }
            Key::Tab if self.palette_visible => {
                if let Some((name, _)) = self.filtered_commands().get(self.palette_cursor).copied()
                {
                    self.input = format!("{name} ");
                    self.cursor = self.input.len();
                    self.palette_visible = false;
                }
            }
            Key::Up => self.history_prev(),
            Key::Down => self.history_next(),
            Key::PageUp => {
                self.anchored_bottom = false;
                let target = self.scroll.saturating_sub((self.height / 2).max(1));
                self.scroll = self.snap_scroll(target, ScrollSnap::Backward);
            }
            Key::PageDown => {
                self.anchored_bottom = false;
                let target = self.scroll.saturating_add((self.height / 2).max(1));
                self.scroll = self.snap_scroll(target, ScrollSnap::Forward);
            }
            Key::Char(ch) => {
                self.insert_char(ch);
                self.refresh_palette();
            }
            Key::Paste(text) => {
                for ch in text.chars() {
                    self.insert_char(ch);
                }
                self.refresh_palette();
            }
            _ => {}
        }
        self.mark_dirty();
        Ok(false)
    }

    fn handle_approval_key(&mut self, key: Key) {
        let Some(approval) = self.approval.as_mut() else {
            return;
        };
        let request_binary_empty = approval.request.binary.is_empty();
        let max = if approval.request.binary.is_empty() {
            1
        } else {
            2
        };
        match key {
            Key::Left | Key::Up => approval.cursor = approval.cursor.saturating_sub(1),
            Key::Right | Key::Down | Key::Tab => approval.cursor = (approval.cursor + 1).min(max),
            Key::PageUp => approval.scroll = approval.scroll.saturating_sub(3),
            Key::PageDown => approval.scroll = approval.scroll.saturating_add(3),
            Key::Esc | Key::CtrlC => self.resolve_approval(ApprovalDecision::No),
            Key::Char('y') | Key::Char('Y') => self.resolve_approval(ApprovalDecision::Yes),
            Key::Char('a') | Key::Char('A') if !request_binary_empty => {
                self.resolve_approval(ApprovalDecision::Always)
            }
            Key::Enter => {
                let decision = match approval.cursor {
                    0 => ApprovalDecision::Yes,
                    1 if !request_binary_empty => ApprovalDecision::Always,
                    _ => ApprovalDecision::No,
                };
                self.resolve_approval(decision);
            }
            _ => {}
        }
        self.mark_dirty();
    }

    fn resolve_approval(&mut self, decision: ApprovalDecision) {
        if let Some(mut approval) = self.approval.take() {
            if let Some(reply) = approval.reply.take() {
                let _ = reply.send(decision);
            }
        }
    }

    fn handle_overlay_key(&mut self, key: Key, app: &mut App) -> Result<bool> {
        let overlay = self.overlay.clone();
        match overlay {
            Overlay::None => {}
            Overlay::ModelSelect { image, mut cursor } => {
                let rows = selector_rows(image);
                match key {
                    Key::Esc | Key::CtrlC => self.close_overlay(),
                    Key::Up | Key::Char('k') => {
                        cursor = cursor.saturating_sub(1);
                        self.overlay = Overlay::ModelSelect { image, cursor };
                    }
                    Key::Down | Key::Char('j') => {
                        if cursor + 1 < rows.len() {
                            cursor += 1;
                        }
                        self.overlay = Overlay::ModelSelect { image, cursor };
                    }
                    Key::Enter => {
                        let picked = rows.get(cursor).copied().unwrap_or("");
                        if picked.is_empty() {
                            self.input.clear();
                            self.cursor = 0;
                            self.overlay = Overlay::ModelCustom { image };
                        } else {
                            self.apply_model_pick(app, image, picked)?;
                            self.close_overlay();
                        }
                    }
                    Key::Char(ch) if ch.is_ascii_digit() && ch != '0' => {
                        let idx = ch as usize - '1' as usize;
                        if idx < rows.len() {
                            let picked = rows[idx];
                            if picked.is_empty() {
                                self.input.clear();
                                self.cursor = 0;
                                self.overlay = Overlay::ModelCustom { image };
                            } else {
                                self.apply_model_pick(app, image, picked)?;
                                self.close_overlay();
                            }
                        }
                    }
                    _ => {}
                }
            }
            Overlay::ModelCustom { image } => match key {
                Key::Esc | Key::CtrlC => self.close_overlay(),
                Key::Enter => {
                    let value = self.input.trim().to_string();
                    if !value.is_empty() {
                        self.apply_model_pick(app, image, &value)?;
                        self.close_overlay();
                    }
                }
                Key::Backspace => self.backspace(),
                Key::Delete => self.delete(),
                Key::Left => self.move_left(),
                Key::Right => self.move_right(),
                Key::Home => self.cursor = 0,
                Key::End => self.cursor = self.input.len(),
                Key::Char(ch) => self.insert_char(ch),
                Key::Paste(text) => {
                    for ch in text.chars() {
                        self.insert_char(ch);
                    }
                }
                _ => {}
            },
            Overlay::Settings { mut cursor } => {
                let rows = settings_rows();
                match key {
                    Key::Esc | Key::CtrlC => self.close_overlay(),
                    Key::Up | Key::Char('k') => {
                        cursor = previous_settings_cursor(&rows, cursor);
                        self.overlay = Overlay::Settings { cursor };
                    }
                    Key::Down | Key::Char('j') => {
                        cursor = next_settings_cursor(&rows, cursor);
                        self.overlay = Overlay::Settings { cursor };
                    }
                    Key::Enter => {
                        self.apply_settings_pick(app, cursor)?;
                        self.close_overlay();
                    }
                    Key::Char(ch) if ch.is_ascii_digit() && ch != '0' => {
                        if let Some(idx) = settings_number_index(&rows, ch as usize - '0' as usize)
                        {
                            self.apply_settings_pick(app, idx)?;
                            self.close_overlay();
                        }
                    }
                    _ => {}
                }
            }
        }
        self.mark_dirty();
        Ok(false)
    }

    fn close_overlay(&mut self) {
        self.overlay = Overlay::None;
        self.input.clear();
        self.cursor = 0;
        self.palette_visible = false;
    }

    fn open_model_selector(&mut self, image: bool) {
        let rows = selector_rows(image);
        let current = if image {
            &self.image_model
        } else {
            &self.model
        };
        let cursor = rows
            .iter()
            .position(|row| !row.is_empty() && row == current)
            .unwrap_or(0);
        self.overlay = Overlay::ModelSelect { image, cursor };
        self.palette_visible = false;
    }

    fn open_settings(&mut self) {
        let rows = settings_rows();
        let cursor = rows
            .iter()
            .position(|row| match row {
                SettingsRow::Choice { kind, value, .. } if *kind == "bash" => {
                    value == &self.bash_mode
                }
                SettingsRow::Choice { kind, value, .. } if *kind == "reasoning" => {
                    value == &self.reasoning_effort
                }
                _ => false,
            })
            .unwrap_or(1);
        self.overlay = Overlay::Settings { cursor };
        self.palette_visible = false;
    }

    fn apply_model_pick(&mut self, app: &mut App, image: bool, picked: &str) -> Result<()> {
        if image {
            if picked.eq_ignore_ascii_case("off") || picked.eq_ignore_ascii_case("none") {
                app.image_provider.clear();
                app.image_model.clear();
            } else {
                if app.image_provider.is_empty() {
                    app.image_provider = app.provider.clone();
                }
                app.image_model = picked.to_string();
            }
            set_project_default(&app.workspace.root, "image_provider", &app.image_provider)?;
            set_project_default(&app.workspace.root, "image_model", &app.image_model)?;
            self.image_provider = app.image_provider.clone();
            self.image_model = app.image_model.clone();
            self.append_raw(format!(
                "{DIM}(image model: {}:{}){RESET}",
                empty_as_none(&self.image_provider),
                empty_as_none(&self.image_model)
            ));
            return Ok(());
        }
        app.model = picked.to_string();
        set_project_default(&app.workspace.root, "llm_model", &app.model)?;
        self.model = app.model.clone();
        self.append_raw(format!(
            "{DIM}(LLM: {}:{}){RESET}",
            self.provider, self.model
        ));
        Ok(())
    }

    fn apply_settings_pick(&mut self, app: &mut App, idx: usize) -> Result<()> {
        let rows = settings_rows();
        let Some(row) = rows.get(idx) else {
            return Ok(());
        };
        match row {
            SettingsRow::Choice { kind, value, .. } if *kind == "bash" => {
                set_project_setting(&app.workspace.root, "bash_permission_mode", value)?;
                app.workspace.project.settings.bash_permission_mode = value.to_string();
                self.bash_mode = effective_bash_mode(value);
            }
            SettingsRow::Choice { kind, value, .. } if *kind == "reasoning" => {
                set_project_setting(&app.workspace.root, "reasoning_effort", value)?;
                app.reasoning_effort = value.to_string();
                self.reasoning_effort = value.to_string();
            }
            _ => return Ok(()),
        }
        self.append_raw(format!(
            "{DIM}(settings: bash={} reasoning={}){RESET}",
            self.bash_mode,
            empty_as_auto(&self.reasoning_effort)
        ));
        Ok(())
    }

    fn submit(
        &mut self,
        text: String,
        app: &mut App,
        session: &mut Session,
        worker: &mut Option<WorkerHandle>,
    ) -> Result<()> {
        if text.starts_with('/') {
            if self.handle_slash(&text, app, session, worker)? {
                self.exit_after_worker = true;
            }
            return Ok(());
        }
        let user_text = if self.active_skill.is_empty() {
            text
        } else {
            let skill = std::mem::take(&mut self.active_skill);
            format!("Apply the skill {skill:?} to this request: first call compile_skill with skill={skill:?} (BARE slug, no 'skillplus:' prefix) to fetch the package's prompt + output schema, then proceed.\n\n{text}")
        };
        self.append_raw(render_user_message(&user_text));
        self.append_raw(String::new());
        session.append_prompt("user", &user_text)?;
        let handle = spawn_runtime(
            app,
            session,
            user_text,
            self.history.clone(),
            self.approval_tx.clone(),
        )?;
        self.running = true;
        self.run_started = Some(Instant::now());
        self.activity = format!("Sending to {}", app.model);
        *worker = Some(handle);
        self.mark_dirty();
        Ok(())
    }

    fn handle_slash(
        &mut self,
        text: &str,
        app: &mut App,
        session: &mut Session,
        _worker: &mut Option<WorkerHandle>,
    ) -> Result<bool> {
        let parts = text.split_whitespace().collect::<Vec<_>>();
        match parts.first().copied().unwrap_or_default() {
            "/exit" | "/quit" | "/q" => Ok(true),
            "/help" => {
                self.append_markdown(
                    SLASH_COMMANDS
                        .iter()
                        .map(|(name, help)| format!("- `{name}` {help}"))
                        .collect::<Vec<_>>()
                        .join("\n"),
                );
                Ok(false)
            }
            "/status" => {
                self.append_raw(format!(
                    "project: {} ({})",
                    app.workspace.project.name, app.workspace.project.id
                ));
                self.append_raw(format!(
                    "model: {}:{} reasoning={}",
                    app.provider,
                    app.model,
                    empty_as_auto(&app.reasoning_effort)
                ));
                self.append_raw(format!(
                    "image: {}:{}",
                    empty_as_none(&app.image_provider),
                    empty_as_none(&app.image_model)
                ));
                self.append_raw(format!(
                    "outputs: {}",
                    app.workspace.outputs_dir().display()
                ));
                Ok(false)
            }
            "/history" => {
                let history = self.history.clone();
                self.append_rendered_history(&history);
                Ok(false)
            }
            "/clear" => {
                self.history.clear();
                self.persisted_up_to = 0;
                self.append_raw("history cleared".to_string());
                Ok(false)
            }
            "/session" => {
                self.append_raw(format!("{}", session.dir.display()));
                Ok(false)
            }
            "/save" => {
                let Some(path) = parts.get(1) else {
                    bail!("/save: usage /save <path>");
                };
                let mut file = std::fs::File::create(path)?;
                for message in &self.history {
                    serde_json::to_writer(&mut file, message)?;
                    file.write_all(b"\n")?;
                }
                self.append_raw(format!("saved {} messages -> {path}", self.history.len()));
                Ok(false)
            }
            "/copy" => {
                let text = render_plain_transcript(&self.history, self.width);
                if text.trim().is_empty() {
                    self.append_raw("nothing to copy".to_string());
                } else {
                    print_osc52(&text)?;
                    self.append_raw(format!(
                        "copied transcript ({} chars)",
                        text.chars().count()
                    ));
                }
                Ok(false)
            }
            "/events" => {
                for event in load_events(&session.dir, 20)? {
                    self.append_raw(serde_json::to_string(&event)?);
                }
                Ok(false)
            }
            "/model" => {
                if let Some(model) = parts.get(1) {
                    self.apply_model_pick(app, false, model)?;
                } else {
                    self.open_model_selector(false);
                }
                Ok(false)
            }
            "/model-image" => {
                if parts.len() >= 3 {
                    app.image_provider = parts[1].to_string();
                    self.apply_model_pick(app, true, parts[2])?;
                } else if let Some(model) = parts.get(1) {
                    self.apply_model_pick(app, true, model)?;
                } else {
                    self.open_model_selector(true);
                }
                Ok(false)
            }
            "/settings" => {
                match (parts.get(1).copied(), parts.get(2).copied()) {
                    (Some("bash"), Some(mode)) if matches!(mode, "strict" | "auto" | "trusted") => {
                        set_project_setting(&app.workspace.root, "bash_permission_mode", mode)?;
                        app.workspace.project.settings.bash_permission_mode = mode.to_string();
                        self.bash_mode = effective_bash_mode(mode);
                        self.append_raw(format!("bash_permission_mode: {mode}"));
                    }
                    (Some("reasoning"), Some(effort))
                        if matches!(effort, "auto" | "medium" | "high" | "xhigh") =>
                    {
                        let value = if effort == "auto" { "" } else { effort };
                        set_project_setting(&app.workspace.root, "reasoning_effort", value)?;
                        app.reasoning_effort = value.to_string();
                        self.reasoning_effort = value.to_string();
                        self.append_raw(format!(
                            "reasoning_effort: {}",
                            empty_as_auto(&app.reasoning_effort)
                        ));
                    }
                    (None, None) => {
                        self.open_settings();
                    }
                    _ => {
                        self.append_error(
                            "/settings: use /settings, /settings bash <strict|auto|trusted>, or /settings reasoning <auto|medium|high|xhigh>",
                        );
                    }
                }
                Ok(false)
            }
            "/skill" => {
                if parts.get(1).is_none() {
                    self.append_raw("usage: /skill <id> or /skill clear".to_string());
                } else if matches!(parts[1], "clear" | "off" | "none") {
                    self.active_skill.clear();
                    self.append_raw("skill cleared".to_string());
                } else {
                    self.active_skill = parts[1].to_string();
                    self.append_raw(format!(
                        "skill: {} applies to your next message",
                        self.active_skill
                    ));
                }
                Ok(false)
            }
            "/space" => {
                let Some(space_id) = parts.get(1) else {
                    bail!("/space: usage /space <id>");
                };
                let env = app.tool_env(Some(session), &session.id);
                let packet = ToolRegistry::standard(&env).dispatch(
                    &env,
                    "get_context_packet",
                    serde_json::json!({"space_id": space_id}),
                )?;
                self.append_markdown(render_compaction_draft(&packet));
                Ok(false)
            }
            "/compact" => {
                let Some(space_id) = parts.get(1) else {
                    bail!("/compact: usage /compact <space-id>");
                };
                let env = app.tool_env(Some(session), &session.id);
                let packet = ToolRegistry::standard(&env).dispatch(
                    &env,
                    "get_context_packet",
                    serde_json::json!({"space_id": space_id}),
                )?;
                self.append_markdown(render_compaction_draft(&packet));
                Ok(false)
            }
            other => {
                self.append_error(format!("unknown command: {other}"));
                Ok(false)
            }
        }
    }

    fn drain_worker(
        &mut self,
        handle: &mut WorkerHandle,
        _app: &mut App,
        session: &mut Session,
    ) -> Result<()> {
        while let Ok(event) = handle.events_rx.try_recv() {
            match event {
                RuntimeEvent::TurnStart { step } => {
                    self.activity = format!("Thinking step {step}");
                    self.mark_dirty();
                }
                RuntimeEvent::TextDelta(delta) => {
                    self.activity = "Streaming response".to_string();
                    self.streaming.push_str(&delta);
                    self.follow_bottom();
                    self.mark_dirty();
                }
                RuntimeEvent::ToolCall(call) => {
                    self.flush_streaming();
                    self.activity = format!("Calling {}", call.name);
                    self.append_tool_call(call.name.clone(), tool_call_summary(&call));
                    self.mark_dirty();
                }
                RuntimeEvent::ToolResult {
                    tool_name,
                    content,
                    error,
                } => {
                    self.activity = format!("Got {tool_name} result");
                    if tool_name == "finish" {
                        let rendered =
                            render_finish_result(&content, self.width, TranscriptMode::Styled);
                        if !rendered.trim().is_empty() {
                            self.append_raw(rendered);
                        }
                    } else {
                        self.append_raw(render_tool_result(
                            &tool_name,
                            &content,
                            TranscriptMode::Styled,
                        ));
                    }
                    if let Some(err) = error {
                        self.append_error(format!("error: {err}"));
                    }
                    self.append_raw(String::new());
                    self.mark_dirty();
                }
                RuntimeEvent::TurnEnd {
                    step,
                    finish,
                    usage,
                } => {
                    self.flush_streaming();
                    self.activity = format!("Turn {step} ended ({finish:?})");
                    self.prompt_tokens += usage.prompt_tokens;
                    self.completion_tokens += usage.completion_tokens;
                    self.mark_dirty();
                }
                RuntimeEvent::QueuedInputApplied { count } => {
                    for _ in 0..count {
                        let _ = self.pending_inputs.pop_front();
                    }
                    self.pending_count = self.pending_inputs.len();
                    self.mark_dirty();
                }
            }
        }

        if let Ok(done) = handle.done_rx.try_recv() {
            handle.finished = true;
            self.running = false;
            self.activity.clear();
            match done.result {
                Ok(result) => {
                    let old_len = self.history.len();
                    self.history = result.messages;
                    if self.persisted_up_to < self.history.len() {
                        session.append_messages(&self.history[self.persisted_up_to..])?;
                        self.persisted_up_to = self.history.len();
                    } else if old_len > self.history.len() {
                        self.persisted_up_to = self.history.len();
                    }
                    session.write_summary(
                        &result.finish_summary,
                        &result.finish_artifacts,
                        result.finished,
                    )?;
                    if result.finished {
                        self.flush_streaming();
                    }
                    let _ = handle;
                }
                Err(err) => self.append_error(format!("error: {err}")),
            }
            self.mark_dirty();
        }
        Ok(())
    }

    fn queue_pending(&mut self, text: String, session: &Session, worker: Option<&WorkerHandle>) {
        self.pending_inputs.push_back(text.clone());
        self.pending_count = self.pending_inputs.len();
        if let Some(worker) = worker {
            let _ = worker.pending_tx.send(text.clone());
        }
        let _ = session.append_prompt("pending", &text);
        self.append_raw(format!(
            "{DIM}queued for next model call:{RESET}\n  > {text}"
        ));
        self.anchored_bottom = true;
    }

    fn flush_streaming(&mut self) {
        if self.streaming.trim().is_empty() {
            self.streaming.clear();
            return;
        }
        let text = std::mem::take(&mut self.streaming);
        self.append_markdown(text);
    }

    fn record_history(&mut self, text: String) {
        if self.input_history.last() != Some(&text) {
            self.input_history.push(text);
        }
        self.history_cursor = None;
        self.history_draft.clear();
    }

    fn history_prev(&mut self) {
        if self.input_history.is_empty() || self.input.contains('\n') {
            return;
        }
        match self.history_cursor {
            None => {
                self.history_draft = self.input.clone();
                self.history_cursor = Some(self.input_history.len() - 1);
            }
            Some(0) => {}
            Some(idx) => self.history_cursor = Some(idx - 1),
        }
        self.apply_history_cursor();
    }

    fn history_next(&mut self) {
        let Some(idx) = self.history_cursor else {
            return;
        };
        if idx + 1 >= self.input_history.len() {
            self.history_cursor = None;
            self.input = self.history_draft.clone();
            self.cursor = self.input.len();
            return;
        }
        self.history_cursor = Some(idx + 1);
        self.apply_history_cursor();
    }

    fn apply_history_cursor(&mut self) {
        if let Some(idx) = self.history_cursor {
            self.input = self.input_history.get(idx).cloned().unwrap_or_default();
            self.cursor = self.input.len();
        }
    }

    fn refresh_palette(&mut self) {
        self.palette_visible = self.input.starts_with('/')
            && !self.input[1..].contains(char::is_whitespace)
            && !self.running;
        if self.palette_cursor >= self.filtered_commands().len() {
            self.palette_cursor = 0;
        }
    }

    fn filtered_commands(&self) -> Vec<(&'static str, &'static str)> {
        if self.input.trim() == "/" {
            return SLASH_COMMANDS.to_vec();
        }
        SLASH_COMMANDS
            .iter()
            .copied()
            .filter(|(name, _)| name.starts_with(self.input.trim()))
            .collect()
    }

    fn insert_char(&mut self, ch: char) {
        self.input.insert(self.cursor, ch);
        self.cursor += ch.len_utf8();
    }

    fn backspace(&mut self) {
        if self.cursor == 0 {
            return;
        }
        if let Some((idx, _)) = self.input[..self.cursor].char_indices().last() {
            self.input.drain(idx..self.cursor);
            self.cursor = idx;
        }
        self.refresh_palette();
    }

    fn delete(&mut self) {
        if self.cursor >= self.input.len() {
            return;
        }
        let next = self.input[self.cursor..]
            .char_indices()
            .nth(1)
            .map(|(idx, _)| self.cursor + idx)
            .unwrap_or(self.input.len());
        self.input.drain(self.cursor..next);
        self.refresh_palette();
    }

    fn move_left(&mut self) {
        if self.cursor == 0 {
            return;
        }
        if let Some((idx, _)) = self.input[..self.cursor].char_indices().last() {
            self.cursor = idx;
        }
    }

    fn move_right(&mut self) {
        if self.cursor >= self.input.len() {
            return;
        }
        self.cursor += self.input[self.cursor..]
            .chars()
            .next()
            .map(char::len_utf8)
            .unwrap_or(0);
    }

    fn snap_scroll(&self, target: usize, direction: ScrollSnap) -> usize {
        let lines = self.transcript_lines();
        match direction {
            ScrollSnap::Backward => snap_scroll_to_block_start(&lines, target),
            ScrollSnap::Forward => snap_scroll_to_next_block_start(&lines, target),
        }
    }
}

fn spawn_runtime(
    app: &App,
    session: &Session,
    prompt: String,
    history: Vec<Message>,
    approval_tx: mpsc::Sender<(ApprovalRequest, mpsc::Sender<ApprovalDecision>)>,
) -> Result<WorkerHandle> {
    let user_config = load_user_config()?;
    let llm_res = resolve_provider(
        &app.workspace.root,
        &app.workspace.project,
        &user_config,
        &app.provider,
    )?;
    let llm = OpenAIClient::new(
        &app.provider,
        llm_res.api_key,
        super::first_non_empty([Some(app.base_url.as_str()), Some(llm_res.base_url.as_str())])
            .unwrap_or_default(),
        app.model.clone(),
    )?;
    let image = build_image_generator(app, &user_config).ok();
    let tool_env = ToolEnv {
        workspace: app.workspace.clone(),
        session_id: session.id.clone(),
        session_dir: session.dir.clone(),
        image,
        bash_mode: effective_bash_mode(&app.workspace.project.settings.bash_permission_mode),
        allowed_bash: app.allowed_bash.clone(),
        approve_bash: Some(channel_approval_fn(approval_tx)),
    };
    let registry = ToolRegistry::standard(&tool_env);
    let system_prompt = build_project_system_prompt(&app.workspace, &registry.names());
    let (events_tx, events_rx) = mpsc::channel();
    let (done_tx, done_rx) = mpsc::channel();
    let (pending_tx, pending_rx_raw) = mpsc::channel::<String>();
    let pending_rx = Arc::new(Mutex::new(pending_rx_raw));
    let pending_for_worker = pending_rx.clone();
    let mut session = session.fork_writer()?;
    session.set_runtime_info(&app.provider, &app.model)?;
    let max_steps = app.options.max_steps;
    let reasoning = app.reasoning_effort.clone();
    thread::spawn(move || {
        let mut runtime = Runtime {
            llm,
            registry,
            env: tool_env,
            max_steps,
            reasoning_effort: reasoning,
            drain_user_input: Some(Box::new(move || {
                let mut out = Vec::new();
                let Ok(rx) = pending_for_worker.lock() else {
                    return out;
                };
                while let Ok(text) = rx.try_recv() {
                    out.push(text);
                }
                out
            })),
            events: Some(events_tx),
        };
        let result = runtime
            .run(
                RunInput {
                    system_prompt,
                    user_input: prompt,
                    history,
                },
                &mut session,
            )
            .map_err(|err| err.to_string());
        let _ = done_tx.send(WorkerDone { result });
    });
    Ok(WorkerHandle {
        events_rx,
        done_rx,
        pending_tx,
        finished: false,
    })
}

fn build_image_generator(
    app: &App,
    user_config: &crate::config::UserConfig,
) -> Result<ImageGenerator> {
    if app.image_provider.trim().is_empty() || app.image_model.trim().is_empty() {
        bail!("image generation is not configured");
    }
    let resolved = resolve_provider(
        &app.workspace.root,
        &app.workspace.project,
        user_config,
        &app.image_provider,
    )?;
    ImageGenerator::new(
        &app.image_provider,
        resolved.api_key,
        super::first_non_empty([
            Some(app.image_base_url.as_str()),
            Some(resolved.base_url.as_str()),
        ])
        .unwrap_or_default(),
        app.image_model.clone(),
    )
}

#[derive(Debug, Clone)]
enum Key {
    None,
    Char(char),
    Paste(String),
    Enter,
    ShiftEnter,
    AltEnter,
    CtrlJ,
    CtrlC,
    CtrlD,
    Esc,
    Backspace,
    Delete,
    Tab,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
}

struct TerminalGuard {
    original: libc::termios,
    stdout: io::Stdout,
    left: bool,
}

#[derive(Default)]
struct InputDecoder {
    buffer: Vec<u8>,
}

#[derive(Debug, Clone)]
enum SettingsRow {
    Section(&'static str),
    Choice {
        kind: &'static str,
        value: &'static str,
        title: &'static str,
        desc: &'static str,
    },
}

fn selector_rows(image: bool) -> Vec<&'static str> {
    let presets = if image { IMAGE_PRESETS } else { LLM_PRESETS };
    let mut rows = presets.to_vec();
    if image {
        rows.push("off");
    }
    rows.push("");
    rows
}

fn settings_rows() -> Vec<SettingsRow> {
    let mut rows = Vec::new();
    rows.push(SettingsRow::Section("Bash permissions"));
    rows.extend(
        BASH_ROWS
            .iter()
            .map(|(value, title, desc)| SettingsRow::Choice {
                kind: "bash",
                value,
                title,
                desc,
            }),
    );
    rows.push(SettingsRow::Section("Reasoning effort"));
    rows.extend(
        REASONING_ROWS
            .iter()
            .map(|(value, title, desc)| SettingsRow::Choice {
                kind: "reasoning",
                value,
                title,
                desc,
            }),
    );
    rows
}

fn previous_settings_cursor(rows: &[SettingsRow], mut cursor: usize) -> usize {
    if rows.is_empty() {
        return 0;
    }
    cursor = cursor.saturating_sub(1);
    while cursor > 0 && matches!(rows[cursor], SettingsRow::Section(_)) {
        cursor -= 1;
    }
    if matches!(rows[cursor], SettingsRow::Section(_)) {
        next_settings_cursor(rows, cursor)
    } else {
        cursor
    }
}

fn next_settings_cursor(rows: &[SettingsRow], mut cursor: usize) -> usize {
    if rows.is_empty() {
        return 0;
    }
    cursor = (cursor + 1).min(rows.len() - 1);
    while cursor + 1 < rows.len() && matches!(rows[cursor], SettingsRow::Section(_)) {
        cursor += 1;
    }
    cursor
}

fn settings_number_index(rows: &[SettingsRow], number: usize) -> Option<usize> {
    if number == 0 {
        return None;
    }
    let mut seen = 0usize;
    for (idx, row) in rows.iter().enumerate() {
        if matches!(row, SettingsRow::Choice { .. }) {
            seen += 1;
            if seen == number {
                return Some(idx);
            }
        }
    }
    None
}

impl InputDecoder {
    fn read_keys(&mut self) -> Result<Vec<Key>> {
        let mut bytes = [0u8; 512];
        let n = io::stdin().read(&mut bytes)?;
        if n == 0 {
            return Ok(vec![Key::None]);
        }
        self.buffer.extend_from_slice(&bytes[..n]);
        Ok(self.drain_keys())
    }

    fn drain_keys(&mut self) -> Vec<Key> {
        let mut keys = Vec::new();
        while !self.buffer.is_empty() {
            if let Some((key, consumed)) = parse_one_key(&self.buffer) {
                self.buffer.drain(..consumed);
                keys.push(key);
                continue;
            }
            match std::str::from_utf8(&self.buffer) {
                Ok(text) => {
                    let consumed = push_text_keys(text, &mut keys);
                    self.buffer.drain(..consumed);
                    if consumed == 0 {
                        self.buffer.clear();
                    }
                }
                Err(err) if err.valid_up_to() > 0 => {
                    let valid = err.valid_up_to();
                    let text = String::from_utf8_lossy(&self.buffer[..valid]);
                    let consumed = push_text_keys(&text, &mut keys).min(valid);
                    self.buffer.drain(..consumed);
                    if consumed == 0 {
                        self.buffer.drain(..valid);
                    }
                }
                Err(err) if err.error_len().is_some() => {
                    self.buffer
                        .drain(..err.valid_up_to() + err.error_len().unwrap_or(1));
                }
                Err(_) => break,
            }
        }
        keys
    }
}

fn push_text_keys(text: &str, keys: &mut Vec<Key>) -> usize {
    let mut consumed = 0usize;
    for ch in text.chars() {
        if ch == '\x1b'
            || matches!(
                ch,
                '\u{0003}' | '\u{0004}' | '\t' | '\n' | '\r' | '\u{007f}' | '\u{0008}'
            )
        {
            break;
        }
        consumed += ch.len_utf8();
        if !ch.is_control() {
            keys.push(Key::Char(ch));
        }
    }
    consumed
}

impl TerminalGuard {
    fn enter() -> Result<Self> {
        let fd = libc::STDIN_FILENO;
        let mut original = unsafe { std::mem::zeroed::<libc::termios>() };
        if unsafe { libc::tcgetattr(fd, &mut original) } != 0 {
            return Err(io::Error::last_os_error()).context("tcgetattr");
        }
        let mut raw = original;
        raw.c_lflag &= !(libc::ECHO | libc::ICANON | libc::ISIG | libc::IEXTEN);
        raw.c_iflag &= !(libc::IXON | libc::ICRNL | libc::BRKINT | libc::INPCK | libc::ISTRIP);
        raw.c_oflag &= !libc::OPOST;
        raw.c_cflag |= libc::CS8;
        raw.c_cc[libc::VMIN] = 0;
        raw.c_cc[libc::VTIME] = 1;
        if unsafe { libc::tcsetattr(fd, libc::TCSAFLUSH, &raw) } != 0 {
            return Err(io::Error::last_os_error()).context("tcsetattr raw");
        }
        let mut stdout = io::stdout();
        write!(stdout, "{HIDE_CURSOR}")?;
        stdout.flush()?;
        Ok(Self {
            original,
            stdout,
            left: false,
        })
    }

    fn leave(&mut self) -> Result<()> {
        if self.left {
            return Ok(());
        }
        write!(self.stdout, "{RESET}{SHOW_CURSOR}\r\n")?;
        self.stdout.flush()?;
        if unsafe { libc::tcsetattr(libc::STDIN_FILENO, libc::TCSAFLUSH, &self.original) } != 0 {
            return Err(io::Error::last_os_error()).context("restore terminal");
        }
        self.left = true;
        Ok(())
    }

    fn size(&self) -> (usize, usize) {
        let mut ws = unsafe { std::mem::zeroed::<libc::winsize>() };
        if unsafe { libc::ioctl(libc::STDOUT_FILENO, libc::TIOCGWINSZ, &mut ws) } == 0
            && ws.ws_col > 0
            && ws.ws_row > 0
        {
            (ws.ws_col as usize, ws.ws_row as usize)
        } else {
            (88, 24)
        }
    }

    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.stdout.write_all(bytes)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stdout.flush()
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = self.leave();
    }
}

fn input_ready(timeout: Duration) -> Result<bool> {
    let mut fds = libc::pollfd {
        fd: libc::STDIN_FILENO,
        events: libc::POLLIN,
        revents: 0,
    };
    let ms = timeout.as_millis().min(i32::MAX as u128) as i32;
    let rc = unsafe { libc::poll(&mut fds, 1, ms) };
    if rc < 0 {
        return Err(io::Error::last_os_error()).context("poll stdin");
    }
    Ok(rc > 0 && (fds.revents & libc::POLLIN) != 0)
}

fn parse_one_key(bytes: &[u8]) -> Option<(Key, usize)> {
    if bytes.is_empty() {
        return None;
    }
    match bytes[0] {
        3 => return Some((Key::CtrlC, 1)),
        4 => return Some((Key::CtrlD, 1)),
        9 => return Some((Key::Tab, 1)),
        10 => return Some((Key::CtrlJ, 1)),
        13 => return Some((Key::Enter, 1)),
        27 => {}
        127 | 8 => return Some((Key::Backspace, 1)),
        _ => return None,
    }

    if bytes.starts_with(b"\x1b[200~") {
        if let Some(end) = find_subslice(bytes, b"\x1b[201~") {
            let body = &bytes[6..end];
            return Some((
                Key::Paste(String::from_utf8_lossy(body).to_string()),
                end + 6,
            ));
        }
        return None;
    }
    for (seq, key) in [
        (b"\x1b[A".as_slice(), Key::Up),
        (b"\x1b[B".as_slice(), Key::Down),
        (b"\x1b[C".as_slice(), Key::Right),
        (b"\x1b[D".as_slice(), Key::Left),
        (b"\x1b[H".as_slice(), Key::Home),
        (b"\x1b[1~".as_slice(), Key::Home),
        (b"\x1b[F".as_slice(), Key::End),
        (b"\x1b[4~".as_slice(), Key::End),
        (b"\x1b[3~".as_slice(), Key::Delete),
        (b"\x1b[5~".as_slice(), Key::PageUp),
        (b"\x1b[6~".as_slice(), Key::PageDown),
        (b"\x1b\r".as_slice(), Key::AltEnter),
        (b"\x1b\n".as_slice(), Key::AltEnter),
        (b"\x1b[13;2u".as_slice(), Key::ShiftEnter),
    ] {
        if bytes.starts_with(seq) {
            return Some((key, seq.len()));
        }
    }
    if bytes[0] == 27 {
        if bytes.len() == 1 {
            return Some((Key::Esc, 1));
        }
        if !bytes[1..].starts_with(b"[") {
            return Some((Key::Esc, 1));
        }
        if !bytes[1].is_ascii() {
            return Some((Key::Esc, 1));
        }
    }
    None
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

fn push_transcript_block(out: &mut Vec<TranscriptLine>, lines: Vec<String>) {
    let mut wrote = false;
    for line in lines {
        out.push(TranscriptLine {
            text: line,
            block_start: !wrote,
        });
        wrote = true;
    }
    if !wrote {
        out.push(TranscriptLine {
            text: String::new(),
            block_start: true,
        });
    }
}

fn snap_scroll_to_block_start(lines: &[TranscriptLine], mut index: usize) -> usize {
    if lines.is_empty() {
        return 0;
    }
    index = index.min(lines.len() - 1);
    while index > 0 && !lines[index].block_start {
        index -= 1;
    }
    index
}

fn snap_scroll_to_next_block_start(lines: &[TranscriptLine], mut index: usize) -> usize {
    if lines.is_empty() {
        return 0;
    }
    index = index.min(lines.len() - 1);
    if lines[index].block_start {
        return index;
    }
    while index + 1 < lines.len() && !lines[index].block_start {
        index += 1;
    }
    if lines[index].block_start {
        index
    } else {
        snap_scroll_to_block_start(lines, index)
    }
}

fn wrap_text(text: &str, width: usize) -> Vec<String> {
    wrap_ansi(text, width.max(1), "")
}

fn wrap_text_with_indent(text: &str, width: usize) -> Vec<String> {
    let indent = leading_indent(text);
    let continuation = if indent.is_empty() {
        String::new()
    } else {
        format!("{indent}  ")
    };
    wrap_ansi(text, width.max(1), &continuation)
}

fn wrap_ansi(text: &str, width: usize, continuation: &str) -> Vec<String> {
    let plain_width = width.max(1);
    let mut out = Vec::new();
    for raw in text.split('\n') {
        let mut current = String::new();
        let mut col = 0usize;
        let mut chars = raw.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\x1b' {
                current.push(ch);
                for next in chars.by_ref() {
                    current.push(next);
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
                continue;
            }
            let w = ch.width().unwrap_or(0);
            if col > 0 && col + w > plain_width {
                out.push(current);
                current = continuation.to_string();
                col = display_width(continuation);
            }
            current.push(ch);
            col += w;
        }
        out.push(current);
    }
    out
}

fn render_tool_call_lines(name: &str, summary: &str, width: usize) -> Vec<String> {
    let prefix = format!("{GREEN}●{RESET} {BOLD}{name}{RESET}");
    let prefix_width = display_width(&prefix);
    let mut lines = Vec::new();
    if summary.trim().is_empty() {
        lines.push(prefix);
        return lines;
    }
    let gap = "  ";
    let available = width.saturating_sub(prefix_width + gap.len()).max(24);
    let summary_lines = wrap_summary(summary, available);
    for (idx, line) in summary_lines.into_iter().enumerate() {
        if idx == 0 {
            lines.push(format!("{prefix}{gap}{DIM}{line}{RESET}"));
        } else {
            lines.push(format!("  {DIM}{line}{RESET}"));
        }
    }
    lines
}

fn wrap_summary(summary: &str, width: usize) -> Vec<String> {
    let clean = summary.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in clean.split(' ') {
        let word_width = display_width(word);
        if word_width > width {
            if !current.is_empty() {
                lines.push(std::mem::take(&mut current));
            }
            lines.extend(split_visible(word, width));
            continue;
        }
        let current_width = display_width(&current);
        if current.is_empty() {
            current.push_str(word);
        } else if current_width + 1 + word_width <= width {
            current.push(' ');
            current.push_str(word);
        } else {
            lines.push(std::mem::take(&mut current));
            current.push_str(word);
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn split_visible(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut col = 0usize;
    for ch in text.chars() {
        let w = ch.width().unwrap_or(0);
        if col > 0 && col + w > width {
            lines.push(std::mem::take(&mut current));
            col = 0;
        }
        current.push(ch);
        col += w;
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines
}

fn leading_indent(text: &str) -> String {
    strip_ansi(text)
        .chars()
        .take_while(|ch| *ch == ' ' || *ch == '\t')
        .collect()
}

fn fit_line(line: &str, width: usize) -> String {
    let mut out = String::new();
    let mut col = 0usize;
    let mut saw_ansi = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            saw_ansi = true;
            out.push(ch);
            for next in chars.by_ref() {
                out.push(next);
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        let w = ch.width().unwrap_or(0);
        if col + w > width {
            break;
        }
        out.push(ch);
        col += w;
    }
    if saw_ansi && !out.ends_with(RESET) {
        out.push_str(RESET);
    }
    if col < width {
        out.push_str(&" ".repeat(width - col));
    }
    out
}

fn render_input_with_cursor(input: &str, cursor: usize) -> String {
    let mut out = String::new();
    let mut inserted = false;
    for (idx, ch) in input.char_indices() {
        if idx == cursor {
            out.push_str("\x1b[7m");
            out.push(ch);
            out.push_str(RESET);
            inserted = true;
        } else {
            out.push(ch);
        }
    }
    if !inserted {
        out.push_str("\x1b[7m \x1b[0m");
    }
    out
}

fn display_width(text: &str) -> usize {
    strip_ansi(text).width()
}

fn join_status_line(left: &str, right: &str, width: usize) -> String {
    let left_width = display_width(left);
    let right_width = display_width(right);
    if left_width + right_width + 1 <= width {
        return format!(
            "{}{}{}",
            left,
            " ".repeat(width - left_width - right_width),
            right
        );
    }
    if right_width + 2 >= width {
        return fit_line(right, width);
    }
    let keep = width.saturating_sub(right_width + 3);
    let mut trimmed = truncate_visible(left, keep);
    trimmed.push('…');
    format!(
        "{}{}{}",
        trimmed,
        " ".repeat(width.saturating_sub(display_width(&trimmed) + right_width)),
        right
    )
}

fn truncate_visible(text: &str, width: usize) -> String {
    let mut out = String::new();
    let mut col = 0usize;
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' {
            out.push(ch);
            for next in chars.by_ref() {
                out.push(next);
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
            continue;
        }
        let w = ch.width().unwrap_or(0);
        if col + w > width {
            break;
        }
        out.push(ch);
        col += w;
    }
    out
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\x1b' && chars.peek() == Some(&'[') {
            let _ = chars.next();
            for next in chars.by_ref() {
                if next.is_ascii_alphabetic() {
                    break;
                }
            }
        } else {
            out.push(ch);
        }
    }
    out
}

fn format_elapsed(d: Duration) -> String {
    let secs = d.as_secs();
    format!("{}:{:02}", secs / 60, secs % 60)
}

fn short_int(n: u64) -> String {
    if n < 1000 {
        n.to_string()
    } else if n < 100_000 {
        format!("{:.1}k", n as f64 / 1000.0)
    } else {
        format!("{}k", n / 1000)
    }
}

fn print_osc52(text: &str) -> Result<()> {
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    eprint!("\x1b]52;c;{}\x07", encoded);
    io::stderr().flush()?;
    Ok(())
}
