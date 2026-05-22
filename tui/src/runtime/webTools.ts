import type {NativeTool} from './nativeTypes.js';
import type {NativeRuntimeContext} from './nativeTypes.js';

export function webSearchTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'web_search',
			description:
				'Search the public web for current information. Returns cited results. Use when facts may be recent, external, or require source attribution.',
			parameters: {
				type: 'object',
				properties: {
					query: {type: 'string', minLength: 2},
					allowed_domains: {type: 'array', items: {type: 'string'}},
					blocked_domains: {type: 'array', items: {type: 'string'}},
					max_results: {type: 'number'}
				},
				required: ['query']
			}
		},
		async dispatch(raw, signal) {
			const args = objectArg<{
				query?: string;
				allowed_domains?: unknown;
				blocked_domains?: unknown;
				max_results?: unknown;
			}>(raw);
			const query = String(args.query ?? '').trim();
			const decision = await ctx.approve({
				id: '',
				tool: 'web_search',
				command: query,
				description: 'Search the public web through DuckDuckGo HTML fallback.',
				binary: 'duckduckgo.com'
			});
			if (!decision.approved) {
				return {error: 'user denied web search'};
			}
			return executeWebSearch(
				{
					query,
					allowedDomains: stringList(args.allowed_domains),
					blockedDomains: stringList(args.blocked_domains),
					maxResults: clampNumber(args.max_results, 8, 1, 12)
				},
				signal
			);
		}
	};
}

export function webFetchTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'web_fetch',
			description: 'Fetch a public URL and return readable text with metadata. Use after web_search when a source needs closer inspection.',
			parameters: {
				type: 'object',
				properties: {
					url: {type: 'string', format: 'uri'},
					prompt: {type: 'string'},
					max_chars: {type: 'number'}
				},
				required: ['url']
			}
		},
		async dispatch(raw, signal) {
			const args = objectArg<{url?: string; prompt?: string; max_chars?: unknown}>(raw);
			const url = String(args.url ?? '');
			const host = safeHost(url) || 'web';
			const decision = await ctx.approve({
				id: '',
				tool: 'web_fetch',
				command: url,
				description: `Fetch and read text content from ${host}.`,
				binary: host
			});
			if (!decision.approved) {
				return {error: 'user denied web fetch'};
			}
			return executeWebFetch({url, prompt: String(args.prompt ?? ''), maxChars: clampNumber(args.max_chars, 6000, 500, 20_000)}, signal);
		}
	};
}

type SearchInput = {
	query: string;
	allowedDomains: string[];
	blockedDomains: string[];
	maxResults: number;
};

type FetchInput = {
	url: string;
	prompt: string;
	maxChars: number;
};

