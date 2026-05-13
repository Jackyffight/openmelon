use std::fs;
use std::io::{self, IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use time::macros::format_description;
use time::OffsetDateTime;

use crate::image::ImageGenerator;
use crate::llm::Tool;
use crate::project::{resolve_output_dir, Workspace};

#[derive(Clone)]
pub struct ToolRegistry {
    tools: Vec<ToolEntry>,
}

pub struct ToolEnv {
    pub workspace: Workspace,
    pub session_id: String,
    pub session_dir: PathBuf,
    pub image: Option<ImageGenerator>,
    pub bash_mode: String,
    pub allowed_bash: std::sync::Arc<std::sync::Mutex<std::collections::BTreeSet<String>>>,
}

#[derive(Clone)]
struct ToolEntry {
    spec: Tool,
    handler: fn(&ToolEnv, Value) -> Result<Value>,
}

impl ToolRegistry {
    pub fn standard(env: &ToolEnv) -> Self {
        let mut registry = Self { tools: Vec::new() };
        registry.register(list_characters_tool());
        registry.register(get_character_tool());
        registry.register(list_references_tool());
        registry.register(get_reference_tool());
        registry.register(search_tool());
        registry.register(read_file_tool());
        registry.register(list_spaces_tool());
        registry.register(plan_creator_workflow_tool());
        registry.register(create_space_tool());
        registry.register(get_context_packet_tool());
        registry.register(activate_space_tool());
        registry.register(record_decision_tool());
        registry.register(record_feedback_tool());
        registry.register(record_memory_item_tool());
        registry.register(promote_memory_item_tool());
        registry.register(create_episode_tool());
        registry.register(register_asset_tool());
        registry.register(update_asset_weight_tool());
        registry.register(record_compaction_tool());
        registry.register(compile_skill_tool());
        registry.register(save_artifact_tool());
        registry.register(bash_tool());
        if env.image.is_some() {
            registry.register(generate_image_tool());
        }
        registry.register(finish_tool());
        registry
    }

    pub fn specs(&self) -> Vec<Tool> {
        self.tools.iter().map(|entry| entry.spec.clone()).collect()
    }

    pub fn names(&self) -> Vec<String> {
        self.tools
            .iter()
            .map(|entry| entry.spec.name.clone())
            .collect()
    }

    pub fn dispatch(&self, env: &ToolEnv, name: &str, args: Value) -> Result<Value> {
        let entry = self
            .tools
            .iter()
            .find(|entry| entry.spec.name == name)
            .with_context(|| format!("unknown tool {name}; available: {:?}", self.names()))?;
        (entry.handler)(env, args)
    }

    fn register(&mut self, entry: ToolEntry) {
        self.tools.push(entry);
    }
}

fn list_characters_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "list_characters",
            "List all characters registered in this project. Optional substring filter on name and description.",
            schema(&[("query", "string", false)]),
        ),
        handler: |env, args| list_registry(env, "characters", "character.json", args),
    }
}

fn get_character_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "get_character",
            "Fetch a character's full details, including absolute paths to portrait images.",
            required_schema(&[("slug", "string")]),
        ),
        handler: |env, args| get_registry(env, "characters", "character.json", args),
    }
}

fn list_references_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "list_references",
            "List all reference images in this project, such as scenes, lighting setups, or composition templates.",
            schema(&[("query", "string", false)]),
        ),
        handler: |env, args| list_registry(env, "references", "reference.json", args),
    }
}

fn get_reference_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "get_reference",
            "Fetch a reference image's full details, including absolute on-disk image paths.",
            required_schema(&[("slug", "string")]),
        ),
        handler: |env, args| get_registry(env, "references", "reference.json", args),
    }
}

fn search_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "search",
            "Search project characters, references, materials, spaces, and visible project text files.",
            required_schema(&[("query", "string")]),
        ),
        handler: search_project,
    }
}

fn read_file_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "read_file",
            "Read a UTF-8 text file from inside the project workdir. Paths may not escape the project.",
            required_schema(&[("path", "string")]),
        ),
        handler: read_file,
    }
}

fn list_spaces_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "list_spaces",
            "List or search creative continuity spaces before starting or continuing a durable series.",
            schema(&[("query", "string", false)]),
        ),
        handler: list_spaces,
    }
}

fn get_context_packet_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "get_context_packet",
            "Fetch a model-readable continuity context packet for a creative space.",
            required_schema(&[("space_id", "string")]),
        ),
        handler: get_context_packet,
    }
}

fn plan_creator_workflow_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "plan_creator_workflow",
            "Plan whether a creative request should start a new space, confirm a draft, or continue an active space.",
            required_schema(&[("intent", "string")]),
        ),
        handler: plan_creator_workflow,
    }
}

fn create_space_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "create_space",
            "Create a draft creative continuity space with provisional assumptions. Ask for confirmation before durable canon/episodes.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "name": {"type": "string"},
                    "platform": {"type": "string"},
                    "audience": {"type": "string"},
                    "description": {"type": "string"},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "assumptions": {"type": "string"}
                },
                "required": ["id", "name"]
            }),
        ),
        handler: create_space,
    }
}

fn activate_space_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "activate_space",
            "Activate a draft creative space after explicit user confirmation and record the confirmation as a decision.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "decision": {"type": "string"},
                    "reason": {"type": "string"},
                    "weight": {"type": "number"}
                },
                "required": ["space_id", "decision"]
            }),
        ),
        handler: activate_space,
    }
}

fn record_decision_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "record_decision",
            "Record a user-confirmed continuity decision for a creative space. Do not use for guesses.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "scope": {"type": "string"},
                    "target": {"type": "string"},
                    "decision": {"type": "string"},
                    "reason": {"type": "string"},
                    "weight": {"type": "number"}
                },
                "required": ["space_id", "decision"]
            }),
        ),
        handler: record_decision,
    }
}

