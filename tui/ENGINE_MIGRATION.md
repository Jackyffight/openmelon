# OpenMelon → all-TypeScript engine migration

**Goal:** eliminate every Go dependency. Today the Ink/React TUI (`tui/`) is only a
front-end; the agent engine (LLM tool loop, tools, providers, imagegen) still runs
as a **Go subprocess** spoken to over JSON-lines (`openmelon runtime-bridge`). The
end state is a fully in-process TypeScript engine — the strongest independent agent
for multimodal creation — with the Go tree deleted.

## STATUS (2026-05-23): ✅ MIGRATION COMPLETE — 100% TypeScript, zero Go

All 13 tasks done. The Go tree (`cmd/`+`internal/`+`pkg/`+`go.mod`/`go.sum`), the Rust TUI
spike (`rust/`), and `experiments/` were deleted (146 files); the `runtime-bridge` Go fallback
and `OPENMELON_USE_GO_BRIDGE` were removed; `processBridge.ts` deleted (shared types moved to
`runtime/types.ts`); the npm `@e8s/openmelon` package is now `tui/` itself (the Go-binary
downloader `npm/` is gone); Makefile + scripts/release.sh + CLAUDE.md + README + ARCHITECTURE
rewritten for TS. `find . -name '*.go' -o -name '*.rs'` → none. tsc green; build + CLI smokes
(help, character/space management, headless `-p` against live OpenRouter) all pass.

Everything below is the historical migration record.

---

## (historical) the whole product is TS except the optional Go fallback

Tasks #1–#8, #10, #2, #11, #12 done — all typechecked + behaviorally tested. The default runtime
path is the in-process TS engine (`createLocalRuntime`); **all 7 management CLI groups** + **headless
`-p`** + **help** are pure TS. TS has **full tool parity (24 tools)** and **3 tool-capable providers**
(openrouter/openai/anthropic — Anthropic tool use exceeds the Go original).

**Only Go left:** the `runtime-bridge` subcommand, used solely by the `OPENMELON_USE_GO_BRIDGE=1`
fallback (the TUI's processBridge spawns the Go binary). Everything else is TS.

**Partial real-machine validation:** `openmelon -p "<intent>"` was exercised against the real
OpenRouter API (picked up the dev's ~/.openmelon config) — bootstrap → session → system prompt →
chat request all correct; it returned a clean `403 "model not available in your region"` (the dev's
configured default model is region-blocked — a config choice, not a code bug). So the LLM client +
credential resolution + factory work against the live API.

**#9 (last task)** — delete the Go tree (`cmd/`+`internal/`), drop the `runtime-bridge` fallback,
repoint npm dist to the TS build, rewrite docs. Gated on: (a) a fuller real-machine smoke test of the
TUI path (`npm run dev` with an *available* model, `OPENMELON_USE_GO_BRIDGE` unset); (b) user
confirmation, since deleting the Go tree is irreversible. Do NOT delete Go before both.

## Real-machine smoke test (do this before #9)

The sandbox can't run it (no model key / network / TTY / subprocess spawn). On a real machine:

```bash
cd tui
npm install --ignore-scripts          # (esbuild postinstall is skipped; fine)
npm run build                          # emits dist/ (incl dist/cli.js)
cd /path/to/an/openmelon-project       # has .openmelon/project.json + a model key configured
unset OPENMELON_USE_GO_BRIDGE          # ensure the TS engine is used
node /path/to/tui/dist/cli.js          # or: npm --prefix /path/to/tui run dev
```

Verify: TUI launches → `ready` (model/provider shown) → type a prompt → streamed text →
`generate_image` tool call → image lands in `outputs/sessions/<id>/` → `finish` summary.
Also try `/publish` (vbox key configured), a bash command (approval modal appears), and a
continuity flow (`create_space` → confirm → `activate_space` → `create_episode`).

To compare against the Go path: `OPENMELON_USE_GO_BRIDGE=1 node dist/cli.js` (needs the Go
binary built at repo root). Behaviour should match.

**Scope note for #9 (full Go removal):** the agent *runtime* is fully TS, but the legacy
management subcommands still shell to the Go binary via `runLegacy` in `src/cli.ts`
(`character`/`reference`/`material`/`project`/`search`/`space`/`session` add/list/show/rm). Task #11.

**#11 progress:**
- registry **write-side DONE** — `engine/registry.ts`: `add` (meta/.search split, image copy +
  numeric-dedup, `allowExists` merge), `setSearch`, `remove`, `addMaterial` (sha256 → `m-<hex16>`).
  Fixed `Item` timestamps to snake_case to match on-disk Go JSON. Typechecks + behavioral test.
- **CLI dispatch DONE for character/reference/material/search/session/project** — `src/commands/manage.ts`
  (interspersed flag parser, tabwriter-style aligned output) wired into `src/cli.ts` via
  `tsManagedCommands`. Verified end-to-end by driving the compiled `dist/cli.js`.
  - `project` added `core/config` helpers: `resolveProvider(workdir,provider)` (now full Go-parity
    precedence + keySource — its signature changed from `(project,provider)`; localRuntime updated),
    `resolveApiKey`, `loadProjectCredentials`/`saveProjectCredentials`/`setProjectApiKey`/
    `unsetProjectApiKey`, `setCurrent`/`markUsed`/`lookup`, `maskKey`, `NoCurrentProjectError`. Tested:
    list/use/show/keys/set-key(project+global)/unset-key, project-overrides-global resolution, masking.
    `set-key` is non-interactive (`--key <value> [--global]`); the Go interactive Ink wizard isn't
    ported — could add later but non-interactive covers scripting/CI.
- **#11 DONE** — `space` CLI ported (`runSpace` in manage.ts: create/activate/list/show[--json]/
  context/search/decision/feedback/memory/promote/episode/asset/asset-weight/compact[--draft]).
  Added `engine/continuity.buildCompactionDraft`. Verified end-to-end via `dist/cli.js` (full
  lifecycle, draft-blocks-episode, JSON context, compact draft). **All 7 management subcommand
  groups (character/reference/material/search/session/project/space) are pure TS.**

**Go entry points still in `src/cli.ts` (runLegacy):**
1. headless `-p "<intent>"` one-shot agent run — task #12 (port: localRuntime-style bootstrap + one
   Runtime turn, no Ink TUI, judge-only bash). Plus help/-h/--help (add a TS usage printer).
