# CLAUDE.md — openmelon

Guidance for Claude Code (claude.ai/code) when working in this repo.

## What this is

`openmelon` is a content-creation agent CLI — **pure TypeScript / Node**. (It was
originally Go + a thin npm wrapper; the entire engine and CLI were migrated to
TypeScript — see `tui/ENGINE_MIGRATION.md` for the history. There is no Go left.)

The whole product lives in **`tui/`** and ships as the npm package `@e8s/openmelon`.

Three usage modes:

1. **Interactive TUI** — `openmelon` (no args, inside a project) opens an Ink/React
   REPL with slash commands, a model/skill picker, a bash approval modal, and session
   resume.
2. **Headless one-shot** — `openmelon -p "<intent>"`. Same engine, no TUI; streams
   progress to stderr, records the run to a session dir.
3. **Management CLI** — `openmelon <character|reference|material|search|space|project|
   session|init|setup|resume>`.

> Repo: https://github.com/eight-acres-lab/openmelon · package: `@e8s/openmelon`

## Layout (everything is under `tui/`)

```
tui/
  bin/openmelon.js          launcher: runs dist/cli.js (built) or src/cli.ts via tsx (dev)
  src/
    cli.ts                  subcommand dispatch (init/setup/resume/-p/help + management)
    main.tsx                Ink entry (runTui)
    App.tsx                 the TUI: state machine, slash commands, overlays, approval modal
    commands/
      init.ts setup.ts      project init + key/model wizard
      manage.ts             character/reference/material/search/session/project/space CLI
      headless.ts           `-p` one-shot runner
    components/             Ink components (Header, Transcript, PromptInput, …)
    core/                   project (projectx), config (userconfig + credentials),
                            session (read+write), skillplus (subprocess), fs, providers
    engine/                 THE AGENT ENGINE (all in-process TS):
      llm/{types,sse,openai,anthropic,factory}.ts
                            cross-vendor chat+tools; OpenAI/OpenRouter (streaming) +
                            Anthropic (tool use). factory: newLLM(provider,…) + auto-detect
      runtime.ts            ReAct loop (Tracer, finish tool, drainUserInput, maxSteps)
      tools/{registry,builtin,bash,continuity}.ts
                            24 tools: read-only library + 13 continuity + compile_skill +
                            generate_image + save_artifact + bash (4-tier gate) + finish
      imagegen.ts           OpenRouter (chat-completions image) + OpenAI image; refs; retry
      registry.ts           characters/references/materials on-disk store (read+write)
      search.ts             tag+grep search
      continuity.ts         creative-space store (spaces/canon/decisions/episodes/assets…)
      systemPrompt.ts       buildProjectSystemPrompt + resolveDefaults + resolveReasoningEffort
      localRuntime.ts       in-process RuntimeBridge the TUI drives (Tracer→RuntimeEvent)
    runtime/types.ts        RuntimeBridge / RuntimeEvent shared types
    state/ terminal/        TUI reducer + terminal helpers
  tsconfig.json             typecheck (NodeNext, strict)
  tsconfig.build.json       emit to dist/
  ENGINE_MIGRATION.md       migration record (architecture, slices, gotchas)

Makefile                    build/check/dev/start/install (delegates to tui/)
scripts/release.sh          tag + build + npm publish @e8s/openmelon
docs/ examples/ config/ assets/   design notes, sample projects, brand
```

## Commands

```bash
make build          # cd tui && npm install --ignore-scripts && npm run build
make check          # typecheck
make dev            # run the TUI from source (tsx)

# Inside tui/:
node node_modules/typescript/bin/tsc --noEmit   # typecheck (see sandbox note below)
npm run build && node dist/cli.js               # run the compiled CLI
```

## Architecture conventions

- **On-disk state** lives under `<project>/.openmelon/` (project.json, credentials.json,
  sessions/, characters/, references/, materials/, spaces/). User-facing outputs go under
  `<project>/outputs/` — never write deliverables into `.openmelon`.
- **API key resolution** (`core/config.resolveProvider`): project.json providers → global
  config providers → project credentials.json → global credentials.json → env var.
- **No vendor model defaults baked into source.** Constructors throw `ModelRequiredError`
  when no model id is given; models come from the auth wizard / project defaults.
- **The engine is provider-agnostic.** Anything implementing `engine/llm/types.LLMClient`
  works; the runtime prefers `streamChat` when present, else `chat`.
- **Tools** return JSON-serializable values; a tool that returns `{error: …}` is surfaced to
  the model so it can self-correct. Tool param schemas are hand-written JSON Schema.
- **bash** is gated 4 ways: trusted-mode bypass → per-session allowlist → LLM judge
  (AUTO/ASK/BLOCK, fail-safe to ASK) → user approval modal. Headless `-p` has no modal
  (judge-only); use `bash_permission_mode: auto|trusted` in project.json for headless bash.
- **skillplus** is a subprocess (`skillplus` console script, or `python3 -m skillplus`).
- **Publishing to V-Box** uses the bundled `@e8s/vbox-cli` library (`core/publish.ts`,
  `/publish` slash command) — `uploadMedia` + `BCPClient.post` into the owner's review queue.

## Adding things

- **A tool**: add a `ToolDef` in `engine/tools/builtin.ts` (or a sibling) and register it in
  `buildRegistry`. Mirror the Go-era JSON-schema style.
- **An LLM provider**: implement `LLMClient` in `engine/llm/`, wire it into
  `engine/llm/factory.newLLM` + auto-detect.
- **An image provider**: implement `ImageGenerator` in `engine/imagegen.ts`, wire into
  `newImageGenerator`.
- **A slash command**: add to `src/commands.ts` `slashCommands` + a branch in `App.tsx`'s
  dispatch (heavier ones delegate to an async helper).

## Sandbox / tooling notes

- Install with `npm install --ignore-scripts` — a plain install runs esbuild's postinstall
  (a `tsx` dep) which can fail in restricted sandboxes and abort the whole install. Verify
  `node_modules/typescript` survives.
- In sandboxes where `.bin` isn't linked, invoke tsc as
  `node node_modules/typescript/bin/tsc`. Behavioral tests: build to `dist/` then run plain
  JS with `node` (tsx/esbuild can't spawn in some sandboxes).