fn record_feedback_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "record_feedback",
            "Record user or audience feedback so future production can adapt strategy, pacing, style, assets, or planning.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "episode_id": {"type": "string"},
                    "source": {"type": "string"},
                    "signal": {"type": "string"},
                    "evidence": {"type": "string"},
                    "recommendation": {"type": "string"}
                },
                "required": ["space_id", "signal"]
            }),
        ),
        handler: record_feedback,
    }
}

fn record_memory_item_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "record_memory_item",
            "Record a provisional memory item for observations, patterns, weak preferences, risks, or unresolved continuity notes.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "id": {"type": "string"},
                    "kind": {"type": "string"},
                    "scope": {"type": "string"},
                    "target": {"type": "string"},
                    "content": {"type": "string"},
                    "source": {"type": "string"},
                    "weight": {"type": "number"},
                    "status": {"type": "string"}
                },
                "required": ["space_id", "content"]
            }),
        ),
        handler: record_memory_item,
    }
}

fn promote_memory_item_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "promote_memory_item",
            "Promote a provisional memory item into a user-confirmed decision after explicit confirmation.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "item_id": {"type": "string"},
                    "decision": {"type": "string"},
                    "reason": {"type": "string"},
                    "target": {"type": "string"}
                },
                "required": ["space_id", "item_id", "decision"]
            }),
        ),
        handler: promote_memory_item,
    }
}

fn create_episode_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "create_episode",
            "Create or register a durable episode under an active creative space.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "id": {"type": "string"},
                    "title": {"type": "string"},
                    "topic": {"type": "string"},
                    "status": {"type": "string"},
                    "brief": {"type": "string"}
                },
                "required": ["space_id", "topic"]
            }),
        ),
        handler: create_episode,
    }
}

fn register_asset_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "register_asset",
            "Register a reusable continuity asset: image, background, character, prop, typography rule, prompt fragment, shot spec, mask, or layered file.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "id": {"type": "string"},
                    "kind": {"type": "string"},
                    "status": {"type": "string"},
                    "description": {"type": "string"},
                    "reuse_policy": {"type": "string"},
                    "files": {"type": "array", "items": {"type": "string"}},
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "weight": {"type": "number"}
                },
                "required": ["space_id", "description"]
            }),
        ),
        handler: register_asset,
    }
}

fn update_asset_weight_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "update_asset_weight",
            "Adjust a reusable asset's weight or status after feedback.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "asset_id": {"type": "string"},
                    "weight": {"type": "number"},
                    "status": {"type": "string"}
                },
                "required": ["space_id", "asset_id", "weight"]
            }),
        ),
        handler: update_asset_weight,
    }
}

fn record_compaction_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "record_compaction",
            "Record a compact summary of long-running state for a creative space.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "space_id": {"type": "string"},
                    "summary": {"type": "string"},
                    "scope": {"type": "string"}
                },
                "required": ["space_id", "summary"]
            }),
        ),
        handler: record_compaction,
    }
}

fn compile_skill_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "compile_skill",
            "Compile a skillplus package and return its compiled prompt + output schema. Pass the BARE skill slug, not skillplus:<slug>.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "skill": {
                        "type": "string",
                        "description": "Bare skill slug, such as brand-logo, or an absolute path to a .skillplus directory. Do not prefix with skillplus:."
                    },
                    "locale": {
                        "type": "string",
                        "description": "Locale to compile for. Allowed: zh-CN or en. Default zh-CN.",
                        "enum": ["zh-CN", "en"]
                    },
                    "model_profile": {
                        "type": "string",
                        "description": "Per-skill prompt overlay slug. Default gpt-image-family."
                    },
                    "vars": {"type": "object", "additionalProperties": {"type": "string"}}
                },
                "required": ["skill"]
            }),
        ),
        handler: compile_skill,
    }
}

fn generate_image_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "generate_image",
            "Generate a single image and save it into the visible project outputs directory for the current session. Include continuity constraints in the prompt and never write final deliverables under .openmelon.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "prompt": {"type": "string"},
                    "reference_images": {"type": "array", "items": {"type": "string"}},
                    "size": {"type": "string"},
                    "label": {"type": "string"},
                    "output_dir": {"type": "string"}
                },
                "required": ["prompt"]
            }),
        ),
        handler: generate_image,
    }
}

fn save_artifact_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "save_artifact",
            "Promote a generated file to a permanent visible project artifact under outputs/artifacts/<slug>/<timestamp>/, or a project-relative output_dir.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "slug": {"type": "string"},
                    "image_path": {"type": "string"},
                    "prompt": {"type": "string"},
                    "output_dir": {"type": "string"}
                },
                "required": ["slug", "image_path"]
            }),
        ),
        handler: save_artifact,
    }
}

fn bash_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "bash",
            "Run a shell command inside the project workdir. Use for lightweight inspection only. Do not use bash to discover fonts, render images, or replace image generation.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "description": {"type": "string"},
                    "timeout_seconds": {"type": "number"}
                },
                "required": ["command", "description"]
            }),
        ),
        handler: bash,
    }
}

fn finish_tool() -> ToolEntry {
    ToolEntry {
        spec: tool(
            "finish",
            "Signal completion. Provide a short user-visible summary and any final artifact paths.",
            serde_json::json!({
                "type": "object",
                "properties": {
                    "summary": {"type": "string"},
                    "artifacts": {"type": "array", "items": {"type": "string"}}
                },
                "required": ["summary"]
            }),
        ),
        handler: |_env, args| {
            Ok(serde_json::json!({
                "ok": true,
                "summary": string_arg(&args, "summary"),
                "artifacts": args.get("artifacts").cloned().unwrap_or_else(|| serde_json::json!([])),
            }))
        },
    }
}

