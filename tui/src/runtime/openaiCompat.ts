import type {ChatMessage, ChatResponse, ProviderConnection, ToolCall, ToolSpec} from './nativeTypes.js';

type StreamHandler = {
	onText?(delta: string): void;
};

type WireTool = {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
};

type WireToolCall = {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
};

type WireMessage = {
	role: string;
	content?: string;
	tool_calls?: WireToolCall[];
	tool_call_id?: string;
};

export async function streamChat(
	connection: ProviderConnection,
	messages: ChatMessage[],
	tools: ToolSpec[],
	signal: AbortSignal,
	handler: StreamHandler = {}
): Promise<ChatResponse> {
	if (connection.provider === 'anthropic') {
		return streamAnthropicChat(connection, messages, tools, signal, handler);
	}
	const response = await fetch(`${connection.baseURL.replace(/\/$/, '')}/v1/chat/completions`, {
		method: 'POST',
		signal,
		headers: headersFor(connection, true),
		body: JSON.stringify({
			model: connection.model,
			messages: messages.map(toWireMessage),
			tools: tools.map(toWireTool),
			temperature: 0.7,
			stream: true,
			stream_options: {include_usage: true},
			...(connection.reasoning ? {reasoning_effort: connection.reasoning} : {})
		})
	});
	if (!response.ok) {
		throw new Error(`llm[${connection.provider}]: HTTP ${response.status}: ${await response.text()}`);
	}
	if (!response.body) {
		throw new Error(`llm[${connection.provider}]: empty stream body`);
	}

	const decoder = new TextDecoder();
	const reader = response.body.getReader();
	let buffer = '';
	let content = '';
	let finishReason: ChatResponse['finish_reason'] = 'other';
	let usage = {};
	const toolByIndex = new Map<number, {id: string; name: string; args: string}>();

	for (;;) {
		const {done, value} = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, {stream: true});
		const parts = buffer.split('\n\n');
		buffer = parts.pop() ?? '';
		for (const part of parts) {
			for (const event of parseSsePart(part)) {
				if (event === '[DONE]') {
					continue;
				}
				const parsed = safeJson(event) as OpenAIStreamChunk | null;
				if (!parsed) {
					continue;
				}
				if (parsed.usage) {
					usage = parsed.usage;
				}
				const choice = parsed.choices?.[0];
				if (!choice) {
					continue;
				}
				if (choice.delta?.content) {
					content += choice.delta.content;
					handler.onText?.(choice.delta.content);
				}
				for (const delta of choice.delta?.tool_calls ?? []) {
					const current = toolByIndex.get(delta.index) ?? {id: '', name: '', args: ''};
					if (delta.id) {
						current.id = delta.id;
					}
					if (delta.function?.name) {
						current.name = delta.function.name;
					}
					if (delta.function?.arguments) {
						current.args += delta.function.arguments;
					}
					toolByIndex.set(delta.index, current);
				}
				if (choice.finish_reason) {
					finishReason = mapFinishReason(choice.finish_reason);
				}
			}
		}
	}

	const toolCalls: ToolCall[] = [...toolByIndex.entries()]
		.sort(([a], [b]) => a - b)
		.map(([, call], index) => ({
			id: call.id || `call_${index + 1}`,
			name: call.name,
			arguments: parseToolArgs(call.args)
		}))
		.filter(call => call.name);

	return {
		message: {role: 'assistant', content, tool_calls: toolCalls.length > 0 ? toolCalls : undefined},
		finish_reason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
		usage
	};
}

