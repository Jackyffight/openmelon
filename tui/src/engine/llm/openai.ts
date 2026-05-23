// OpenAI Chat Completions client — also serves OpenRouter and any other
// OpenAI-compatible endpoint (same wire shape, different host + headers).
//
// Ported from internal/llm/openai*.go. Uses global fetch (Node ≥18).

import {sseData} from './sse.js';
import {
	LLMHttpError,
	ModelRequiredError,
	NoApiKeyError,
	mapFinishReason,
	normalizeReasoningEffort,
	type ChatRequest,
	type ChatResponse,
	type LLMClient,
	type Message,
	type StreamHandlers,
	type ToolCall,
	type Usage
} from './types.js';

const openaiDefaultBaseURL = 'https://api.openai.com';
const openrouterDefaultBaseURL = 'https://openrouter.ai/api';

type OpenAIVendor = 'openai' | 'openrouter';

type WireToolCall = {
	id?: string;
	type?: string;
	function?: {name?: string; arguments?: string};
};

type WireMessage = {
	role: string;
	content?: string | null;
	tool_calls?: WireToolCall[];
	tool_call_id?: string;
};

type WireUsage = {prompt_tokens?: number; completion_tokens?: number; total_tokens?: number};

export class OpenAIClient implements LLMClient {
	private readonly apiKey: string;
	private readonly baseURL: string;
	private readonly defaultModel: string;
	private readonly vendor: OpenAIVendor;

	constructor(vendor: OpenAIVendor, apiKey: string, baseURL: string, defaultModel: string) {
		this.vendor = vendor;
		this.apiKey = apiKey;
		this.baseURL = baseURL.replace(/\/+$/, '');
		this.defaultModel = defaultModel;
	}

	provider(): string {
		return this.vendor;
	}

	model(): string {
		return this.defaultModel;
	}

	private headers(stream: boolean): Record<string, string> {
		const h: Record<string, string> = {
			authorization: `Bearer ${this.apiKey}`,
			'content-type': 'application/json',
			'user-agent': 'openmelon-tui (ts)'
		};
		if (stream) {
			h['accept'] = 'text/event-stream';
		}
		if (this.vendor === 'openrouter') {
			h['HTTP-Referer'] = 'https://github.com/eight-acres-lab/openmelon';
			h['X-Title'] = 'openmelon';
		}
		return h;
	}

	private buildBody(req: ChatRequest, stream: boolean): string {
		const body: Record<string, unknown> = {
			model: req.model || this.defaultModel,
			messages: req.messages.map(toWireMessage),
			temperature: req.temperature && req.temperature !== 0 ? req.temperature : 0.7
		};
		if (req.tools && req.tools.length > 0) {
			body['tools'] = req.tools.map(t => ({
				type: 'function',
				function: {name: t.name, description: t.description, parameters: t.parameters}
			}));
		}
		if (req.maxTokens && req.maxTokens > 0) {
			body['max_tokens'] = req.maxTokens;
		}
		const effort = normalizeReasoningEffort(req.reasoningEffort);
		if (effort) {
			body['reasoning_effort'] = effort;
		}
		if (stream) {
			body['stream'] = true;
			body['stream_options'] = {include_usage: true};
		}
		return JSON.stringify(body);
	}