fn tool(name: &str, description: &str, parameters: Value) -> Tool {
    Tool {
        name: name.to_string(),
        description: description.to_string(),
        parameters,
    }
}

fn schema(fields: &[(&str, &str, bool)]) -> Value {
    let mut props = serde_json::Map::new();
    let mut required = Vec::new();
    for (name, kind, req) in fields {
        props.insert((*name).to_string(), serde_json::json!({ "type": kind }));
        if *req {
            required.push(Value::String((*name).to_string()));
        }
    }
    serde_json::json!({
        "type": "object",
        "properties": Value::Object(props),
        "required": required,
    })
}

fn required_schema(fields: &[(&str, &str)]) -> Value {
    let fields = fields
        .iter()
        .map(|(a, b)| (*a, *b, true))
        .collect::<Vec<_>>();
    schema(&fields)
}

fn list_registry(env: &ToolEnv, dir: &str, meta_name: &str, args: Value) -> Result<Value> {
    let query = string_arg(&args, "query").to_ascii_lowercase();
    let root = env.workspace.state_dir().join(dir);
    let mut out = Vec::new();
    if !root.exists() {
        return Ok(Value::Array(out));
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let item = load_registry_item(&entry.path(), meta_name)?;
        let hay = format!(
            "{} {} {}",
            item.get("slug").and_then(Value::as_str).unwrap_or_default(),
            item.get("name").and_then(Value::as_str).unwrap_or_default(),
            item.get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
        )
        .to_ascii_lowercase();
        if query.is_empty() || hay.contains(&query) {
            out.push(item);
        }
    }
    Ok(Value::Array(out))
}

fn get_registry(env: &ToolEnv, dir: &str, meta_name: &str, args: Value) -> Result<Value> {
    let slug = string_arg(&args, "slug");
    if slug.trim().is_empty() {
        return Ok(error_value("slug is required"));
    }
    let path = env.workspace.state_dir().join(dir).join(&slug);
    if !path.exists() {
        return Ok(error_value(&format!("{dir}/{slug} not found")));
    }
    load_registry_item(&path, meta_name)
}

fn load_registry_item(path: &Path, meta_name: &str) -> Result<Value> {
    let meta_path = path.join(meta_name);
    let mut item = if meta_path.exists() {
        serde_json::from_str::<Value>(&fs::read_to_string(&meta_path)?)?
    } else {
        serde_json::json!({})
    };
    if item.get("slug").is_none() {
        item["slug"] = Value::String(
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
        );
    }
    if let Ok(search) = fs::read_to_string(path.join(".search")) {
        item["description"] = Value::String(search.trim().to_string());
    }
    let mut images = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let p = entry.path();
        if is_image_path(&p) {
            images.push(Value::String(p.display().to_string()));
        }
    }
    item["images"] = Value::Array(images);
    Ok(item)
}

fn search_project(env: &ToolEnv, args: Value) -> Result<Value> {
    let query = string_arg(&args, "query").to_ascii_lowercase();
    if query.trim().is_empty() {
        return Ok(error_value("query is required"));
    }
    let mut hits = Vec::new();
    collect_text_hits(
        &env.workspace.state_dir().join("characters"),
        &query,
        &mut hits,
    )?;
    collect_text_hits(
        &env.workspace.state_dir().join("references"),
        &query,
        &mut hits,
    )?;
    collect_text_hits(
        &env.workspace.state_dir().join("materials"),
        &query,
        &mut hits,
    )?;
    collect_text_hits(&env.workspace.state_dir().join("spaces"), &query, &mut hits)?;
    collect_text_hits(&env.workspace.outputs_dir(), &query, &mut hits)?;
    hits.truncate(40);
    Ok(Value::Array(hits))
}

fn collect_text_hits(root: &Path, query: &str, hits: &mut Vec<Value>) -> Result<()> {
    if !root.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if entry.file_type()?.is_dir() {
            collect_text_hits(&path, query, hits)?;
            continue;
        }
        if !is_text_path(&path) {
            continue;
        }
        let Ok(body) = fs::read_to_string(&path) else {
            continue;
        };
        if body.to_ascii_lowercase().contains(query) {
            hits.push(serde_json::json!({
                "path": path.display().to_string(),
                "snippet": snippet(&body, query),
            }));
        }
    }
    Ok(())
}

fn read_file(env: &ToolEnv, args: Value) -> Result<Value> {
    let rel = string_arg(&args, "path");
    let path = safe_join(&env.workspace.root, &rel)?;
    let content = fs::read_to_string(&path).with_context(|| format!("read {}", path.display()))?;
    Ok(serde_json::json!({ "path": rel, "content": content }))
}

fn list_spaces(env: &ToolEnv, args: Value) -> Result<Value> {
    let query = string_arg(&args, "query").to_ascii_lowercase();
    let root = env.workspace.state_dir().join("spaces");
    let mut out = Vec::new();
    if !root.exists() {
        return Ok(Value::Array(out));
    }
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path().join("space.json");
        if !path.exists() {
            continue;
        }
        let space: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
        let hay = serde_json::to_string(&space)?.to_ascii_lowercase();
        if query.is_empty() || hay.contains(&query) {
            out.push(space);
        }
    }
    Ok(Value::Array(out))
}

