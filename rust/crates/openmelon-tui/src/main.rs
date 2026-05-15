mod app;
mod config;
mod image;
mod llm;
mod project;
mod render;
mod runtime;
mod session;
mod terminal;
mod tools;

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "openmelon-tui")]
#[command(about = "Rust TUI for OpenMelon")]
struct Cli {
    #[arg(long, default_value = ".")]
    workdir: PathBuf,

    #[arg(short = 'p', long)]
    prompt: Option<String>,

    #[arg(long)]
    resume: Option<String>,

    #[arg(long)]
    llm: Option<String>,

    #[arg(long = "llm-model")]
    llm_model: Option<String>,

    #[arg(long = "llm-base-url")]
    llm_base_url: Option<String>,

    #[arg(long = "reasoning-effort")]
    reasoning_effort: Option<String>,

    #[arg(long = "image-provider")]
    image_provider: Option<String>,

    #[arg(long = "image-model")]
    image_model: Option<String>,

    #[arg(long = "image-base-url")]
    image_base_url: Option<String>,

    #[arg(long = "max-steps", default_value_t = 24)]
    max_steps: usize,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    Repl,
    EventTui,
    Demo,
    Run { prompt: String },
    Resume { session_id: String },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let command = match cli.command {
        Some(command) => command,
        None if cli.prompt.is_some() => Command::Run {
            prompt: cli.prompt.clone().unwrap_or_default(),
        },
        None if cli.resume.is_some() => Command::Resume {
            session_id: cli.resume.clone().unwrap_or_default(),
        },
        None => Command::Repl,
    };

    let options = app::AppOptions {
        workdir: cli.workdir,
        provider: cli.llm,
        model: cli.llm_model,
        base_url: cli.llm_base_url,
        reasoning_effort: cli.reasoning_effort,
        image_provider: cli.image_provider,
        image_model: cli.image_model,
        image_base_url: cli.image_base_url,
        max_steps: cli.max_steps,
    };

    match command {
        Command::Repl => app::App::new(options, None)?.run(),
        Command::EventTui => app::App::new(options, None)?.run_event_tui(),
        Command::Demo => app::App::new_demo(options.workdir)?.run_demo(),
        Command::Run { prompt } => app::App::new(options, None)?.run_one_shot(prompt),
        Command::Resume { session_id } => app::App::new(options, Some(session_id))?.run(),
    }
}
