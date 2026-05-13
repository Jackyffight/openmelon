use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

pub const STATE_DIR: &str = ".openmelon";
pub const PROJECT_FILE: &str = "project.json";
pub const OUTPUTS_DIR: &str = "outputs";

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub persona: String,
    #[serde(default)]
    pub constraints: Vec<String>,
    #[serde(default)]
    pub defaults: Defaults,
    #[serde(default)]
    pub providers: std::collections::BTreeMap<String, ProviderConfig>,
    #[serde(default)]
    pub settings: Settings,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Defaults {
    #[serde(default)]
    pub llm_provider: String,
    #[serde(default)]
    pub llm_model: String,
    #[serde(default)]
    pub image_provider: String,
    #[serde(default)]
    pub image_model: String,
    #[serde(default)]
    pub vision_model: String,
    #[serde(default)]
    pub locale: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct ProviderConfig {
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Settings {
    #[serde(default)]
    pub bash_permission_mode: String,
    #[serde(default)]
    pub reasoning_effort: String,
}

#[derive(Debug, Clone)]
pub struct Workspace {
    pub root: PathBuf,
    pub project: Project,
}

impl Workspace {
    pub fn discover(start: impl AsRef<Path>) -> Result<Self> {
        let root = discover_root(start)?;
        let project = load_project(&root)?;
        ensure_project_dirs(&root)?;
        Ok(Self { root, project })
    }

    pub fn state_dir(&self) -> PathBuf {
        self.root.join(STATE_DIR)
    }

    pub fn outputs_dir(&self) -> PathBuf {
        self.root.join(OUTPUTS_DIR)
    }

    pub fn session_outputs_dir(&self, session_id: &str) -> PathBuf {
        self.outputs_dir().join("sessions").join(session_id)
    }

    pub fn artifact_outputs_dir(&self, slug: &str, timestamp: &str) -> PathBuf {
        self.outputs_dir()
            .join("artifacts")
            .join(slug)
            .join(timestamp)
    }
}

pub fn discover_root(start: impl AsRef<Path>) -> Result<PathBuf> {
    let mut cur = start
        .as_ref()
        .canonicalize()
        .with_context(|| format!("resolve {}", start.as_ref().display()))?;

    loop {
        if cur.join(STATE_DIR).join(PROJECT_FILE).is_file() {
            return Ok(cur);
        }
        if !cur.pop() {
            bail!(
                "not an openmelon project: no {}/{} found from {} upward",
                STATE_DIR,
                PROJECT_FILE,
                start.as_ref().display()
            );
        }
    }
}

pub fn load_project(root: &Path) -> Result<Project> {
    let path = root.join(STATE_DIR).join(PROJECT_FILE);
    let body = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&body).with_context(|| format!("parse {}", path.display()))
}

pub fn update_project_json(root: &Path, update: impl FnOnce(&mut serde_json::Value)) -> Result<()> {
    let path = root.join(STATE_DIR).join(PROJECT_FILE);
    let body = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    let mut value: serde_json::Value =
        serde_json::from_str(&body).with_context(|| format!("parse {}", path.display()))?;
    update(&mut value);
    fs::write(&path, serde_json::to_string_pretty(&value)? + "\n")
        .with_context(|| format!("write {}", path.display()))?;
    Ok(())
}

pub fn set_project_default(root: &Path, key: &str, value: &str) -> Result<()> {
    update_project_json(root, |project| {
        ensure_object(project, "defaults");
        project["defaults"][key] = serde_json::Value::String(value.to_string());
    })
}

pub fn set_project_setting(root: &Path, key: &str, value: &str) -> Result<()> {
    update_project_json(root, |project| {
        ensure_object(project, "settings");
        if value.trim().is_empty() {
            if let Some(obj) = project["settings"].as_object_mut() {
                obj.remove(key);
            }
        } else {
            project["settings"][key] = serde_json::Value::String(value.to_string());
        }
    })
}

fn ensure_object(value: &mut serde_json::Value, key: &str) {
    if !value.get(key).is_some_and(serde_json::Value::is_object) {
        value[key] = serde_json::json!({});
    }
}

pub fn ensure_project_dirs(root: &Path) -> Result<()> {
    for sub in [
        "characters",
        "references",
        "materials",
        "sessions",
        "spaces",
    ] {
        fs::create_dir_all(root.join(STATE_DIR).join(sub))
            .with_context(|| format!("create .openmelon/{sub}"))?;
    }
    fs::create_dir_all(root.join(OUTPUTS_DIR)).context("create outputs dir")?;
    Ok(())
}

pub fn resolve_output_dir(root: &Path, requested: &str, fallback: &Path) -> Result<PathBuf> {
    let candidate = if requested.trim().is_empty() {
        fallback.to_path_buf()
    } else {
        let requested = PathBuf::from(requested.trim());
        if requested.is_absolute() {
            requested
        } else {
            root.join(requested)
        }
    };

    let root = root.canonicalize()?;
    let state = root.join(STATE_DIR);
    let abs = if candidate.exists() {
        candidate.canonicalize()?
    } else {
        let parent = candidate.parent().unwrap_or(&root);
        let parent_abs = if parent.exists() {
            parent.canonicalize()?
        } else {
            root.clone()
        };
        parent_abs.join(candidate.file_name().unwrap_or_default())
    };

    if !abs.starts_with(&root) {
        bail!("output dir {} escapes project workdir", candidate.display());
    }
    if abs.starts_with(&state) {
        bail!(
            "output dir {} is inside .openmelon; choose a visible project directory",
            candidate.display()
        );
    }
    Ok(abs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_output_rejects_hidden_state() {
        let root = std::env::temp_dir().join("openmelon-rust-project");
        let _ = std::fs::create_dir_all(root.join(".openmelon"));
        let fallback = root.join("outputs");
        let err = resolve_output_dir(&root, ".openmelon/artifacts", &fallback).unwrap_err();
        assert!(err.to_string().contains(".openmelon"));
    }
}
