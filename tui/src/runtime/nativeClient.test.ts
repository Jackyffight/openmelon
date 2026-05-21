import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createNativeRuntimeClient} from './nativeClient.js';
import type {RuntimeEvent} from './protocol.js';

test('native runtime creates a session lazily on first run', async () => {
	const workdir = await mkdtemp(path.join(tmpdir(), 'openmelon-native-client-'));
	await writeProject(workdir);

	const previousCwd = process.cwd();
	process.chdir(workdir);
	try {
		const events: RuntimeEvent[] = [];
		const client = createNativeRuntimeClient(event => events.push(event));
		await waitFor(() => events.some(event => event.type === 'ready'));

		assert.equal(events.find(event => event.type === 'ready' && event.sessionId)?.type, undefined);
		assert.deepEqual(await listSessions(workdir), []);

		client.run('hello');
		await waitFor(() => events.some(event => event.type === 'ready' && Boolean(event.sessionId)));

		assert.equal((await listSessions(workdir)).length, 1);
		client.shutdown();
	} finally {
		process.chdir(previousCwd);
	}
});

test('native runtime resumes the same session instead of creating a child session', async () => {
	const workdir = await mkdtemp(path.join(tmpdir(), 'openmelon-native-client-resume-'));
	await writeProject(workdir);
	const parent = 'parent-session';
	await mkdir(path.join(workdir, '.openmelon', 'sessions', parent), {recursive: true});
	await writeFile(
		path.join(workdir, '.openmelon', 'sessions', parent, 'meta.json'),
		JSON.stringify({id: parent, project_id: 'proj', started_at: new Date().toISOString(), workspace_root: workdir})
	);
	await writeFile(
		path.join(workdir, '.openmelon', 'sessions', parent, 'messages.jsonl'),
		`${JSON.stringify({role: 'user', content: 'old turn'})}\n`
	);

	const previousCwd = process.cwd();
	process.chdir(workdir);
	try {
		const events: RuntimeEvent[] = [];
		const client = createNativeRuntimeClient(event => events.push(event), {resumeId: parent});
		await waitFor(() => events.some(event => event.type === 'ready' && Boolean(event.sessionId)));

		assert.equal((events.find(event => event.type === 'ready' && Boolean(event.sessionId)) as {sessionId?: string}).sessionId, parent);
		assert.deepEqual(await listSessions(workdir), [parent]);
		client.shutdown();
	} finally {
		process.chdir(previousCwd);
	}
});

test('native runtime downgrades missing resume history to a fresh lazy session', async () => {
	const workdir = await mkdtemp(path.join(tmpdir(), 'openmelon-native-client-bad-resume-'));
	await writeProject(workdir);
	const missingHistory = 'missing-history';
	await mkdir(path.join(workdir, '.openmelon', 'sessions', missingHistory), {recursive: true});
	await writeFile(
		path.join(workdir, '.openmelon', 'sessions', missingHistory, 'meta.json'),
		JSON.stringify({id: missingHistory, project_id: 'proj', started_at: new Date().toISOString(), workspace_root: workdir})
	);

	const previousCwd = process.cwd();
	process.chdir(workdir);
	try {
		const events: RuntimeEvent[] = [];
		const client = createNativeRuntimeClient(event => events.push(event), {resumeId: missingHistory});
		await waitFor(() => events.some(event => event.type === 'ready' && Boolean(event.sessionId)));

		assert.equal((events.find(event => event.type === 'ready' && Boolean(event.sessionId)) as {sessionId?: string}).sessionId, missingHistory);
		assert.deepEqual(await listSessions(workdir), [missingHistory]);
		assert.equal(await readFile(path.join(workdir, '.openmelon', 'sessions', missingHistory, 'messages.jsonl'), 'utf8'), '');
		client.shutdown();
	} finally {
		process.chdir(previousCwd);
	}
});

async function writeProject(workdir: string) {
	await mkdir(path.join(workdir, '.openmelon'), {recursive: true});
	await writeFile(
		path.join(workdir, '.openmelon', 'project.json'),
		JSON.stringify({
			id: 'proj',
			name: 'Project',
			defaults: {llm_provider: 'openai', llm_model: 'gpt-test'},
			providers: {openai: {api_key: 'test-key', base_url: 'http://127.0.0.1:9'}}
		})
	);
}

async function listSessions(workdir: string) {
	try {
		return await readdir(path.join(workdir, '.openmelon', 'sessions'));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

async function waitFor(predicate: () => boolean) {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	throw new Error('timed out waiting for condition');
}
