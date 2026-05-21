# TS-First TUI Architecture

OpenMelon's product TUI and default creator runtime are now TypeScript and Ink.
The goal is one product entrypoint that does not require non-TS runtimes.

## Decision

The user-facing `openmelon` command is the TS package under `tui/`. Historical
non-TS implementations must not be on the installed command path, and the
installed command, TUI, runtime, and common project commands must not spawn
non-TS binaries.

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
- `src/runtime/nativeClient.ts` runs the TS-native agent loop
- `src/runtime/openaiCompat.ts` implements OpenAI-compatible and Anthropic
  streaming tool calls
- `src/commands/` contains TS-native project, registry, search, session, and
  continuity-space CLI commands
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

The product boundary is an in-process TS runtime client:

- TS owns the terminal UI, onboarding screens, slash palette, input behavior,
  normal scrollback rendering, and creator runtime.
- The native runtime owns tool registry, session persistence, approvals, model
  calls, image generation, and continuity tools.
- Runtime configuration changes use `reload` so the active runtime sees the new
  settings without losing the session.
- `runtime-bridge` and process fallback are retired in the TS entrypoint.

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
- `/model`, `/model-image`, and `/settings` persist to project config and call
  runtime `reload` so the active runtime sees the new settings without losing
  the session.

This keeps the product path TS-native while allowing old non-TS code to be
inspected separately during migration.
