# Rust TUI Rewrite

This branch starts the Rust rewrite without replacing the current Go CLI yet.
The first goal is to lock down the terminal interaction contract before runtime
parity work begins.

## Direction

OpenMelon should behave like a creator-native agent, not a full-screen dashboard.
The terminal should keep native scrollback, selection, copying, and resize
behavior. Model output, tool output, permission prompts, and user input should
be rendered as stream-friendly transcript blocks instead of a synthetic screen
buffer.

The Rust TUI should therefore optimize for:

- normal terminal scrollback and native copy behavior;
- a real terminal cursor and IME-friendly text editing;
- stable history navigation and interrupt semantics;
- Markdown-aware transcript rendering;
- clear tool, permission, error, and assistant block boundaries;
- terminal-native soft wrapping and resize reflow instead of hard-wrapped
  synthetic screen lines;
- visible creator outputs under `outputs/`, with `.openmelon/` reserved for
  internal state.

## Current Slice

The new workspace lives under `rust/` and currently contains one crate:

- `crates/openmelon-tui`: a standalone prototype binary.

The Rust binary now provides:

- project layout discovery;
- hidden internal state at `.openmelon/`;
- visible creator output root at `outputs/`;
- readline-backed input history;
- normal-scrollback transcript output;
- simple Markdown block rendering that leaves line reflow to the terminal;
- status/help/history commands for local iteration;
- OpenAI/OpenRouter-compatible chat completions with tool calls;
- `reasoning_effort` forwarding for GPT-5-family models;
- project/global config and credentials resolution compatible with the Go CLI;
- session creation/resume using the same `.openmelon/sessions/<id>/`
  `meta.json`, `messages.jsonl`, and `summary.json` layout;
- core tools for project inspection, file reads, search, visible artifact
  saves, guarded shell inspection, image generation, and `finish`.
- creator continuity tools for planning, space creation/activation,
  decisions, feedback, provisional memory, episodes, reusable assets, and
  compaction records.

This still runs as a separate Rust binary and does not replace the existing Go
entrypoint. Keeping the entrypoints separate lets us test the Rust runtime
without breaking the current executable.

## Usage

```sh
cargo run --manifest-path rust/Cargo.toml -- repl
cargo run --manifest-path rust/Cargo.toml -- run "create today's episode brief"
cargo run --manifest-path rust/Cargo.toml -- resume <session-id>
```

The Rust runtime reads the same project defaults:

- `<project>/.openmelon/project.json`
- `<project>/.openmelon/credentials.json`
- `~/.openmelon/config.json`
- `~/.openmelon/credentials.json`
- provider environment variables

## Migration Plan

1. Stabilize the Rust TUI contract.
2. Add transcript block types for assistant text, reasoning summaries, tool
   calls, permission prompts, errors, and creator workflow checkpoints.
3. Port session loading and resume rendering into Rust.
4. Port the Go runtime behavior behind a Rust event model, keeping the disk
   protocol compatible while the entrypoint is separate.
5. Replace the Go TUI entrypoint only after resize, copy, history, interrupt,
   Markdown, and permission behavior match the target experience.

## Remaining Gaps

- Anthropic native requests are not ported yet.
- Bash approvals are conservative: trusted mode runs commands, strict mode
  auto-allows only read-only inspection commands.
- Slash command parity is not complete yet (`/model`, `/model-image`,
  `/settings`, `/copy`, `/events`, `/space`, `/compact`, `/skill` still need
  Rust implementations).
- Streaming SSE text/tool-call rendering is not ported yet; Rust currently uses
  non-streaming chat completions.
- The Go `openmelon` executable is still the production entrypoint.
