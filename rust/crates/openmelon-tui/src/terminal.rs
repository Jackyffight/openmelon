use std::path::PathBuf;

use anyhow::{Context, Result};
use rustyline::error::ReadlineError;
use rustyline::DefaultEditor;

pub enum Input {
    Line(String),
    Interrupted,
    Eof,
}

pub struct LineEditor {
    editor: DefaultEditor,
    history_file: PathBuf,
}

impl LineEditor {
    pub fn new(history_file: PathBuf) -> Result<Self> {
        let mut editor = DefaultEditor::new().context("create line editor")?;
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