async function streamAnthropicChat(connection: ProviderConnection, messages: ChatMessage[], tools: ToolSpec[], signal: AbortSignal, handler: StreamHandler = {}): Promise<ChatResponse> {
	const {system, wireMessages} = toAnthropicMessages(messages);
	const response = await fetch(`${connection.baseURL.replace(/\/$/, '')}/v1/messages`, {
		method: 'POST',
		signal,
		headers: {
			'x-api-key': connection.apiKey,
			'anthropic-version': '2023-06-01',
			'content-type': 'application/json',
			accept: 'text/event-stream',
			'user-agent': 'openmelon-tui/ts-native'
		},
		body: JSON.stringify({
			model: connection.model,
			max_tokens: 8192,
			temperature: 0.7,
			system,
			messages: wireMessages,
			tools: tools.map(tool => ({name: tool.name, description: tool.description, input_schema: tool.parameters})),
			stream: true
		})
	});
	if (!response.ok) {
		throw new Error(`llm[anthropic]: HTTP ${response.status}: ${await response.text()}`);
	}
	if (!response.body) {
		throw new Error('llm[anthropic]: empty stream body');
	}

	const decoder = new TextDecoder();
	const reader = response.body.getReader();
	let buffer = '';
	let content = '';
	let finishReason: ChatResponse['finish_reason'] = 'other';
	let usage: ChatUsageLike = {};
	const blockByIndex = new Map<number, {type: string; id?: string; name?: string; input: string}>();

	for (;;) {
		const {done, value} = await reader.read();
		if (done) {
			break;
		}
		buffer += decoder.decode(value, {stream: true});
		const parts = buffer.split('\n\n');
		buffer = parts.pop() ?? '';
		for (const part of parts) {
			const eventName = parseSseEventName(part);
			for (const data of parseSsePart(part)) {
				const parsed = safeJson(data) as AnthropicStreamEvent | null;
				if (!parsed) {
					continue;
				}
				if (eventName === 'message_start' && parsed.message?.usage) {
					usage = {...usage, prompt_tokens: parsed.message.usage.input_tokens};
				}
				if (eventName === 'content_block_start' && parsed.content_block) {
					const index = parsed.index ?? 0;
					const block = parsed.content_block;
					blockByIndex.set(index, {type: block.type, id: block.id, name: block.name, input: block.input ? JSON.stringify(block.input) : ''});
				}
				if (eventName === 'content_block_delta' && parsed.delta) {
					const index = parsed.index ?? 0;
					const current = blockByIndex.get(index);
					if (parsed.delta.type === 'text_delta' && parsed.delta.text) {
						content += parsed.delta.text;
						handler.onText?.(parsed.delta.text);
					}
					if (parsed.delta.type === 'input_json_delta' && current) {
						current.input += parsed.delta.partial_json ?? '';
						blockByIndex.set(index, current);
					}
				}
				if (eventName === 'message_delta') {
					if (parsed.delta?.stop_reason) {
						finishReason = parsed.delta.stop_reason === 'tool_use' ? 'tool_calls' : mapFinishReason(parsed.delta.stop_reason);
					}
					if (parsed.usage) {
						usage = {...usage, completion_tokens: parsed.usage.output_tokens, total_tokens: (usage.prompt_tokens ?? 0) + (parsed.usage.output_tokens ?? 0)};
					}
				}
			}
		}
	}

	const toolCalls: ToolCall[] = [...blockByIndex.entries()]
		.sort(([a], [b]) => a - b)
		.filter(([, block]) => block.type === 'tool_use' && block.name)
		.map(([, block], index) => ({
			id: block.id || `toolu_${index + 1}`,
			name: block.name!,
			arguments: parseToolArgs(block.input)
		}));

	return {
		message: {role: 'assistant', content, tool_calls: toolCalls.length > 0 ? toolCalls : undefined},
		finish_reason: toolCalls.length > 0 ? 'tool_calls' : finishReason,
		usage
	};
}

export function __testParseSseChunks(chunks: string[]) {
	let buffer = '';
	const events: string[] = [];
	for (const chunk of chunks) {
		buffer += chunk;
		const parts = buffer.split('\n\n');
		buffer = parts.pop() ?? '';
		for (const part of parts) {
			events.push(...parseSsePart(part));
		}
	}
	return {events, remainder: buffer};
}

export async function generateOpenRouterImage(
	connection: Exclude<ProviderConnection, {provider: 'openai'}>,
	prompt: string,
	references: Buffer[],
	signal: AbortSignal
): Promise<{data: Buffer; contentType: string}> {
	const message =
		references.length > 0
			? {
					role: 'user',
					content: [
						...references.map(ref => ({
							type: 'image_url',
							image_url: {url: `data:${sniffImageContentType(ref)};base64,${ref.toString('base64')}`}
						})),
						{type: 'text', text: prompt}
					]
			  }
			: {role: 'user', content: prompt};
	const response = await fetch(`${connection.baseURL.replace(/\/$/, '')}/v1/chat/completions`, {
		method: 'POST',
		signal,
		headers: headersFor(connection, false),
		body: JSON.stringify({model: connection.model, messages: [message], modalities: ['image', 'text']})
	});
	if (!response.ok) {
		throw new Error(`imagegen[openrouter]: HTTP ${response.status}: ${await response.text()}`);
	}
	const parsed = (await response.json()) as OpenRouterImageResponse;
	const url = parsed.choices?.[0]?.message?.images?.[0]?.image_url?.url;
	if (!url) {
		const text = parsed.choices?.[0]?.message?.content?.trim();
		throw new Error(text ? `imagegen[openrouter]: no image in response (${text})` : 'imagegen[openrouter]: no image in response');
	}
	return decodeDataUrl(url);
}

export async function generateOpenAIImage(
	connection: Exclude<ProviderConnection, {provider: 'openrouter'}>,
	prompt: string,
	size: string,
	signal: AbortSignal
): Promise<{data: Buffer; contentType: string}> {
	const response = await fetch(`${connection.baseURL.replace(/\/$/, '')}/v1/images/generations`, {
		method: 'POST',
		signal,
		headers: headersFor(connection, false),
		body: JSON.stringify({model: connection.model, prompt, size: size || '1024x1024', n: 1})
	});
	if (!response.ok) {
		throw new Error(`imagegen[openai]: HTTP ${response.status}: ${await response.text()}`);
	}
	const parsed = (await response.json()) as {data?: Array<{b64_json?: string}>};
	const raw = parsed.data?.[0]?.b64_json;
	if (!raw) {
		throw new Error('imagegen[openai]: empty data in response');
	}
	return {data: Buffer.from(raw, 'base64'), contentType: 'image/png'};
}