fn get_context_packet(env: &ToolEnv, args: Value) -> Result<Value> {
    let space_id = string_arg(&args, "space_id");
    if space_id.trim().is_empty() {
        return Ok(error_value("space_id is required"));
    }
    let dir = env.workspace.state_dir().join("spaces").join(&space_id);
    if !dir.exists() {
        return Ok(error_value(&format!("space {space_id} not found")));
    }
    let read = |name: &str| fs::read_to_string(dir.join(name)).unwrap_or_default();
    let jsonl = |name: &str, limit: usize| read_jsonl_tail(&dir.join(name), limit);
    Ok(serde_json::json!({
        "project_id": env.workspace.project.id,
        "authority": "canon and decisions outrank memory and assumptions; assumptions are provisional until user confirmation",
        "space": read_json_file(&dir.join("space.json")).unwrap_or_else(|| serde_json::json!({ "id": space_id })),
        "assumptions": read("assumptions.md"),
        "canon": read("canon.md"),
        "memory": read("memory.md"),
        "plan": read("plan.md"),
        "recent_decisions": jsonl("decisions.jsonl", 12),
        "recent_feedback": jsonl("feedback.jsonl", 12),
        "recent_episodes": collect_json_files(&dir.join("episodes"), 12),
        "assets": collect_json_files(&dir.join("assets"), 24),
    }))
}

fn plan_creator_workflow(env: &ToolEnv, args: Value) -> Result<Value> {
    let intent = string_arg(&args, "intent").to_ascii_lowercase();
    let spaces = list_spaces(env, serde_json::json!({ "query": intent }))?;
    let best = spaces.as_array().and_then(|items| items.first()).cloned();
    let Some(space) = best else {
        return Ok(serde_json::json!({
            "intent": string_arg(&args, "intent"),
            "mode": "new_space",
            "needs_confirmation": true,
            "reason": "No matching creative space was found; start with provisional assumptions and ask for confirmation.",
            "steps": [
                {"id": "find-context", "action": "search existing spaces", "tool": "list_spaces"},
                {"id": "draft-space", "action": "create draft space", "tool": "create_space"},
                {"id": "ask-confirmation", "action": "ask concise confirmation questions"}
            ]
        }));
    };
    let status = space
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let space_id = space.get("id").and_then(Value::as_str).unwrap_or_default();
    if status == "draft" {
        Ok(serde_json::json!({
            "intent": string_arg(&args, "intent"),
            "mode": "confirm_space",
            "space_id": space_id,
            "needs_confirmation": true,
            "reason": "A draft space matches; confirm or correct assumptions before durable production.",
            "steps": [
                {"id": "load-context", "action": "load selected context", "tool": "get_context_packet"},
                {"id": "ask-confirmation", "action": "ask user to confirm or correct core direction"},
                {"id": "activate", "action": "activate after confirmation", "tool": "activate_space"}
            ]
        }))
    } else {
        Ok(serde_json::json!({
            "intent": string_arg(&args, "intent"),
            "mode": "continue_space",
            "space_id": space_id,
            "needs_confirmation": false,
            "reason": "An active creative space matches; load context and continue production.",
            "steps": [
                {"id": "load-context", "action": "load selected context", "tool": "get_context_packet"},
                {"id": "adapt", "action": "adapt using feedback and memory"},
                {"id": "produce", "action": "create or update episode/assets", "tool": "create_episode"},
                {"id": "finish", "action": "summarize updates", "tool": "finish"}
            ]
        }))
    }
}

fn create_space(env: &ToolEnv, args: Value) -> Result<Value> {
    let id = clean_label(&string_arg(&args, "id"));
    if id.is_empty() {
        return Ok(error_value("id is required"));
    }
    let dir = env.workspace.state_dir().join("spaces").join(&id);
    if dir.join("space.json").exists() {
        return Ok(error_value(&format!("space {id} already exists")));
    }
    fs::create_dir_all(dir.join("episodes"))?;
    fs::create_dir_all(dir.join("assets"))?;
    let now = now_rfc3339()?;
    let space = serde_json::json!({
        "id": id,
        "name": string_arg(&args, "name"),
        "platform": string_arg(&args, "platform"),
        "audience": string_arg(&args, "audience"),
        "status": "draft",
        "description": string_arg(&args, "description"),
        "tags": array_arg(&args, "tags"),
        "created_at": now,
        "updated_at": now,
    });
    write_json(&dir.join("space.json"), &space)?;
    fs::write(
        dir.join("assumptions.md"),
        ensure_newline(&first_non_empty_str(&[
            string_arg(&args, "assumptions"),
            "# Assumptions\n\nModel-generated setup assumptions live here until confirmed."
                .to_string(),
        ])),
    )?;
    fs::write(
        dir.join("canon.md"),
        "# Canon\n\nConfirmed long-term rules live here.\n",
    )?;
    fs::write(dir.join("memory.md"), "# Memory\n\n")?;
    fs::write(dir.join("plan.md"), "# Plan\n\n## Backlog\n- TBD\n")?;
    Ok(serde_json::json!({
        "id": id,
        "status": "draft",
        "dir": dir.display().to_string(),
        "next_action": "Ask the user to confirm or correct assumptions before durable canon or episodes.",
    }))
}

fn activate_space(env: &ToolEnv, args: Value) -> Result<Value> {
    let space_id = string_arg(&args, "space_id");
    let dir = env.workspace.state_dir().join("spaces").join(&space_id);
    let Some(mut space) = read_json_file(&dir.join("space.json")) else {
        return Ok(error_value(&format!("space {space_id} not found")));
    };
    let decision = append_decision(env, &args, "space", "space_activation")?;
    space["status"] = serde_json::json!("active");
    space["updated_at"] = serde_json::json!(now_rfc3339()?);
    write_json(&dir.join("space.json"), &space)?;
    Ok(serde_json::json!({ "space": space, "decision": decision }))
}

fn record_decision(env: &ToolEnv, args: Value) -> Result<Value> {
    append_decision(
        env,
        &args,
        &string_arg(&args, "scope"),
        &string_arg(&args, "target"),
    )
}

