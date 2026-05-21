import test from 'node:test';
import assert from 'node:assert/strict';
import {__testParseSseChunks} from './openaiCompat.js';

test('parses split SSE chunks into data events', () => {
	const result = __testParseSseChunks([
		'event: message\ndata: {"a":',
		'1}\n\n',
		'data: [DONE]\n\n'
	]);

	assert.deepEqual(result.events, ['{"a":1}', '[DONE]']);
	assert.equal(result.remainder, '');
});
