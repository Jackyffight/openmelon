#![allow(dead_code)]

use std::io::{self, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{Arc, Mutex};

use anyhow::{bail, Context, Result};
use base64::Engine;

use crate::config::{default_provider, load_user_config, resolve_provider};
use crate::image::ImageGenerator;
use crate::llm::{Message, OpenAIClient};
use crate::project::{set_project_default, set_project_setting, Workspace};
use crate::render::{
    divider, render_block, render_history as render_transcript_history, render_plain_transcript,
    Block, BlockKind,
};
use crate::runtime::{RunInput, Runtime};
use crate::session::{load_events, load_history, ProjectLayout, Session};
use crate::terminal::{Input, LineEditor};
use crate::tools::{ToolEnv, ToolRegistry};

mod event_tui;

#[derive(Debug, Clone)]
pub struct AppOptions {
    pub workdir: PathBuf,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub reasoning_effort: Option<String>,
    pub image_provider: Option<String>,
    pub image_model: Option<String>,
    pub image_base_url: Option<String>,
    pub max_steps: usize,
}

pub struct App {
    workspace: Workspace,
    editor: LineEditor,
    options: AppOptions,
    resumed_from: Option<String>,
    initial_history: Vec<Message>,
    provider: String,
    model: String,
    base_url: String,
    reasoning_effort: String,
    image_provider: String,
    image_model: String,
    image_base_url: String,
    active_skill: String,
    allowed_bash: Arc<Mutex<std::collections::BTreeSet<String>>>,
}

pub struct DemoApp {
    layout: ProjectLayout,
    editor: LineEditor,
    width: usize,
}

impl App {
    pub fn new(options: AppOptions, resumed_from: Option<String>) -> Result<Self> {
        let workspace = Workspace::discover(&options.workdir)?;
        let user_config = load_user_config()?;

        let mut provider = first_non_empty([
            options.provider.as_deref(),
            Some(workspace.project.defaults.llm_provider.as_str()),
            Some(user_config.defaults.llm_provider.as_str()),
        ])
        .unwrap_or_else(default_provider);
        if provider == "auto" {
            provider = default_provider();
        }
        let model = first_non_empty([
            options.model.as_deref(),
            Some(workspace.project.defaults.llm_model.as_str()),
            Some(user_config.defaults.llm_model.as_str()),
        ])
        .unwrap_or_default();
        let reasoning_effort = first_non_empty([
            options.reasoning_effort.as_deref(),
            Some(workspace.project.settings.reasoning_effort.as_str()),
            Some(user_config.defaults.reasoning_effort.as_str()),
        ])
        .unwrap_or_else(|| default_reasoning_effort(&provider, &model));
        let image_provider = first_non_empty([
            options.image_provider.as_deref(),
            Some(workspace.project.defaults.image_provider.as_str()),
            Some(user_config.defaults.image_provider.as_str()),
        ])
        .unwrap_or_default();
        let image_model = first_non_empty([
            options.image_model.as_deref(),
            Some(workspace.project.defaults.image_model.as_str()),
            Some(user_config.defaults.image_model.as_str()),
        ])
        .unwrap_or_default();

        let provider_resolution =
            resolve_provider(&workspace.root, &workspace.project, &user_config, &provider)?;
        let base_url = options
            .base_url
            .clone()
            .unwrap_or(provider_resolution.base_url);
        let image_base_url = options.image_base_url.clone().unwrap_or_default();
        let editor = LineEditor::new(workspace.state_dir().join("rust-tui-history.txt"))?;
        let initial_history = if let Some(id) = &resumed_from {
            load_history(&workspace.root, id).with_context(|| format!("resume {id}"))?
        } else {
            Vec::new()
        };

        Ok(Self {
            workspace,
            editor,
            options,
            resumed_from,
            initial_history,
            provider,
            model,
            base_url,
            reasoning_effort,
            image_provider,
            image_model,
            image_base_url,
            active_skill: String::new(),
            allowed_bash: Arc::new(Mutex::new(std::collections::BTreeSet::new())),
        })
    }

    pub fn run(self) -> Result<()> {
        self.run_plain()
    }

    pub fn run_event_tui(self) -> Result<()> {
        event_tui::run(self)
    }

    pub fn run_plain(mut self) -> Result<()> {
        let mut history = self.initial_history.clone();
        let mut session = self.create_session("interactive REPL")?;
        self.print_header(&session)?;
        if !history.is_empty() {
            println!("loaded {} prior messages", history.len());
            render_history(&history);
        }

        loop {
            match self.editor.read("› ")? {
                Input::Line(line) => {
                    let text = line.trim();
                    if text.is_empty() {
                        continue;
                    }
                    if text.starts_with('/') {
                        if self.handle_slash(text, &mut history, &session)? {
                            break;
                        }
                        continue;
                    }
                    let user_text = self.apply_active_skill(text);
                    let result = self.run_turn(&mut session, user_text, history)?;
                    history = result;
                }
                Input::Interrupted => {
                    println!("input cleared");
                }
                Input::Eof => break,
            }
        }

        Ok(())
    }

    pub fn run_one_shot(self, prompt: String) -> Result<()> {
        let history = self.initial_history.clone();
        let mut session = self.create_session(&prompt.chars().take(80).collect::<String>())?;
        let _ = self.run_turn(&mut session, prompt, history)?;
        Ok(())
    }

    fn create_session(&self, intent: &str) -> Result<Session> {
        Session::create(
            &self.workspace.root,
            &self.workspace.project.id,
            intent,
            self.resumed_from.as_deref(),
        )
    }

    fn run_turn(
        &self,
        session: &mut Session,
        prompt: String,
        history: Vec<Message>,
    ) -> Result<Vec<Message>> {
        if self.provider == "anthropic" {
            bail!("Rust runtime does not support Anthropic yet; use openai/openrouter for this branch");
        }
        let user_config = load_user_config()?;
        let llm_res = resolve_provider(
            &self.workspace.root,
            &self.workspace.project,
            &user_config,
            &self.provider,
        )?;
        let llm = OpenAIClient::new(
            &self.provider,
            llm_res.api_key,
            first_non_empty([
                Some(self.base_url.as_str()),
                Some(llm_res.base_url.as_str()),
            ])
            .unwrap_or_default(),
            self.model.clone(),
        )?;

        session.set_runtime_info(llm.provider(), llm.model())?;
        session.append_prompt("user", &prompt)?;

        let image = self.build_image_generator(&user_config).ok();
        let tool_env = ToolEnv {
            workspace: self.workspace.clone(),
            session_id: session.id.clone(),
            session_dir: session.dir.clone(),
            image,
            bash_mode: effective_bash_mode(&self.workspace.project.settings.bash_permission_mode),
            allowed_bash: self.allowed_bash.clone(),
            approve_bash: None,
        };
        let registry = ToolRegistry::standard(&tool_env);
        let system_prompt = build_project_system_prompt(&self.workspace, &registry.names());
        self.print_context_status(&registry, &tool_env);
        let mut runtime = Runtime {
            llm,
            registry,
            env: tool_env,
            max_steps: self.options.max_steps,
            reasoning_effort: self.reasoning_effort.clone(),
            drain_user_input: None,
            events: None,
        };

        let history_len = history.len();
        let result = runtime.run(
            RunInput {
                system_prompt,
                user_input: prompt,
                history,
            },
            session,
        )?;
        let delta = if history_len <= result.messages.len() {
            &result.messages[history_len..]
        } else {
            result.messages.as_slice()
        };
        session.append_messages(delta)?;
        session.write_summary(
            &result.finish_summary,
            &result.finish_artifacts,
            result.finished,
        )?;
        println!("session {}", session.id);
        Ok(result.messages)
    }

    fn build_image_generator(
        &self,
        user_config: &crate::config::UserConfig,
    ) -> Result<ImageGenerator> {
        if self.image_provider.trim().is_empty() || self.image_model.trim().is_empty() {
            bail!("image generation is not configured");
        }
        let resolved = resolve_provider(
            &self.workspace.root,
            &self.workspace.project,
            user_config,
            &self.image_provider,
        )?;
        ImageGenerator::new(
            &self.image_provider,
            resolved.api_key,
            first_non_empty([
                Some(self.image_base_url.as_str()),
                Some(resolved.base_url.as_str()),
            ])
            .unwrap_or_default(),
            self.image_model.clone(),
        )
    }

    fn print_header(&self, session: &Session) -> Result<()> {
        const RESET: &str = "\x1b[0m";
        const BOLD: &str = "\x1b[1m";
        const CYAN: &str = "\x1b[36m";

        println!("{BOLD}{CYAN}OpenMelon{RESET}");
        println!(
            "project · {} · {} · model {}:{} · reasoning {}",
            self.workspace.project.name,
            self.workspace.root.display(),
            self.provider,
            self.model,
            empty_as_auto(&self.reasoning_effort)
        );
        if !self.image_model.is_empty() {
            println!(
                "image · {}:{}",
                empty_as_none(&self.image_provider),
                self.image_model
            );
        }
        println!("outputs · {}", self.workspace.outputs_dir().display());
        println!("session {}", session.id);
        if let Some(resumed) = &self.resumed_from {
            println!("resumed from {resumed}");
        }
        println!("Type a request, /help for commands, Ctrl-C clears input, Ctrl-D exits.");
        println!();
        io::stdout().flush()?;
        Ok(())
    }

    fn handle_slash(
        &mut self,
        text: &str,
        history: &mut Vec<Message>,
        session: &Session,
    ) -> Result<bool> {
        let parts = text.split_whitespace().collect::<Vec<_>>();
        match parts.first().copied().unwrap_or_default() {
            "/exit" | "/quit" | "/q" => Ok(true),
            "/help" => {
                println!("  /help       show commands");
                println!("  /status     show project/model status");
                println!("  /history    render current conversation history");
                println!("  /clear      clear in-memory conversation history");
                println!("  /session    print current session directory");
                println!("  /save PATH  save current history as JSONL");
                println!("  /copy       print OSC52 clipboard sequence for transcript");
                println!("  /events     show recent session events");
                println!("  /model ID   switch LLM model and persist project default");
                println!("  /model-image off | [PROVIDER] MODEL");
                println!("  /settings bash strict|auto|trusted");
                println!("  /settings reasoning auto|medium|high|xhigh");
                println!("  /skill      list skills");
                println!("  /skill ID   apply a skillplus package to the next message");
                println!("  /space ID   show a creative space summary");
                println!("  /compact ID print a compaction draft");
                println!("  /exit       exit");
                Ok(false)
            }
            "/status" => {
                println!(
                    "project: {} ({})",
                    self.workspace.project.name, self.workspace.project.id
                );
                println!(
                    "model: {}:{} reasoning={}",
                    self.provider,
                    self.model,
                    empty_as_auto(&self.reasoning_effort)
                );
                println!("outputs: {}", self.workspace.outputs_dir().display());
                Ok(false)
            }
            "/history" => {
                render_history(history);
                Ok(false)
            }
            "/clear" => {
                history.clear();
                println!("history cleared");
                Ok(false)
            }
            "/session" => {
                println!("{}", session.dir.display());
                Ok(false)
            }
            "/save" => {
                let Some(path) = parts.get(1) else {
                    bail!("/save: usage /save <path>");
                };
                save_history_jsonl(history, path)?;
                println!("saved {} messages -> {}", history.len(), path);
                Ok(false)
            }
            "/copy" => {
                let text = plain_transcript(history);
                if text.trim().is_empty() {
                    println!("nothing to copy");
                } else {
                    print_osc52(&text)?;
                    println!("copied transcript ({} chars)", text.chars().count());
                }
                Ok(false)
            }
            "/events" => {
                let events = load_events(&session.dir, 20)?;
                if events.is_empty() {
                    println!("(no events recorded yet)");
                } else {
                    for event in events {
                        println!("{}", serde_json::to_string(&event)?);
                    }
                }
                Ok(false)
            }
            "/model" => {
                let Some(model) = parts.get(1) else {
                    bail!("/model: usage /model <model-id>");
                };
                self.model = (*model).to_string();
                set_project_default(&self.workspace.root, "llm_model", &self.model)?;
                println!("model: {}:{}", self.provider, self.model);
                Ok(false)
            }
            "/model-image" => {
                if parts.get(1).is_none() {
                    bail!("/model-image: usage /model-image off | [provider] <model-id>");
                }
                if matches!(parts.get(1), Some(&"off" | &"disable" | &"none")) {
                    self.image_provider.clear();
                    self.image_model.clear();
                    set_project_default(&self.workspace.root, "image_provider", "")?;
                    set_project_default(&self.workspace.root, "image_model", "")?;
                    println!("image generation disabled");
                    return Ok(false);
                }
                let (provider, model) = if parts.len() >= 3 {
                    (parts[1], parts[2])
                } else {
                    (
                        if self.image_provider.is_empty() {
                            self.provider.as_str()
                        } else {
                            self.image_provider.as_str()
                        },
                        parts[1],
                    )
                };
                self.image_provider = provider.to_string();
                self.image_model = model.to_string();
                set_project_default(&self.workspace.root, "image_provider", &self.image_provider)?;
                set_project_default(&self.workspace.root, "image_model", &self.image_model)?;
                println!("image model: {}:{}", self.image_provider, self.image_model);
                Ok(false)
            }
            "/settings" => {
                self.handle_settings(&parts)?;
                Ok(false)
            }
            "/skill" => {
                self.handle_skill(&parts)?;
                Ok(false)
            }
            "/space" => {
                self.print_space(&parts)?;
                Ok(false)
            }
            "/compact" => {
                self.print_compact(&parts)?;
                Ok(false)
            }
            other => {
                println!(
                    "{}",
                    render_block(
                        &Block {
                            kind: BlockKind::Error,
                            body: format!("unknown command: {other}"),
                        },
                        88,
                    )
                );
                Ok(false)
            }
        }
    }

    fn apply_active_skill(&mut self, text: &str) -> String {
        if self.active_skill.is_empty() {
            return text.to_string();
        }
        let skill = std::mem::take(&mut self.active_skill);
        format!(
            "Apply the skill {skill:?} to this request: first call compile_skill with skill={skill:?} (BARE slug, no 'skillplus:' prefix) to fetch the package's prompt + output schema, then proceed.\n\n{text}"
        )
    }

    fn handle_skill(&mut self, parts: &[&str]) -> Result<()> {
        if parts.len() == 1 {
            let skills = list_skillplus()?;
            if skills.is_empty() {
                println!("(no skillplus packages found)");
            } else {
                for skill in skills {
                    println!(
                        "  {}  {}",
                        skill
                            .get("id")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("<unknown>"),
                        skill
                            .get("description")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("")
                    );
                }
            }
            println!("usage: /skill <id> or /skill clear");
            return Ok(());
        }
        let arg = parts[1];
        if matches!(arg, "clear" | "off" | "none") {
            self.active_skill.clear();
            println!("skill cleared");
            return Ok(());
        }
        self.active_skill = arg.to_string();
        println!("skill: {} applies to your next message", self.active_skill);
        Ok(())
    }

    fn print_space(&self, parts: &[&str]) -> Result<()> {
        let Some(space_id) = parts.get(1) else {
            bail!("/space: usage /space <id>");
        };
        let tool_env = self.tool_env(None, "");
        let packet = ToolRegistry::standard(&tool_env).dispatch(
            &tool_env,
            "get_context_packet",
            serde_json::json!({ "space_id": space_id }),
        )?;
        if let Some(err) = packet.get("error").and_then(serde_json::Value::as_str) {
            bail!("/space: {err}");
        }
        let space = packet.get("space").cloned().unwrap_or_default();
        println!(
            "{} ({}) {}",
            space
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(*space_id),
            space
                .get("status")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown"),
            space
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
        );
        println!(
            "  {} decisions · {} feedback · {} episodes · {} assets",
            packet
                .get("recent_decisions")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len)
                .unwrap_or(0),
            packet
                .get("recent_feedback")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len)
                .unwrap_or(0),
            packet
                .get("recent_episodes")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len)
                .unwrap_or(0),
            packet
                .get("assets")
                .and_then(serde_json::Value::as_array)
                .map(Vec::len)
                .unwrap_or(0)
        );
        Ok(())
    }

    fn print_compact(&self, parts: &[&str]) -> Result<()> {
        let Some(space_id) = parts.get(1) else {
            bail!("/compact: usage /compact <space-id>");
        };
        let tool_env = self.tool_env(None, "");
        let packet = ToolRegistry::standard(&tool_env).dispatch(
            &tool_env,
            "get_context_packet",
            serde_json::json!({ "space_id": space_id }),
        )?;
        if let Some(err) = packet.get("error").and_then(serde_json::Value::as_str) {
            bail!("/compact: {err}");
        }
        println!("{}", render_compaction_draft(&packet));
        Ok(())
    }

    fn handle_settings(&mut self, parts: &[&str]) -> Result<()> {
        if parts.len() == 1 {
            println!(
                "bash_permission_mode: {}",
                effective_bash_mode(&self.workspace.project.settings.bash_permission_mode)
            );
            println!(
                "reasoning_effort: {}",
                empty_as_auto(&self.reasoning_effort)
            );
            return Ok(());
        }
        match parts.get(1).copied() {
            Some("bash") => {
                let Some(mode) = parts.get(2).copied() else {
                    bail!("/settings bash: expected strict|auto|trusted");
                };
                if !matches!(mode, "strict" | "auto" | "trusted") {
                    bail!("/settings bash: expected strict|auto|trusted");
                }
                set_project_setting(&self.workspace.root, "bash_permission_mode", mode)?;
                self.workspace.project.settings.bash_permission_mode = mode.to_string();
                println!("bash_permission_mode: {mode}");
            }
            Some("reasoning") => {
                let Some(effort) = parts.get(2).copied() else {
                    bail!("/settings reasoning: expected auto|medium|high|xhigh");
                };
                if effort == "auto" {
                    set_project_setting(&self.workspace.root, "reasoning_effort", "")?;
                    self.reasoning_effort = default_reasoning_effort(&self.provider, &self.model);
                    println!(
                        "reasoning_effort: {}",
                        empty_as_auto(&self.reasoning_effort)
                    );
                } else {
                    if !matches!(effort, "medium" | "high" | "xhigh") {
                        bail!("/settings reasoning: expected auto|medium|high|xhigh");
                    }
                    set_project_setting(&self.workspace.root, "reasoning_effort", effort)?;
                    self.reasoning_effort = effort.to_string();
                    println!("reasoning_effort: {}", self.reasoning_effort);
                }
            }
            _ => bail!("/settings: expected bash or reasoning"),
        }
        Ok(())
    }

    fn tool_env(&self, session: Option<&Session>, session_id: &str) -> ToolEnv {
        ToolEnv {
            workspace: self.workspace.clone(),
            session_id: session
                .map(|s| s.id.clone())
                .unwrap_or_else(|| session_id.to_string()),
            session_dir: session
                .map(|s| s.dir.clone())
                .unwrap_or_else(|| self.workspace.state_dir().join("sessions")),
            image: None,
            bash_mode: effective_bash_mode(&self.workspace.project.settings.bash_permission_mode),
            allowed_bash: self.allowed_bash.clone(),
            approve_bash: None,
        }
    }

    fn print_context_status(&self, registry: &ToolRegistry, env: &ToolEnv) {
        let Ok(spaces) = registry.dispatch(env, "list_spaces", serde_json::json!({})) else {
            return;
        };
        let Some(items) = spaces.as_array() else {
            return;
        };
        if items.is_empty() {
            return;
        }
        println!("continuity: {} creative spaces available", items.len());
    }
}

