import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {findProjectApproval, recordProjectApproval} from './approvals.js';

test('project approvals persist and match by tool and binary', async () => {
	const workdir = await mkdtemp(path.join(tmpdir(), 'openmelon-approvals-'));
	const request = {tool: 'bash', binary: 'python3', command: 'python3 script.py', description: 'test'};

	assert.equal(await findProjectApproval(workdir, request), null);
	await recordProjectApproval(workdir, request);

	const rule = await findProjectApproval(workdir, request);
	assert.equal(rule?.tool, 'bash');
	assert.equal(rule?.binary, 'python3');

	const store = JSON.parse(await readFile(path.join(workdir, '.openmelon', 'approvals.json'), 'utf8')) as {rules: unknown[]};
	assert.equal(store.rules.length, 1);
});

test('project approvals distinguish web search provider and fetch host', async () => {
	const workdir = await mkdtemp(path.join(tmpdir(), 'openmelon-web-approvals-'));
	await recordProjectApproval(workdir, {
		tool: 'web_search',
		binary: 'duckduckgo.com',
		command: 'openmelon',
		description: 'search'
	});
	await recordProjectApproval(workdir, {
		tool: 'web_fetch',
		binary: 'example.com',
		command: 'https://example.com/article',
		description: 'fetch'
	});

	assert.equal((await findProjectApproval(workdir, {tool: 'web_search', binary: 'duckduckgo.com', command: 'x', description: 'search'}))?.tool, 'web_search');
	assert.equal((await findProjectApproval(workdir, {tool: 'web_fetch', binary: 'example.com', command: 'https://example.com/other', description: 'fetch'}))?.tool, 'web_fetch');
	assert.equal(await findProjectApproval(workdir, {tool: 'web_fetch', binary: 'other.test', command: 'https://other.test', description: 'fetch'}), null);
});
