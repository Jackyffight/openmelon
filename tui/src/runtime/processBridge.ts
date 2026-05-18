import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {TranscriptKind} from '../state/types.js';

export type RuntimeEvent =
	| {
			type: 'ready';
			status?: 'ready';
			activity?: string;
			model?: string;
			reasoning?: string;
			project?: string;
			sessionId?: string;
			sessionDir?: string;
			provider?: string;
	  }
	| {type: 'status'; status: 'thinking' | 'tool' | 'ready' | 'error'; activity: string}
	| {type: 'append'; kind: TranscriptKind; text: string}
	| {type: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number}
	| {type: 'approval'; activity?: string; detail?: {id?: string; tool?: string; command?: string; description?: string; binary?: string}}
	| {type: 'done'}
	| {type: 'error'; error: string};

export type RuntimeBridge = {
	isAvailable(): boolean;
	run(text: string): void;
	pending(text: string): void;
	cancel(): void;
	clearHistory(): void;
	history(): void;
	save(path: string): void;
	reload(): void;
	approval(id: string, approved: boolean, always: boolean): void;
	shutdown(): void;
};

type Emit = (event: RuntimeEvent) => void;

export type RuntimeBridgeOptions = {
	resumeId?: string;
};

export function createRuntimeBridge(emit: Emit, options: RuntimeBridgeOptions = {}): RuntimeBridge {
	let closed = false;
	const args = ['runtime-bridge'];
	if (options.resumeId) {
		args.push(options.resumeId);
	}
	const child = spawn(resolveRuntimeBinary(), args, {
		stdio: ['pipe', 'pipe', 'pipe'],
		cwd: process.cwd(),
		env: process.env
	});
	child.stdin.on('error', error => {
		if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
			emit({type: 'append', kind: 'error', text: `runtime bridge stdin error: ${error.message}`});
		}
		closed = true;
	});
	wireJsonLines(child, emit);
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', chunk => {
		const text = String(chunk).trim();
		if (text) {
			emit({type: 'append', kind: 'error', text});
		}
	});
	child.on('error', error => {
		emit({type: 'append', kind: 'error', text: `runtime bridge failed: ${error.message}`});
		closed = true;
	});
	child.on('exit', (code, signal) => {
		closed = true;
		if (code && code !== 0) {
			emit({type: 'append', kind: 'error', text: `runtime bridge exited with code ${code}`});
		}
		if (signal) {
			emit({type: 'append', kind: 'error', text: `runtime bridge exited on ${signal}`});
		}
	});

	return {
		isAvailable() {
			return !closed;
		},
		run(text: string) {
			send(child, {type: 'run', text}, () => closed);
		},
		pending(text: string) {
			send(child, {type: 'pending', text}, () => closed);
		},
		cancel() {
			send(child, {type: 'cancel'}, () => closed);
		},
		clearHistory() {
			send(child, {type: 'clear'}, () => closed);
		},
		history() {
			send(child, {type: 'history'}, () => closed);
		},
		save(path: string) {
			send(child, {type: 'save', text: path}, () => closed);
		},
		reload() {
			send(child, {type: 'reload'}, () => closed);
		},
		approval(id: string, approved: boolean, always: boolean) {
			send(child, {type: 'approval', id, approved, always}, () => closed);
		},
		shutdown() {
			send(child, {type: 'shutdown'}, () => closed);
			closed = true;
			if (!child.killed) {
				child.kill();
			}
		}
	};
}

function wireJsonLines(child: ChildProcessWithoutNullStreams, emit: Emit) {
	let buffer = '';
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', chunk => {
		buffer += String(chunk);
		for (;;) {
			const idx = buffer.indexOf('\n');
			if (idx < 0) {
				break;
			}
			const line = buffer.slice(0, idx).trim();
			buffer = buffer.slice(idx + 1);
			if (!line) {
				continue;
			}
			try {
				emit(JSON.parse(line) as RuntimeEvent);
			} catch (error) {
				emit({type: 'append', kind: 'error', text: `bad runtime event: ${(error as Error).message}`});
			}
		}
	});
}

function send(child: ChildProcessWithoutNullStreams, payload: unknown, isClosed: () => boolean) {
	if (isClosed() || child.killed || child.stdin.destroyed || !child.stdin.writable) {
		return;
	}
	child.stdin.write(`${JSON.stringify(payload)}\n`, error => {
		if (error && (error as NodeJS.ErrnoException).code !== 'EPIPE') {
			// The stream error event is also wired above; avoid throwing from the
			// callback because shutdown is best-effort.
		}
	});
}

function resolveRuntimeBinary() {
	if (process.env.OPENMELON_RUNTIME_BIN) {
		return process.env.OPENMELON_RUNTIME_BIN;
	}
	const here = dirname(fileURLToPath(import.meta.url));
	const repoBinary = resolve(here, '..', '..', '..', 'openmelon');
	if (existsSync(repoBinary)) {
		return repoBinary;
	}
	return 'openmelon';
}
