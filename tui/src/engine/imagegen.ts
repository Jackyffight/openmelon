// Image generation, ported from internal/imagegen.
//
// Two providers behind one Generator interface:
//   - OpenRouter: chat-completions with modalities=["image","text"]; supports
//     reference images (inline data URLs) for character/scene consistency. This
//     is the agent's default image surface.
//   - OpenAI: /v1/images/generations (no reference-image support).
//
// Uses global fetch (Node ≥18) + a small transient-error retry.

import {NoApiKeyError, ModelRequiredError} from './llm/types.js';

export type GenerateOptions = {
	/** Image-generation instruction. Required. */
	prompt: string;
	/** Overrides the generator default. */
	model?: string;
	/** WxH (OpenAI only; OpenRouter ignores it — embed size in the prompt). */
	size?: string;
	/** Reference images to anchor the result (OpenRouter only). */
	referenceImages?: Uint8Array[];
};

export type ImageResult = {
	data: Uint8Array;
	contentType: string;
	provider: string;
	model: string;
	prompt: string;
	sizeBytes: number;
};

export type ImageGenerator = {
	generate(opts: GenerateOptions, signal?: AbortSignal): Promise<ImageResult>;
	provider(): string;
	model(): string;
};

const openaiDefaultBaseURL = 'https://api.openai.com';
const openrouterDefaultBaseURL = 'https://openrouter.ai/api';
const maxAttempts = 3;

/** OpenRouter chat-completions image generation (supports reference images). */
export class OpenRouterGenerator implements ImageGenerator {
	constructor(
		private readonly apiKey: string,
		private readonly baseURL: string,
		private readonly defaultModel: string
	) {
		this.baseURL = baseURL.replace(/\/+$/, '');
	}

	provider(): string {
		return 'openrouter';
	}
	model(): string {
		return this.defaultModel;
	}

	async generate(opts: GenerateOptions, signal?: AbortSignal): Promise<ImageResult> {
		if (!opts.prompt) {
			throw new Error('imagegen[openrouter]: prompt is required');
		}
		const model = opts.model || this.defaultModel;

		let message: Record<string, unknown>;
		const refs = opts.referenceImages ?? [];
		if (refs.length > 0) {
			const parts: unknown[] = refs.map(img => ({
				type: 'image_url',
				image_url: {url: `data:${sniffImageContentType(img)};base64,${Buffer.from(img).toString('base64')}`}
			}));
			parts.push({type: 'text', text: opts.prompt});
			message = {role: 'user', content: parts};
		} else {
			message = {role: 'user', content: opts.prompt};
		}

		const body = JSON.stringify({model, messages: [message], modalities: ['image', 'text']});
		const response = await transientFetch(
			`${this.baseURL}/v1/chat/completions`,
			{
				method: 'POST',
				headers: {
					authorization: `Bearer ${this.apiKey}`,
					'content-type': 'application/json',
					'HTTP-Referer': 'https://github.com/eight-acres-lab/openmelon',
					'X-Title': 'openmelon'
				},
				body,
				signal
			},
			'openrouter'
		);
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`imagegen[openrouter]: HTTP ${response.status}: ${text}`);
		}
		const parsed = JSON.parse(text) as {
			choices?: {message?: {content?: string; images?: {image_url?: {url?: string}}[]}}[];
		};
		const choice = parsed.choices?.[0];
		if (!choice) {
			throw new Error('imagegen[openrouter]: no choices in response');
		}
		const images = choice.message?.images ?? [];
		if (images.length === 0) {
			const said = choice.message?.content?.trim();
			throw new Error(
				said
					? `imagegen[openrouter]: no image in response (model said: ${said})`
					: 'imagegen[openrouter]: no image in response'
			);
		}
		const url = images[0]?.image_url?.url ?? '';
		const {data, contentType} = decodeDataURL(url);
		return {data, contentType, provider: 'openrouter', model, prompt: opts.prompt, sizeBytes: data.length};
	}
}

/** OpenAI /v1/images/generations (no reference-image support). */
export class OpenAIGenerator implements ImageGenerator {
	constructor(
		private readonly apiKey: string,
		private readonly baseURL: string,
		private readonly defaultModel: string
	) {
		this.baseURL = baseURL.replace(/\/+$/, '');
	}

	provider(): string {
		return 'openai';
	}
	model(): string {
		return this.defaultModel;
	}