impl DemoApp {
    pub fn new(workdir: PathBuf) -> Result<Self> {
        let layout = ProjectLayout::discover(workdir)?;
        let editor = LineEditor::new(layout.history_file())?;
        let width = terminal_width();

        Ok(Self {
            layout,
            editor,
            width,
        })
    }

    pub fn run_demo(mut self) -> Result<()> {
        self.print_header()?;

        loop {
            match self.editor.read("> ")? {
                Input::Line(line) => {
                    let command = line.trim();

                    if command.is_empty() {
                        continue;
                    }

                    match command {
                        "/quit" | "/exit" => break,
                        "/help" => self.print_help()?,
                        "/status" => self.print_status()?,
                        "/tool" => self.print_tool_demo()?,
                        "/error" => self.print_error_demo()?,
                        _ => self.print_assistant_echo(command)?,
                    }
                }
                Input::Interrupted => {
                    println!("input cleared");
                }
                Input::Eof => break,
            }
        }

        Ok(())
    }

    fn print_header(&self) -> Result<()> {
        println!("openmelon rust tui demo");
        println!("{}", divider(self.width));
        println!("project: {}", self.layout.root().display());
        println!("outputs: {}", self.layout.outputs_dir().display());
        println!("type /help for commands, Ctrl-D to exit");
        println!();
        io::stdout().flush()?;
        Ok(())
    }

