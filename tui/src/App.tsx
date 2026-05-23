import React, {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react';
import {Box, useApp, useInput, useStdout} from 'ink';
import {filterSlashCommands, slashCommands} from './commands.js';
import {HeaderCard} from './components/Header.js';
import {PromptInput} from './components/PromptInput.js';
import {SelectorPanel, type SelectorRow} from './components/SelectorPanel.js';
import {SlashPalette} from './components/SlashPalette.js';
import {StatusLine} from './components/StatusLine.js';
import {Transcript} from './components/Transcript.js';
import type {RuntimeBridge, RuntimeEvent} from './runtime/types.js';
import {createLocalRuntime} from './engine/localRuntime.js';

// The all-TS in-process engine is the runtime. (The Go `runtime-bridge`
// subprocess fallback was removed once the TS engine reached full parity.)
const createRuntime = createLocalRuntime;
import {randomPlaceholder} from './placeholder.js';
import {initialState, reducer} from './state/reducer.js';
import {discoverProject} from './core/project.js';
import {loadProject, saveProject} from './core/project.js';
import {loadSessionEvents, loadSessionHistory, sessionDir, type ChatMessage} from './core/session.js';
import {inspectBootstrap, type BootstrapState} from './core/bootstrap.js';
import {Onboarding} from './onboarding/Onboarding.js';
import {providers, type ProviderOption} from './core/providers.js';
import type {ProjectSettings} from './core/project.js';
import {buildCompactionDraft, summarizeSpace} from './core/space.js';
import {publishToVbox} from './core/publish.js';
import {listSkills, type SkillInfo} from './core/skillplus.js';
import {osc52Copy} from './terminal/clipboard.js';
import type {TuiAction, TuiState, TranscriptItem} from './state/types.js';

type Props = {
	resumeId?: string;
};

type Overlay =
	| {kind: 'model'; cursor: number}
	| {kind: 'image-model'; cursor: number}
	| {kind: 'settings'; cursor: number}
	| {kind: 'skill'; cursor: number; skills: SkillInfo[]; error: string}
	| {kind: 'custom-model'; cursor: number; image: boolean; input: string}
	| {kind: 'approval'; cursor: number; id: string; tool: string; command: string; description: string; binary: string};

type Dispatch = React.Dispatch<TuiAction>;

type OverlayRow = SelectorRow & {
	value: string;
	provider?: ProviderOption['slug'];
	section?: boolean;
};

export function App({resumeId}: Props) {
	const {exit} = useApp();
	const {stdout} = useStdout();
	const width = Math.max(32, stdout.columns ?? 88);
	const [state, dispatch] = useReducer(reducer, undefined, initialState);
	const placeholder = useMemo(() => randomPlaceholder(), []);
	const [running, setRunning] = useState(false);
	const [bootstrap, setBootstrap] = useState<BootstrapState | null>(null);
	const [overlay, setOverlay] = useState<Overlay | null>(null);
	const runtimeBridge = useRef<RuntimeBridge | null>(null);
	const stateRef = useRef(state);
	const submittedRef = useRef(false);

	useEffect(() => {
		stateRef.current = state;
	}, [state]);

	const refreshBootstrap = useCallback(async () => {
		const info = await inspectBootstrap();
		setBootstrap(info);
		dispatch({
			type: 'runtime-ready',
			model: info.model,
			reasoning: info.reasoning,
			project: info.projectId || info.projectName || stateRef.current.project,
			provider: info.provider
		});
		if (info.issues.length > 0) {
			dispatch({type: 'status', status: 'error', activity: 'Setup required'});
		}
		return info;
	}, []);

	useEffect(() => {
		let cancelled = false;
		refreshBootstrap()
			.then(info => {
				if (cancelled) {
					return;
				}
				setBootstrap(info);
			})
			.catch(error => {
				dispatch({type: 'append', kind: 'error', text: `bootstrap: ${(error as Error).message}`});
			});
		return () => {
			cancelled = true;
		};
	}, [refreshBootstrap]);

	const handleRuntimeEvent = useCallback((event: RuntimeEvent) => {
		switch (event.type) {
			case 'ready':
				dispatch({
					type: 'runtime-ready',
					model: event.model,
					reasoning: event.reasoning,
					project: event.project,
					provider: event.provider,
					sessionId: event.sessionId,
					sessionDir: event.sessionDir
				});
				dispatch({type: 'status', status: 'ready', activity: event.activity ?? 'Ready'});
				break;
			case 'append':
				if (event.kind === 'error' && stateRef.current.items.length === 0 && !submittedRef.current) {
					dispatch({type: 'notice', notice: event.text});
				} else {
					dispatch({type: 'append', kind: event.kind, text: event.text});
				}
				break;
			case 'status':
				dispatch({type: 'status', status: event.status, activity: event.activity});
				if (event.status === 'ready' || event.status === 'error') {
					setRunning(false);
				}
				break;
			case 'usage':
				dispatch({
					type: 'set-usage',
					promptTokens: event.promptTokens ?? 0,
					completionTokens: event.completionTokens ?? 0
				});
				break;
			case 'approval':
				setOverlay({
					kind: 'approval',
					cursor: 0,
					id: event.detail?.id ?? '',
					tool: event.detail?.tool ?? 'tool',
					command: event.detail?.command ?? '',
					description: event.detail?.description ?? '',
					binary: event.detail?.binary ?? 'this binary'
				});
				dispatch({type: 'status', status: 'tool', activity: event.activity ?? 'Approval required'});
				break;
			case 'done':
				setRunning(false);
				dispatch({type: 'drain-pending'});
				break;
			case 'error':
				dispatch({type: 'append', kind: 'error', text: event.error});
				setRunning(false);
				break;
		}
	}, []);

	useEffect(() => {
		if (!bootstrap?.ready) {
			return;
		}
		runtimeBridge.current = createRuntime(handleRuntimeEvent, {resumeId});
		return () => runtimeBridge.current?.shutdown();
	}, [bootstrap?.ready, handleRuntimeEvent, resumeId]);

	const reloadRuntime = useCallback(() => {
		if (runtimeBridge.current?.isAvailable()) {
			runtimeBridge.current.reload();
		} else {
			runtimeBridge.current = createRuntime(handleRuntimeEvent, {resumeId});
		}
	}, [handleRuntimeEvent, resumeId]);

	useEffect(() => {
		if (!resumeId) {
			return;
		}
		let cancelled = false;
		(async () => {
			const workdir = await discoverProject();
			if (!workdir) {
				return;
			}
			const history = await loadSessionHistory(workdir, resumeId);
			if (cancelled) {
				return;
			}
			dispatch({type: 'append', kind: 'info', text: `resumed from ${resumeId}`});
			dispatch({type: 'append', kind: 'info', text: `prior conversation (${history.length} messages)`});
			for (const item of renderHistory(history)) {
				dispatch({type: 'append', kind: item.kind, text: item.text});
			}
			dispatch({type: 'append', kind: 'info', text: 'continue below'});
		})().catch(error => {
			dispatch({type: 'append', kind: 'error', text: `resume: ${(error as Error).message}`});
		});
		return () => {
			cancelled = true;
		};
	}, [resumeId]);

	const filteredCommands = useMemo(() => filterSlashCommands(state.input), [state.input]);

	useEffect(() => {
		if (state.paletteIndex >= filteredCommands.length) {
			dispatch({type: 'palette-reset'});
		}
	}, [filteredCommands.length, state.paletteIndex]);

	const startTurn = useCallback((text: string) => {
		setRunning(true);
		runtimeBridge.current?.run(text);
	}, []);

	const submit = useCallback((raw: string) => {
		let text = raw.trim();
		if (text.length === 0) {
			return;
		}

		submittedRef.current = true;
		dispatch({type: 'submit-start', text});

		if (matchesExit(text)) {
			runtimeBridge.current?.shutdown();
			exit();
			return;
		}
		if (text === '/help' || text === '/?') {
			dispatch({
				type: 'append',
				kind: 'info',
				text: 'Commands:\n' + slashCommands.map(command => `  ${command.name.padEnd(14)} ${command.help}`).join('\n')
			});
			return;
		}
		if (text === '/copy') {
			const body = transcriptText(stateRef.current.items);
			if (!body.trim()) {
				dispatch({type: 'append', kind: 'error', text: 'nothing to copy'});
				return;
			}
			osc52Copy(body);
			dispatch({type: 'append', kind: 'info', text: `copied transcript (${Array.from(body).length} chars)`});
			return;
		}
		if (text === '/clear') {
			dispatch({type: 'clear-transcript'});
			runtimeCommand(runtimeBridge.current, dispatch, bridge => bridge.clearHistory());
			return;
		}
		if (text === '/status') {
			dispatch({
				type: 'append',
				kind: 'info',
				text: `project ${stateRef.current.project} · provider ${stateRef.current.provider || 'default'} · model ${stateRef.current.model} · reasoning ${stateRef.current.reasoning} · session ${stateRef.current.sessionId || '(starting)'}`
			});
			return;
		}
		if (text === '/skill') {
			void openSkillOverlay(setOverlay, dispatch);
			return;
		}
		if (text.startsWith('/skill ')) {
			const arg = text.split(/\s+/, 2)[1] ?? '';
			if (['clear', 'off', 'none'].includes(arg)) {
				dispatch({type: 'set-active-skill', skill: ''});
				dispatch({type: 'append', kind: 'info', text: '(skill cleared)'});
			} else {
				dispatch({type: 'set-active-skill', skill: arg});
				dispatch({type: 'append', kind: 'info', text: `(skill: ${arg}) — applies to your next message`});
			}
			return;
		}
		if (text === '/history') {
			runtimeCommand(runtimeBridge.current, dispatch, bridge => bridge.history());
			return;
		}
		if (text.startsWith('/save')) {
			const [, rawPath] = text.split(/\s+/, 2);
			if (!rawPath) {
				dispatch({type: 'append', kind: 'error', text: '/save: usage: /save <path>'});
				return;
			}
			runtimeCommand(runtimeBridge.current, dispatch, bridge => bridge.save(rawPath));
			return;
		}
		if (text === '/session') {
			const current = stateRef.current;
			const dir = current.sessionDir || (bootstrap?.workdir && current.sessionId ? sessionDir(bootstrap.workdir, current.sessionId) : '');
			dispatch({type: 'append', kind: 'info', text: dir || '(session not ready)'});
			return;
		}
		if (text === '/events') {
			void eventsCommand(bootstrap?.workdir ?? '', stateRef.current.sessionId, dispatch);
			return;
		}
		if (text.startsWith('/space')) {
			void spaceCommand(text, bootstrap?.workdir ?? '', dispatch);
			return;
		}
		if (text.startsWith('/compact')) {
			void compactCommand(text, bootstrap?.workdir ?? '', dispatch);
			return;
		}
		if (text.startsWith('/publish')) {
			void publishCommand(text, bootstrap?.workdir ?? '', dispatch);
			return;
		}
		if (text === '/model') {
			setOverlay({kind: 'model', cursor: 0});
			return;
		}
		if (text.startsWith('/model ')) {
			if (!bootstrap) {
				dispatch({type: 'append', kind: 'error', text: 'bootstrap is not ready'});
				return;
			}
			void applyModelCommand(text, bootstrap, dispatch, reloadRuntime, refreshBootstrap);
			return;
		}
		if (text === '/model-image') {
			setOverlay({kind: 'image-model', cursor: 0});
			return;
		}
		if (text.startsWith('/model-image ')) {
			if (!bootstrap) {
				dispatch({type: 'append', kind: 'error', text: 'bootstrap is not ready'});
				return;
			}
			void applyImageModelCommand(text, bootstrap, dispatch, reloadRuntime, refreshBootstrap);
			return;
		}
		if (text === '/settings' || text === '/config') {
			setOverlay({kind: 'settings', cursor: 0});
			return;
		}
		if (text.startsWith('/settings ') || text.startsWith('/config ')) {
			if (!bootstrap) {
				dispatch({type: 'append', kind: 'error', text: 'bootstrap is not ready'});
				return;
			}
			void applySettingsCommand(text, bootstrap, dispatch, reloadRuntime, refreshBootstrap);
			return;
		}
		if (text.startsWith('/')) {
			dispatch({type: 'append', kind: 'error', text: `unknown command: ${text.split(/\s+/)[0]} (try /help)`});
			return;
		}

		const skill = stateRef.current.activeSkill;
		if (skill) {
			text = `Apply the skill "${skill}" to this request: first call compile_skill with skill="${skill}" (BARE slug, no 'skillplus:' prefix) to fetch the package's prompt + output schema, then proceed.\n\n${text}`;
			dispatch({type: 'set-active-skill', skill: ''});
		}

		if (running) {
			dispatch({type: 'queue-pending', text});
			dispatch({type: 'append', kind: 'info', text: `queued pending input: ${text}`});
			runtimeBridge.current?.pending(text);
			return;
		}

		if (runtimeBridge.current && !runtimeBridge.current.isAvailable()) {
			dispatch({type: 'append', kind: 'error', text: stateRef.current.notice || 'runtime unavailable'});
			return;
		}

		startTurn(text);
	}, [bootstrap?.workdir, exit, running, startTurn]);

	useInput((chunk, key) => {
		if (!bootstrap || !bootstrap.ready) {
			return;
		}

		const current = stateRef.current;

		if (overlay) {
			if (overlay.kind === 'custom-model') {
				if (key.escape || (key.ctrl && chunk === 'c')) {
					setOverlay(null);
					return;
				}
				if (key.return) {
					const value = overlay.input.trim();
					if (value) {
						void applyCustomModel(overlay.image, value, bootstrap, dispatch, reloadRuntime, refreshBootstrap);
					}
					setOverlay(null);
					return;
				}
				if (key.backspace || key.delete) {
					setOverlay({...overlay, input: Array.from(overlay.input).slice(0, -1).join('')});
					return;
				}
				if (!key.ctrl) {
					const text = normalizeTextInput(chunk);
					if (text) {
						setOverlay({...overlay, input: overlay.input + text});
					}
				}
				return;
			}
			if (overlay.kind === 'approval') {
				const rows = approvalRows(overlay);
				if (key.upArrow || chunk === 'k') {
					setOverlay({...overlay, cursor: Math.max(0, overlay.cursor - 1)});
					return;
				}
				if (key.downArrow || chunk === 'j') {
					setOverlay({...overlay, cursor: Math.min(rows.length - 1, overlay.cursor + 1)});
					return;
				}
				if (key.escape || chunk === 'n' || chunk === 'N') {
					runtimeBridge.current?.approval(overlay.id, false, false);
					setOverlay(null);
					return;
				}
				if (chunk === 'y' || chunk === 'Y') {
					runtimeBridge.current?.approval(overlay.id, true, false);
					setOverlay(null);
					return;
				}
				if (/^[1-3]$/.test(chunk)) {
					answerApproval(runtimeBridge.current, overlay, Number(chunk) - 1);
					setOverlay(null);
					return;
				}
				if (key.return) {
					answerApproval(runtimeBridge.current, overlay, overlay.cursor);
					setOverlay(null);
					return;
				}
				return;
			}
			if (overlay.kind === 'skill') {
				const rows = skillRows(overlay, current);
				if (key.escape || (key.ctrl && chunk === 'c')) {
					setOverlay(null);
					return;
				}
				if (key.upArrow || chunk === 'k') {
					setOverlay({...overlay, cursor: Math.max(0, overlay.cursor - 1)});
					return;
				}
				if (key.downArrow || chunk === 'j') {
					setOverlay({...overlay, cursor: Math.min(rows.length - 1, overlay.cursor + 1)});
					return;
				}
				if (/^[1-9]$/.test(chunk)) {
					const row = rows[Number(chunk) - 1];
					if (row) {
						commitSkillRow(row, dispatch);
						setOverlay(null);
					}
					return;
				}
				if (key.return) {
					const row = rows[overlay.cursor];
					if (row) {
						commitSkillRow(row, dispatch);
						setOverlay(null);
					}
					return;
				}
				return;
			}
			const rows = overlayRows(overlay, bootstrap, current);
			if (key.escape || (key.ctrl && chunk === 'c')) {
				setOverlay(null);
				return;
			}
			if (key.upArrow || chunk === 'k') {
				setOverlay({...overlay, cursor: Math.max(0, overlay.cursor - 1)});
				return;
			}
			if (key.downArrow || chunk === 'j') {
				setOverlay({...overlay, cursor: Math.min(rows.length - 1, overlay.cursor + 1)});
				return;
			}
			if (/^[1-9]$/.test(chunk)) {
				const index = Number(chunk) - 1;
				if (index < rows.length) {
					const row = rows[index]!;
					if (row.value === 'custom') {
						setOverlay({kind: 'custom-model', cursor: 0, image: overlay.kind === 'image-model', input: ''});
					} else {
						void applyOverlaySelection(overlay, row, bootstrap, dispatch, reloadRuntime, refreshBootstrap);
						setOverlay(null);
					}
				}
				return;
			}
			if (key.return) {
				const row = rows[overlay.cursor];
				if (row) {
					if (row.value === 'custom') {
						setOverlay({kind: 'custom-model', cursor: 0, image: overlay.kind === 'image-model', input: ''});
					} else {
						void applyOverlaySelection(overlay, row, bootstrap, dispatch, reloadRuntime, refreshBootstrap);
						setOverlay(null);
					}
				}
				return;
			}
			return;
		}

		if (key.ctrl && chunk === 'c') {
			if (current.input.trim().length > 0) {
				dispatch({type: 'clear-input', notice: 'input cleared', remember: true});
				return;
			}
			const now = Date.now();
			if (current.quitArmedAt && now - current.quitArmedAt < 2000) {
				runtimeBridge.current?.shutdown();
				exit();
				return;
			}
			dispatch({type: 'arm-quit', at: now});
			return;
		}

		if (key.escape) {
			if (current.input.trim().length > 0) {
				dispatch({type: 'clear-input', notice: 'input cleared', remember: true});
			} else {
				dispatch({type: 'notice', notice: ''});
			}
			return;
		}

		if (filteredCommands.length > 0 && key.upArrow) {
			dispatch({type: 'palette-prev', count: filteredCommands.length});
			return;
		}
		if (filteredCommands.length > 0 && key.downArrow) {
			dispatch({type: 'palette-next', count: filteredCommands.length});
			return;
		}
		if (filteredCommands.length > 0 && key.tab) {
			dispatch({type: 'set-input', input: `${filteredCommands[current.paletteIndex]?.name ?? '/'} `});
			return;
		}

		if (key.upArrow) {
			dispatch({type: 'history-prev'});
			return;
		}
		if (key.downArrow) {
			dispatch({type: 'history-next'});
			return;
		}

		if (isShiftEnter(chunk, key)) {
			dispatch({type: 'insert', text: '\n'});
			return;
		}

		if (key.return) {
			if (filteredCommands.length > 0 && current.input.trim() === '/') {
				dispatch({type: 'set-input', input: `${filteredCommands[current.paletteIndex]?.name ?? '/'} `});
				return;
			}
			submit(current.input);
			return;
		}

		if (key.backspace || key.delete) {
			dispatch({type: 'backspace'});
			return;
		}

		if (key.ctrl) {
			return;
		}

		const text = normalizeTextInput(chunk);
		if (text.length > 0) {
			dispatch({type: 'insert', text});
		}
	});

	if (!bootstrap) {
		return null;
	}

	if (bootstrap && !bootstrap.ready) {
		return <Onboarding bootstrap={bootstrap} onComplete={refreshBootstrap} />;
	}

	return (
		<Box flexDirection="column">
			<HeaderCard state={state} />
			<Transcript items={state.items} width={width} />
			<Box flexDirection="column" marginTop={1}>
				{overlay ? (
					<SelectorPanel {...overlayView(overlay, bootstrap, state)} />
				) : filteredCommands.length > 0 ? (
					<SlashPalette commands={filteredCommands} active={state.paletteIndex} />
				) : null}
				{!overlay && <PromptInput input={state.input} placeholder={placeholder} width={width} />}
				<StatusLine state={state} width={width} />
			</Box>
		</Box>
	);
}

function matchesExit(text: string) {
	return text === '/exit' || text === '/quit' || text === '/q';
}

function isShiftEnter(chunk: string, key: {return?: boolean; shift?: boolean}) {
	if (key.return && key.shift) {
		return true;
	}

	return (
		chunk === '\u001B\r' ||
		chunk === '\u001B\n' ||
		/^\u001B\[(?:10|13);2u$/.test(chunk) ||
		/^\u001B\[(?:10|13);2~$/.test(chunk) ||
		/^\u001B\[27;2;(?:10|13)~$/.test(chunk)
	);
}

function normalizeTextInput(chunk: string) {
	if (!chunk || chunk.includes('\u001B')) {
		return '';
	}

	return chunk
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

function renderHistory(messages: ChatMessage[]) {
	const output: Array<{kind: 'user' | 'assistant' | 'tool' | 'result' | 'info' | 'error'; text: string}> = [];
	const toolNames = new Map<string, string>();

	for (const message of messages) {
		switch (message.role) {
			case 'system':
				break;
			case 'user':
				if (message.content?.trim()) {
					output.push({kind: 'user', text: message.content});
				}
				break;
			case 'assistant':
				if (message.content?.trim()) {
					output.push({kind: 'assistant', text: message.content});
				}
				for (const call of message.tool_calls ?? []) {
					if (call.id && call.name) {
						toolNames.set(call.id, call.name);
					}
					if (call.name && call.name !== 'finish') {
						output.push({kind: 'tool', text: `● ${call.name} ${formatToolArguments(call.arguments)}`});
					}
				}
				break;
			case 'tool': {
				const tool = message.tool_call_id ? toolNames.get(message.tool_call_id) : '';
				if (tool === 'finish') {
					if (message.content?.trim()) {
						output.push({kind: 'assistant', text: finishText(message.content)});
					}
					break;
				}
				output.push({kind: 'result', text: `└ ${compactToolContent(message.content ?? '')}`});
				break;
			}
		}
	}

	return output;
}

function formatToolArguments(value: unknown) {
	if (value === undefined || value === null) {
		return '';
	}
	if (typeof value === 'string') {
		return truncateOneLine(value, 140);
	}
	return truncateOneLine(JSON.stringify(value), 140);
}

function compactToolContent(content: string) {
	try {
		const parsed = JSON.parse(content) as Record<string, unknown>;
		if (parsed.error) {
			return `error: ${String(parsed.error)}`;
		}
		for (const key of ['path', 'file', 'output', 'summary', 'status']) {
			if (parsed[key] !== undefined) {
				return truncateOneLine(`${key}: ${String(parsed[key])}`, 180);
			}
		}
	} catch {}
	return truncateOneLine(content, 180);
}

function finishText(content: string) {
	try {
		const parsed = JSON.parse(content) as {summary?: string};
		return parsed.summary?.trim() || content;
	} catch {
		return content;
	}
}

function truncateOneLine(text: string, max: number) {
	const oneLine = text.replace(/\s+/g, ' ').trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

function transcriptText(items: TranscriptItem[]) {
	return items
		.map(item => {
			const label = item.kind === 'assistant' ? 'assistant' : item.kind;
			return `[${label}] ${item.text}`;
		})
		.join('\n\n');
}

function runtimeCommand(bridge: RuntimeBridge | null, dispatch: Dispatch, run: (bridge: RuntimeBridge) => void) {
	if (!bridge || !bridge.isAvailable()) {
		dispatch({type: 'append', kind: 'error', text: 'runtime unavailable'});
		return;
	}
	run(bridge);
}

async function eventsCommand(workdir: string, sessionId: string, dispatch: Dispatch) {
	if (!workdir || !sessionId) {
		dispatch({type: 'append', kind: 'error', text: '/events: session is not ready'});
		return;
	}
	const events = await loadSessionEvents(workdir, sessionId, 20);
	if (events.length === 0) {
		dispatch({type: 'append', kind: 'info', text: '(no events recorded yet)'});
		return;
	}
	dispatch({
		type: 'append',
		kind: 'info',
		text: events
			.map(event => `${event.type ?? 'event'} step=${event.step ?? 0} tool=${event.tool ?? ''} space=${event.space_id ?? ''} status=${event.status ?? ''}`)
			.join('\n')
	});
}

async function spaceCommand(text: string, workdir: string, dispatch: Dispatch) {
	const [, id] = text.split(/\s+/, 2);
	if (!workdir || !id) {
		dispatch({type: 'append', kind: 'error', text: '/space: usage: /space <id>'});
		return;
	}
	const summary = await summarizeSpace(workdir, id);
	dispatch({
		type: 'append',
		kind: 'info',
		text: `${summary.meta.id} (${summary.meta.status ?? 'unknown'}): ${summary.meta.name ?? ''}\n  ${summary.decisions} decisions · ${summary.feedback} feedback · ${summary.episodes} episodes · ${summary.assets} assets`
	});
}

async function compactCommand(text: string, workdir: string, dispatch: Dispatch) {
	const [, id] = text.split(/\s+/, 2);
	if (!workdir || !id) {
		dispatch({type: 'append', kind: 'error', text: '/compact: usage: /compact <space-id>'});
		return;
	}
	const draft = await buildCompactionDraft(workdir, id);
	dispatch({type: 'append', kind: 'assistant', text: draft || '(empty compaction draft)'});
}

function parsePublishArgs(text: string): {file?: string; caption: string} {
	const rest = text.replace(/^\/publish\s*/, '');
	const fileMatch = rest.match(/--file\s+(\S+)\s*/);
	if (fileMatch && fileMatch.index !== undefined) {
		const file = fileMatch[1];
		const caption = (rest.slice(0, fileMatch.index) + rest.slice(fileMatch.index + fileMatch[0].length)).trim();
		return {file, caption};
	}
	return {caption: rest.trim()};
}

async function publishCommand(text: string, workdir: string, dispatch: Dispatch) {
	if (!workdir) {
		dispatch({type: 'append', kind: 'error', text: '/publish: no openmelon project here'});
		return;
	}
	const {file, caption} = parsePublishArgs(text);
	dispatch({type: 'append', kind: 'info', text: 'publishing to V-Box…'});
	try {
		const result = await publishToVbox({workdir, text: caption, file});
		const where = result.imageName ?? 'text-only';
		const id = result.contentId ? ` · ${result.contentId}` : '';
		dispatch({
			type: 'append',
			kind: 'info',
			text: `✓ submitted to V-Box review queue (${where})${id}\n  pending owner approval in the V-Box app`
		});
	} catch (error) {
		dispatch({type: 'append', kind: 'error', text: `/publish: ${(error as Error).message}`});
	}
}

async function applyModelCommand(
	text: string,
	bootstrap: BootstrapState,
	dispatch: Dispatch,
	reloadRuntime: () => void,
	refreshBootstrap: () => Promise<BootstrapState>
) {
	const parts = text.split(/\s+/);
	const model = parts[1]?.trim();
	if (!model) {
		dispatch({type: 'append', kind: 'error', text: '/model: usage: /model <model-id>'});
		return;
	}
	await applyModelDefaults(bootstrap, dispatch, reloadRuntime, refreshBootstrap, {
		provider: providerForSlug(bootstrap.provider).slug,
		model
	});
}

async function applyImageModelCommand(
	text: string,
	bootstrap: BootstrapState,
	dispatch: Dispatch,
	reloadRuntime: () => void,
	refreshBootstrap: () => Promise<BootstrapState>
) {
	const parts = text.split(/\s+/);
	const first = parts[1]?.trim();
	if (!first) {
		dispatch({
			type: 'append',
			kind: 'error',
			text: '/model-image: usage: /model-image <model-id> | /model-image <provider> <model-id> | /model-image off'
		});
		return;
	}
	if (['off', 'disable', 'none'].includes(first)) {
		await applyImageDefaults(bootstrap, dispatch, reloadRuntime, refreshBootstrap, {
			provider: '',
			model: ''
		});
		return;
	}

	let provider = imageProviderFor(bootstrap, stateFromBootstrap(bootstrap)).slug;
	let model = first;
	if (parts[2]) {
		provider = providerForSlug(first).slug;
		model = parts[2];
	}
	await applyImageDefaults(bootstrap, dispatch, reloadRuntime, refreshBootstrap, {provider, model});
}

async function applySettingsCommand(
	text: string,
	bootstrap: BootstrapState,
	dispatch: Dispatch,
	reloadRuntime: () => void,
	refreshBootstrap: () => Promise<BootstrapState>
) {
	const parts = text.split(/\s+/);
	const section = parts[1];
	const value = parts[2];
	if (!section || !value) {
		dispatch({
			type: 'append',
			kind: 'error',
			text: '/settings: usage: /settings bash strict|auto|trusted or /settings reasoning auto|medium|high|xhigh'
		});
		return;
	}
	if (!bootstrap.workdir) {
		dispatch({type: 'append', kind: 'error', text: 'project is not ready'});
		return;
	}
	const project = await loadProject(bootstrap.workdir);
	project.settings = project.settings ?? {};
	if (section === 'bash') {
		if (!['strict', 'auto', 'trusted'].includes(value)) {
			dispatch({type: 'append', kind: 'error', text: '/settings bash: expected strict|auto|trusted'});
			return;
		}
		project.settings.bash_permission_mode = value as 'strict' | 'auto' | 'trusted';
	} else if (section === 'reasoning') {
		if (!['auto', 'medium', 'high', 'xhigh'].includes(value)) {
			dispatch({type: 'append', kind: 'error', text: '/settings reasoning: expected auto|medium|high|xhigh'});
			return;
		}
		project.settings.reasoning_effort = value === 'auto' ? undefined : (value as ProjectSettings['reasoning_effort']);
	} else {
		dispatch({type: 'append', kind: 'error', text: '/settings: expected bash or reasoning'});
		return;
	}
	await saveProject(bootstrap.workdir, project);
	await refreshBootstrap();
	reloadRuntime();
	dispatch({
		type: 'append',
		kind: 'info',
		text: `(settings: bash=${project.settings.bash_permission_mode || 'strict'} reasoning=${project.settings.reasoning_effort || 'auto'})`
	});
}

function overlayView(overlay: Overlay, bootstrap: BootstrapState, state: TuiState) {
	if (overlay.kind === 'skill') {
		return {
			title: 'Select a skillplus package',
			description: overlay.error || 'Picked skill is applied to your next message. Pick (none) to clear.',
			rows: skillRows(overlay, state),
			active: overlay.cursor,
			footer: 'Enter to confirm · Esc to cancel · 1-N shortcut'
		};
	}
	if (overlay.kind === 'approval') {
		return {
			title: `Do you want to run ${overlay.tool}?`,
			description: [overlay.description, overlay.command].filter(Boolean).join('\n\n'),
			rows: approvalRows(overlay),
			active: overlay.cursor,
			footer: 'Enter to confirm · y=yes · n=no · Esc=no · 1/2/3 shortcut'
		};
	}
	if (overlay.kind === 'custom-model') {
		return {
			title: overlay.image ? 'Custom image model id' : 'Custom LLM model id',
			description: 'Type the vendor-specific model id, then press Enter.',
			rows: [
				{
					id: 'input',
					value: overlay.input,
					title: overlay.input ? `› ${overlay.input}▌` : '› ▌ vendor/model-id',
					subtitle: 'Enter to confirm · Esc to cancel'
				}
			],
			active: 0,
			footer: 'Enter to confirm · Esc to cancel'
		};
	}
	const rows = overlayRows(overlay, bootstrap, state);
	switch (overlay.kind) {
		case 'model':
			return {
				title: 'Select LLM model',
				description: 'Switch the model used by this and future turns. Persists to project.json.',
				rows,
				active: overlay.cursor,
				footer: 'Enter to confirm · Esc to cancel · 1-N shortcut'
			};
		case 'image-model':
			return {
				title: 'Select image model',
				description: 'Switch or disable the model used by generate_image. Persists to project.json.',
				rows,
				active: overlay.cursor,
				footer: 'Enter to confirm · Esc to cancel · 1-N shortcut'
			};
		case 'settings':
			return {
				title: 'Settings',
				description: 'Persists to project.json.',
				rows,
				active: overlay.cursor,
				footer: 'Enter to set · Esc to close · ↑/↓ select · 1-7 shortcut'
			};
	}
}

function overlayRows(overlay: Overlay, bootstrap: BootstrapState, state: TuiState): OverlayRow[] {
	if (overlay.kind === 'model') {
		const provider = providerForSlug(state.provider || bootstrap.provider);
		return [
			...provider.llmPresets.map(preset => ({
				id: preset.id,
				value: preset.id,
				title: preset.id,
				subtitle: preset.subtitle,
				checked: preset.id === state.model
			})),
			{id: 'custom', value: 'custom', title: 'Custom...', subtitle: 'Type a model id in project.json or use setup flags for now.'}
		];
	}
	if (overlay.kind === 'image-model') {
		let provider = imageProviderFor(bootstrap, state);
		if (!provider.imageProvider && provider.slug === 'anthropic') {
			provider = providerForSlug('openrouter');
		}
		return [
			{id: 'disable', value: '', provider: provider.slug, title: 'Disable image generation', checked: !bootstrapProjectImageModel(bootstrap)},
			...provider.imagePresets.map(preset => ({
				id: preset.id,
				value: preset.id,
				provider: provider.slug,
				title: preset.id,
				subtitle: preset.subtitle,
				checked: preset.id === bootstrapProjectImageModel(bootstrap)
			})),
			{id: 'custom', value: 'custom', provider: provider.slug, title: 'Custom...', subtitle: 'Type a model id in project.json or use setup flags for now.'}
		];
	}
	return settingsRows(bootstrap);
}

async function openSkillOverlay(setOverlay: React.Dispatch<React.SetStateAction<Overlay | null>>, dispatch: Dispatch) {
	try {
		const skills = await listSkills();
		setOverlay({kind: 'skill', cursor: 0, skills, error: skills.length === 0 ? 'No skillplus packages found.' : ''});
	} catch (error) {
		setOverlay({kind: 'skill', cursor: 0, skills: [], error: `error listing skills: ${(error as Error).message}`});
		dispatch({type: 'append', kind: 'error', text: `/skill: ${(error as Error).message}`});
	}
}

function skillRows(overlay: Extract<Overlay, {kind: 'skill'}>, state: TuiState): OverlayRow[] {
	const rows = overlay.skills.map(skill => ({
		id: skill.id,
		value: skill.id,
		title: skill.id + (skill.id === state.activeSkill ? ' ✓' : ''),
		subtitle: skill.description || skill.name || skill.source || ''
	}));
	return [
		...rows,
		{
			id: 'none',
			value: '',
			title: '(none)' + (state.activeSkill ? '' : ' ✓'),
			subtitle: "don't apply any skill"
		}
	];
}

function commitSkillRow(row: OverlayRow, dispatch: Dispatch) {
	dispatch({type: 'set-active-skill', skill: row.value});
	dispatch({
		type: 'append',
		kind: 'info',
		text: row.value ? `(skill: ${row.value}) — applies to your next message` : '(skill cleared)'
	});
}

function approvalRows(overlay: Extract<Overlay, {kind: 'approval'}>): OverlayRow[] {
	return [
		{id: 'yes', value: 'yes', title: 'Yes'},
		{id: 'always', value: 'always', title: `Yes, always allow \`${overlay.binary || 'this binary'}\` this session`},
		{id: 'no', value: 'no', title: 'No'}
	];
}

function answerApproval(bridge: RuntimeBridge | null, overlay: Extract<Overlay, {kind: 'approval'}>, index: number) {
	switch (index) {
		case 0:
			bridge?.approval(overlay.id, true, false);
			break;
		case 1:
			bridge?.approval(overlay.id, true, true);
			break;
		default:
			bridge?.approval(overlay.id, false, false);
			break;
	}
}

async function applyOverlaySelection(
	overlay: Overlay,
	row: OverlayRow,
	bootstrap: BootstrapState,
	dispatch: Dispatch,
	reloadRuntime: () => void,
	refreshBootstrap: () => Promise<BootstrapState>
) {
	if (row.disabled || row.section) {
		return;
	}
	if (!bootstrap.workdir) {
		dispatch({type: 'append', kind: 'error', text: 'project is not ready'});
		return;
	}
	if (row.value === 'custom') {
		dispatch({type: 'append', kind: 'info', text: 'custom model input is not wired yet; edit project defaults or run setup with flags.'});
		return;
	}
	if (overlay.kind === 'model') {
		const provider = providerForSlug(bootstrap.provider);
		await applyModelDefaults(bootstrap, dispatch, reloadRuntime, refreshBootstrap, {provider: provider.slug, model: row.value});
		return;
	}
	if (overlay.kind === 'image-model') {
		await applyImageDefaults(bootstrap, dispatch, reloadRuntime, refreshBootstrap, {
			provider: row.value ? row.provider || imageProviderFor(bootstrap, stateFromBootstrap(bootstrap)).slug : '',
			model: row.value
		});
		return;
	}
	if (overlay.kind === 'settings') {
		const project = await loadProject(bootstrap.workdir);
		project.settings = project.settings ?? {};
		if (row.id.startsWith('bash:')) {
			project.settings.bash_permission_mode = row.value as 'strict' | 'auto' | 'trusted';
		}
		if (row.id.startsWith('reasoning:')) {
			project.settings.reasoning_effort = (row.value || undefined) as ProjectSettings['reasoning_effort'];
		}
		await saveProject(bootstrap.workdir, project);
		dispatch({type: 'append', kind: 'info', text: `(settings updated: ${row.title})`});
		await refreshBootstrap();
		reloadRuntime();
	}
}

async function applyCustomModel(
	image: boolean,
	value: string,
	bootstrap: BootstrapState,
	dispatch: Dispatch,
	reloadRuntime: () => void,
	refreshBootstrap: () => Promise<BootstrapState>
) {
	await applyOverlaySelection(
		{kind: image ? 'image-model' : 'model', cursor: 0},
		{
			id: value,
			value,
			provider: image ? imageProviderFor(bootstrap, stateFromBootstrap(bootstrap)).slug : providerForSlug(bootstrap.provider).slug,
			title: value
		},
		bootstrap,
		dispatch,
		reloadRuntime,
		refreshBootstrap
	);
}

async function applyModelDefaults(
	bootstrap: BootstrapState,
	dispatch: Dispatch,
	reloadRuntime: () => void,
	refreshBootstrap: () => Promise<BootstrapState>,
	next: {provider: ProviderOption['slug']; model: string}
) {
	if (!bootstrap.workdir) {
		dispatch({type: 'append', kind: 'error', text: 'project is not ready'});
		return;
	}
	const project = await loadProject(bootstrap.workdir);
	project.defaults = project.defaults ?? {};
	project.defaults.llm_provider = next.provider;
	project.defaults.llm_model = next.model;
	await saveProject(bootstrap.workdir, project);
	await refreshBootstrap();
	reloadRuntime();
	dispatch({type: 'append', kind: 'info', text: `(LLM: ${composeModelTag(next.provider, next.model)})`});
}

async function applyImageDefaults(
	bootstrap: BootstrapState,
	dispatch: Dispatch,
	reloadRuntime: () => void,
	refreshBootstrap: () => Promise<BootstrapState>,
	next: {provider: string; model: string}
) {
	if (!bootstrap.workdir) {
		dispatch({type: 'append', kind: 'error', text: 'project is not ready'});
		return;
	}
	const project = await loadProject(bootstrap.workdir);
	project.defaults = project.defaults ?? {};
	project.defaults.image_provider = next.model ? next.provider : '';
	project.defaults.image_model = next.model;
	await saveProject(bootstrap.workdir, project);
	await refreshBootstrap();
	reloadRuntime();
	dispatch({
		type: 'append',
		kind: 'info',
		text: next.model ? `(image model: ${composeModelTag(next.provider, next.model)})` : '(image generation disabled)'
	});
}

function settingsRows(bootstrap: BootstrapState): OverlayRow[] {
	const settings = bootstrapProjectSettings(bootstrap);
	const bash = settings.bash_permission_mode || 'strict';
	const reasoning = settings.reasoning_effort || '';
	return [
		{id: 'bash:strict', value: 'strict', title: 'Strict', subtitle: 'Every bash needs your approval. Judge LLM auto-blocks destructive commands.', checked: bash === 'strict'},
		{id: 'bash:auto', value: 'auto', title: 'Auto-judge', subtitle: 'Read-only commands can run automatically; writes ask; destructive commands are blocked.', checked: bash === 'auto'},
		{id: 'bash:trusted', value: 'trusted', title: 'Trusted (DANGEROUS)', subtitle: 'Run any bash without asking. Use only in throwaway or fully trusted projects.', checked: bash === 'trusted'},
		{id: 'reasoning:auto', value: '', title: 'Auto', subtitle: 'Use OpenMelon model-aware default. GPT-5-family models default to xhigh.', checked: reasoning === ''},
		{id: 'reasoning:medium', value: 'medium', title: 'Medium', subtitle: 'Balanced reasoning depth for normal iteration.', checked: reasoning === 'medium'},
		{id: 'reasoning:high', value: 'high', title: 'High', subtitle: 'Deeper reasoning for planning, code, and tool-heavy tasks.', checked: reasoning === 'high'},
		{id: 'reasoning:xhigh', value: 'xhigh', title: 'XHigh', subtitle: 'Maximum reasoning hint when the endpoint supports it.', checked: reasoning === 'xhigh'}
	];
}

function providerForSlug(slug: string) {
	return providers.find(provider => provider.slug === slug) ?? providers[0]!;
}

function composeModelTag(provider: string, model: string) {
	return provider ? `${provider}:${model}` : model;
}

function imageProviderFor(bootstrap: BootstrapState, state: TuiState) {
	const projectImageProvider = bootstrapProjectImageProvider(bootstrap);
	return providerForSlug(projectImageProvider || state.provider || bootstrap.provider || 'openrouter');
}

function bootstrapProjectImageProvider(bootstrap: BootstrapState) {
	return bootstrap.project?.defaults?.image_provider ?? '';
}

function bootstrapProjectImageModel(bootstrap: BootstrapState) {
	return bootstrap.project?.defaults?.image_model ?? '';
}

function bootstrapProjectSettings(bootstrap: BootstrapState) {
	return bootstrap.project?.settings ?? {};
}

function stateFromBootstrap(bootstrap: BootstrapState): TuiState {
	return {
		...initialState(),
		model: bootstrap.model,
		reasoning: bootstrap.reasoning,
		project: bootstrap.projectId,
		provider: bootstrap.provider
	};
}