2. `runtime-bridge` subcommand — only the `OPENMELON_USE_GO_BRIDGE` fallback uses it (the TUI's
   processBridge spawns the Go binary). Keep until #9; remove with the Go tree.

After #12, the only Go left is the optional bridge fallback → #9 deletes the Go tree + repoints npm
dist to the TS build + rewrites docs, gated on a real-machine smoke test + user confirmation.

## Current boundary (what bridges to Go)

`tui/src/runtime/processBridge.ts` spawns `openmelon runtime-bridge` and exchanges:

- **Requests** (TUI→Go): `run` · `pending` · `cancel` · `clear` · `history` ·
  `save` · `reload` · `approval` · `shutdown`.
- **Events** (Go→TUI): `ready` · `status{thinking|tool|ready|error}` ·
  `append{kind,text}` · `usage` · `approval{detail}` · `done` · `error`.

The Go side (`cmd/openmelon/cmd_runtime_bridge.go`) wires:
`projectx.Load → llm.New → imagegen.New → runtime.Runtime{MaxSteps:24} →
tools.RegisterAll(Env) → buildProjectSystemPrompt`, then `rt.Run({SystemPrompt,
UserInput, History})` streaming through a `Tracer` that maps 1:1 to the events above.

**The seam:** implement a TS `RuntimeBridge` (same interface `processBridge.ts`
exports) backed by an in-process TS engine. Swap `createRuntimeBridge` in `App.tsx`.
Nothing else in the TUI changes — it already consumes `RuntimeEvent`.

## What is already TS (in `tui/src/core/`)

`config` (userconfig), `project` (projectx), `session` (read side), `space`
(continuity read), `skillplus` (subprocess wrapper), `providers`, `bootstrap`, `fs`.
So the project/config/session leaf layers are largely done. The **engine heart** is
what remains.

## What does NOT need porting

`internal/tui/` (3196 LOC) and `internal/repl/` (2229 LOC) are obsoleted by the Ink
TUI. The Go `cmd_*` REPL/onboarding paths likewise. Don't port presentation.

## Target layout

