// openmelon's tool-driven agent loop, ported from internal/runtime.
//
// A classic ReAct cycle:
//   1. Send (system prompt, conversation, tools) to the LLM.
//   2. The model replies with text and/or tool_calls.
//   3. Dispatch each tool_call via the registry, append the result as a
//      tool message.
//   4. Loop until: the model finishes naturally, calls the `finish` tool,
//      or hits maxSteps.
//
// Provider-agnostic: anything implementing LLMClient works. When the client
// also implements streamChat, the loop streams text so the TUI renders as it
// arrives.

import type {ChatRequest, FinishReason, LLMClient, Message, Tool, ToolCall, Usage} from './llm/types.js';

export const defaultMaxSteps = 16;

/** A tool's machine-readable contract sent to the model. */
export type ToolSpec = {
	name: string;
	description: string;
	/** JSON Schema object. */
	parameters: Record<string, unknown>;
};

/**
 * The runtime depends only on this narrow registry surface. The tools package
 * implements it (specs to advertise + dispatch to run).
 */
export type ToolRegistry = {
	specs(): ToolSpec[];
	/** Run the named tool with the raw JSON argument string; resolve a JSON-serializable value or throw. */
	dispatch(name: string, argsJson: string, signal?: AbortSignal): Promise<unknown>;
};

/** Structured per-turn events. Implementations render however they like. */
export type Tracer = {
	onTurnStart?(turn: number): void;
	/** Streamed when the client supports it; otherwise fired once with the full text. */
	onText?(delta: string): void;
	onToolCall?(call: ToolCall): void;
	onToolResult?(call: ToolCall, content: string, err: Error | null): void;
	onTurnEnd?(turn: number, finish: FinishReason, usage: Usage): void;
};

export type RunInput = {
	/** Sets the agent's behavior + project context. Sent only when history is empty. */
	systemPrompt?: string;
	/** The user's request for this run. Appended after history. */
	userInput?: string;
	/** Prior conversation (incl. tool messages). When non-empty, systemPrompt is ignored (system already at [0]). */
	history?: Message[];
	temperature?: number;
	maxTokens?: number;
};

export type RunResult = {
	/** Full conversation incl. all tool calls + replies. Pass back as history to continue. */
	messages: Message[];
	/** LLM round-trips taken in this run (not cumulative). */
	steps: number;
	/** True when the loop exited via `finish` or a natural stop. */
	finished: boolean;
	finishSummary?: string;
	finishArtifacts?: string[];
};

export type RuntimeOptions = {
	llm: LLMClient;
	registry: ToolRegistry;
	tracer?: Tracer;
	maxSteps?: number;
	reasoningEffort?: string;
	/** Called before each model request to fold in user corrections queued mid-run. */
	drainUserInput?: () => string[];
};

export class Runtime {
	constructor(private readonly opts: RuntimeOptions) {}

	get reasoningEffort(): string {
		return this.opts.reasoningEffort ?? '';
	}

