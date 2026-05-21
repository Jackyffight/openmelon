import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {appendMessages, appendPrompt, createNativeSession, setRuntimeInfo, writeSummary} from './sessionStore.js';

test('native session store writes Go-compatible session files', async () => {
	const workdir = await mkdtemp(path.join(tmpdir(), 'openmelon-session-'));
	const session = await createNativeSession(workdir, 'proj', 'test intent', 'old-session');
	await setRuntimeInfo(session, 'openai', 'gpt-5.5');
	await appendPrompt(session, 'user', 'hello');
	await appendMessages(session, [{role: 'user', content: 'hello'}]);
	await writeSummary(session, 'done', ['/tmp/a.png'], true);

	const meta = JSON.parse(await readFile(path.join(session.dir, 'meta.json'), 'utf8')) as Record<string, unknown>;
	assert.equal(meta.project_id, 'proj');
	assert.equal(meta.provider, 'openai');
	assert.equal(meta.model, 'gpt-5.5');
	assert.equal(meta.resumed_from, 'old-session');

	const messages = await readFile(path.join(session.dir, 'messages.jsonl'), 'utf8');
	assert.equal(JSON.parse(messages.trim()).role, 'user');

	const summary = JSON.parse(await readFile(path.join(session.dir, 'summary.json'), 'utf8')) as Record<string, unknown>;
	assert.equal(summary.finished, true);
});
