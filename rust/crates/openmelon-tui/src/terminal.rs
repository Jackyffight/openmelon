use std::path::PathBuf;

use anyhow::{Context, Result};
use rustyline::completion::{Completer, Pair};
use rustyline::config::{BellStyle, CompletionType};
use rustyline::error::ReadlineError;
use rustyline::highlight::Highlighter;
use rustyline::hint::{Hint, Hinter};
use rustyline::validate::Validator;
use rustyline::{
    Cmd, Config, Context as RustyContext, Editor, Event, Helper, KeyCode, KeyEvent, Modifiers,
};

pub enum Input {
    Line(String),
    Interrupted,
    Eof,
}

pub struct LineEditor {
    editor: Editor<OpenMelonHelper, rustyline::history::DefaultHistory>,
    history_file: PathBuf,
}

impl LineEditor {
    pub fn new(history_file: PathBuf) -> Result<Self> {
        let config = Config::builder()
            .completion_type(CompletionType::List)
            .bell_style(BellStyle::None)
            .auto_add_history(false)
            .build();
        let mut editor = Editor::with_config(config).context("create line editor")?;
        editor.set_helper(Some(OpenMelonHelper::new()));
        editor.bind_sequence(KeyEvent::ctrl('J'), Cmd::Newline);
        editor.bind_sequence(
            Event::KeySeq(vec![KeyEvent(KeyCode::Enter, Modifiers::SHIFT)]),
            Cmd::Newline,
        );
        let _ = editor.load_history(&history_file);

        Ok(Self {
            editor,
            history_file,
        })
    }

    pub fn read(&mut self, prompt: &str) -> Result<Input> {
        match self.editor.readline(prompt) {
            Ok(line) => {
                if !line.trim().is_empty() {
                    let _ = self.editor.add_history_entry(line.as_str());
                    let _ = self.editor.save_history(&self.history_file);
                }

                Ok(Input::Line(line))
            }
            Err(ReadlineError::Interrupted) => Ok(Input::Interrupted),
            Err(ReadlineError::Eof) => Ok(Input::Eof),
            Err(err) => Err(err).context("read input"),
        }
    }
}

struct OpenMelonHelper {
    commands: Vec<SlashCommand>,
}

struct SlashCommand {
    name: &'static str,
    hint: &'static str,
}

struct OpenMelonHint {
    display: String,
    completion: String,
}

impl OpenMelonHelper {
    fn new() -> Self {
        Self {
            commands: slash_commands(),
        }
    }
}

impl Completer for OpenMelonHelper {
    type Candidate = Pair;

    fn complete(
        &self,
        line: &str,
        pos: usize,
        _ctx: &RustyContext<'_>,
    ) -> rustyline::Result<(usize, Vec<Self::Candidate>)> {
        let Some(prefix) = slash_prefix(line, pos) else {
            return Ok((0, Vec::new()));
        };
        let candidates = self
            .commands
            .iter()
            .filter(|command| command.name.starts_with(prefix))
            .map(|command| Pair {
                display: format!("{:<13} {}", command.name, command.hint),
                replacement: command.name.to_string(),
            })
            .collect::<Vec<_>>();
        Ok((0, candidates))
    }
}

impl Hinter for OpenMelonHelper {
    type Hint = OpenMelonHint;

    fn hint(&self, line: &str, pos: usize, _ctx: &RustyContext<'_>) -> Option<Self::Hint> {
        let prefix = slash_prefix(line, pos)?;
        if prefix == "/" {
            return None;
        }
        self.commands
            .iter()
            .find(|command| command.name.starts_with(prefix) && command.name != prefix)
            .map(|command| OpenMelonHint {
                display: command.name[prefix.len()..].to_string(),
                completion: command.name[prefix.len()..].to_string(),
            })
    }
}

impl Hint for OpenMelonHint {
    fn display(&self) -> &str {
        &self.display
    }

    fn completion(&self) -> Option<&str> {
        if self.completion.is_empty() {
            None
        } else {
            Some(&self.completion)
        }
    }
}

impl Highlighter for OpenMelonHelper {}

impl Validator for OpenMelonHelper {}

impl Helper for OpenMelonHelper {}

fn slash_prefix(line: &str, pos: usize) -> Option<&str> {
    if pos != line.len() {
        return None;
    }
    if !line.starts_with('/') || line.contains(char::is_whitespace) {
        return None;
    }
    Some(line)
}

fn slash_commands() -> Vec<SlashCommand> {
    vec![
        SlashCommand {
            name: "/help",
            hint: "show commands",
        },
        SlashCommand {
            name: "/status",
            hint: "show project/model status",
        },
        SlashCommand {
            name: "/history",
            hint: "render conversation history",
        },
        SlashCommand {
            name: "/clear",
            hint: "clear in-memory history",
        },
        SlashCommand {
            name: "/session",
            hint: "print session directory",
        },
        SlashCommand {
            name: "/save",
            hint: "save history as JSONL",
        },
        SlashCommand {
            name: "/copy",
            hint: "copy transcript via OSC52",
        },
        SlashCommand {
            name: "/events",
            hint: "show recent session events",
        },
        SlashCommand {
            name: "/model",
            hint: "switch LLM model",
        },
        SlashCommand {
            name: "/model-image",
            hint: "switch image model",
        },
        SlashCommand {
            name: "/settings",
            hint: "change settings",
        },
        SlashCommand {
            name: "/skill",
            hint: "apply a skillplus package",
        },
        SlashCommand {
            name: "/space",
            hint: "show creative space summary",
        },
        SlashCommand {
            name: "/compact",
            hint: "print compaction draft",
        },
        SlashCommand {
            name: "/exit",
            hint: "exit",
        },
        SlashCommand {
            name: "/quit",
            hint: "exit",
        },
        SlashCommand {
            name: "/q",
            hint: "exit",
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustyline::history::DefaultHistory;

    #[test]
    fn slash_prefix_requires_command_start() {
        assert_eq!(slash_prefix("/he", 3), Some("/he"));
        assert_eq!(slash_prefix(" /he", 4), None);
        assert_eq!(slash_prefix("/help now", 9), None);
    }

    #[test]
    fn slash_completion_matches_prefix() {
        let helper = OpenMelonHelper::new();
        let history = DefaultHistory::new();
        let ctx = RustyContext::new(&history);
        let (_start, candidates) = helper.complete("/mod", 4, &ctx).unwrap();

        assert!(candidates
            .iter()
            .any(|candidate| candidate.replacement == "/model"));
        assert!(candidates
            .iter()
            .any(|candidate| candidate.replacement == "/model-image"));
    }
}
