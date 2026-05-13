use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

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
