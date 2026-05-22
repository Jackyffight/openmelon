import type {TuiAction, TuiState} from './types.js';
import {
	backspace,
	deleteForward,
	editorWithText,
	insertText,
	moveCursor,
	moveLineBoundary,
	moveVertical,
	type InputEditor
} from './inputEditor.js';

export function initialState(): TuiState {
	return {
		items: [],
		commandPanel: null,
		input: '',
		inputCursor: 0,
		inputPreferredColumn: null,
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
		totalPromptTokens: 0,
		totalCompletionTokens: 0,
		runStartedAt: null,
		nextId: 1
	};
}

export function reducer(state: TuiState, action: TuiAction): TuiState {
	switch (action.type) {
		case 'append':
			return {
				...state,
				commandPanel: null,
				items: [...state.items, {id: state.nextId, kind: action.kind, text: action.text, markdown: action.kind === 'assistant'}],
				nextId: state.nextId + 1
			};
		case 'append-delta': {
			const last = state.items.at(-1);
			if (last && last.kind === action.kind && Boolean(last.markdown) === Boolean(action.markdown)) {
				return {
					...state,
					commandPanel: null,
					items: [
						...state.items.slice(0, -1),
						{
							...last,
							text: `${last.text}${action.text}`
						}
					]
				};
			}
			return {
				...state,
				commandPanel: null,
				items: [
					...state.items,
					{id: state.nextId, kind: action.kind, text: action.text, markdown: action.markdown ?? action.kind === 'assistant'}
				],
				nextId: state.nextId + 1
			};
		}
		case 'command-panel':
			return {
				...state,
				commandPanel: {id: 0, kind: action.kind, text: action.text, markdown: action.markdown ?? action.kind === 'assistant'}
			};
		case 'clear-command-panel':
			return {...state, commandPanel: null};
		case 'set-input':
			return updateInput(state, editorWithText(action.input), {historyIndex: null, notice: '', commandPanel: null});
		case 'insert':
			return updateInput(state, insertText(currentEditor(state), action.text), {historyIndex: null, notice: '', commandPanel: null});
		case 'backspace':
			return updateInput(state, backspace(currentEditor(state)), {historyIndex: null});
		case 'delete-forward':
			return updateInput(state, deleteForward(currentEditor(state)), {historyIndex: null});
		case 'move-input': {
			const editor = currentEditor(state);
			const next =
				action.movement === 'line-start'
					? moveLineBoundary(editor, 'start')
					: action.movement === 'line-end'
						? moveLineBoundary(editor, 'end')
						: action.movement === 'up'
							? moveVertical(editor, -1, action.width ?? 80)
							: action.movement === 'down'
								? moveVertical(editor, 1, action.width ?? 80)
								: moveCursor(editor, action.movement);
			return updateInput(state, next);
		}
		case 'clear-input': {
			const remember = action.remember ?? true;
			const inputHistory =
				remember && state.input.trim() !== '' && state.inputHistory.at(-1) !== state.input
					? [...state.inputHistory, state.input]
					: state.inputHistory;
			return {
				...state,
				input: '',
				inputCursor: 0,
				inputPreferredColumn: null,
				inputHistory,
				historyIndex: null,
				historyDraft: '',
				paletteIndex: 0,
				commandPanel: null,
				notice: action.notice ?? ''
			};
		}
		case 'commit-input':
		case 'submit-start': {
			const inputHistory =
				action.text.trim() !== '' && state.inputHistory.at(-1) !== action.text
					? [...state.inputHistory, action.text]
					: state.inputHistory;
			return {
				...state,
				commandPanel: null,
				items: [...state.items, {id: state.nextId, kind: 'user', text: action.text}],
				input: '',
				inputCursor: 0,
				inputPreferredColumn: null,
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
					...inputPatch(editorWithText(state.inputHistory[next] ?? state.input))
				};
			}
			const next = Math.max(0, state.historyIndex - 1);
			return {...state, historyIndex: next, ...inputPatch(editorWithText(state.inputHistory[next] ?? state.input))};
		}
		case 'history-next': {
			if (state.historyIndex === null) {
				return state;
			}
			const next = state.historyIndex + 1;
			if (next >= state.inputHistory.length) {
				return {...state, historyIndex: null, ...inputPatch(editorWithText(state.historyDraft)), historyDraft: ''};
			}
			return {...state, historyIndex: next, ...inputPatch(editorWithText(state.inputHistory[next] ?? state.input))};
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
				commandPanel: null,
				pendingInputs: [...state.pendingInputs, action.text],
				notice: `${state.pendingInputs.length + 1} pending input`
			};
		case 'pending-applied': {
			const count = Math.max(0, action.count);
			return {
				...state,
				pendingInputs: count >= state.pendingInputs.length ? [] : state.pendingInputs.slice(count)
			};
		}
		case 'recall-pending': {
			const pending = action.texts ?? state.pendingInputs;
			if (pending.length === 0 || state.input.trim().length > 0) {
				return state;
			}
			const text = pending.join('\n\n');
			return {
				...state,
				...inputPatch(editorWithText(text)),
				commandPanel: null,
				pendingInputs: [],
				notice: 'pending input recalled'
			};
		}
		case 'drain-pending':
			return {...state, pendingInputs: []};
		case 'status':
			return {
				...state,
				status: action.status,
				activity: action.activity ?? state.activity,
				runStartedAt: action.status === 'ready' || action.status === 'error' ? null : state.runStartedAt
			};
		case 'notice':
			return {...state, notice: action.notice};
		case 'arm-quit':
			return {...state, quitArmedAt: action.at, notice: 'press Ctrl-C again to quit'};
		case 'set-usage':
			return {
				...state,
				promptTokens: action.promptTokens,
				completionTokens: action.completionTokens,
				totalPromptTokens: state.totalPromptTokens + action.promptTokens,
				totalCompletionTokens: state.totalCompletionTokens + action.completionTokens
			};
		case 'turn-started':
			return {...state, runStartedAt: action.at};
		case 'runtime-ready':
			return {
				...state,
				model: action.model || state.model,
				reasoning: action.reasoning || state.reasoning,
				project: action.project || state.project,
				provider: action.provider || state.provider,
				sessionId: action.clearSession ? '' : action.sessionId || state.sessionId,
				sessionDir: action.clearSession ? '' : action.sessionDir || state.sessionDir
			};
		case 'set-active-skill':
			return {...state, activeSkill: action.skill, commandPanel: null, notice: action.skill ? `skill ${action.skill} applies to next message` : 'skill cleared'};
		case 'clear-transcript':
			return {...state, items: [], commandPanel: null, nextId: 1};
	}
}

function currentEditor(state: TuiState): InputEditor {
	return {
		text: state.input,
		cursor: Math.min(state.inputCursor, Array.from(state.input).length),
		preferredColumn: state.inputPreferredColumn
	};
}

function inputPatch(editor: InputEditor) {
	return {input: editor.text, inputCursor: editor.cursor, inputPreferredColumn: editor.preferredColumn};
}

function updateInput(state: TuiState, editor: InputEditor, patch: Partial<TuiState> = {}): TuiState {
	return {...state, ...inputPatch(editor), ...patch};
}