fn append_decision(env: &ToolEnv, args: &Value, scope: &str, target: &str) -> Result<Value> {
    let space_id = string_arg(args, "space_id");
    let decision = string_arg(args, "decision");
    if space_id.is_empty() || decision.is_empty() {
        return Ok(error_value("space_id and decision are required"));
    }
    let dir = env.workspace.state_dir().join("spaces").join(&space_id);
    if !dir.exists() {
        return Ok(error_value(&format!("space {space_id} not found")));
    }
    let now = now_rfc3339()?;
    let row = serde_json::json!({
        "id": format!("dec-{}", compact_timestamp()?),
        "scope": first_non_empty_str(&[scope.to_string(), "space".to_string()]),
        "target": target,
        "decision": decision,
        "reason": string_arg(args, "reason"),
        "weight": args.get("weight").and_then(Value::as_f64).unwrap_or(1.0),
        "status": "active",
        "created_at": now,
    });
    append_jsonl(&dir.join("decisions.jsonl"), &row)?;
    Ok(row)
}

fn record_feedback(env: &ToolEnv, args: Value) -> Result<Value> {
    append_space_jsonl(env, &args, "feedback.jsonl", |args| {
        serde_json::json!({
            "id": format!("fb-{}", compact_timestamp().unwrap_or_else(|_| "now".to_string())),
            "episode_id": string_arg(args, "episode_id"),
            "source": first_non_empty_str(&[string_arg(args, "source"), "user".to_string()]),
            "signal": string_arg(args, "signal"),
            "evidence": string_arg(args, "evidence"),
            "recommendation": string_arg(args, "recommendation"),
            "created_at": now_rfc3339().unwrap_or_default(),
        })
    })
}

fn record_memory_item(env: &ToolEnv, args: Value) -> Result<Value> {
    append_space_jsonl(env, &args, "memory.jsonl", |args| {
        serde_json::json!({
            "id": first_non_empty_str(&[clean_label(&string_arg(args, "id")), format!("mem-{}", compact_timestamp().unwrap_or_else(|_| "now".to_string()))]),
            "kind": first_non_empty_str(&[string_arg(args, "kind"), "observation".to_string()]),
            "scope": string_arg(args, "scope"),
            "target": string_arg(args, "target"),
            "content": string_arg(args, "content"),
            "source": first_non_empty_str(&[string_arg(args, "source"), "model".to_string()]),
            "weight": args.get("weight").and_then(Value::as_f64).unwrap_or(0.5),
            "status": first_non_empty_str(&[string_arg(args, "status"), "provisional".to_string()]),
            "created_at": now_rfc3339().unwrap_or_default(),
            "updated_at": now_rfc3339().unwrap_or_default(),
        })
    })
}

fn promote_memory_item(env: &ToolEnv, args: Value) -> Result<Value> {
    let mut decision_args = args.clone();
    decision_args["scope"] = serde_json::json!("memory");
    decision_args["target"] = serde_json::json!(string_arg(&args, "item_id"));
    append_decision(env, &decision_args, "memory", &string_arg(&args, "item_id"))
}

fn create_episode(env: &ToolEnv, args: Value) -> Result<Value> {
    let space_id = string_arg(&args, "space_id");
    let dir = env.workspace.state_dir().join("spaces").join(&space_id);
    let Some(space) = read_json_file(&dir.join("space.json")) else {
        return Ok(error_value(&format!("space {space_id} not found")));
    };
    if space.get("status").and_then(Value::as_str) == Some("draft") {
        return Ok(error_value(
            "space is draft; activate it after user confirmation before creating durable episodes",
        ));
    }
    let id = first_non_empty_str(&[
        clean_label(&string_arg(&args, "id")),
        clean_label(&string_arg(&args, "topic")),
        "episode".to_string(),
    ]);
    let ep_dir = dir.join("episodes").join(&id);
    fs::create_dir_all(&ep_dir)?;
    let now = now_rfc3339()?;
    let episode = serde_json::json!({
        "id": id,
        "title": string_arg(&args, "title"),
        "topic": string_arg(&args, "topic"),
        "status": first_non_empty_str(&[string_arg(&args, "status"), "draft".to_string()]),
        "brief": string_arg(&args, "brief"),
        "created_at": now,
        "updated_at": now,
    });
    write_json(&ep_dir.join("episode.json"), &episode)?;
    if !string_arg(&args, "brief").is_empty() {
        fs::write(
            ep_dir.join("brief.md"),
            ensure_newline(&string_arg(&args, "brief")),
        )?;
    }
    Ok(episode)
}

fn register_asset(env: &ToolEnv, args: Value) -> Result<Value> {
    let space_id = string_arg(&args, "space_id");
    let dir = env.workspace.state_dir().join("spaces").join(&space_id);
    if !dir.exists() {
        return Ok(error_value(&format!("space {space_id} not found")));
    }
    let id = first_non_empty_str(&[
        clean_label(&string_arg(&args, "id")),
        clean_label(&string_arg(&args, "description")),
        "asset".to_string(),
    ]);
    let asset_dir = dir.join("assets").join(&id);
    fs::create_dir_all(&asset_dir)?;
    let now = now_rfc3339()?;
    let asset = serde_json::json!({
        "id": id,
        "kind": string_arg(&args, "kind"),
        "space_id": space_id,
        "status": first_non_empty_str(&[string_arg(&args, "status"), "active".to_string()]),
        "description": string_arg(&args, "description"),
        "reuse_policy": string_arg(&args, "reuse_policy"),
        "files": array_arg(&args, "files"),
        "tags": array_arg(&args, "tags"),
        "weight": args.get("weight").and_then(Value::as_f64).unwrap_or(1.0),
        "created_at": now,
        "updated_at": now,
    });
    write_json(&asset_dir.join("asset.json"), &asset)?;
    Ok(asset)
}

