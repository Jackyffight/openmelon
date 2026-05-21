import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState, reducer} from './reducer.js';

test('assistant deltas merge into one markdown transcript block', () => {
	let state = initialState();
	state = reducer(state, {type: 'append-delta', kind: 'assistant', text: '# Title', markdown: true});
	state = reducer(state, {type: 'append-delta', kind: 'assistant', text: '\nBody', markdown: true});

	assert.equal(state.items.length, 1);
	assert.equal(state.items[0]?.text, '# Title\nBody');
	assert.equal(state.items[0]?.markdown, true);
});

test('different transcript kinds do not merge', () => {
	let state = initialState();
	state = reducer(state, {type: 'append-delta', kind: 'assistant', text: 'hello', markdown: true});
	state = reducer(state, {type: 'append', kind: 'tool', text: '● bash'});
	state = reducer(state, {type: 'append-delta', kind: 'assistant', text: 'world', markdown: true});

	assert.equal(state.items.length, 3);
	assert.equal(state.items[2]?.text, 'world');
});

test('pending-applied removes only consumed pending inputs', () => {
	let state = initialState();
	state = reducer(state, {type: 'queue-pending', text: 'one'});
	state = reducer(state, {type: 'queue-pending', text: 'two'});
	state = reducer(state, {type: 'pending-applied', count: 1});

	assert.deepEqual(state.pendingInputs, ['two']);
});

test('ready status clears the running timer', () => {
	let state = initialState();
	state = reducer(state, {type: 'turn-started', at: 123});
	state = reducer(state, {type: 'status', status: 'ready', activity: 'Ready'});

	assert.equal(state.runStartedAt, null);
});

test('usage tracks last turn and accumulated totals', () => {
	let state = initialState();
	state = reducer(state, {type: 'set-usage', promptTokens: 10, completionTokens: 2});
	state = reducer(state, {type: 'set-usage', promptTokens: 3, completionTokens: 4});

	assert.equal(state.promptTokens, 3);
	assert.equal(state.completionTokens, 4);
	assert.equal(state.totalPromptTokens, 13);
	assert.equal(state.totalCompletionTokens, 6);
});
