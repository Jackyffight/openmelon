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

test('pending input can be recalled into the editor', () => {
	let state = initialState();
	state = reducer(state, {type: 'queue-pending', text: 'first pending'});
	state = reducer(state, {type: 'queue-pending', text: 'second pending'});
	state = reducer(state, {type: 'recall-pending'});

	assert.equal(state.input, 'first pending\n\nsecond pending');
	assert.equal(state.inputCursor, state.input.length);
	assert.deepEqual(state.pendingInputs, []);
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

test('input edits at the cursor instead of appending only', () => {
	let state = initialState();
	state = reducer(state, {type: 'insert', text: 'helo'});
	state = reducer(state, {type: 'move-input', movement: 'left'});
	state = reducer(state, {type: 'insert', text: 'l'});

	assert.equal(state.input, 'hello');
	assert.equal(state.inputCursor, 4);

	state = reducer(state, {type: 'delete-forward'});
	assert.equal(state.input, 'hell');
});

test('input supports line boundary and vertical cursor movement', () => {
	let state = initialState();
	state = reducer(state, {type: 'insert', text: 'first\nsecond'});
	state = reducer(state, {type: 'move-input', movement: 'line-start'});

	assert.equal(state.inputCursor, 'first\n'.length);

	state = reducer(state, {type: 'move-input', movement: 'line-end'});
	assert.equal(state.inputCursor, 'first\nsecond'.length);

	state = reducer(state, {type: 'move-input', movement: 'up', width: 80});
	assert.equal(state.inputCursor, 'first'.length);
});

test('history navigation restores cursor to end of selected input', () => {
	let state = initialState();
	state = reducer(state, {type: 'insert', text: 'one'});
	state = reducer(state, {type: 'commit-input', text: state.input});
	state = reducer(state, {type: 'insert', text: 'two'});
	state = reducer(state, {type: 'commit-input', text: state.input});

	state = reducer(state, {type: 'history-prev'});
	assert.equal(state.input, 'two');
	assert.equal(state.inputCursor, 3);

	state = reducer(state, {type: 'history-prev'});
	assert.equal(state.input, 'one');
	assert.equal(state.inputCursor, 3);
});