```
tui/src/engine/
  llm/
    types.ts        Message, Tool, ToolCall, ChatRequest, ChatResponse, Usage, Role, FinishReason
    sse.ts          SSE line parser (data: frames, [DONE])
    openai.ts       OpenAI + OpenRouter (same wire); Chat + StreamChat, tool-call delta reassembly
    anthropic.ts    Anthropic messages API + tool use
    factory.ts      new(provider, key, baseURL, model); auto-detect by env key
  runtime.ts        ReAct loop (port internal/runtime/runtime.go), Tracer, finish, drainUserInput, MaxSteps
  tools/
    registry.ts     Registry (Spec+Handler), Env
    builtin.ts      list_characters, get_character, search, compile_skill, generate_image, save_artifact, bash(+judge), finish
  imagegen.ts       Generator (OpenRouter image), reference images, transient retry
  registry.ts       characters/references/materials on-disk store (+ .search), tag+grep search
  systemPrompt.ts   buildProjectSystemPrompt, resolveDefaults, resolveReasoningEffort
  localRuntime.ts   in-process RuntimeBridge: owns runtime+session+tools, Tracer→RuntimeEvent
```

## Wire facts to preserve (from the Go port)

- Endpoint `POST {baseURL}/v1/chat/completions`. OpenAI base `https://api.openai.com`;
  OpenRouter base `https://openrouter.ai/api` + headers `HTTP-Referer`, `X-Title`.
- Streaming: `stream:true`, `stream_options.include_usage:true`. Tool-call args are
  split across chunks — reassemble by `tool_calls[].index`, not by id (id only on
  first delta). Materialize in index order; empty args → `{}`.
- `reasoning_effort` ∈ {none,minimal,low,medium,high,xhigh}, else omit.
- Default temperature 0.7. Tool message role `tool` + `tool_call_id`.
- Runtime: seed system+user (new) or history+user (continuation; system already at [0]).
  Loop until natural stop, `finish` tool, or MaxSteps (24 in bridge). Tool results are
  JSON; an `{"error":...}` result is surfaced to the model so it can self-correct.

## Provider policy (project memory)

Model stack is **OpenRouter (OpenAI/Google/xAI) + Cloudflare Workers AI**, described
by function not vendor. Do NOT bake in vendor model defaults (Go returns
`ErrModelRequired`); models come from the auth wizard / `/model`. No Chinese-origin
providers.

## Slice order (tracked as tasks #1–#9)

1. ✅ **LLM client (OpenAI/OpenRouter, streaming+tools)** — `engine/llm/{types,sse,openai}.ts`.
   Typechecks + behavioral test (streaming tool-call reassembly, usage, text deltas).
2. ✅ Anthropic client — `engine/llm/anthropic.ts` (Messages API **with tool use** — stronger than the
   Go original, which has no tool support). chat() only (runtime falls back from streamChat). Wired
   into factory.ts (`newAnthropic`, auto-detect prefers it per Go order). Typechecks + behavioral test
   (OpenAI→Anthropic msg conversion: system extraction, tool_use/tool_result blocks; response parse).
3. ✅ **ReAct runtime loop** — `engine/runtime.ts`. Typechecks + behavioral test (dispatch
   order, finish summary/artifacts, history shape, tracer events). Hooks seam left as TODO.
4. ✅ **Tools registry + builtins** (core scope) — `engine/tools/{registry,builtin}.ts`. Registered:
   list_characters, get_character, list_references, get_reference, search, read_file, compile_skill
   (via `core/skillplus.compileSkill`), generate_image, save_artifact, finish. Param schemas + JSON
   results copied verbatim from builtin.go. Typechecks + **end-to-end integration test**
   (Runtime+Registry+imagegen: model→generate_image→file in outputs/→finish).
   **bash DONE** — `engine/tools/bash.ts`: 4-tier gate (trusted→allowlist→LLM judge AUTO/ASK/BLOCK→
   user modal), `firstBinary`, `judgeBashWithLLM` (fail-safe to ask). Wired into localRuntime
   (allowlist Set, judge via main LLM, approval round-trip: emit `approval` → TUI modal →
   `bridge.approval(id,…)` → `engine.answerApproval` resolves the handler promise). Gating branches +
   judge tested; the spawn exec path can't be tested in-sandbox (spawn blocked) but is a faithful port.
   TS tool set now matches the Go non-continuity set (11 tools). **Deferred:** the 13 continuity tools (#10).
5. ✅ imagegen — `engine/imagegen.ts` (OpenRouter chat-completions image + OpenAI images; reference
   images; transient retry). Typechecks + behavioral test (request shape, data-URL decode, sniff).

   ★ **#10 continuity DONE** — `engine/continuity.ts` (full file-backed store: spaces, assumptions,
   canon, memory, plan, decisions, feedback, memory items, compactions, episodes, assets; search,
   workflow planner, selected context packet with asset ranking + truncation flags) +
   `engine/tools/continuity.ts` (all 13 tools, specs verbatim) wired into buildRegistry. Typechecks +
   lifecycle behavioral test. **TS registry now exposes all 24 tools — full tool parity with Go.**
