import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {stateDir} from '../core/project.js';
import type {ChatMessage} from './nativeTypes.js';

export type NativeSession = {
	id: string;
	dir: string;
	startedAt: Date;
	workdir: string;
	projectId: string;
	resumedFrom: string;
};

export async function createNativeSession(workdir: string, projectId: string, intent: string, resumedFrom = ''): Promise<NativeSession> {
	const startedAt = new Date();
	const id = `${sessionTimestamp(startedAt)}-${randomBytes(4).toString('hex')}`;
	const dir = path.join(stateDir(workdir), 'sessions', id);
	await fs.mkdir(dir, {recursive: true});
	await writeJson(path.join(dir, 'meta.json'), {
		version: 2,
		id,
		project_id: projectId,
		intent,
		started_at: startedAt.toISOString(),
		workspace_root: workdir,
		...(resumedFrom ? {resumed_from: resumedFrom} : {})
	});
	await fs.writeFile(path.join(dir, 'messages.jsonl'), '', {flag: 'a'});
	return {id, dir, startedAt, workdir, projectId, resumedFrom};
}

export async function openNativeSession(workdir: string, id: string): Promise<NativeSession> {
	const dir = path.join(stateDir(workdir), 'sessions', id);
	const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8')) as {
		project_id?: string;
		started_at?: string;
		resumed_from?: string;
	};
	await fs.writeFile(path.join(dir, 'messages.jsonl'), '', {flag: 'a'});
	return {
		id,
		dir,
		startedAt: meta.started_at ? new Date(meta.started_at) : new Date(),
		workdir,
		projectId: meta.project_id ?? '',
		resumedFrom: meta.resumed_from ?? ''
	};
}

export async function setRuntimeInfo(session: NativeSession, provider: string, model: string) {
	const filePath = path.join(session.dir, 'meta.json');
	const meta = JSON.parse(await fs.readFile(filePath, 'utf8')) as Record<string, unknown>;
	meta.provider = provider;
	meta.model = model;
	await writeJson(filePath, meta);
}

export async function appendPrompt(session: NativeSession, kind: string, content: string) {
	const trimmed = content.trim();
	if (!trimmed) {
		return;
	}
	await appendJsonl(path.join(session.dir, 'prompt_history.jsonl'), {
		at: new Date().toISOString(),
		kind: kind || 'user',
		content: trimmed
	});
}

export async function appendMessages(session: NativeSession, messages: ChatMessage[]) {
	for (const message of messages) {
		await appendJsonl(path.join(session.dir, 'messages.jsonl'), message);
	}
}

export async function appendEvent(session: NativeSession, type: string, record: Record<string, unknown> = {}) {
	await appendJsonl(path.join(session.dir, 'events.jsonl'), {
		at: new Date().toISOString(),
		type,
		...record
	});
}

export async function writeSummary(session: NativeSession, summary: string, artifacts: string[], finished: boolean) {
	await writeJson(path.join(session.dir, 'summary.json'), {
		id: session.id,
		finished,
		summary,
		artifacts,
		finished_at: new Date().toISOString()
	});
}

async function appendJsonl(filePath: string, value: unknown) {
	await fs.mkdir(path.dirname(filePath), {recursive: true});
	await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
}

async function writeJson(filePath: string, value: unknown) {
	await fs.mkdir(path.dirname(filePath), {recursive: true});
	await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sessionTimestamp(date: Date) {
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}
