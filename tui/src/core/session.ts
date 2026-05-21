import {promises as fs} from 'node:fs';
import path from 'node:path';
import {stateDir} from './project.js';

export type SessionMeta = {
	version?: number;
	id: string;
	project_id?: string;
	intent?: string;
	started_at?: string;
	workspace_root?: string;
	provider?: string;
	model?: string;
	resumed_from?: string;
};

export type ChatMessage = {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content?: string;
	tool_calls?: Array<{id?: string; name?: string; arguments?: unknown}>;
	tool_call_id?: string;
};

export type SessionSummary = {
	id: string;
	startedAt: Date;
	turnCount: number;
	firstUserMessage: string;
	intent: string;
	resumedFrom: string;
};

export type SessionEvent = {
	at?: string;
	type?: string;
	step?: number;
	tool?: string;
	space_id?: string;
	status?: string;
	detail?: Record<string, unknown>;
};

export async function listSessions(workdir: string, limit = 10): Promise<SessionSummary[]> {
	const root = sessionsDir(workdir);
	let entries;
	try {
		entries = await fs.readdir(root, {withFileTypes: true});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}

	const summaries = await Promise.all(
		entries
			.filter(entry => entry.isDirectory())
			.map(entry => loadSessionSummary(workdir, entry.name))
	);

	return summaries
		.filter((summary): summary is SessionSummary => summary !== null)
		.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
		.slice(0, limit);
}

export async function loadSessionHistory(workdir: string, id: string) {
	const filePath = path.join(sessionsDir(workdir), id, 'messages.jsonl');
	let body = '';
	try {
		body = await fs.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
	return body
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => JSON.parse(line) as ChatMessage);
}

export async function loadSessionEvents(workdir: string, id: string, limit = 20) {
	const filePath = path.join(sessionsDir(workdir), id, 'events.jsonl');
	let body = '';
	try {
		body = await fs.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
	const events = body
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => JSON.parse(line) as SessionEvent);
	return limit > 0 ? events.slice(-limit) : events;
}

export function sessionDir(workdir: string, id: string) {
	return path.join(sessionsDir(workdir), id);
}

export async function validateSessionWorkspace(workdir: string, id: string) {
	const meta = await loadSessionMeta(workdir, id);
	if (!meta.workspace_root) {
		return;
	}
	if (path.resolve(meta.workspace_root) !== path.resolve(workdir)) {
		throw new Error(`session ${id} belongs to ${meta.workspace_root}, current project is ${workdir}`);
	}
}

async function loadSessionSummary(workdir: string, id: string): Promise<SessionSummary | null> {
	try {
		const meta = await loadSessionMeta(workdir, id);
		const messages = await loadSessionHistory(workdir, id).catch(() => []);
		const firstUserMessage = messages.find(message => message.role === 'user' && message.content?.trim())?.content ?? '';
		return {
			id: meta.id || id,
			startedAt: meta.started_at ? new Date(meta.started_at) : new Date(0),
			turnCount: messages.length,
			firstUserMessage,
			intent: meta.intent ?? '',
			resumedFrom: meta.resumed_from ?? ''
		};
	} catch {
		return null;
	}
}

async function loadSessionMeta(workdir: string, id: string) {
	const body = await fs.readFile(path.join(sessionsDir(workdir), id, 'meta.json'), 'utf8');
	return JSON.parse(body) as SessionMeta;
}

function sessionsDir(workdir: string) {
	return path.join(stateDir(workdir), 'sessions');
}