	async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
		if (req.messages.length === 0) {
			throw new Error(`llm[${this.vendor}]: chat requires at least one message`);
		}
		const response = await fetch(`${this.baseURL}/v1/chat/completions`, {
			method: 'POST',
			headers: this.headers(false),
			body: this.buildBody(req, false),
			signal
		});
		if (!response.ok) {
			throw new LLMHttpError(this.vendor, response.status, await safeText(response));
		}
		const parsed = (await response.json()) as {
			choices?: {message: WireMessage; finish_reason?: string}[];
			usage?: WireUsage;
		};
		const choice = parsed.choices?.[0];
		if (!choice) {
			throw new Error(`llm[${this.vendor}]: no choices in response`);
		}
		return {
			message: fromWireMessage(choice.message),
			finishReason: mapFinishReason(choice.finish_reason ?? ''),
			usage: toUsage(parsed.usage)
		};
	}

	async streamChat(req: ChatRequest, handlers: StreamHandlers, signal?: AbortSignal): Promise<ChatResponse> {
		if (req.messages.length === 0) {
			throw new Error(`llm[${this.vendor}]: streamChat requires at least one message`);
		}
		const response = await fetch(`${this.baseURL}/v1/chat/completions`, {
			method: 'POST',
			headers: this.headers(true),
			body: this.buildBody(req, true),
			signal
		});
		if (!response.ok) {
			throw new LLMHttpError(this.vendor, response.status, await safeText(response));
		}
		if (!response.body) {
			throw new Error(`llm[${this.vendor}]: stream response has no body`);
		}

		let text = '';
		// Tool-call args arrive split across chunks, keyed by index (id only
		// appears on the first delta). Reassemble by index.
		const toolByIdx = new Map<number, {id: string; name: string; args: string}>();
		let finishReason = '';
		let usage: Usage = {promptTokens: 0, completionTokens: 0, totalTokens: 0};

		for await (const data of sseData(response.body)) {
			if (data === '[DONE]') {
				break;
			}
			let chunk: {
				choices?: {
					delta?: {content?: string; tool_calls?: (WireToolCall & {index?: number})[]};
					finish_reason?: string;
				}[];
				usage?: WireUsage;
			};
			try {
				chunk = JSON.parse(data);
			} catch {
				continue; // skip malformed; let the stream finish
			}
			if (chunk.usage) {
				usage = toUsage(chunk.usage);
			}
			const choice = chunk.choices?.[0];
			if (!choice) {
				continue;
			}
			const delta = choice.delta;
			if (delta?.content) {
				text += delta.content;
				handlers.onText?.(delta.content);
			}
			for (const tcd of delta?.tool_calls ?? []) {
				const idx = tcd.index ?? 0;
				let entry = toolByIdx.get(idx);
				if (!entry) {
					entry = {id: '', name: '', args: ''};
					toolByIdx.set(idx, entry);
				}
				if (tcd.id) {
					entry.id = tcd.id;
				}
				if (tcd.function?.name) {
					entry.name = tcd.function.name;
				}
				if (tcd.function?.arguments) {
					entry.args += tcd.function.arguments;
				}
			}
			if (choice.finish_reason) {
				finishReason = choice.finish_reason;
			}
		}

		const calls: ToolCall[] = [];
		const maxIdx = toolByIdx.size === 0 ? -1 : Math.max(...toolByIdx.keys());
		for (let i = 0; i <= maxIdx; i++) {
			const entry = toolByIdx.get(i);
			if (!entry) {
				continue;
			}
			calls.push({id: entry.id, name: entry.name, arguments: entry.args.length > 0 ? entry.args : '{}'});
		}

		return {
			message: {role: 'assistant', content: text, toolCalls: calls.length > 0 ? calls : undefined},
			finishReason: mapFinishReason(finishReason),
			usage
		};
	}
}

function toWireMessage(m: Message): WireMessage {
	const out: WireMessage = {role: m.role};
	if (m.content !== undefined) {
		out.content = m.content;
	}
	if (m.toolCallId) {
		out.tool_call_id = m.toolCallId;
	}
	if (m.toolCalls && m.toolCalls.length > 0) {
		out.tool_calls = m.toolCalls.map(tc => ({
			id: tc.id,
			type: 'function',
			function: {name: tc.name, arguments: tc.arguments}
		}));
	}
	return out;
}

function fromWireMessage(w: WireMessage): Message {
	const out: Message = {role: (w.role as Message['role']) || 'assistant', content: w.content ?? ''};
	if (w.tool_call_id) {
		out.toolCallId = w.tool_call_id;
	}
	if (w.tool_calls && w.tool_calls.length > 0) {
		out.toolCalls = w.tool_calls.map(tc => ({
			id: tc.id ?? '',
			name: tc.function?.name ?? '',
			arguments: tc.function?.arguments ?? '{}'
		}));
	}
	return out;
}

function toUsage(u: WireUsage | undefined): Usage {
	return {
		promptTokens: u?.prompt_tokens ?? 0,
		completionTokens: u?.completion_tokens ?? 0,
		totalTokens: u?.total_tokens ?? 0
	};
}

async function safeText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return '';
	}
}

/** Build an OpenAI client. Falls back to OPENAI_API_KEY / OPENAI_BASE_URL. */
export function newOpenAI(apiKey: string, baseURL: string, defaultModel: string): OpenAIClient {
	const key = apiKey || process.env.OPENAI_API_KEY || '';
	if (!key) {
		throw new NoApiKeyError();
	}
	if (!defaultModel) {
		throw new ModelRequiredError();
	}
	const base = baseURL || process.env.OPENAI_BASE_URL || openaiDefaultBaseURL;
	return new OpenAIClient('openai', key, base, defaultModel);
}

/** Build an OpenRouter client. Falls back to OPENROUTER_API_KEY / OPENROUTER_BASE_URL. */
export function newOpenRouter(apiKey: string, baseURL: string, defaultModel: string): OpenAIClient {
	const key = apiKey || process.env.OPENROUTER_API_KEY || '';
	if (!key) {
		throw new NoApiKeyError();
	}
	if (!defaultModel) {
		throw new ModelRequiredError();
	}
	const base = baseURL || process.env.OPENROUTER_BASE_URL || openrouterDefaultBaseURL;
	return new OpenAIClient('openrouter', key, base, defaultModel);
}
