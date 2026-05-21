import path from 'node:path';
import {findProjectApproval, recordProjectApproval} from '../core/approvals.js';
import {outputsDir} from '../core/project.js';
import {loadSessionHistory} from '../core/session.js';
import {buildNativeTools} from './nativeTools.js';
import {buildSystemPrompt, loadNativeRuntimeBootstrap} from './nativeConfig.js';
import {streamChat} from './openaiCompat.js';
import {appendEvent, appendMessages, appendPrompt, createNativeSession, openNativeSession, setRuntimeInfo, writeSummary, type NativeSession} from './sessionStore.js';
import type {RuntimeClient, RuntimeClientOptions, RuntimeEventHandler} from './protocol.js';
import type {ChatMessage, NativeRuntimeContext, NativeTool, ToolCall} from './nativeTypes.js';

const maxSteps = 24;
type NativeRuntimeBoot = Awaited<ReturnType<typeof loadNativeRuntimeBootstrap>>;

export function createNativeRuntimeClient(emit: RuntimeEventHandler, options: RuntimeClientOptions = {}): RuntimeClient {
	let closed = false;
	let running = false;
	let controller: AbortController | null = null;
	let boot: NativeRuntimeBoot | null = null;
	let context: NativeRuntimeContext | null = null;
	let session: NativeSession | null = null;
	let history: ChatMessage[] = [];
	let persisted = 0;
	let tools: NativeTool[] = [];
	let systemPrompt = '';
	const pending: string[] = [];
	const approvals = new Map<string, (decision: {approved: boolean; always: boolean}) => void>();
	const alwaysApprovedBinaries = new Set<string>();
	let approvalSeq = 0;

	const ready = (async () => {
		boot = await loadNativeRuntimeBootstrap();
		if (options.resumeId) {
			try {
				history = (await loadSessionHistory(boot.workdir, options.resumeId)) as ChatMessage[];
				persisted = history.length;
				session = await openNativeSession(boot.workdir, options.resumeId);
				await setRuntimeInfo(session, boot.llm.provider, boot.llm.model);
				context = buildContext(boot, session);
				rebuildToolsAndPrompt();
			} catch (error) {
				history = [];
				persisted = 0;
				rebuildToolsAndPrompt();
				emit({type: 'append', kind: 'info', text: `resume ${options.resumeId} unavailable; starting a new session on first input. ${(error as Error).message}`});
			}
		} else {
			rebuildToolsAndPrompt();
		}
		emit({
			type: 'ready',
			status: 'ready',
			activity: 'Ready',
			...sessionReadyInfo(),
			model: boot.llm.model,
			reasoning: boot.llm.reasoning,
			project: boot.project.id,
			provider: boot.llm.provider
		});
		if (options.initialPrompt?.trim()) {
			queueMicrotask(() => start(options.initialPrompt!.trim()));
		}
	})().catch(error => {
		emit({type: 'append', kind: 'error', text: (error as Error).message});
		emit({type: 'status', status: 'error', activity: 'Runtime unavailable'});
		closed = true;
	});

	async function start(text: string) {
		await ready;
		if (closed) {
			return;
		}
		if (running) {
			pending.push(text);
			if (session) {
				await appendPrompt(session, 'pending', text);
			}
			return;
		}
		await ensureSession(text);
		if (!context || !session) {
			throw new Error('native runtime not initialized');
		}
		running = true;
		controller = new AbortController();
		await appendPrompt(session, 'user', text);
		try {
			const result = await runLoop(text, controller.signal);
			history = result.messages;
			await writeSummary(session, result.summary, result.artifacts, result.finished);
			emit({type: 'status', status: 'ready', activity: 'Ready'});
			emit({type: 'done'});
		} catch (error) {
			if (controller.signal.aborted || (error as Error).name === 'AbortError') {
				emit({type: 'append', kind: 'error', text: 'interrupted'});
				emit({type: 'status', status: 'error', activity: 'Interrupted'});
				emit({type: 'done'});
			} else {
				emit({type: 'append', kind: 'error', text: (error as Error).message});
				emit({type: 'status', status: 'error', activity: 'Error'});
				emit({type: 'done'});
			}
		} finally {
			running = false;
			controller = null;
		}

		const next = drainPending().join('\n\n').trim();
		if (next && !closed) {
			void start(next);
		}
	}

	async function runLoop(userInput: string, signal: AbortSignal) {
		if (!context || !session) {
			throw new Error('native runtime not initialized');
		}
		let messages = history.length > 0 ? [...history] : [{role: 'system' as const, content: systemPrompt}];
		if (userInput.trim()) {
			const userMessage: ChatMessage = {role: 'user', content: userInput.trim()};
			messages.push(userMessage);
			await persistMessages([userMessage]);
		}
		let summary = '';
		let artifacts: string[] = [];
		let finished = false;

		for (let step = 1; step <= maxSteps; step++) {
			const drained = drainPending();
			for (const item of drained) {
				messages.push({role: 'user', content: item});
			}
			emit({type: 'status', status: 'thinking', activity: `Thinking step ${step}`});
			await appendEvent(session, 'model_request', {step, status: 'before', detail: {messages: messages.length, tools: tools.length}});
			const response = await streamChat(context.llm, messages, tools.map(tool => tool.spec), signal, {
				onText(delta) {
					emit({type: 'append', kind: 'assistant', text: delta, delta: true, markdown: true});
				}
			});
			messages.push(response.message);
			await persistMessages([response.message]);
			await appendEvent(session, 'model_response', {
				step,
				status: response.finish_reason,
				detail: {
					tool_calls: response.message.tool_calls?.length ?? 0,
					content_chars: response.message.content?.length ?? 0,
					prompt_tokens: response.usage.prompt_tokens ?? 0,
					completion_tokens: response.usage.completion_tokens ?? 0
				}
			});
			emit({type: 'usage', promptTokens: response.usage.prompt_tokens ?? 0, completionTokens: response.usage.completion_tokens ?? 0, totalTokens: response.usage.total_tokens ?? 0});

			const calls = response.message.tool_calls ?? [];
			if (calls.length === 0) {
				finished = response.finish_reason === 'stop' || response.finish_reason === 'other';
				return {messages, summary, artifacts, finished};
			}

			for (const call of calls) {
				const output = await dispatchTool(call, step, signal);
				const content = JSON.stringify(output);
				const toolMessage: ChatMessage = {role: 'tool', tool_call_id: call.id, content};
				messages.push(toolMessage);
				await persistMessages([toolMessage]);
				if (call.name === 'finish' && !isErrorResult(output)) {
					const result = output as {summary?: string; artifacts?: string[]};
					summary = result.summary ?? '';
					artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
					finished = true;
				}
			}
			if (finished) {
				return {messages, summary, artifacts, finished};
			}
		}
		throw new Error(`runtime: hit MaxSteps=${maxSteps} without finishing`);
	}

	async function dispatchTool(call: ToolCall, step: number, signal: AbortSignal) {
		if (!session) {
			throw new Error('native runtime not initialized');
		}
		const tool = tools.find(candidate => candidate.spec.name === call.name);
		if (!tool) {
			return {error: `unknown tool ${call.name}`};
		}
		if (call.name !== 'finish') {
			emit({type: 'append', kind: 'tool', text: formatToolCall(call)});
			emit({type: 'status', status: 'tool', activity: `Calling ${call.name}`});
		}
		await appendEvent(session, 'tool_call', {step, tool: call.name, status: 'before', detail: {tool_call_id: call.id}});
		let result: unknown;
		let status = 'ok';
		try {
			result = await tool.dispatch(call.arguments, signal);
			if (isErrorResult(result)) {
				status = 'error';
			}
		} catch (error) {
			status = 'error';
			result = {error: (error as Error).message};
		}
		await appendEvent(session, 'tool_result', {step, tool: call.name, status, detail: {tool_call_id: call.id, content_chars: JSON.stringify(result).length}});
		if (call.name !== 'finish') {
			const kind = status === 'error' ? 'error' : 'result';
			emit({type: 'append', kind, text: compactToolResult(result)});
		}
		return result;
	}

	function drainPending() {
		const out = pending.splice(0);
		if (out.length > 0) {
			emit({type: 'pending-applied', count: out.length});
		}
		return out;
	}

	function approvalRequest(req: {id: string; tool: string; command: string; description: string; binary: string}) {
		if (req.tool === 'bash' && req.binary && alwaysApprovedBinaries.has(req.binary)) {
			return Promise.resolve({approved: true, always: true});
		}
		if (context) {
			return findProjectApproval(context.workdir, req).then(rule => {
				if (rule) {
					alwaysApprovedBinaries.add(req.binary);
					return {approved: true, always: true};
				}
				return promptApproval(req);
			});
		}
		return promptApproval(req);
	}

	function promptApproval(req: {id: string; tool: string; command: string; description: string; binary: string}) {
		const id = `approval-${++approvalSeq}`;
		return new Promise<{approved: boolean; always: boolean}>(resolve => {
			approvals.set(id, decision => {
				if (decision.approved && decision.always && req.tool === 'bash' && req.binary) {
					alwaysApprovedBinaries.add(req.binary);
					if (context) {
						void recordProjectApproval(context.workdir, req);
					}
				}
				resolve(decision);
			});
			emit({type: 'approval', activity: `Approve ${req.tool}`, detail: {...req, id}});
		});
	}

	async function persistMessages(messages: ChatMessage[]) {
		if (!session || messages.length === 0) {
			return;
		}
		await appendMessages(session, messages);
	}

	function sessionReadyInfo() {
		const current = session as NativeSession | null;
		return {
			sessionId: current?.id,
			sessionDir: current?.dir
		};
	}

	return {
		isAvailable() {
			return !closed;
		},
		run(text: string) {
			void start(text);
		},
		pending(text: string) {
			if (text.trim()) {
				pending.push(text.trim());
			}
		},
		cancel() {
			controller?.abort();
		},
		clearHistory() {
			history = [];
			persisted = 0;
			emit({type: 'append', kind: 'info', text: '(history cleared)'});
		},
		history() {
			if (history.length === 0) {
				emit({type: 'append', kind: 'info', text: '(no conversation history)'});
				return;
			}
			emit({
				type: 'append',
				kind: 'info',
				text: history.map((message, index) => `  [${index}] ${message.role}: ${truncate((message.content ?? '').replace(/\s+/g, ' '), 200)}`).join('\n')
			});
		},
		save(filePath: string) {
			void (async () => {
				const {promises: fs} = await import('node:fs');
				await fs.writeFile(filePath, history.map(message => JSON.stringify(message)).join('\n') + '\n');
				emit({type: 'append', kind: 'info', text: `saved ${history.length} messages -> ${filePath}`});
			})().catch(error => emit({type: 'append', kind: 'error', text: `/save: ${(error as Error).message}`}));
		},
		reload() {
			void reloadRuntime();
		},
		approval(id: string, approved: boolean, always: boolean) {
			const resolve = approvals.get(id);
			approvals.delete(id);
			resolve?.({approved, always});
		},
		shutdown() {
			closed = true;
			controller?.abort();
			for (const [id, resolve] of approvals) {
				approvals.delete(id);
				resolve({approved: false, always: false});
			}
		}
		};

	async function ensureSession(intent: string) {
		if (session) {
			return session;
		}
		if (!boot) {
			throw new Error('native runtime bootstrap not initialized');
		}
		const nextSession = await createNativeSession(
			boot.workdir,
			boot.project.id,
			intent.trim() || `ts native runtime ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
		);
		await setRuntimeInfo(nextSession, boot.llm.provider, boot.llm.model);
		session = nextSession;
		context = buildContext(boot, nextSession);
		rebuildToolsAndPrompt();
		emit({
			type: 'ready',
			status: 'ready',
			activity: 'Ready',
			sessionId: nextSession.id,
			sessionDir: nextSession.dir,
			model: boot.llm.model,
			reasoning: boot.llm.reasoning,
			project: boot.project.id,
			provider: boot.llm.provider
		});
		return nextSession;
	}

	function buildContext(boot: NativeRuntimeBoot, nextSession: NativeSession): NativeRuntimeContext {
		return {
			workdir: boot.workdir,
			projectId: boot.project.id,
			projectName: boot.project.name,
			projectDescription: boot.project.description ?? '',
			projectPersona: boot.project.persona ?? '',
			projectConstraints: boot.project.constraints ?? [],
			bashMode: boot.bashMode,
			llm: boot.llm,
			image: boot.image,
			sessionId: nextSession.id,
			sessionDir: nextSession.dir,
			outputDir: path.join(outputsDir(boot.workdir), 'sessions', nextSession.id),
			approve: approvalRequest
		};
	}

	function rebuildToolsAndPrompt() {
		if (!boot && !context) {
			return;
		}
		if (!context && boot) {
			systemPrompt = buildSystemPrompt(
				{
					projectId: boot.project.id,
					projectName: boot.project.name,
					projectDescription: boot.project.description ?? '',
					projectPersona: boot.project.persona ?? '',
					projectConstraints: boot.project.constraints ?? []
				},
				[]
			);
			return;
		}
		const currentContext = context;
		if (!currentContext) {
			return;
		}
		tools = buildNativeTools(currentContext);
		systemPrompt = buildSystemPrompt(currentContext, tools.map(tool => tool.spec.name));
	}

	async function reloadRuntime() {
		await ready;
		if (!boot) {
			return;
		}
		if (running) {
			emit({type: 'append', kind: 'error', text: 'reload: cannot reload while a turn is running'});
			return;
		}
		try {
			boot = await loadNativeRuntimeBootstrap();
			if (session) {
				context = buildContext(boot, session);
				await setRuntimeInfo(session, boot.llm.provider, boot.llm.model);
			}
			rebuildToolsAndPrompt();
			emit({
				type: 'ready',
				status: 'ready',
				activity: 'Ready',
				sessionId: session?.id,
				sessionDir: session?.dir,
				model: boot.llm.model,
				reasoning: boot.llm.reasoning,
				project: boot.project.id,
				provider: boot.llm.provider
			});
		} catch (error) {
			emit({type: 'append', kind: 'error', text: `reload: ${(error as Error).message}`});
			emit({type: 'status', status: 'error', activity: 'Reload failed'});
		}
	}
}

function isErrorResult(value: unknown) {
	return Boolean(value && typeof value === 'object' && 'error' in value && (value as {error?: unknown}).error);
}

function compactToolResult(value: unknown) {
	if (isErrorResult(value)) {
		return `error: ${String((value as {error: unknown}).error)}`;
	}
	if (value && typeof value === 'object') {
		const obj = value as Record<string, unknown>;
		for (const key of ['path', 'file', 'output', 'summary', 'status']) {
			if (obj[key] !== undefined) {
				return truncate(`${key}: ${String(obj[key])}`, 220);
			}
		}
	}
	return truncate(JSON.stringify(value), 220);
}

function formatToolCall(call: ToolCall) {
	const args = compactToolArgs(call.arguments);
	return args ? `${call.name}  ${args}` : call.name;
}

function compactToolArgs(value: unknown) {
	if (!value || typeof value !== 'object') {
		return value === undefined || value === null ? '' : truncate(String(value), 140);
	}
	const obj = value as Record<string, unknown>;
	const preferred = ['query', 'space_id', 'path', 'name', 'title', 'output_path', 'prompt'];
	const parts: string[] = [];
	for (const key of preferred) {
		if (obj[key] !== undefined) {
			parts.push(`${key}: ${compactArgValue(obj[key])}`);
		}
	}
	for (const [key, raw] of Object.entries(obj)) {
		if (parts.length >= 3) {
			break;
		}
		if (preferred.includes(key)) {
			continue;
		}
		parts.push(`${key}: ${compactArgValue(raw)}`);
	}
	return truncate(parts.join(' · '), 180);
}

function compactArgValue(value: unknown) {
	if (Array.isArray(value)) {
		return `[${value.length}]`;
	}
	if (value && typeof value === 'object') {
		return '{...}';
	}
	return JSON.stringify(value ?? '').replace(/^"|"$/g, '');
}

function truncate(value: string, max: number) {
	const oneLine = value.replace(/\s+/g, ' ').trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
}