6. ✅ **registry/search** — `engine/registry.ts` + `engine/search.ts` (read side). Typechecks +
   behavioral test (list/get/images, tag/substring/negative/kind search). Write side (add/remove)
   deferred to the CLI slice.
7. ✅ session write-side (`core/session.ts`: `createSession`/`appendMessages`/`writeSummary`/
   `setRuntimeInfo`, schema v2, snake_case messages.jsonl compatible with the Go reader) +
   `engine/systemPrompt.ts` (`buildProjectSystemPrompt`, `resolveDefaults`, `resolveReasoningEffort`).
   Typechecks + behavioral test (write/resume round-trip, meta/summary, prompt, effort defaults).
   Also added `engine/llm/factory.ts` (`newLLM`, env auto-detect) + `core/config.resolveProvider`.
8. ✅ **in-process runtime adapter** — `engine/localRuntime.ts` implements `RuntimeBridge` in-process
   (bootstrap project→llm→imagegen→registry→systemPrompt→session; run/cancel/clear/history/save/
   reload/shutdown; Tracer→RuntimeEvent; pending queue; engine.Message↔on-disk ChatMessage convert).
   **App.tsx now defaults to `createLocalRuntime`** (Go bridge behind `OPENMELON_USE_GO_BRIDGE=1`).
   Full project typechecks + builds; engine e2e test green. **The Go subprocess is off the default
   runtime path.** `approval()` is a stub until bash lands.
   ⚠️ NOT yet live-run: the TUI↔localRuntime path hasn't been exercised with a real project + model
   key + TTY. Verify with `npm run dev` inside an openmelon project (key configured), unset
   `OPENMELON_USE_GO_BRIDGE`.
9. ⬜ decommission Go (delete cmd/internal runtime path, repoint npm dist to TS build, fix
   CLAUDE.md/README/ARCHITECTURE). **Blocked on:** bash tool + continuity tools (#10) for full parity.

Verify each slice with `node node_modules/typescript/bin/tsc --noEmit` (the sandbox can't link
`.bin`; invoke tsc via node directly). Behavioral tests: `tsc -p tsconfig.build.json` then run a
plain-JS test against `dist/` with node (tsx/esbuild can't spawn in the sandbox). Keep the Go bridge
working until #8 lands so the TUI is never broken mid-migration.

**Sandbox note:** always install with `npm install --ignore-scripts --no-audit --no-fund`.
A plain install runs esbuild's postinstall (a `tsx` dep) which spawns a subprocess —
blocked by the sandbox (errno -88) — and that *aborts the whole install*, leaving
`node_modules/typescript` unlinked. `--ignore-scripts` skips it (we never run
esbuild/tsx here anyway). Verify `node_modules/typescript/bin/tsc` exists after. Beware
zombie background `npm install`s from earlier turns: they can prune node_modules when
they finally complete — chain install+typecheck+build+test in one command to avoid races.

## Notes / gotchas

- Deep import for vbox-cli lib today: `@e8s/vbox-cli/dist/lib/index.js` (no exports
  map yet). `/publish` already uses it (`tui/src/core/publish.ts`).
- `CLAUDE.md` in this repo is still **Go-oriented** (bubbletea, slash cmds in
  model.go) — stale; update in slice #9.
- The TS TUI tracks no structured artifacts in state; image paths arrive as
  transcript text. `save_artifact`/`generate_image` tools should keep writing to
  `outputs/` so `/publish` and the user can find results.
