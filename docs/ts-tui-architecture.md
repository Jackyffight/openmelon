# TS-First TUI Architecture

OpenMelon's product TUI is moving to TypeScript and Ink. The goal is not to
replace the creator runtime in this step; it is to make the terminal experience
stable enough to become the main product surface.

## Decision

The TUI should be implemented as a TS/Ink application and installed as the
user-facing `openmelon` command when this migration is complete.

Go remains the current runtime reference. Rust TUI work is kept as a prototype
and comparison point, but it is no longer the primary UI direction.

## Why

The product bottleneck is interaction quality rather than low-level execution:

- slash command palettes need component-level layout
- prompt, status, transcript, tool blocks, and approvals need fast visual
  iteration
- Chinese IME, resize, scrollback, and copy behavior need to be validated in the
  real terminal before runtime integration
- full-screen viewport approaches create recurring conflicts with terminal
  scrollback and native copying

The chosen shape is scrollback-first:

- transcript output remains in the terminal's normal scrollback
- the app does not use alternate screen as the default product mode
- the current prompt, slash palette, status, and pending input are interactive
  Ink components
- runtime output is appended as transcript events rather than re-rendering old
  history

## Current Package

The production TUI package lives in `tui/`.

- `src/App.tsx` owns the UI state machine and key handling
- `src/components/` contains visual components
- `src/state/` contains reducer/state types
- `src/runtime/processBridge.ts` talks to the Go runtime bridge over JSONL
- `bin/openmelon.js` launches built JS when available, or TS source through
  `tsx` in development

Run locally:

```sh
cd tui
npm install
npm run dev
```

Install as the local `openmelon` command:

```sh
make tui-install
```

## Runtime Boundary

The product boundary is a JSONL process bridge:

- TS owns the terminal UI, onboarding screens, slash palette, input behavior,
  and normal scrollback rendering.
- Go owns the creator runtime, tool registry, session persistence, approvals,
  model calls, image generation, and continuity tools.
- The bridge process is launched as `openmelon runtime-bridge [resume-id]`.
- Resume ids must be passed into the bridge, not only rendered by the UI, so
  the next model call receives the loaded message history.
- Runtime configuration changes use `reload` instead of killing the bridge.
  This preserves in-memory conversation history, pending input, the current
  session directory, and per-session bash allowlists.

The UI expects runtime events shaped like:

- `status`: Ready, Thinking, Calling tool, Error
- `append`: user, assistant, tool, result, info, error transcript blocks
- `usage`: prompt/completion token updates
- `done`: active turn finished

Input flows the other direction:

- normal submit starts a run when idle
- submit while running queues pending input
- pending input is sent at the next model-call boundary
- if the run has already ended, pending input starts a new run immediately
- `/clear`, `/history`, and `/save` are runtime commands, not transcript-only
  UI commands. They operate on the LLM message history.
- `/model`, `/model-image`, and `/settings` persist to project config and then
  call bridge `reload` so the active runtime sees the new settings without
  losing the session.

This keeps the TUI independent from whether the runtime remains Go, moves to TS,
or runs as a separate native process.
