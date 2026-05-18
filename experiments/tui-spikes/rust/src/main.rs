use std::{
    io::{self, Write},
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

use anyhow::Result;
use crossterm::event::{KeyCode, KeyModifiers};
use nu_ansi_term::{Color, Style};
use reedline::{
    default_emacs_keybindings, Completer, DefaultPrompt, DefaultPromptSegment, DescriptionMenu,
    EditCommand, Emacs, ExternalPrinter, FileBackedHistory, MenuBuilder, Reedline, ReedlineEvent,
    ReedlineMenu, Signal, Span, Suggestion,
};

const COMMANDS: &[SlashCommand] = &[
    SlashCommand::new("/help", "show commands and keybindings"),
    SlashCommand::new("/status", "show model, reasoning, project, and tokens"),
    SlashCommand::new("/history", "print the simulated transcript"),
    SlashCommand::new("/clear", "clear the current spike transcript"),
    SlashCommand::new("/model", "switch the text model"),
    SlashCommand::new("/model-image", "switch the image model"),
    SlashCommand::new("/settings", "open settings"),
    SlashCommand::new("/copy", "copy transcript via OSC52 in production"),
    SlashCommand::new("/exit", "exit the spike"),
];

#[derive(Clone, Copy)]
struct SlashCommand {
    name: &'static str,
    description: &'static str,
}

impl SlashCommand {
    const fn new(name: &'static str, description: &'static str) -> Self {
        Self { name, description }
    }
}

#[derive(Default)]
struct SlashCompleter;

impl Completer for SlashCompleter {
    fn complete(&mut self, line: &str, pos: usize) -> Vec<Suggestion> {
        if pos != line.len() {
            return Vec::new();
        }

        let Some(prefix) = slash_prefix(line) else {
            return Vec::new();
        };

        COMMANDS
            .iter()
            .filter(|command| command.name.starts_with(prefix))
            .map(|command| Suggestion {
                value: command.name.to_string(),
                display_override: Some(command.name.to_string()),
                description: Some(command.description.to_string()),
                span: Span::new(0, prefix.len()),
                append_whitespace: true,
                ..Suggestion::default()
            })
            .collect()
    }
}

fn slash_prefix(line: &str) -> Option<&str> {
    let first_line = line.split('\n').next().unwrap_or_default();
    let trimmed = first_line.trim_start();
    if !trimmed.starts_with('/') || trimmed.contains(char::is_whitespace) {
        return None;
    }
    Some(trimmed)
}

fn main() -> Result<()> {
    print_banner()?;

    let printer = ExternalPrinter::<String>::new(512);
    let output = printer.clone();
    let mut line_editor = build_line_editor(printer)?;
    let prompt = DefaultPrompt::new(
        DefaultPromptSegment::Basic("OpenMelon".into()),
        DefaultPromptSegment::Basic("gpt-5.5 · xhigh · bigone".into()),
    );

    let mut quit_armed_until: Option<Instant> = None;
    let mut pending: Vec<String> = Vec::new();

    loop {
        match line_editor.read_line(&prompt)? {
            Signal::Success(input) => {
                quit_armed_until = None;
                let text = input.trim().to_string();
                if text.is_empty() {
                    continue;
                }
                if matches!(text.as_str(), "/exit" | "/quit" | "/q") {
                    break;
                }
                if text == "/help" {
                    print_help()?;
                    continue;
                }

                run_simulated_turn(&output, text, &mut pending)?;
            }
            Signal::CtrlC => {
                let now = Instant::now();
                if quit_armed_until.is_some_and(|until| now <= until) {
                    break;
                }
                quit_armed_until = Some(now + Duration::from_secs(2));
                println!(
                    "{}",
                    Color::Yellow.paint("input cleared; press Ctrl-C again within 2s to exit")
                );
            }
            Signal::CtrlD => break,
            Signal::ExternalBreak(input) => {
                if !input.trim().is_empty() {
                    pending.push(input);
                    println!(
                        "{}",
                        Color::Cyan.paint("external break queued current input")
                    );
                }
            }
            _ => {}
        }
    }

    println!("{}", Color::Fixed(8).paint("session saved at <spike>"));
    Ok(())
}

fn build_line_editor(printer: ExternalPrinter<String>) -> Result<Reedline> {
    let mut keybindings = default_emacs_keybindings();
    keybindings.add_binding(
        KeyModifiers::NONE,
        KeyCode::Tab,
        ReedlineEvent::UntilFound(vec![
            ReedlineEvent::Menu("slash_menu".to_string()),
            ReedlineEvent::MenuNext,
        ]),
    );
    keybindings.add_binding(
        KeyModifiers::CONTROL,
        KeyCode::Char('j'),
        ReedlineEvent::Edit(vec![EditCommand::InsertNewline]),
    );
    keybindings.add_binding(
        KeyModifiers::SHIFT,
        KeyCode::Enter,
        ReedlineEvent::Edit(vec![EditCommand::InsertNewline]),
    );
    keybindings.add_binding(
        KeyModifiers::NONE,
        KeyCode::Esc,
        ReedlineEvent::Edit(vec![EditCommand::Clear]),
    );

    let menu = DescriptionMenu::default()
        .with_name("slash_menu")
        .with_marker(" / ")
        .with_columns(1)
        .with_selection_rows(8)
        .with_description_rows(2)
        .with_text_style(Style::new().fg(Color::White))
        .with_selected_text_style(Style::new().fg(Color::Black).on(Color::Cyan))
        .with_description_text_style(Style::new().fg(Color::Fixed(8)));

    let history_path = PathBuf::from(".openmelon/tui-spike-rust-history.txt");
    let history = FileBackedHistory::with_file(200, history_path)?;

    Ok(Reedline::create()
        .use_bracketed_paste(true)
        .with_ansi_colors(true)
        .with_history(Box::new(history))
        .with_completer(Box::new(SlashCompleter))
        .with_menu(ReedlineMenu::EngineCompleter(Box::new(menu)))
        .with_edit_mode(Box::new(Emacs::new(keybindings)))
        .with_external_printer(printer)
        .with_poll_interval(Duration::from_millis(33)))
}

fn print_banner() -> Result<()> {
    let mut out = io::stdout();
    writeln!(
        out,
        "{}",
        Color::Cyan
            .bold()
            .paint("OpenMelon TUI Spike: Rust/reedline")
    )?;
    writeln!(
        out,
        "{}",
        Color::White.paint("project bigone · model gpt-5.5 · reasoning xhigh · normal scrollback")
    )?;
    writeln!(
        out,
        "{}",
        Color::Fixed(8).paint(
            "Type / then Tab for the command menu. Ctrl-J/Shift-Enter newline. Esc clears input."
        )
    )?;
    writeln!(out)?;
    out.flush()?;
    Ok(())
}

fn print_help() -> Result<()> {
    println!("{}", Color::Cyan.bold().paint("Commands"));
    for command in COMMANDS {
        println!(
            "  {}  {}",
            Color::Cyan.paint(command.name),
            Color::Fixed(8).paint(command.description)
        );
    }
    println!();
    Ok(())
}

fn run_simulated_turn(
    output: &ExternalPrinter<String>,
    text: String,
    pending: &mut Vec<String>,
) -> Result<()> {
    output.print(format!("{} {}", Color::Cyan.paint("›"), text))?;

    let sender = output.clone();
    let user_text = text.clone();
    let handle = thread::spawn(move || -> Result<()> {
        let long_line = "这是一段很长的中文输出，用来验证 resize、自动换行、复制和滚动行为；it also includes a very long English segment_that_should_wrap_without_breaking_the_prompt_or_overflowing_the_terminal_width.";
        let steps = [
            format!(
                "{} planning simulated creator workflow",
                Color::Green.paint("●")
            ),
            format!(" {}", long_line),
            format!(
                "{} bash  echo validating external printer and prompt redraw",
                Color::Green.paint("●")
            ),
            format!(
                "  {}",
                Color::Fixed(8).paint("tool result: ok; output stayed in scrollback")
            ),
            format!(
                "{} received: {}",
                Color::White.bold().paint("assistant"),
                user_text
            ),
        ];
        for step in steps {
            thread::sleep(Duration::from_millis(650));
            sender.print(step)?;
        }
        sender.print(String::new())?;
        Ok(())
    });

    // Keep the spike deterministic: the user can still type while the thread is
    // emitting output because reedline owns the active prompt and redraws it.
    handle.join().expect("simulated turn thread panicked")?;

    if !pending.is_empty() {
        let queued = std::mem::take(pending).join("\n\n");
        output.print(format!(
            "{} applying pending input at next model-call boundary",
            Color::Purple.paint("↳")
        ))?;
        run_simulated_turn(output, queued, pending)?;
    }

    Ok(())
}