    fn print_help(&self) -> Result<()> {
        self.print_block(BlockKind::Assistant, DEMO_HELP)
    }

    fn print_status(&self) -> Result<()> {
        self.print_block(
            BlockKind::Assistant,
            &format!(
                "# Status\n\n- Project: `{}`\n- Outputs: `{}`\n- TUI mode: normal scrollback prototype",
                self.layout.root().display(),
                self.layout.outputs_dir().display()
            ),
        )
    }

    fn print_tool_demo(&self) -> Result<()> {
        self.print_block(
            BlockKind::Tool,
            "image_generate: writing visible creator output to outputs/artifacts/demo",
        )
    }

    fn print_error_demo(&self) -> Result<()> {
        self.print_block(
            BlockKind::Error,
            "This is an error block demo. Runtime errors and model/tool failures should use this visual channel.",
        )
    }

    fn print_assistant_echo(&self, input: &str) -> Result<()> {
        self.print_block(
            BlockKind::Assistant,
            &format!(
                "# Draft turn\n\nThis Rust prototype received:\n\n> {}\n\n- Transcript output stays in normal terminal scrollback, so resize, selection, and copying remain native.\n- Runtime/model integration will be added after the TUI contract is stable.",
                input
            ),
        )
    }

    fn print_block(&self, kind: BlockKind, body: &str) -> Result<()> {
        println!();
        println!("{}", divider(self.width));
        println!(
            "{}",
            render_block(
                &Block {
                    kind,
                    body: body.to_string()
                },
                self.width
            )
        );
        println!();
        io::stdout().flush()?;
        Ok(())
    }
}

