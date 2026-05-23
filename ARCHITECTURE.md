# Architecture

OpenMelon is a pure-TypeScript (Node) content-production runtime built around two core
abstractions:

- **Project** — a directory under `<workdir>/.openmelon/` holding the agent's persistent state: characters, references, session logs, settings, credentials.
- **Tool loop** — a ReAct-style agent where the model decides which tools to call against the project on each turn.

## Operating modes

| Mode | Entry | Used for |
|---|---|---|
| Interactive TUI | `openmelon` (no args) | Day-to-day creator workflow |
| Headless one-shot | `openmelon -p "<intent>"` | Scripts, sub-agent integration, CI |
| Management CLI | `openmelon <character\|space\|project\|…>` | Curate the project's libraries + spaces |

The agent loop runs **in-process** (`engine/localRuntime.ts` for the TUI, `commands/headless.ts`
for `-p`) — there is no separate runtime process.

## Tool loop

```
                    ┌─────────────────────┐
                    │   user message      │
                    └──────────┬──────────┘
                               ▼
              ┌────────────────────────────────┐
              │  LLM (with tools registered)   │◀────────┐
              └────────────────┬───────────────┘         │
                               ▼                         │
                    finish?────yes────▶ done             │
                       │                                 │
                       no                                │
                       ▼                                 │
              dispatch tool (locally or with approval)   │
                       │                                 │
                       ▼                                 │
            tool result appended as assistant message ───┘
```

Tools available to the model:

```
list_characters / get_character    project's character registry
list_references / get_reference    project's reference-image registry
search                             tag + substring grep across libraries
read_file                          read any file under the project workdir
compile_skill                      compile a skillplus package
generate_image (refs[])            image model, optional anchor images
save_artifact                      promote a session image to a final artifact
bash                               shell, gated by permission mode
finish                             end the loop with a summary
```

## Skill-Plus

Content "filters" live as [skillplus](https://github.com/eight-acres-lab/skillplus) packages — versioned, locale-aware bundles of system prompt + output schema. `compile_skill` shells out to the `skillplus` CLI. The TUI's `/skill` command picks one for the next message; the model can also pick on its own.

## Bash permission gate

Four tiers, evaluated in order:

```
1. Trusted mode bypass    Mode = trusted: no checks.
2. Per-session allowlist  Binaries the user marked "always" this run.
3. Judge LLM              Classifies: AUTO / ASK / BLOCK.
4. User approval modal    Yes / Yes-always-for-<binary> / No.
```

Mode lives at `project.json:settings.bash_permission_mode`. Defaults to strict. Headless mode lacks tier 4; bash is unavailable in strict + no allowlist.

## Sessions

Each `openmelon` launch (or `openmelon resume`) creates a new session dir. `messages.jsonl` records the conversation incrementally; `meta.json` records project id, intent, timestamps, and `resumed_from` for traceability. Sessions are append-only: resuming creates a new dir, the original is untouched.

## LLM interfaces (`engine/llm/`)

- `LLMClient.chat(req)` — multi-turn message list with tool calls (required).
- `LLMClient.streamChat(req, handlers)` — optional; token-by-token streaming. The runtime
  prefers it when present, else falls back to `chat`. OpenAI/OpenRouter use
  `stream_options.include_usage=true` (final chunk carries Usage); tool-call deltas are
  reassembled by `tool_calls[].index` since vendors split `function.arguments` across chunks.
- Providers: OpenAI + OpenRouter (`openai.ts`, streaming) and Anthropic (`anthropic.ts`,
  Messages API with tool use). `factory.newLLM(provider,…)` selects, with env auto-detect.

## API key resolution

`core/config.resolveProvider(workdir, provider)`: project.json providers → global config
providers → project `.openmelon/credentials.json` → global `~/.openmelon/credentials.json` →
environment variable. Both the TUI and headless `-p` use it.