function headersFor(connection: ProviderConnection, stream: boolean) {
	const headers: Record<string, string> = {
		authorization: `Bearer ${connection.apiKey}`,
		'content-type': 'application/json',
		'user-agent': 'openmelon-tui/ts-native'
	};
	if (stream) {
		headers.accept = 'text/event-stream';
	}
	if (connection.provider === 'openrouter') {
		headers['http-referer'] = 'https://github.com/eight-acres-lab/openmelon';
		headers['x-title'] = 'openmelon';
	}
	return headers;
}

function toWireTool(tool: ToolSpec): WireTool {
	return {type: 'function', function: {name: tool.name, description: tool.description, parameters: tool.parameters}};
}

function toWireMessage(message: ChatMessage): WireMessage {
	return {
		role: message.role,
		content: message.content,
		tool_call_id: message.tool_call_id,
		tool_calls: message.tool_calls?.map(call => ({
			id: call.id,
			type: 'function',
			function: {name: call.name, arguments: JSON.stringify(call.arguments ?? {})}
		}))
	};
}

function parseSsePart(part: string) {
	const out: string[] = [];
	for (const line of part.split('\n')) {
		const trimmed = line.trimEnd();
		if (trimmed.startsWith('data:')) {
			out.push(trimmed.slice(5).trimStart());
		}
	}
	return out;
}

function parseSseEventName(part: string) {
	for (const line of part.split('\n')) {
		const trimmed = line.trimEnd();
		if (trimmed.startsWith('event:')) {
			return trimmed.slice(6).trimStart();
		}
	}
	return '';
}

function safeJson(value: string) {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

function parseToolArgs(value: string) {
	const trimmed = value.trim();
	if (!trimmed) {
		return {};
	}
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return {raw: value};
	}
}

function mapFinishReason(value: string): ChatResponse['finish_reason'] {
	switch (value) {
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

function decodeDataUrl(url: string) {
	const match = /^data:([^;,]+);base64,(.+)$/s.exec(url);
	if (!match) {
		throw new Error('invalid image data URL');
	}
	return {contentType: match[1]!, data: Buffer.from(match[2]!, 'base64')};
}

function sniffImageContentType(buffer: Buffer) {
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return 'image/png';
	}
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return 'image/jpeg';
	}
	if (buffer.length >= 12 && buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') {
		return 'image/webp';
	}
	if (buffer.length >= 6 && (buffer.subarray(0, 6).toString() === 'GIF87a' || buffer.subarray(0, 6).toString() === 'GIF89a')) {
		return 'image/gif';
	}
	return 'image/png';
}

type OpenAIStreamChunk = {
	choices?: Array<{
		delta?: {
			content?: string;
			tool_calls?: Array<{
				index: number;
				id?: string;
				function?: {name?: string; arguments?: string};
			}>;
		};
		finish_reason?: string;
	}>;
	usage?: {prompt_tokens?: number; completion_tokens?: number; total_tokens?: number};
};

type ChatUsageLike = {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
};

type AnthropicWireMessage = {
	role: 'user' | 'assistant';
	content: Array<Record<string, unknown>>;
};

function toAnthropicMessages(messages: ChatMessage[]) {
	let system = '';
	const wireMessages: AnthropicWireMessage[] = [];
	let pendingToolResults: Array<Record<string, unknown>> = [];

	const flushToolResults = () => {
		if (pendingToolResults.length > 0) {
			wireMessages.push({role: 'user', content: pendingToolResults});
			pendingToolResults = [];
		}
	};

	for (const message of messages) {
		if (message.role === 'system') {
			system = [system, message.content ?? ''].filter(Boolean).join('\n\n');
			continue;
		}
		if (message.role === 'tool') {
			pendingToolResults.push({type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content ?? ''});
			continue;
		}
		flushToolResults();
		if (message.role === 'user') {
			wireMessages.push({role: 'user', content: [{type: 'text', text: message.content ?? ''}]});
			continue;
		}
		const content: Array<Record<string, unknown>> = [];
		if (message.content) {
			content.push({type: 'text', text: message.content});
		}
		for (const call of message.tool_calls ?? []) {
			content.push({type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {}});
		}
		if (content.length > 0) {
			wireMessages.push({role: 'assistant', content});
		}
	}
	flushToolResults();
	return {system, wireMessages};
}

type AnthropicStreamEvent = {
	index?: number;
	message?: {usage?: {input_tokens?: number; output_tokens?: number}};
	content_block?: {type: string; id?: string; name?: string; input?: unknown};
	delta?: {type?: string; text?: string; partial_json?: string; stop_reason?: string};
	usage?: {input_tokens?: number; output_tokens?: number};
};

type OpenRouterImageResponse = {
	choices?: Array<{
		message?: {
			content?: string;
			images?: Array<{image_url?: {url?: string}}>;
		};
	}>;
};