fn update_asset_weight(env: &ToolEnv, args: Value) -> Result<Value> {
    let space_id = string_arg(&args, "space_id");
    let asset_id = string_arg(&args, "asset_id");
    let path = env
        .workspace
        .state_dir()
        .join("spaces")
        .join(&space_id)
        .join("assets")
        .join(&asset_id)
        .join("asset.json");
    let Some(mut asset) = read_json_file(&path) else {
        return Ok(error_value(&format!("asset {asset_id} not found")));
    };
    asset["weight"] = serde_json::json!(args.get("weight").and_then(Value::as_f64).unwrap_or(1.0));
    let status = string_arg(&args, "status");
    if !status.is_empty() {
        asset["status"] = serde_json::json!(status);
    }
    asset["updated_at"] = serde_json::json!(now_rfc3339()?);
    write_json(&path, &asset)?;
    Ok(asset)
}

fn record_compaction(env: &ToolEnv, args: Value) -> Result<Value> {
    append_space_jsonl(env, &args, "compactions.jsonl", |args| {
        serde_json::json!({
            "id": format!("cmp-{}", compact_timestamp().unwrap_or_else(|_| "now".to_string())),
            "summary": string_arg(args, "summary"),
            "scope": first_non_empty_str(&[string_arg(args, "scope"), "space".to_string()]),
            "created_at": now_rfc3339().unwrap_or_default(),
        })
    })
}

fn append_space_jsonl(
    env: &ToolEnv,
    args: &Value,
    file_name: &str,
    make_row: impl Fn(&Value) -> Value,
) -> Result<Value> {
    let space_id = string_arg(args, "space_id");
    if space_id.is_empty() {
        return Ok(error_value("space_id is required"));
    }
    let dir = env.workspace.state_dir().join("spaces").join(&space_id);
    if !dir.exists() {
        return Ok(error_value(&format!("space {space_id} not found")));
    }
    let row = make_row(args);
    append_jsonl(&dir.join(file_name), &row)?;
    Ok(row)
}

fn compile_skill(_env: &ToolEnv, args: Value) -> Result<Value> {
    let skill = normalize_skill_spec(&string_arg(&args, "skill"));
    if skill.is_empty() {
        return Ok(error_value("skill is required"));
    }
    let locale = normalize_locale(&string_arg(&args, "locale"));
    let model_profile = first_non_empty_str(&[
        string_arg(&args, "model_profile"),
        "gpt-image-family".to_string(),
    ]);

    let mut cli_args = vec![
        skill.clone(),
        "--target".to_string(),
        "openmelon".to_string(),
        "--model-profile".to_string(),
        model_profile.clone(),
    ];
    if !locale.is_empty() {
        cli_args.push("--locale".to_string());
        cli_args.push(locale.clone());
    }
    if let Some(vars) = args.get("vars").and_then(Value::as_object) {
        for (key, value) in vars {
            let rendered = value
                .as_str()
                .map(ToString::to_string)
                .unwrap_or_else(|| value.to_string());
            cli_args.push("--var".to_string());
            cli_args.push(format!("{key}={rendered}"));
        }
    }

    match Command::new("skillplus").args(&cli_args).output() {
        Ok(output) => return parse_skillplus_output(&skill, "skillplus", output),
        Err(skillplus_err) if skillplus_err.kind() != io::ErrorKind::NotFound => {
            return Ok(error_value(&format!(
                "skillplus compile failed for {skill:?}: {skillplus_err}"
            )));
        }
        Err(_) => {}
    }

    let python = std::env::var("OPENMELON_SKILLPLUS_PYTHON").unwrap_or_else(|_| "python3".into());
    let mut py_args = vec!["-m".to_string(), "skillplus".to_string()];
    py_args.extend(cli_args);
    let mut cmd = Command::new(&python);
    cmd.args(&py_args);
    if let Ok(path) = std::env::var("OPENMELON_SKILLPLUS_PYTHONPATH") {
        if !path.trim().is_empty() {
            cmd.env("PYTHONPATH", path);
        }
    }
    match cmd.output() {
        Ok(output) => parse_skillplus_output(&skill, &format!("{python} -m skillplus"), output),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(error_value(&format!(
            "skillplus: neither \"skillplus\" nor \"{python}\" is on PATH; install skillplus or set OPENMELON_SKILLPLUS_PYTHON/OPENMELON_SKILLPLUS_PYTHONPATH"
        ))),
        Err(err) => Ok(error_value(&format!(
            "skillplus compile failed for {skill:?}: {err}"
        ))),
    }
}

fn generate_image(env: &ToolEnv, args: Value) -> Result<Value> {
    let Some(generator) = &env.image else {
        return Ok(error_value("image generation is not configured"));
    };
    let prompt = string_arg(&args, "prompt");
    if prompt.trim().is_empty() {
        return Ok(error_value("prompt is required"));
    }
    let reference_images = args
        .get("reference_images")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(ToString::to_string))
        .collect::<Vec<_>>();
    let result = generator.generate(&prompt, &string_arg(&args, "size"), &reference_images)?;
    let label = clean_label(&string_arg(&args, "label"));
    let fallback = if env.session_dir.exists() {
        env.workspace.session_outputs_dir(&env.session_id)
    } else {
        env.workspace.outputs_dir()
    };
    let out_dir = resolve_output_dir(
        &env.workspace.root,
        &string_arg(&args, "output_dir"),
        &fallback,
    )?;
    fs::create_dir_all(&out_dir)?;
    let name = format!(
        "{}-{}{}",
        if label.is_empty() { "image" } else { &label },
        OffsetDateTime::now_utc().format(format_description!("[hour][minute][second]"))?,
        result.extension()
    );
    let out_path = out_dir.join(name);
    fs::write(&out_path, &result.data)?;
    Ok(serde_json::json!({
        "path": out_path.display().to_string(),
        "label": label,
        "sha256": sha256_hex(&result.data),
        "size_bytes": result.data.len(),
        "prompt": prompt,
    }))
}

