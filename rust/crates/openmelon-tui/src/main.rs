mod app;
mod render;
mod session;
mod terminal;

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Debug, Parser)]
#[command(name = "openmelon-tui")]
#[command(about = "Rust TUI prototype for OpenMelon")]
struct Cli {
    #[arg(long, default_value = ".")]
    workdir: PathBuf,

    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    Demo,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let command = cli.command.unwrap_or(Command::Demo);

    match command {
        Command::Demo => app::App::new(cli.workdir)?.run(),
    }
}