impl App {
    pub fn new_demo(workdir: PathBuf) -> Result<DemoApp> {
        DemoApp::new(workdir)
    }
}

const DEMO_HELP: &str = r#"# Commands

- `/help` shows this help.
- `/status` prints project paths and current prototype mode.
- `/tool` prints a tool block demo.
- `/error` prints an error block demo.
- `/quit` exits the demo.

This crate keeps output in normal terminal scrollback so native copy, scroll, and resize behavior stay predictable."#;

fn build_project_system_prompt(workspace: &Workspace, tool_names: &[String]) -> String {
    let p = &workspace.project;
    let mut out = String::new();
    out.push_str(
        "You are openmelon, a content-creation agent operating inside a creator's project.\n\n",
    );
    out.push_str(&format!("Project: {} ({})\n", p.name, p.id));
    if !p.description.trim().is_empty() {
        out.push_str(&format!("Description: {}\n", p.description));
    }
    if !p.persona.trim().is_empty() {
        out.push_str(&format!("Voice / persona: {}\n", p.persona));
    }
    if !p.constraints.is_empty() {
        out.push_str("House rules:\n");
        for constraint in &p.constraints {
            out.push_str(&format!("  - {}\n", constraint));
        }
    }
    out.push_str("\nWork like a senior creator operating a durable creative workspace. Decide whether the request starts a new creative space, continues an existing space, modifies canon, records feedback, plans future content, or produces an episode. Load known spaces, characters, references, typography, layout rules, and reusable assets before production. Treat typography as descriptive continuity context and image prompt constraints, not a local font lookup. User-facing deliverables must be saved in visible project output directories such as outputs/; .openmelon is reserved for internal state, sessions, config, and continuity data. When done, call finish with a short summary and final artifact paths or updated continuity state.\n");
    out.push_str("\nAvailable tools: ");
    out.push_str(&tool_names.join(", "));
    out.push('\n');
    out
}