	async generate(opts: GenerateOptions, signal?: AbortSignal): Promise<ImageResult> {
		if (!opts.prompt) {
			throw new Error('imagegen[openai]: prompt is required');
		}
		const model = opts.model || this.defaultModel;
		const body = JSON.stringify({model, prompt: opts.prompt, size: opts.size || '1024x1024', n: 1});
		const response = await transientFetch(
			`${this.baseURL}/v1/images/generations`,
			{
				method: 'POST',
				headers: {authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json'},
				body,
				signal
			},
			'openai'
		);
		const text = await response.text();
		if (!response.ok) {
			throw new Error(`imagegen[openai]: HTTP ${response.status}: ${text}`);
		}
		const parsed = JSON.parse(text) as {data?: {b64_json?: string}[]};
		const b64 = parsed.data?.[0]?.b64_json;
		if (!b64) {
			throw new Error('imagegen[openai]: empty data in response');
		}
		const data = new Uint8Array(Buffer.from(b64, 'base64'));
		return {data, contentType: 'image/png', provider: 'openai', model, prompt: opts.prompt, sizeBytes: data.length};
	}
}

/** Build an image generator for the requested provider. */
export function newImageGenerator(provider: string, apiKey: string, baseURL: string, defaultModel: string): ImageGenerator {
	const p = provider || 'openrouter';
	if (!defaultModel) {
		throw new ModelRequiredError();
	}
	if (p === 'openrouter') {
		const key = apiKey || process.env.OPENROUTER_API_KEY || '';
		if (!key) {
			throw new NoApiKeyError();
		}
		return new OpenRouterGenerator(key, baseURL || process.env.OPENROUTER_BASE_URL || openrouterDefaultBaseURL, defaultModel);
	}
	if (p === 'openai') {
		const key = apiKey || process.env.OPENAI_API_KEY || '';
		if (!key) {
			throw new NoApiKeyError();
		}
		return new OpenAIGenerator(key, baseURL || process.env.OPENAI_BASE_URL || openaiDefaultBaseURL, defaultModel);
	}
	throw new Error(`imagegen: unknown provider ${JSON.stringify(provider)} (supported: openrouter, openai)`);
}

/** fetch with up to 3 attempts, retrying transient network errors + 5xx. */
async function transientFetch(url: string, init: RequestInit, provider: string): Promise<Response> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const response = await fetch(url, init);
			if (response.status >= 500 && attempt < maxAttempts) {
				lastErr = new Error(`imagegen[${provider}]: HTTP ${response.status}`);
				await delay(attempt);
				continue;
			}
			return response;
		} catch (error) {
			// AbortError must propagate immediately — the user cancelled.
			if ((error as Error).name === 'AbortError') {
				throw error;
			}
			lastErr = error;
			if (attempt < maxAttempts) {
				await delay(attempt);
				continue;
			}
		}
	}
	throw lastErr instanceof Error ? lastErr : new Error(`imagegen[${provider}]: request failed`);
}

function delay(attempt: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, attempt * 400));
}

/** MIME sniff for the common image headers; falls back to image/png. */
export function sniffImageContentType(b: Uint8Array): string {
	if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
		return 'image/png';
	}
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
		return 'image/jpeg';
	}
	if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
		return 'image/webp';
	}
	if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
		return 'image/gif';
	}
	return 'image/png';
}

/** Parse a `data:<mime>;base64,<payload>` URL into raw bytes + MIME type. */
export function decodeDataURL(dataURL: string): {data: Uint8Array; contentType: string} {
	if (!dataURL.startsWith('data:')) {
		throw new Error('not a data URL');
	}
	const rest = dataURL.slice('data:'.length);
	const commaIdx = rest.indexOf(',');
	if (commaIdx < 0) {
		throw new Error('data URL missing comma separator');
	}
	const header = rest.slice(0, commaIdx);
	const payload = rest.slice(commaIdx + 1);
	let contentType = 'application/octet-stream';
	let isBase64 = false;
	for (const raw of header.split(';')) {
		const part = raw.trim();
		if (part === 'base64') {
			isBase64 = true;
		} else if (part.includes('/')) {
			contentType = part;
		}
	}
	if (!isBase64) {
		throw new Error(`data URL is not base64-encoded (got header: ${JSON.stringify(header)})`);
	}
	return {data: new Uint8Array(Buffer.from(payload, 'base64')), contentType};
}
