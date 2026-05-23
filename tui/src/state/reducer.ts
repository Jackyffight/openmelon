import type {TuiAction, TuiState} from './types.js';

export function initialState(): TuiState {
	return {
		items: [],
		input: '',
		inputHistory: [],
		historyIndex: null,
		historyDraft: '',
		paletteIndex: 0,
		pendingInputs: [],
		status: 'ready',
		activity: 'Ready',
		notice: '',
		quitArmedAt: null,
		model: 'gpt-5.5',
		reasoning: 'xhigh',
		project: 'bigone',
		provider: '',
		sessionId: '',
		sessionDir: '',
		activeSkill: '',
		promptTokens: 0,
		completionTokens: 0,
		nextId: 1
	};
}

export function reducer(state: TuiState, action: TuiAction): TuiState {
	switch (action.type) {
		case 'append':
			return {
				...state,
				items: [...state.items, {id: state.nextId, kind: action.kind, text: action.text}],
				nextId: state.nextId + 1
			};
		case 'set-input':
			return {...state, input: action.input, historyIndex: null, notice: ''};
		case 'insert':
			return {...state, input: state.input + action.text, historyIndex: null, notice: ''};
		case 'backspace':
			return {
				...state,
				input: Array.from(state.input).slice(0, -1).join(''),
				historyIndex: null
			};
		case 'clear-input': {
			const remember = action.remember ?? true;
			const inputHistory =
				remember && state.input.trim() !== '' && state.inputHistory.at(-1) !== state.input
					? [...state.inputHistory, state.input]
					: state.inputHistory;
			return {
				...state,
				input: '',
				inputHistory,
				historyIndex: null,
				historyDraft: '',
				paletteIndex: 0,
				notice: action.notice ?? ''
			};
		}
		case 'submit-start': {
			const inputHistory =
				action.text.trim() !== '' && state.inputHistory.at(-1) !== action.text
					? [...state.inputHistory, action.text]
					: state.inputHistory;
			return {
				...state,
				items: [...state.items, {id: state.nextId, kind: 'user', text: action.text}],
				input: '',
				inputHistory,
				historyIndex: null,
				historyDraft: '',
				paletteIndex: 0,
				notice: '',
				quitArmedAt: null,
				nextId: state.nextId + 1
			};
		}
		case 'history-prev': {
			if (state.inputHistory.length === 0 || state.input.includes('\n')) {
				return state;
			}
			if (state.historyIndex === null) {
				const next = state.inputHistory.length - 1;
				return {
					...state,
					historyDraft: state.input,
					historyIndex: next,
					input: state.inputHistory[next] ?? state.input
				};
			}
			const next = Math.max(0, state.historyIndex - 1);
			return {...state, historyIndex: next, input: state.inputHistory[next] ?? state.input};
		}
		case 'history-next': {
			if (state.historyIndex === null) {
				return state;
			}
			const next = state.historyIndex + 1;
			if (next >= state.inputHistory.length) {
				return {...state, historyIndex: null, input: state.historyDraft, historyDraft: ''};
			}
			return {...state, historyIndex: next, input: state.inputHistory[next] ?? state.input};
		}
		case 'palette-prev':
			if (action.count <= 0) {
				return {...state, paletteIndex: 0};
			}
			return {
				...state,
				paletteIndex: state.paletteIndex <= 0 ? action.count - 1 : state.paletteIndex - 1
			};
		case 'palette-next':
			return {
				...state,
				paletteIndex: action.count <= 0 ? 0 : (state.paletteIndex + 1) % action.count
			};
		case 'palette-reset':
			return {...state, paletteIndex: 0};
		case 'queue-pending':
			return {
				...state,
				pendingInputs: [...state.pendingInputs, action.text],
				notice: `${state.pendingInputs.length + 1} pending input`
			};
		case 'drain-pending':
			return {...state, pendingInputs: []};
		case 'status':
			return {...state, status: action.status, activity: action.activity ?? state.activity};
		case 'notice':
			return {...state, notice: action.notice};
		case 'arm-quit':
			return {...state, quitArmedAt: action.at, notice: 'press Ctrl-C again to quit'};
		case 'set-usage':
			return {
				...state,
				promptTokens: action.promptTokens,
				completionTokens: action.completionTokens
			};
		case 'runtime-ready':
			return {
				...state,
				model: action.model || state.model,
				reasoning: action.reasoning || state.reasoning,
				project: action.project || state.project,
				provider: action.provider || state.provider,
				sessionId: action.sessionId || state.sessionId,
				sessionDir: action.sessionDir || state.sessionDir
			};
		case 'set-active-skill':
			return {...state, activeSkill: action.skill, notice: action.skill ? `skill ${action.skill} applies to next message` : 'skill cleared'};
		case 'clear-transcript':
			return {...state, items: [], nextId: 1};
	}
}