export async function executeWebSearch(input: SearchInput, signal: AbortSignal) {
	if (input.query.length < 2) {
		return {error: 'query must be at least 2 characters'};
	}
	const started = Date.now();
	const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(input.query)}`;
	const response = await fetchWithTimeout(url, signal);
	const html = await response.text();
	let results = extractDuckDuckGoResults(html);
	if (results.length === 0) {
		results = extractGenericLinks(html, response.url);
	}
	results = results
		.filter(result => domainAllowed(result.url, input.allowedDomains, input.blockedDomains))
		.filter((result, index, all) => all.findIndex(item => item.url === result.url) === index)
		.slice(0, input.maxResults);

	return {
		query: input.query,
		source: 'duckduckgo_html',
		results,
		duration_ms: Date.now() - started,
		instructions: results.length > 0 ? 'Use these URLs as sources. Include source links when answering.' : 'No matching web results were found.'
	};
}

export async function executeWebFetch(input: FetchInput, signal: AbortSignal) {
	const requestUrl = normalizeHttpUrl(input.url);
	if (!requestUrl) {
		return {error: 'url must be an http(s) URL'};
	}
	const started = Date.now();
	const response = await fetchWithTimeout(requestUrl, signal);
	const contentType = response.headers.get('content-type') ?? '';
	const raw = await response.text();
	const text = normalizeFetchedText(raw, contentType);
	const title = extractTitle(raw) || new URL(response.url).hostname;
	const content = truncate(text, input.maxChars);
	return {
		url: response.url,
		status: response.status,
		status_text: response.statusText,
		content_type: contentType,
		title,
		prompt: input.prompt,
		content,
		truncated: text.length > content.length,
		duration_ms: Date.now() - started
	};
}

function extractDuckDuckGoResults(html: string) {
	const results: Array<{title: string; url: string; snippet: string}> = [];
	const blocks = html.match(/<a\b[^>]*class="[^"]*result__a[^"]*"[\s\S]*?(?=<a\b[^>]*class="[^"]*result__a|<\/body>|$)/gi) ?? [];
	for (const block of blocks) {
		const anchor = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
		if (!anchor) {
			continue;
		}
		const url = decodeDuckDuckGoUrl(decodeHtml(anchor[1] ?? ''));
		const title = cleanHtml(anchor[2] ?? '');
		const snippet = cleanHtml(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ?? '');
		if (url && title) {
			results.push({title, url, snippet});
		}
	}
	return results;
}

function extractGenericLinks(html: string, baseUrl: string) {
	const out: Array<{title: string; url: string; snippet: string}> = [];
	for (const match of html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
		const title = cleanHtml(match[2] ?? '');
		const url = absolutizeUrl(decodeHtml(match[1] ?? ''), baseUrl);
		if (title && url && /^https?:\/\//.test(url)) {
			out.push({title, url, snippet: ''});
		}
	}
	return out;
}

function decodeDuckDuckGoUrl(value: string) {
	const absolute = absolutizeUrl(value, 'https://duckduckgo.com/');
	if (!absolute) {
		return '';
	}
	const url = new URL(absolute);
	const redirected = url.searchParams.get('uddg');
	return redirected ? decodeURIComponent(redirected) : absolute;
}

function normalizeFetchedText(raw: string, contentType: string) {
	if (!contentType.includes('html')) {
		return normalizeText(raw);
	}
	const text = raw
		.replace(/<script[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style[\s\S]*?<\/style>/gi, ' ')
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
		.replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
		.replace(/<\/(?:p|div|section|article|header|footer|main|li|h[1-6]|tr|table|ul|ol)\s*>/gi, '\n')
		.replace(/<[^>]+>/g, ' ');
	return normalizeText(decodeHtml(text));
}

function extractTitle(raw: string) {
	return cleanHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] ?? '');
}

async function fetchWithTimeout(url: string, signal: AbortSignal) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 20_000);
	signal.addEventListener('abort', () => controller.abort(), {once: true});
	try {
		return await fetch(url, {
			signal: controller.signal,
			headers: {
				'user-agent': 'OpenMelon/0.1 (+https://github.com/eight-acres-lab/openmelon)',
				accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.7'
			}
		});
	} finally {
		clearTimeout(timer);
	}
}

function domainAllowed(url: string, allowed: string[], blocked: string[]) {
	const host = safeHost(url);
	if (!host) {
		return false;
	}
	if (allowed.length > 0 && !allowed.some(domain => hostMatches(host, domain))) {
		return false;
	}
	return !blocked.some(domain => hostMatches(host, domain));
}

function hostMatches(host: string, domain: string) {
	const normalized = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
	return host === normalized || host.endsWith(`.${normalized}`);
}

function safeHost(url: string) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return '';
	}
}

function normalizeHttpUrl(value: string) {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
	} catch {
		return '';
	}
}

function absolutizeUrl(value: string, baseUrl: string) {
	try {
		return new URL(value, baseUrl).toString();
	} catch {
		return '';
	}
}

function cleanHtml(value: string) {
	return decodeHtml(value)
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeText(value: string) {
	return value
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.split('\n')
		.map(line => line.replace(/[ \t\f\v]+/g, ' ').trim())
		.filter(Boolean)
		.join('\n');
}

function decodeHtml(value: string) {
	return value
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

function truncate(value: string, max: number) {
	return value.length > max ? `${value.slice(0, max)}…` : value;
}

function objectArg<T extends Record<string, unknown>>(raw: unknown): T {
	return raw && typeof raw === 'object' ? (raw as T) : ({} as T);
}

function stringList(value: unknown) {
	return Array.isArray(value) ? value.map(String).map(item => item.trim()).filter(Boolean) : [];
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
	const num = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(num) ? Math.max(min, Math.min(max, num)) : fallback;
}