fn save_artifact(env: &ToolEnv, args: Value) -> Result<Value> {
    let slug = clean_label(&string_arg(&args, "slug"));
    let image_path = string_arg(&args, "image_path");
    if slug.is_empty() {
        return Ok(error_value("slug is required"));
    }
    if image_path.trim().is_empty() {
        return Ok(error_value("image_path is required"));
    }
    let source = safe_join_allow_abs(&env.workspace.root, &image_path)?;
    let data = fs::read(&source).with_context(|| format!("read {}", source.display()))?;
    let ts = OffsetDateTime::now_utc().format(format_description!(
        "[year][month][day]-[hour][minute][second]"
    ))?;
    let fallback = env.workspace.artifact_outputs_dir(&slug, &ts);
    let out_dir = resolve_output_dir(
        &env.workspace.root,
        &string_arg(&args, "output_dir"),
        &fallback,
    )?;
    fs::create_dir_all(&out_dir)?;
    let ext = source.extension().and_then(|e| e.to_str()).unwrap_or("png");
    let out_path = out_dir.join(format!("image.{ext}"));
    fs::write(&out_path, &data)?;
    let prompt = string_arg(&args, "prompt");
    if !prompt.trim().is_empty() {
        fs::write(out_dir.join("prompt.txt"), prompt)?;
    }
    Ok(serde_json::json!({
        "path": out_path.display().to_string(),
        "sha256": sha256_hex(&data),
    }))
}

fn bash(env: &ToolEnv, args: Value) -> Result<Value> {
    let command = string_arg(&args, "command");
    if command.trim().is_empty() {
        return Ok(error_value("command is required"));
    }
    let description = string_arg(&args, "description");
    let binary = first_binary(&command);
    let approved_via = approve_bash(env, &command, &description, &binary)?;
    if let Some(error) = approved_via.strip_prefix("error:") {
        return Ok(error_value(error.trim()));
    }
    let timeout = args
        .get("timeout_seconds")
        .and_then(Value::as_f64)
        .unwrap_or(30.0)
        .clamp(1.0, 300.0);
    let output = Command::new("/bin/sh")
        .arg("-c")
        .arg(&command)
        .current_dir(&env.workspace.root)
        .env("OPENMELON_BASH_TIMEOUT_SECONDS", timeout.to_string())
        .output()
        .with_context(|| format!("run bash command: {command}"))?;
    Ok(serde_json::json!({
        "stdout": String::from_utf8_lossy(&output.stdout).to_string() + &String::from_utf8_lossy(&output.stderr),
        "exit_code": output.status.code().unwrap_or(-1),
        "approved_via": approved_via,
        "timeout_seconds": Duration::from_secs_f64(timeout).as_secs(),
    }))
}

fn string_arg(args: &Value, name: &str) -> String {
    args.get(name)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn error_value(message: &str) -> Value {
    serde_json::json!({ "error": message })
}

fn normalize_skill_spec(value: &str) -> String {
    value
        .trim()
        .strip_prefix("skillplus:")
        .unwrap_or(value.trim())
        .strip_prefix("path:")
        .unwrap_or_else(|| {
            value
                .trim()
                .strip_prefix("skillplus:")
                .unwrap_or(value.trim())
        })
        .trim()
        .to_string()
}

fn normalize_locale(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "zh" | "zh-cn" | "zh_cn" | "chinese" | "cn" => "zh-CN".to_string(),
        "en" | "en-us" | "english" | "us" => "en".to_string(),
        _ => value.trim().to_string(),
    }
}

fn parse_skillplus_output(skill: &str, via: &str, output: std::process::Output) -> Result<Value> {
    if !output.status.success() {
        let detail = first_non_empty_str(&[
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
            format!("exit {}", output.status.code().unwrap_or(-1)),
        ]);
        return Ok(error_value(&format!(
            "skillplus compile failed for {skill:?} via {via}: {detail}"
        )));
    }
    let value: Value = match serde_json::from_slice(&output.stdout) {
        Ok(value) => value,
        Err(err) => {
            return Ok(error_value(&format!(
                "skillplus compiler output is not valid JSON: {err}"
            )))
        }
    };
    Ok(value)
}

fn approve_bash(env: &ToolEnv, command: &str, description: &str, binary: &str) -> Result<String> {
    if env.bash_mode == "trusted" {
        return Ok("trusted".to_string());
    }
    if !binary.is_empty()
        && env
            .allowed_bash
            .lock()
            .map(|allowed| allowed.contains(binary))
            .unwrap_or(false)
    {
        return Ok("allowlisted".to_string());
    }
    if env.bash_mode == "auto" && is_read_only_command(command) {
        return Ok("read-only".to_string());
    }
    if !io::stdin().is_terminal() {
        return Ok(
            "error:bash is unavailable: command needs approval but stdin is not interactive"
                .to_string(),
        );
    }

    render_approval_request(command, description, binary)?;
    let mut answer = String::new();
    io::stdin().read_line(&mut answer)?;
    match answer.trim().to_ascii_lowercase().as_str() {
        "y" | "yes" => Ok("user-approved".to_string()),
        "a" | "always" => {
            if !binary.is_empty() {
                let mut allowed = env
                    .allowed_bash
                    .lock()
                    .map_err(|_| anyhow::anyhow!("bash allowlist lock poisoned"))?;
                allowed.insert(binary.to_string());
            }
            Ok("user-approved".to_string())
        }
        _ => Ok("error:user denied execution".to_string()),
    }
}

