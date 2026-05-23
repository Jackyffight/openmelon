import {promises as fs} from 'node:fs';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {stateDir} from './project.js';

export const sessionSchemaVersion = 2;

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
	const body = await fs.readFile(filePath, 'utf8');
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

// --- write side (ported from internal/session) ---

/** A writable session directory: appends messages/events, writes the summary. */
export type WritableSession = {
	id: string;
	dir: string;
	startedAt: Date;
	/** Persist each message as one JSONL line (on-disk snake_case shape). */
	appendMessages(messages: ChatMessage[]): Promise<void>;
	/** Write the final summary.json. */
	writeSummary(summary: string, artifacts: string[], finished: boolean): Promise<void>;
	/** Record provider/model into meta.json. */
	setRuntimeInfo(provider: string, model: string): Promise<void>;
	appendEvent(event: SessionEvent): Promise<void>;
};

function utcStamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/**
 * Create a fresh session under <workdir>/.openmelon/sessions/<id>/, writing
 * meta.json. The id is "<UTC timestamp>-<8 hex>" so listings sort
 * chronologically. The on-disk message shape matches the Go reader so
 * `openmelon resume` (and the legacy Go binary) stay compatible.
 */
export async function createSession(
	workdir: string,
	projectId: string,
	intent: string,
	resumedFrom = ''
): Promise<WritableSession> {
	const now = new Date();
	const id = `${utcStamp(now)}-${randomBytes(4).toString('hex')}`;
	const dir = path.join(sessionsDir(workdir), id);
	await fs.mkdir(dir, {recursive: true});

	let provider = '';
	let model = '';

	async function writeMeta(): Promise<void> {
		const meta: SessionMeta = {
			version: sessionSchemaVersion,
			id,
			project_id: projectId,
			intent,
			started_at: now.toISOString(),
			workspace_root: workdir
		};
		if (provider) {
			meta.provider = provider;
		}
		if (model) {
			meta.model = model;
		}
		if (resumedFrom) {
			meta.resumed_from = resumedFrom;
		}
		await fs.writeFile(path.join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
	}

	await writeMeta();

	return {
		id,
		dir,
		startedAt: now,
		async appendMessages(messages) {
			if (messages.length === 0) {
				return;
			}
			const body = messages.map(m => JSON.stringify(m)).join('\n') + '\n';
			await fs.appendFile(path.join(dir, 'messages.jsonl'), body);
		},
		async writeSummary(summary, artifacts, finished) {
			const payload = {
				id,
				finished,
				summary,
				artifacts,
				finished_at: new Date().toISOString()
			};
			await fs.writeFile(path.join(dir, 'summary.json'), `${JSON.stringify(payload, null, 2)}\n`);
		},
		async setRuntimeInfo(p, m) {
			provider = p.trim();
			model = m.trim();
			await writeMeta();
		},
		async appendEvent(event) {
			const rec = {at: new Date().toISOString(), ...event};
			await fs.appendFile(path.join(dir, 'events.jsonl'), `${JSON.stringify(rec)}\n`);
		}
	};
}
