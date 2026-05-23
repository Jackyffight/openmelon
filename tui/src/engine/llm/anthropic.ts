// Anthropic Messages API client WITH tool use.
//
// Note: the Go internal/llm Anthropic client only implements the legacy
// single-turn Complete/Stream and has NO tool support, so it can't drive the
// agent loop. This TS port adds tool use (tool_use / tool_result content
// blocks), so Anthropic is a first-class agent provider here — stronger than
// the Go original. Non-streaming for now (the runtime fires onText once with
// the full reply when streamChat is absent).

import {
	LLMHttpError,
	ModelRequiredError,
	NoApiKeyError,
	type ChatRequest,
	type ChatResponse,
	type FinishReason,
	type LLMClient,
	type Message,
	type ToolCall,
	type Usage
} from './types.js';

const anthropicDefaultBaseURL = 'https://api.anthropic.com';
const anthropicAPIVersion = '2023-06-01';

type AnthropicBlock =
	| {type: 'text'; text: string}
	| {type: 'tool_use'; id: string; name: string; input: unknown}
	| {type: 'tool_result'; tool_use_id: string; content: string};

type AnthropicMessage = {role: 'user' | 'assistant'; content: AnthropicBlock[]};

export class AnthropicClient implements LLMClient {
	constructor(
		private readonly apiKey: string,
		private readonly baseURL: string,
		private readonly defaultModel: string
	) {
		this.baseURL = baseURL.replace(/\/+$/, '');
	}

	provider(): string {
		return 'anthropic';
	}
	model(): string {
		return this.defaultModel;
	}

	async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
		if (req.messages.length === 0) {
			throw new Error('llm[anthropic]: chat requires at least one message');
		}
		const {system, messages} = toAnthropicMessages(req.messages);
		const body: Record<string, unknown> = {
			model: req.model || this.defaultModel,
			max_tokens: req.maxTokens && req.maxTokens > 0 ? req.maxTokens : 4096,
			temperature: req.temperature && req.temperature !== 0 ? req.temperature : 0.7,
			messages
		};
		if (system) {
			body['system'] = system;
		}
		if (req.tools && req.tools.length > 0) {
			body['tools'] = req.tools.map(t => ({name: t.name, description: t.description, input_schema: t.parameters}));
		}

		const response = await fetch(`${this.baseURL}/v1/messages`, {
			method: 'POST',
			headers: {
				'x-api-key': this.apiKey,
				'anthropic-version': anthropicAPIVersion,
				'content-type': 'application/json'
			},
			body: JSON.stringify(body),
			signal
		});
		const text = await response.text();
		if (!response.ok) {
			throw new LLMHttpError('anthropic', response.status, text);
		}
		const parsed = JSON.parse(text) as {
			content?: ({type: string; text?: string; id?: string; name?: string; input?: unknown})[];
			stop_reason?: string;
			usage?: {input_tokens?: number; output_tokens?: number};
		};

		let content = '';
		const toolCalls: ToolCall[] = [];
		for (const block of parsed.content ?? []) {
			if (block.type === 'text' && block.text) {
				content += block.text;
			} else if (block.type === 'tool_use') {
				toolCalls.push({id: block.id ?? '', name: block.name ?? '', arguments: JSON.stringify(block.input ?? {})});
			}
		}

		return {
			message: {role: 'assistant', content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined},
			finishReason: mapStopReason(parsed.stop_reason),
			usage: toUsage(parsed.usage)
		};
	}
}

/**
 * Convert the OpenAI-style message list into Anthropic's shape:
 *  - system messages → a single top-level `system` string.
 *  - assistant tool_calls → an assistant turn with tool_use blocks.
 *  - tool messages → tool_result blocks folded into a user turn (consecutive
 *    tool results merge into one user turn, as Anthropic requires).
 */
function toAnthropicMessages(messages: Message[]): {system: string; messages: AnthropicMessage[]} {
	const systemParts: string[] = [];
	const out: AnthropicMessage[] = [];
	let pendingToolResults: AnthropicBlock[] = [];

	const flushToolResults = () => {
		if (pendingToolResults.length > 0) {
			out.push({role: 'user', content: pendingToolResults});
			pendingToolResults = [];
		}
	};

	for (const m of messages) {
		if (m.role === 'system') {
			if (m.content) {
				systemParts.push(m.content);
			}
			continue;
		}
		if (m.role === 'tool') {
			pendingToolResults.push({type: 'tool_result', tool_use_id: m.toolCallId ?? '', content: m.content ?? ''});
			continue;
		}
		flushToolResults();
		if (m.role === 'user') {
			out.push({role: 'user', content: [{type: 'text', text: m.content ?? ''}]});
			continue;
		}
		// assistant
		const blocks: AnthropicBlock[] = [];
		if (m.content) {
			blocks.push({type: 'text', text: m.content});
		}
		for (const tc of m.toolCalls ?? []) {
			blocks.push({type: 'tool_use', id: tc.id, name: tc.name, input: parseInput(tc.arguments)});
		}
		out.push({role: 'assistant', content: blocks.length > 0 ? blocks : [{type: 'text', text: ''}]});
	}
	flushToolResults();
	return {system: systemParts.join('\n\n'), messages: out};
}

function parseInput(raw: string): unknown {
	try {
		return JSON.parse(raw || '{}');
	} catch {
		return {};
	}
}

function mapStopReason(s: string | undefined): FinishReason {
	switch (s) {
		case 'end_turn':
		case 'stop_sequence':
			return 'stop';
		case 'tool_use':
			return 'tool_calls';
		case 'max_tokens':
			return 'length';
		default:
			return 'other';
	}
}

function toUsage(u: {input_tokens?: number; output_tokens?: number} | undefined): Usage {
	const promptTokens = u?.input_tokens ?? 0;
	const completionTokens = u?.output_tokens ?? 0;
	return {promptTokens, completionTokens, totalTokens: promptTokens + completionTokens};
}

/** Build an Anthropic client. Falls back to ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL. */
export function newAnthropic(apiKey: string, baseURL: string, defaultModel: string): AnthropicClient {
	const key = apiKey || process.env.ANTHROPIC_API_KEY || '';
	if (!key) {
		throw new NoApiKeyError();
	}
	if (!defaultModel) {
		throw new ModelRequiredError();
	}
	return new AnthropicClient(key, baseURL || process.env.ANTHROPIC_BASE_URL || anthropicDefaultBaseURL, defaultModel);
}