fn render_approval_request(command: &str, description: &str, binary: &str) -> Result<()> {
    eprintln!();
    eprintln!("Do you want to proceed?");
    if !description.is_empty() {
        eprintln!("  Reason:  {description}");
    }
    eprintln!("  Command: {command}");
    if binary.is_empty() {
        eprint!("Approve? [y]es / [N]o: ");
    } else {
        eprint!("Approve? [y]es / [a]lways allow {binary} this session / [N]o: ");
    }
    io::stderr().flush()?;
    Ok(())
}

fn safe_join(root: &Path, rel: &str) -> Result<PathBuf> {
    let path = root.join(rel.trim());
    let root = root.canonicalize()?;
    let abs = path.canonicalize()?;
    if !abs.starts_with(root) {
        bail!("path escapes project workdir: {rel}");
    }
    Ok(abs)
}

fn safe_join_allow_abs(root: &Path, value: &str) -> Result<PathBuf> {
    let path = PathBuf::from(value.trim());
    let candidate = if path.is_absolute() {
        path
    } else {
        root.join(path)
    };
    let root = root.canonicalize()?;
    let abs = candidate.canonicalize()?;
    if !abs.starts_with(root) {
        bail!("path escapes project workdir: {value}");
    }
    Ok(abs)
}

fn is_text_path(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|e| e.to_str()).unwrap_or(""),
        "json" | "jsonl" | "md" | "txt" | "search"
    ) || path.file_name().and_then(|n| n.to_str()) == Some(".search")
}

fn is_image_path(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "png" | "jpg" | "jpeg" | "webp" | "gif"
    )
}

fn snippet(body: &str, query: &str) -> String {
    let lower = body.to_ascii_lowercase();
    let idx = lower.find(query).unwrap_or(0);
    let start = idx.saturating_sub(80);
    let end = (idx + query.len() + 160).min(body.len());
    body[start..end].replace('\n', " ")
}

fn read_json_file(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|body| serde_json::from_str(&body).ok())
}

fn write_json(path: &Path, value: &Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string_pretty(value)? + "\n")?;
    Ok(())
}

fn append_jsonl(path: &Path, value: &Value) -> Result<()> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    serde_json::to_writer(&mut file, value)?;
    file.write_all(b"\n")?;
    Ok(())
}

fn read_jsonl_tail(path: &Path, limit: usize) -> Vec<Value> {
    let Ok(body) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut rows = body
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    if rows.len() > limit {
        rows = rows.split_off(rows.len() - limit);
    }
    rows
}

fn collect_json_files(root: &Path, limit: usize) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            rows.extend(collect_json_files(&path, limit));
        } else if path.extension().and_then(|e| e.to_str()) == Some("json") {
            if let Some(value) = read_json_file(&path) {
                rows.push(value);
            }
        }
    }
    rows.truncate(limit);
    rows
}

fn clean_label(value: &str) -> String {
    value
        .trim()
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn array_arg(args: &Value, name: &str) -> Value {
    args.get(name)
        .and_then(Value::as_array)
        .cloned()
        .map(Value::Array)
        .unwrap_or_else(|| Value::Array(Vec::new()))
}

fn now_rfc3339() -> Result<String> {
    Ok(OffsetDateTime::now_utc().format(&time::format_description::well_known::Rfc3339)?)
}

fn compact_timestamp() -> Result<String> {
    Ok(OffsetDateTime::now_utc().format(format_description!(
        "[year][month][day]-[hour][minute][second]"
    ))?)
}

fn ensure_newline(value: &str) -> String {
    if value.ends_with('\n') {
        value.to_string()
    } else {
        format!("{value}\n")
    }
}

fn first_non_empty_str(values: &[String]) -> String {
    values
        .iter()
        .map(|value| value.trim())
        .find(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn first_binary(command: &str) -> String {
    for mut token in command.split_whitespace() {
        if token.is_empty() {
            continue;
        }
        if token.contains('=') && !token.contains('/') && !token.contains('\\') {
            continue;
        }
        if matches!(token, "sudo" | "time" | "exec" | "nohup" | "env") {
            continue;
        }
        if let Some(idx) = token.rfind(['/', '\\']) {
            token = &token[idx + 1..];
        }
        return token.to_string();
    }
    String::new()
}

fn sha256_hex(data: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(data);
    format!("{:x}", hasher.finalize())
}

fn is_read_only_command(command: &str) -> bool {
    let mut parts = command.split_whitespace();
    let first = parts.next().unwrap_or_default();
    matches!(
        first,
        "ls" | "find"
            | "rg"
            | "grep"
            | "sed"
            | "cat"
            | "head"
            | "tail"
            | "wc"
            | "pwd"
            | "file"
            | "du"
            | "stat"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_label_normalizes_to_slug_like_text() {
        assert_eq!(clean_label("My Image 01"), "my-image-01");
    }

    #[test]
    fn normalize_skill_spec_strips_legacy_prefixes() {
        assert_eq!(normalize_skill_spec("skillplus:brand-logo"), "brand-logo");
        assert_eq!(
            normalize_skill_spec("path:/tmp/brand.skillplus"),
            "/tmp/brand.skillplus"
        );
    }

    #[test]
    fn normalize_locale_accepts_common_aliases() {
        assert_eq!(normalize_locale("zh"), "zh-CN");
        assert_eq!(normalize_locale("EN-US"), "en");
        assert_eq!(normalize_locale("fr"), "fr");
    }

    #[test]
    fn first_binary_skips_common_shell_wrappers() {
        assert_eq!(first_binary("FOO=bar env /usr/bin/rg hello"), "rg");
        assert_eq!(first_binary("sudo time ls -la"), "ls");
    }
}