	async run(input: RunInput, signal?: AbortSignal): Promise<RunResult> {
		const {llm, registry, tracer} = this.opts;
		const maxSteps = this.opts.maxSteps && this.opts.maxSteps > 0 ? this.opts.maxSteps : defaultMaxSteps;

		const wireTools: Tool[] = registry.specs().map(s => ({
			name: s.name,
			description: s.description,
			parameters: s.parameters
		}));

		// Seed the message list: new conversations get system + user;
		// continuations get history + user.
		let messages: Message[] = [];
		if (input.history && input.history.length > 0) {
			messages = [...input.history];
		} else if (input.systemPrompt) {
			messages.push({role: 'system', content: input.systemPrompt});
		}
		if (input.userInput) {
			messages.push({role: 'user', content: input.userInput});
		}

		const out: RunResult = {messages, steps: 0, finished: false};

		for (let step = 0; step < maxSteps; step++) {
			out.steps = step + 1;
			messages = appendDrained(messages, this.opts.drainUserInput);
			tracer?.onTurnStart?.(step + 1);

			const req: ChatRequest = {
				messages,
				tools: wireTools,
				temperature: input.temperature,
				maxTokens: input.maxTokens,
				reasoningEffort: this.reasoningEffort
			};

			let resp;
			if (llm.streamChat) {
				resp = await llm.streamChat(req, {onText: d => tracer?.onText?.(d)}, signal);
			} else {
				resp = await llm.chat(req, signal);
				if (resp.message.content) {
					tracer?.onText?.(resp.message.content);
				}
			}

			messages = [...messages, resp.message];
			const toolCalls = resp.message.toolCalls ?? [];

			if (toolCalls.length === 0) {
				tracer?.onTurnEnd?.(step + 1, resp.finishReason, resp.usage);
				out.messages = messages;
				out.finished = resp.finishReason === 'stop' || resp.finishReason === 'other';
				return out;
			}

			let hitFinish = false;
			for (const tc of toolCalls) {
				tracer?.onToolCall?.(tc);
				let content: string;
				let dispatchErr: Error | null = null;
				let resValue: unknown = null;
				try {
					resValue = await registry.dispatch(tc.name, tc.arguments, signal);
					content = safeStringify(resValue);
					dispatchErr = toolContentError(content);
				} catch (error) {
					dispatchErr = error as Error;
					content = JSON.stringify({error: (error as Error).message});
				}
				tracer?.onToolResult?.(tc, content, dispatchErr);
				messages = [...messages, {role: 'tool', toolCallId: tc.id, content}];

				if (tc.name === 'finish' && !dispatchErr) {
					const m = resValue as {summary?: unknown; artifacts?: unknown} | null;
					if (m && typeof m === 'object') {
						if (typeof m.summary === 'string' && m.summary) {
							out.finishSummary = m.summary;
						}
						if (Array.isArray(m.artifacts)) {
							out.finishArtifacts = m.artifacts.filter((a): a is string => typeof a === 'string');
						}
					}
					hitFinish = true;
				}
			}

			tracer?.onTurnEnd?.(step + 1, resp.finishReason, resp.usage);
			if (hitFinish) {
				out.messages = messages;
				out.finished = true;
				return out;
			}
		}

		out.messages = messages;
		throw new RuntimeMaxStepsError(maxSteps, out);
	}
}

/** Thrown when the loop hits maxSteps without finishing. Carries the partial result. */
export class RuntimeMaxStepsError extends Error {
	constructor(
		readonly maxSteps: number,
		readonly partial: RunResult
	) {
		super(`runtime: hit maxSteps=${maxSteps} without finishing`);
		this.name = 'RuntimeMaxStepsError';
	}
}

function appendDrained(messages: Message[], drain: (() => string[]) | undefined): Message[] {
	if (!drain) {
		return messages;
	}
	const extra = drain()
		.map(t => t.trim())
		.filter(Boolean)
		.map((content): Message => ({role: 'user', content}));
	return extra.length > 0 ? [...messages, ...extra] : messages;
}

function safeStringify(value: unknown): string {
	try {
		const s = JSON.stringify(value ?? null);
		return s ?? 'null';
	} catch (error) {
		return JSON.stringify({error: `tool result not serializable: ${(error as Error).message}`});
	}
}

/**
 * If a tool returned a JSON object with a non-empty `error` field, surface it
 * as an Error so the tracer marks it failed — while the content is still fed
 * back to the model so it can self-correct.
 */
function toolContentError(content: string): Error | null {
	let obj: unknown;
	try {
		obj = JSON.parse(content);
	} catch {
		return null;
	}
	if (!obj || typeof obj !== 'object' || !('error' in obj)) {
		return null;
	}
	const raw = (obj as {error: unknown}).error;
	if (raw == null) {
		return null;
	}
	if (typeof raw === 'string') {
		return raw.trim() ? new Error(raw) : null;
	}
	return new Error(JSON.stringify(raw));
}
