# CLAUDE.md — openmelon

Guidance for Claude Code (claude.ai/code) when working in this repo.

## What this is

`openmelon` is a content-creation agent CLI — **pure TypeScript / Node**. It was
originally Go + a thin npm wrapper; the engine, runtime, and CLI were migrated to
TypeScript and the entire Go tree was deleted. There is no Go left — do not add any.

The whole product lives in **`tui/`** and ships as the npm package `@e8s/openmelon`.

Three usage modes:

1. **Interactive TUI** — `openmelon` (no args, inside a project) opens an Ink/React
   REPL with slash commands, a model/skill picker, a bash approval modal, and session
   resume.
2. **Headless one-shot** — `openmelon -p "<intent>"`. Same native runtime, no TUI;
   streams progress, records the run to a session dir.
3. **Management CLI** — `openmelon <init|setup|resume|project|registry (character/
   reference/material)|search|session|space>`.

> Repo: https://github.com/eight-acres-lab/openmelon · package: `@e8s/openmelon`

## Layout (everything is under `tui/`)

```
tui/
  bin/openmelon.js          launcher: runs dist/cli.js (built) or src/cli.ts via tsx (dev)
  src/
    cli.ts                  subcommand dispatch (init/setup/resume/-p/help + management)
    main.tsx                Ink entry (runTui)
    App.tsx                 the TUI: state machine, slash commands, overlays, approval modal
    commands/               management subcommands: init, setup, project, registry,
                            search, session, space (+ common helpers)
    components/             Ink components: Header, Transcript, PromptInput, StatusLine,
                            WorkingLine, SelectorPanel, SetupPanel, SlashPalette
    core/                   project (workdir .openmelon/project.json), config
                            (~/.openmelon/{config,credentials,projects}.json), session,
                            registry (characters/references/materials), space (creative
                            continuity), approvals (bash gate), providers, skillplus, fs
    runtime/                THE NATIVE TS RUNTIME (no subprocess, no Go):
      index.ts              createRuntimeClient → always the native client
      nativeClient.ts       drives the agent loop; lazy session, resume, clearHistory
      nativeConfig.ts       loadNativeRuntimeBootstrap + buildSystemPrompt
      nativeTools.ts        the tools: registry reads, generate_image, continuity,
                            compile_skill, save_artifact, bash (gated), web_search/fetch
      openaiCompat.ts       OpenAI/OpenRouter chat+tools (streaming) + image generation
                            (honors reference images); Anthropic-style handled here too
      webTools.ts           web_search + web_fetch (DuckDuckGo, domain allow/block)
      sessionStore.ts       per-run messages.jsonl + meta.json
      protocol.ts           RuntimeClient / RuntimeEvent shared types
    state/                  TUI reducer + inputEditor (line editing) + types
    terminal/               anchoredStdout, cursorAnchor, markdown (marked), wrap, clipboard
    onboarding/             first-run wizard (trust → auth → project init)
  tsconfig.json             typecheck (NodeNext, strict)
  tsconfig.build.json       emit to dist/
```

## Commands

```bash
make build         # cd tui && npm install --ignore-scripts && npm run build  → tui/dist
make check         # typecheck (tsc --noEmit)
make dev           # run the TUI from source (tsx)
make install       # build then npm link the openmelon bin
cd tui && npm test # build + node --test on dist/**/*.test.js
```

Release: `./scripts/release.sh vX.Y.Z [--dry-run]` (bumps tui/package.json, builds,
`npm publish`es @e8s/openmelon — no native binaries).

## Conventions

- **Config is GLOBAL only.** Model, provider, API key, base_url, and the image
  model/provider live in `~/.openmelon/{config.json,credentials.json}` — never in the
  project. The project file carries identity, persona, constraints, continuity, and the
  one per-project behaviour knob `reasoning_effort`. All resolution goes through
  `core/config.ts` helpers: `resolveProvider` / `resolveApiKey` (global → env, no
  workdir lookup) and `setGlobalDefaults` / `setGlobalBaseUrl` / `setGlobalApiKey` /
  `unsetGlobalApiKey`. Do not reintroduce project-level model/key overrides.

- **Native runtime only.** `runtime/index.ts` always returns the native TS client;
  `OPENMELON_RUNTIME=process|go` is accepted but ignored (warns). No subprocess engine.

- **The bash tool is gated** (strict / auto / trusted via `project.json:settings.
  bash_permission_mode`): trusted bypass → per-session allowlist → judge LLM → user
  approval modal. Headless `-p` wires the judge but has no modal.

- **Publishing to V-Box is a bundled capability, not a command.** `@e8s/vbox-cli` is a
  dependency of `tui/`; `runtime/nativeTools.ts:bashEnv()` prepends `node_modules/.bin`
  to the bash PATH so the agent can run `vbox-cli upload` / `vbox-cli post` itself. The
  system prompt (`buildSystemPrompt`) tells the model how. There is no `/publish`.

- **Slug rules** are uniform kebab-case `[a-z][a-z0-9-]*`, len 2–64. Material slugs are
  `m-<hex>`.

- **No vendor model defaults baked into source.** Users pick from curated presets in the
  auth wizard / `/model` selector (`core/providers.ts`); the choice persists to global
  `config.json:defaults`.

- **Sessions are append-only.** A new session dir per launch (or per `resume`); the
  prior dir is never modified.

- **Tests** are colocated `*.test.ts`, run via `node --test` on the built `dist/`. Tests
  that exercise the runtime must isolate `OPENMELON_HOME` to a temp dir and point the
  global default at a dead local port so they never touch the developer's real config or
  API key (see `runtime/nativeClient.test.ts:useTempGlobalConfig`).

## Adding a tool

Add it in `runtime/nativeTools.ts` (it returns the full `NativeTool[]`), give it a JSON
schema + handler, and it is automatically advertised in `buildSystemPrompt`'s tool list.

## Adding an LLM / image provider

Wire it in `runtime/openaiCompat.ts` (chat + image are OpenAI-compatible) and add a row
to `core/providers.ts` so the auth wizard / `/model` selector know about it. Honor
reference images on the image path.
