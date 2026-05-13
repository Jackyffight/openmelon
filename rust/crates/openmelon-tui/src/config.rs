use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::project::{Project, ProviderConfig};

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct UserConfig {
    #[serde(default)]
    pub current_project: String,
    #[serde(default)]
    pub defaults: UserDefaults,
    #[serde(default)]
    pub providers: BTreeMap<String, ProviderConfig>,
    #[serde(default)]
    pub trusted_dirs: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct UserDefaults {
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
    #[serde(default)]
    pub reasoning_effort: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Credentials {
    #[serde(default)]
    pub api_keys: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default)]
pub struct ProviderResolution {
    pub api_key: String,
    pub base_url: String,
}

pub fn openmelon_home() -> Result<PathBuf> {
    if let Ok(home) = env::var("OPENMELON_HOME") {
        return Ok(PathBuf::from(home));
    }
    let home = env::var("HOME").context("HOME is not set")?;
    Ok(PathBuf::from(home).join(".openmelon"))
}

pub fn load_user_config() -> Result<UserConfig> {
    let path = openmelon_home()?.join("config.json");
    if !path.exists() {
        return Ok(UserConfig::default());
    }
    let body = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&body).with_context(|| format!("parse {}", path.display()))
}

pub fn load_credentials(path: &Path) -> Result<Credentials> {
    if !path.exists() {
        return Ok(Credentials::default());
    }
    let body = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_str(&body).with_context(|| format!("parse {}", path.display()))
}

pub fn resolve_provider(
    workdir: &Path,
    project: &Project,
    user: &UserConfig,
    provider: &str,
) -> Result<ProviderResolution> {
    let provider = provider.trim().to_string();
    let mut out = ProviderResolution::default();

    if let Some(cfg) = project.providers.get(&provider) {
        if !cfg.api_key.trim().is_empty() {
            out.api_key = cfg.api_key.clone();
        }
        if !cfg.base_url.trim().is_empty() {
            out.base_url = cfg.base_url.clone();
        }
    }
    if let Some(cfg) = user.providers.get(&provider) {
        if out.api_key.is_empty() && !cfg.api_key.trim().is_empty() {
            out.api_key = cfg.api_key.clone();
        }
        if out.base_url.is_empty() && !cfg.base_url.trim().is_empty() {
            out.base_url = cfg.base_url.clone();
        }
    }
    if out.api_key.is_empty() {
        let project_creds = load_credentials(&workdir.join(".openmelon").join("credentials.json"))?;
        if let Some(key) = project_creds.api_keys.get(&provider) {
            out.api_key = key.clone();
        }
    }
    if out.api_key.is_empty() {
        let global_creds = load_credentials(&openmelon_home()?.join("credentials.json"))?;
        if let Some(key) = global_creds.api_keys.get(&provider) {
            out.api_key = key.clone();
        }
    }
    if out.api_key.is_empty() {
        if let Ok(key) = env::var(api_key_env(&provider)) {
            out.api_key = key;
        }
    }
    if out.base_url.is_empty() {
        if let Ok(base_url) = env::var(base_url_env(&provider)) {
            out.base_url = base_url;
        }
    }

    Ok(out)
}

pub fn api_key_env(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "ANTHROPIC_API_KEY",
        "openrouter" => "OPENROUTER_API_KEY",
        _ => "OPENAI_API_KEY",
    }
}

pub fn base_url_env(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "ANTHROPIC_BASE_URL",
        "openrouter" => "OPENROUTER_BASE_URL",
        _ => "OPENAI_BASE_URL",
    }
}

pub fn default_provider() -> String {
    if env::var("ANTHROPIC_API_KEY").is_ok() {
        return "anthropic".to_string();
    }
    if env::var("OPENAI_API_KEY").is_ok() {
        return "openai".to_string();
    }
    if env::var("OPENROUTER_API_KEY").is_ok() {
        return "openrouter".to_string();
    }
    "openai".to_string()
}
