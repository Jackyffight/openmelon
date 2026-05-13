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

The prototype provides:

- project layout discovery;
- hidden internal state at `.openmelon/`;
- visible creator output root at `outputs/`;
- readline-backed input history;
- normal-scrollback transcript output;
- simple Markdown block rendering that leaves line reflow to the terminal;
- status/help demo commands for local iteration.

This is intentionally not wired into the Go runtime yet. Keeping it separate
lets us test the terminal contract without breaking the existing executable.

## Migration Plan

1. Stabilize the Rust TUI contract.
2. Add transcript block types for assistant text, reasoning summaries, tool
   calls, permission prompts, errors, and creator workflow checkpoints.
3. Port session loading and resume rendering into Rust.
4. Bridge Rust TUI to the existing Go runtime through a small JSON event stream,
   or port the runtime after the event contract is proven.
5. Replace the Go TUI entrypoint only after resize, copy, history, interrupt,
   Markdown, and permission behavior match the target experience.

## Non-goals For This Slice

- No model request code is moved yet.
- No image generation workflow is changed yet.
- No Go command is replaced yet.
- No generated deliverable is moved back into `.openmelon/`.
