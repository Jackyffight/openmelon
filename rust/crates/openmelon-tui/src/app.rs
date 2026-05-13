use std::io::{self, Write};
use std::path::PathBuf;

use anyhow::Result;

use crate::render::{divider, render_block, Block, BlockKind};
use crate::session::ProjectLayout;
use crate::terminal::{Input, LineEditor};

pub struct App {
    layout: ProjectLayout,
    editor: LineEditor,
    width: usize,
}

impl App {
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

    pub fn run(mut self) -> Result<()> {
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
        println!("openmelon rust tui");
        println!("{}", divider(self.width));
        println!("project: {}", self.layout.root().display());
        println!("outputs: {}", self.layout.outputs_dir().display());
        println!("type /help for commands, Ctrl-D to exit");
        println!();
        io::stdout().flush()?;
        Ok(())
    }

    fn print_help(&self) -> Result<()> {
        self.print_block(BlockKind::Assistant, HELP)
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

const HELP: &str = r#"# Commands

- `/help` shows this help.
- `/status` prints project paths and current prototype mode.
- `/tool` prints a tool block demo.
- `/error` prints an error block demo.
- `/quit` exits the demo.

This crate is the first Rust TUI slice. It deliberately keeps output in normal terminal scrollback so native copy, scroll, and resize behavior stay predictable."#;

fn terminal_width() -> usize {
    std::env::var("COLUMNS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(88)
}
