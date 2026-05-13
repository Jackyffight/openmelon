# Rust TUI Rewrite

This branch carries the Rust rewrite without replacing the current Go CLI yet.
The goal is no longer a throwaway prototype: the Rust binary must preserve the
same project/session/tool protocol while moving the interactive surface to a
normal terminal-scrollback architecture.

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
- Markdown block rendering for history/resume and line-buffered Markdown
  rendering for streamed assistant text;
- status/help/history/session/events/copy/settings/model/model-image/skill/
  space/compact slash commands for local iteration;
- OpenAI/OpenRouter-compatible streaming chat completions with tool calls;
- `reasoning_effort` forwarding for GPT-5-family models;
- OpenAI-compatible request headers, including `openmelon-tui/<version>` user
  agent and OpenRouter `HTTP-Referer`/`X-Title`;
- project/global config and credentials resolution compatible with the Go CLI;
- session creation/resume using the same `.openmelon/sessions/<id>/`
  `meta.json`, `messages.jsonl`, and `summary.json` layout;
- session lifecycle events for turn starts, model responses, tool calls, and
  tool results;
- core tools for project inspection, file reads, search, visible artifact
  saves, Skill-Plus compilation, guarded shell execution, image generation,
  and `finish`.
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

1. Keep the Go entrypoint as production while Rust runs as an explicit binary.
2. Verify Rust parity against real creator projects: resume, long output,
   image generation, Skill-Plus, shell approval, and continuity reuse.
3. Harden the readline surface: multiline editing, Ctrl-C semantics, slash
   completion, and history behavior must match the expected Codex/Claude-like
   feel.
4. Port any remaining Go-only onboarding/setup commands or make the Rust
   binary call into the same project config files without drift.
5. Replace the Go TUI entrypoint only after copy, scroll, resize, Markdown,
   permission, model switching, output placement, and creator workflow parity
   are verified in daily use.

## Remaining Gaps

- Anthropic native tool calling is not ported. This mirrors the current Go
  interactive agent constraint: use OpenAI/OpenRouter-compatible providers for
  tool-calling sessions.
- Bash approval is interactive and supports yes/always/no, but the Rust branch
  does not yet have the Go TUI modal or LLM safety judge.
- The Rust input layer uses `rustyline`, not the full Go Bubble Tea visual
  prompt. It gives native editing/history/IME behavior, but slash completion
  and pending-input behavior still need the final Codex/Claude-like polish.
- Onboarding/setup/install commands remain in the Go CLI.
- The Go `openmelon` executable is still the production entrypoint until this
  branch is promoted.
