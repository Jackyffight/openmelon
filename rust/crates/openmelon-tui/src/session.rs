use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::{macros::format_description, OffsetDateTime};

use crate::llm::Message;

#[derive(Debug, Clone)]
pub struct ProjectLayout {
    root: PathBuf,
    state_dir: PathBuf,
    outputs_dir: PathBuf,
}

impl ProjectLayout {
    pub fn discover(workdir: impl AsRef<Path>) -> Result<Self> {
        let root = workdir
            .as_ref()
            .canonicalize()
            .with_context(|| format!("resolve project root {}", workdir.as_ref().display()))?;
        let state_dir = root.join(".openmelon");
        let outputs_dir = root.join("outputs");

        fs::create_dir_all(&state_dir)
            .with_context(|| format!("create state dir {}", state_dir.display()))?;
        fs::create_dir_all(&outputs_dir)
            .with_context(|| format!("create outputs dir {}", outputs_dir.display()))?;

        Ok(Self {
            root,
            state_dir,
            outputs_dir,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn history_file(&self) -> PathBuf {
        self.state_dir.join("rust-tui-history.txt")
    }

    pub fn outputs_dir(&self) -> &Path {
        &self.outputs_dir
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Meta {
    pub version: u8,
    pub id: String,
    pub project_id: String,
    pub intent: String,
    pub started_at: String,
    #[serde(default)]
    pub workspace_root: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub resumed_from: String,
}

pub struct Session {
    pub id: String,
    pub dir: PathBuf,
    workdir: PathBuf,
    project_id: String,
    intent: String,
    started_at: OffsetDateTime,
    provider: String,
    model: String,
    resumed_from: String,
    messages: File,
}

impl Session {
    pub fn create(
        workdir: &Path,
        project_id: &str,
        intent: &str,
        resumed_from: Option<&str>,
    ) -> Result<Self> {
        let now = OffsetDateTime::now_utc();
        let id = format!(
            "{}-{}",
            now.format(format_description!(
                "[year][month][day]-[hour][minute][second]"
            ))?,
            short_id()
        );
        let dir = workdir.join(".openmelon").join("sessions").join(&id);
        fs::create_dir_all(&dir)
            .with_context(|| format!("create session dir {}", dir.display()))?;

        let messages = OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("messages.jsonl"))
            .with_context(|| format!("open {}", dir.join("messages.jsonl").display()))?;

        let session = Self {
            id,
            dir,
            workdir: workdir.to_path_buf(),
            project_id: project_id.to_string(),
            intent: intent.to_string(),
            started_at: now,
            provider: String::new(),
            model: String::new(),
            resumed_from: resumed_from.unwrap_or_default().to_string(),
            messages,
        };
        session.write_meta()?;
        Ok(session)
    }

    pub fn set_runtime_info(&mut self, provider: &str, model: &str) -> Result<()> {
        self.provider = provider.to_string();
        self.model = model.to_string();
        self.write_meta()
    }

    pub fn fork_writer(&self) -> Result<Self> {
        let messages = OpenOptions::new()
            .create(true)
            .append(true)
            .open(self.dir.join("messages.jsonl"))
            .with_context(|| format!("open {}", self.dir.join("messages.jsonl").display()))?;
        Ok(Self {
            id: self.id.clone(),
            dir: self.dir.clone(),
            workdir: self.workdir.clone(),
            project_id: self.project_id.clone(),
            intent: self.intent.clone(),
            started_at: self.started_at,
            provider: self.provider.clone(),
            model: self.model.clone(),
            resumed_from: self.resumed_from.clone(),
            messages,
        })
    }

    pub fn append_prompt(&self, kind: &str, content: &str) -> Result<()> {
        if content.trim().is_empty() {
            return Ok(());
        }
        append_jsonl(
            &self.dir.join("prompt_history.jsonl"),
            &serde_json::json!({
                "at": OffsetDateTime::now_utc().format(&Rfc3339)?,
                "kind": if kind.trim().is_empty() { "user" } else { kind },
                "content": content.trim(),
            }),
        )
    }

    #[allow(dead_code)]
    pub fn append_event(&self, event_type: &str, value: serde_json::Value) -> Result<()> {
        let mut obj = match value {
            serde_json::Value::Object(map) => map,
            other => {
                let mut map = serde_json::Map::new();
                map.insert("detail".to_string(), other);
                map
            }
        };
        obj.insert(
            "at".to_string(),
            serde_json::json!(OffsetDateTime::now_utc().format(&Rfc3339)?),
        );
        obj.insert("type".to_string(), serde_json::json!(event_type));
        append_jsonl(
            &self.dir.join("events.jsonl"),
            &serde_json::Value::Object(obj),
        )
    }

    pub fn append_messages(&mut self, messages: &[Message]) -> Result<()> {
        for message in messages {
            serde_json::to_writer(&mut self.messages, message)?;
            self.messages.write_all(b"\n")?;
        }
        self.messages.flush()?;
        Ok(())
    }

    pub fn write_summary(&self, summary: &str, artifacts: &[String], finished: bool) -> Result<()> {
        let body = serde_json::json!({
            "id": self.id,
            "finished": finished,
            "summary": summary,
            "artifacts": artifacts,
            "finished_at": OffsetDateTime::now_utc().format(&Rfc3339)?,
        });
        fs::write(
            self.dir.join("summary.json"),
            serde_json::to_string_pretty(&body)? + "\n",
        )?;
        Ok(())
    }

    fn write_meta(&self) -> Result<()> {
        let meta = Meta {
            version: 2,
            id: self.id.clone(),
            project_id: self.project_id.clone(),
            intent: self.intent.clone(),
            started_at: self.started_at.format(&Rfc3339)?,
            workspace_root: self.workdir.display().to_string(),
            provider: self.provider.clone(),
            model: self.model.clone(),
            resumed_from: self.resumed_from.clone(),
        };
        fs::write(
            self.dir.join("meta.json"),
            serde_json::to_string_pretty(&meta)? + "\n",
        )?;
        Ok(())
    }
}

pub fn load_history(workdir: &Path, session_id: &str) -> Result<Vec<Message>> {
    let path = workdir
        .join(".openmelon")
        .join("sessions")
        .join(session_id)
        .join("messages.jsonl");
    let file = File::open(&path).with_context(|| format!("open {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut out = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        out.push(serde_json::from_str(&line).with_context(|| format!("parse {}", path.display()))?);
    }
    Ok(out)
}

pub fn load_events(session_dir: &Path, limit: usize) -> Result<Vec<serde_json::Value>> {
    let path = session_dir.join("events.jsonl");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = File::open(&path).with_context(|| format!("open {}", path.display()))?;
    let reader = BufReader::new(file);
    let mut rows = Vec::new();
    for line in reader.lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        rows.push(serde_json::from_str(&line)?);
    }
    if limit > 0 && rows.len() > limit {
        Ok(rows.split_off(rows.len() - limit))
    } else {
        Ok(rows)
    }
}

fn append_jsonl(path: &Path, value: &serde_json::Value) -> Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    Ok(())
}

fn short_id() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let mut hasher = DefaultHasher::new();
    std::time::SystemTime::now().hash(&mut hasher);
    std::process::id().hash(&mut hasher);
    format!("{:08x}", hasher.finish() as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_layout_keeps_state_hidden_and_outputs_visible() {
        let root = PathBuf::from("/tmp/openmelon-example");
        let layout = ProjectLayout {
            state_dir: root.join(".openmelon"),
            outputs_dir: root.join("outputs"),
            root: root.clone(),
        };

        assert_eq!(
            layout.history_file(),
            root.join(".openmelon/rust-tui-history.txt")
        );
        assert_eq!(layout.outputs_dir(), root.join("outputs"));
    }
}
