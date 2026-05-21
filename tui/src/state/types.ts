export type TranscriptKind = 'user' | 'assistant' | 'tool' | 'result' | 'info' | 'error';

export type TranscriptItem = {
	id: number;
	kind: TranscriptKind;
	text: string;
	markdown?: boolean;
};

export type RuntimeStatus = 'ready' | 'thinking' | 'tool' | 'error';

export type TuiState = {
	items: TranscriptItem[];
	input: string;
	inputHistory: string[];
	historyIndex: number | null;
	historyDraft: string;
	paletteIndex: number;
	pendingInputs: string[];
	status: RuntimeStatus;
	activity: string;
	notice: string;
	quitArmedAt: number | null;
	model: string;
	reasoning: string;
	project: string;
	provider: string;
	sessionId: string;
	sessionDir: string;
	activeSkill: string;
	promptTokens: number;
	completionTokens: number;
	totalPromptTokens: number;
	totalCompletionTokens: number;
	runStartedAt: number | null;
	nextId: number;
};

export type TuiAction =
	| {type: 'append'; kind: TranscriptKind; text: string}
	| {type: 'append-delta'; kind: TranscriptKind; text: string; markdown?: boolean}
	| {type: 'set-input'; input: string}
	| {type: 'insert'; text: string}
	| {type: 'backspace'}
	| {type: 'clear-input'; notice?: string; remember?: boolean}
	| {type: 'commit-input'; text: string}
	| {type: 'submit-start'; text: string}
	| {type: 'history-prev'}
	| {type: 'history-next'}
	| {type: 'palette-prev'; count: number}
	| {type: 'palette-next'; count: number}
	| {type: 'palette-reset'}
	| {type: 'queue-pending'; text: string}
	| {type: 'pending-applied'; count: number}
	| {type: 'drain-pending'}
	| {type: 'status'; status: RuntimeStatus; activity?: string}
	| {type: 'notice'; notice: string}
	| {type: 'arm-quit'; at: number}
	| {type: 'set-usage'; promptTokens: number; completionTokens: number}
	| {type: 'turn-started'; at: number}
	| {type: 'runtime-ready'; model?: string; reasoning?: string; project?: string; provider?: string; sessionId?: string; sessionDir?: string}
	| {type: 'set-active-skill'; skill: string}
	| {type: 'clear-transcript'};
