import assert from 'node:assert/strict';
import test from 'node:test';
import {executeWebFetch, executeWebSearch} from './webTools.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
	globalThis.fetch = originalFetch;
});

test('web_search extracts DuckDuckGo results and applies domain filters', async () => {
	globalThis.fetch = async () =>
		response(
			'https://duckduckgo.com/html/?q=openmelon',
			`<html><body>
				<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpost">Example &amp; Result</a>
				<a class="result__snippet">Useful snippet about OpenMelon.</a>
				<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fblocked.test%2Fpost">Blocked Result</a>
				<a class="result__snippet">Filtered snippet.</a>
			</body></html>`
		);

	const result = await executeWebSearch(
		{query: 'openmelon', allowedDomains: ['example.com'], blockedDomains: ['blocked.test'], maxResults: 8},
		new AbortController().signal
	);

	assert.equal(result.query, 'openmelon');
	assert.equal(result.results.length, 1);
	assert.deepEqual(result.results[0], {
		title: 'Example & Result',
		url: 'https://example.com/post',
		snippet: 'Useful snippet about OpenMelon.'
	});
});

test('web_fetch normalizes HTML into readable text', async () => {
	globalThis.fetch = async () =>
		response(
			'https://example.com/page',
			`<html>
				<head><title>Hello &amp; Source</title><script>ignored()</script></head>
				<body><h1>Title</h1><p>Body &amp; more.</p><style>.x{}</style></body>
			</html>`,
			{'content-type': 'text/html; charset=utf-8'}
		);

	const result = await executeWebFetch({url: 'https://example.com/page', prompt: 'summarize', maxChars: 500}, new AbortController().signal);

	assert.equal(result.url, 'https://example.com/page');
	assert.equal(result.status, 200);
	assert.equal(result.title, 'Hello & Source');
	assert.equal(result.prompt, 'summarize');
	assert.match(result.content, /Title\nBody & more\./);
	assert.doesNotMatch(result.content, /ignored|\.x/);
	assert.equal(result.truncated, false);
});

function response(url: string, body: string, headers: Record<string, string> = {}) {
	return {
		url,
		status: 200,
		statusText: 'OK',
		headers: {
			get(name: string) {
				return headers[name.toLowerCase()] ?? null;
			}
		},
		async text() {
			return body;
		}
	} as Response;
}
