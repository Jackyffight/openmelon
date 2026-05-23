// Cross-vendor LLM surface for the in-process TS engine.
//
// Ported from the Go internal/llm package. The runtime drives a tool-calling
// chat loop against any LLMClient; clients that can stream also implement
// streamChat so the TUI renders text as it arrives.

export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** One entry in a chat history. Mirrors the OpenAI / Anthropic conventions. */
export type Message = {
	role: Role;
	/** Text body. For tool messages, the tool's (usually JSON) response. Empty when an assistant message is purely tool calls. */
	content?: string;
	/** Set on assistant messages that ask the model to call tools. */
	toolCalls?: ToolCall[];
	/** Set on tool messages — references the assistant tool-call id this responds to. */
	toolCallId?: string;
};

/** A callable function the model may invoke. `parameters` is a JSON Schema object, sent verbatim. */
export type Tool = {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
};

/** The model's request to invoke a tool. `arguments` is the raw JSON string the vendor emitted. */
export type ToolCall = {
	id: string;
	name: string;
	arguments: string;
};

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other';

/** Per-turn token counts. Fields are 0 when the vendor didn't report a value. */
export type Usage = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
};

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** One turn of a multi-turn conversation. */
export type ChatRequest = {
	messages: Message[];
	tools?: Tool[];
	/** 0 → vendor default (~0.7). */
	temperature?: number;
	/** 0 → vendor default. */
	maxTokens?: number;
	/** empty → client default. */
	model?: string;
	/** empty → model/provider default. */
	reasoningEffort?: string;
};

/** The model's reply for one turn. */
export type ChatResponse = {
	message: Message;
	finishReason: FinishReason;
	usage: Usage;
};

/** Per-event callbacks for streaming. */
export type StreamHandlers = {
	/** Fires for each non-empty text delta (the new chunk only). */
	onText?: (delta: string) => void;
};

/**
 * Cross-vendor client. `streamChat` is optional — the runtime prefers it when
 * present (per-token output) and falls back to `chat` otherwise.
 */
export type LLMClient = {
	provider(): string;
	model(): string;
	chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
	streamChat?(req: ChatRequest, handlers: StreamHandlers, signal?: AbortSignal): Promise<ChatResponse>;
};

/** Thrown when no API key is supplied and no env fallback is set. */
export class NoApiKeyError extends Error {
	constructor() {
		super('llm: no API key supplied and no env fallback set');
		this.name = 'NoApiKeyError';
	}
}

/** Thrown when no model id is supplied and no env fallback is set. */
export class ModelRequiredError extends Error {
	constructor() {
		super('llm: no model id supplied — pass a model or set the per-provider env var');
		this.name = 'ModelRequiredError';
	}
}

/** Wraps a non-2xx vendor response with provider + status + body. */
export class LLMHttpError extends Error {
	constructor(
		readonly providerName: string,
		readonly status: number,
		readonly body: string
	) {
		super(`llm[${providerName}]: HTTP ${status}: ${body}`);
		this.name = 'LLMHttpError';
	}
}

/** Normalize a reasoning-effort hint; returns undefined for unsupported values. */
export function normalizeReasoningEffort(effort: string | undefined): ReasoningEffort | undefined {
	const v = effort?.trim().toLowerCase();
	switch (v) {
		case 'none':
		case 'minimal':
		case 'low':
		case 'medium':
		case 'high':
		case 'xhigh':
			return v;
		default:
			return undefined;
	}
}

export function mapFinishReason(s: string): FinishReason {
	switch (s) {
		case 'stop':
			return 'stop';
		case 'tool_calls':
			return 'tool_calls';
		case 'length':
			return 'length';
		default:
			return 'other';
	}
}
