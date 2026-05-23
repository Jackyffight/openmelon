// Provider factory, ported from internal/llm/factory.go.
//
// Anthropic is intentionally not wired yet (task #2): newLLM throws a clear
// "not yet ported" message rather than silently degrading, so the migration
// status is obvious at runtime.

import {newOpenAI, newOpenRouter} from './openai.js';
import {newAnthropic} from './anthropic.js';
import type {LLMClient} from './types.js';

/**
 * Build an LLMClient for the requested provider. `provider` is one of
 * "openai" | "openrouter" | "anthropic" | "auto" | "". Empty values for
 * apiKey/baseURL/model fall back to the provider's env vars + built-in hosts.
 */
export function newLLM(provider: string, apiKey: string, baseURL: string, model: string): LLMClient {
	const p = provider && provider !== 'auto' ? provider : autoDetectProvider();
	switch (p) {
		case 'openrouter':
			return newOpenRouter(apiKey, baseURL, model);
		case 'openai':
			return newOpenAI(apiKey, baseURL, model);
		case 'anthropic':
			return newAnthropic(apiKey, baseURL, model);
		case '':
			throw new Error(
				'llm: could not auto-detect a provider — set ANTHROPIC_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY, or pick a provider explicitly'
			);
		default:
			throw new Error(`llm: unknown provider ${JSON.stringify(p)} (supported: anthropic, openai, openrouter)`);
	}
}

/** Pick a provider from the environment. Anthropic first (Go's order), then openrouter, then openai. */
function autoDetectProvider(): string {
	if (process.env.ANTHROPIC_API_KEY) {
		return 'anthropic';
	}
	if (process.env.OPENROUTER_API_KEY) {
		return 'openrouter';
	}
	if (process.env.OPENAI_API_KEY) {
		return 'openai';
	}
	return '';
}