fn render_history(messages: &[Message]) {
    print!(
        "{}",
        render_transcript_history(messages, 88, crate::render::TranscriptMode::Styled)
    );
}

fn save_history_jsonl(history: &[Message], path: &str) -> Result<()> {
    let mut file = std::fs::File::create(path)?;
    for message in history {
        serde_json::to_writer(&mut file, message)?;
        file.write_all(b"\n")?;
    }
    Ok(())
}

fn plain_transcript(history: &[Message]) -> String {
    render_plain_transcript(history, 88)
}

fn render_compaction_draft(packet: &serde_json::Value) -> String {
    let space = packet.get("space").cloned().unwrap_or_default();
    let name = space
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("Space");
    let id = space
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let status = space
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let mut out = String::new();
    out.push_str(&format!("# {name} Compaction\n\n"));
    out.push_str(&format!("Space: {id} ({status})\n"));

    let canon = packet
        .get("canon")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if !canon.is_empty() {
        out.push_str("\n## Canon\n");
        out.push_str(canon);
        out.push('\n');
    }

    push_compaction_rows(
        &mut out,
        "Confirmed Decisions",
        packet.get("recent_decisions"),
        |row| {
            let decision = row
                .get("decision")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let target = row
                .get("target")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if target.is_empty() {
                decision.to_string()
            } else {
                format!("{decision} [{target}]")
            }
        },
    );
    push_compaction_rows(
        &mut out,
        "Feedback Signals",
        packet.get("recent_feedback"),
        |row| {
            let signal = row
                .get("signal")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let recommendation = row
                .get("recommendation")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            if recommendation.is_empty() {
                signal.to_string()
            } else {
                format!("{signal}: {recommendation}")
            }
        },
    );
    push_compaction_rows(&mut out, "Reusable Assets", packet.get("assets"), |row| {
        let asset_id = row
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let status = row
            .get("status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let weight = row
            .get("weight")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        let description = row
            .get("description")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        format!("{asset_id} ({status}, weight {weight:.2}): {description}")
    });
    push_compaction_rows(
        &mut out,
        "Recent Episodes",
        packet.get("recent_episodes"),
        |row| {
            let episode_id = row
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let topic = first_non_empty([
                row.get("topic").and_then(serde_json::Value::as_str),
                row.get("title").and_then(serde_json::Value::as_str),
            ])
            .unwrap_or_default();
            format!("{episode_id}: {topic}")
        },
    );

    out.trim().to_string()
}

fn push_compaction_rows(
    out: &mut String,
    title: &str,
    rows: Option<&serde_json::Value>,
    render: impl Fn(&serde_json::Value) -> String,
) {
    let Some(rows) = rows.and_then(serde_json::Value::as_array) else {
        return;
    };
    if rows.is_empty() {
        return;
    }
    out.push_str(&format!("\n## {title}\n"));
    for row in rows {
        let text = render(row);
        if !text.trim().is_empty() {
            out.push_str(&format!("- {text}\n"));
        }
    }
}

fn print_osc52(text: &str) -> Result<()> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    eprint!("\x1b]52;c;{}\x07", encoded);
    io::stderr().flush()?;
    Ok(())
}

