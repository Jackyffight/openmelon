import type {TranscriptKind} from '../state/types.js';

export type RuntimeStatus = 'thinking' | 'tool' | 'ready' | 'error';

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
	| {type: 'status'; status: RuntimeStatus; activity: string}
	| {type: 'append'; kind: TranscriptKind; text: string; delta?: boolean; markdown?: boolean}
	| {type: 'pending-applied'; count: number}
	| {type: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number}
	| {type: 'approval'; activity?: string; detail?: ApprovalRequest}
	| {type: 'done'}
	| {type: 'error'; error: string};

export type ApprovalRequest = {
	id?: string;
	tool?: string;
	command?: string;
	description?: string;
	binary?: string;
};

export type RuntimeRequest =
	| {type: 'run'; text: string}
	| {type: 'pending'; text: string}
	| {type: 'cancel'}
	| {type: 'clear'}
	| {type: 'history'}
	| {type: 'save'; text: string}
	| {type: 'reload'}
	| {type: 'approval'; id: string; approved: boolean; always: boolean}
	| {type: 'shutdown'};

export type RuntimeEventHandler = (event: RuntimeEvent) => void;

export type RuntimeClient = {
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

export type RuntimeClientOptions = {
	resumeId?: string;
	initialPrompt?: string;
};
