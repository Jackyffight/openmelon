// Shared runtime-driver types. The in-process TS engine (engine/localRuntime.ts)
// implements RuntimeBridge and emits RuntimeEvent; the Ink TUI (App.tsx) drives
// it. (These were originally defined alongside the Go subprocess bridge, which
// has been removed — the engine is fully in-process TS now.)

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

export type RuntimeBridgeOptions = {
	resumeId?: string;
};