fn list_skillplus() -> Result<Vec<serde_json::Value>> {
    let output = Command::new("skillplus").arg("list").arg("--json").output();
    let Ok(output) = output else {
        return Ok(Vec::new());
    };
    if !output.status.success() {
        return Ok(Vec::new());
    }
    let skills = serde_json::from_slice(&output.stdout)?;
    Ok(skills)
}

fn first_non_empty<'a>(values: impl IntoIterator<Item = Option<&'a str>>) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn default_reasoning_effort(provider: &str, model: &str) -> String {
    let p = provider.to_ascii_lowercase();
    let m = model.to_ascii_lowercase();
    if (p == "openai" || p == "openrouter") && (m.starts_with("gpt-5") || m.contains("/gpt-5")) {
        "xhigh".to_string()
    } else {
        String::new()
    }
}

fn effective_bash_mode(value: &str) -> String {
    match value {
        "auto" | "trusted" => value.to_string(),
        _ => "strict".to_string(),
    }
}

fn empty_as_auto(value: &str) -> &str {
    if value.is_empty() {
        "auto"
    } else {
        value
    }
}

fn empty_as_none(value: &str) -> &str {
    if value.is_empty() {
        "none"
    } else {
        value
    }
}

fn terminal_width() -> usize {
    std::env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(88)
}
