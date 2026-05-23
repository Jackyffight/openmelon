// In-process runtime — the all-TS replacement for the Go `runtime-bridge`
// subprocess. Implements the same RuntimeBridge interface the Ink TUI already
// drives, so swapping createRuntimeBridge → createLocalRuntime in App.tsx
// removes Go from the runtime path entirely.
//
// Ported from cmd/openmelon/cmd_runtime_bridge.go (bridgeRuntime + bridgeTracer),
// minus stdin/stdout framing (events go straight to the emit callback) and minus
// bash approval (bash isn't ported yet; the approval() method is a no-op stub).

import {writeFile} from 'node:fs/promises';
import {discoverProject, loadProject, sessionOutputDir, type ProjectConfig} from '../core/project.js';
import {resolveProvider} from '../core/config.js';
import {createSession, loadSessionHistory, type ChatMessage, type WritableSession} from '../core/session.js';
import type {RuntimeBridge, RuntimeEvent, RuntimeBridgeOptions} from '../runtime/types.js';
import {Runtime, type Tracer} from './runtime.js';
import {newLLM} from './llm/factory.js';
import {newImageGenerator, type ImageGenerator} from './imagegen.js';
import {buildRegistry} from './tools/builtin.js';
import {judgeBashWithLLM, type ApprovalDecision, type BashMode} from './tools/bash.js';
import {buildProjectSystemPrompt, resolveDefaults, resolveReasoningEffort} from './systemPrompt.js';
import type {Message, ToolCall} from './llm/types.js';

const maxSteps = 24;

type Emit = (event: RuntimeEvent) => void;

export function createLocalRuntime(emit: Emit, options: RuntimeBridgeOptions = {}): RuntimeBridge {
	const engine = new LocalEngine(emit, options.resumeId);
	void engine.init();
	return {
		isAvailable: () => engine.isAvailable(),
		run: text => engine.run(text),
		pending: text => engine.addPending(text),
		cancel: () => engine.cancel(),
		clearHistory: () => engine.clearHistory(),
		history: () => engine.emitHistory(),
		save: path => void engine.save(path),
		reload: () => void engine.reload(),
		approval: (id, approved, always) => engine.answerApproval(id, approved, always),
		shutdown: () => engine.shutdown()
	};
}

class LocalEngine {
	private ready = false;
	private closed = false;
	private running = false;
	private workdir = '';
	private project: ProjectConfig | undefined;
	private runtime: Runtime | undefined;
	private session: WritableSession | undefined;
	private systemPrompt = '';
	private history: Message[] = [];
	private persisted = 0;
	private pending: string[] = [];
	private controller: AbortController | undefined;
	private readonly allowedBins = new Set<string>();
	private readonly approvals = new Map<string, (decision: ApprovalDecision) => void>();
	private approvalSeq = 0;

	constructor(
		private readonly emit: Emit,
		private readonly resumeId?: string
	) {}

	isAvailable(): boolean {
		return !this.closed;
	}

	async init(): Promise<void> {
		try {
			const workdir = await discoverProject();
			if (!workdir) {
				throw new Error('no openmelon project found — run `openmelon init` or `openmelon setup` first');
			}
			this.workdir = workdir;
			const project = await loadProject(workdir);
			this.project = project;

			const defaults = await resolveDefaults(project);
			const llmProvider = defaults.llmProvider || 'auto';
			const imageProvider = defaults.imageProvider || 'openrouter';

			const llmCreds = llmProvider === 'auto' ? {apiKey: '', baseURL: ''} : await resolveProvider(workdir, llmProvider);
			const llm = newLLM(llmProvider, llmCreds.apiKey, llmCreds.baseURL, defaults.llmModel);

			let imageGen: ImageGenerator | undefined;
			if (defaults.imageModel) {
				try {
					const imgCreds = await resolveProvider(workdir, imageProvider);
					imageGen = newImageGenerator(imageProvider, imgCreds.apiKey, imgCreds.baseURL, defaults.imageModel);
				} catch (error) {
					this.emit({type: 'append', kind: 'error', text: `image generation disabled: ${(error as Error).message}`});
				}
			}

			const session = await createSession(workdir, project.id, `ts tui ${new Date().toISOString()}`, this.resumeId);
			await session.setRuntimeInfo(llm.provider(), llm.model());
			this.session = session;

			const registry = buildRegistry({
				workdir,
				project,
				outputDir: sessionOutputDir(workdir, session.id),
				imageGen,
				bashMode: (project.settings?.bash_permission_mode as BashMode) ?? 'strict',
				isBashAllowed: binary => this.allowedBins.has(binary),
				allowBash: binary => this.allowedBins.add(binary),
				judgeBash: judgeBashWithLLM(llm),
				approve: req => this.requestApproval(req)
			});
			this.systemPrompt = buildProjectSystemPrompt(project, registry.names());

			this.runtime = new Runtime({
				llm,
				registry,
				tracer: this.tracer(),
				maxSteps,
				reasoningEffort: await resolveReasoningEffort(project, llm.provider(), llm.model()),
				drainUserInput: () => this.drainPending()
			});

			if (this.resumeId) {
				const prior = await loadSessionHistory(workdir, this.resumeId).catch(() => []);
				this.history = prior.map(fromDiskMessage);
				this.persisted = this.history.length;
			}

			this.ready = true;
			this.emit({
				type: 'ready',
				status: 'ready',
				activity: 'Ready',
				sessionId: session.id,
				sessionDir: session.dir,
				model: llm.model(),
				provider: llm.provider(),
				reasoning: this.runtime.reasoningEffort,
				project: project.id
			});
		} catch (error) {
			const msg = (error as Error).message;
			this.emit({type: 'append', kind: 'error', text: msg});
			this.emit({type: 'status', status: 'error', activity: 'Runtime unavailable'});
		}
	}

	run(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) {
			return;
		}
		if (!this.ready || !this.runtime || !this.session) {
			this.emit({type: 'append', kind: 'error', text: 'runtime not ready'});
			this.emit({type: 'done'});
			return;
		}
		if (this.running) {
			this.addPending(trimmed);
			this.emit({type: 'append', kind: 'info', text: 'queued pending input'});
			return;
		}
		void this.runTurn(trimmed);
	}

	private async runTurn(text: string): Promise<void> {
		this.running = true;
		this.controller = new AbortController();
		try {
			const result = await this.runtime!.run(
				{systemPrompt: this.systemPrompt, userInput: text, history: this.history},
				this.controller.signal
			);
			this.history = result.messages;
			if (this.persisted < this.history.length) {
				await this.session!.appendMessages(this.history.slice(this.persisted).map(toDiskMessage));
				this.persisted = this.history.length;
			}
			await this.session!.writeSummary(result.finishSummary ?? '', result.finishArtifacts ?? [], result.finished);
			this.emit({type: 'status', status: 'ready', activity: 'Ready'});
			this.emit({type: 'done'});
		} catch (error) {
			const msg = (error as Error).message;
			this.emit({type: 'append', kind: 'error', text: msg});
			this.emit({type: 'status', status: 'error', activity: 'Error'});
			this.emit({type: 'done'});
		} finally {
			this.running = false;
			this.controller = undefined;
		}
		const next = this.takePendingJoined();
		if (next) {
			void this.runTurn(next);
		}
	}

	private tracer(): Tracer {
		return {
			onTurnStart: turn => this.emit({type: 'status', status: 'thinking', activity: `Thinking step ${turn}`}),
			onText: delta => this.emit({type: 'append', kind: 'assistant', text: delta}),
			onToolCall: call => {
				if (call.name === 'finish') {
					return;
				}
				this.emit({type: 'append', kind: 'tool', text: `● ${call.name}  ${call.arguments.trim()}`});
				this.emit({type: 'status', status: 'tool', activity: `Calling ${call.name}`});
			},
			onToolResult: (call, content, err) => {
				if (call.name === 'finish') {
					this.emit({type: 'append', kind: 'assistant', text: finishSummary(content)});
					return;
				}
				if (err) {
					this.emit({type: 'append', kind: 'error', text: `└ error: ${err.message}`});
				} else {
					this.emit({type: 'append', kind: 'result', text: `└ ${compactToolResult(content)}`});
				}
			},
			onTurnEnd: (_turn, _finish, usage) =>
				this.emit({
					type: 'usage',
					promptTokens: usage.promptTokens,
					completionTokens: usage.completionTokens,
					totalTokens: usage.totalTokens
				})
		};
	}

	addPending(text: string): void {
		const trimmed = text.trim();
		if (trimmed) {
			this.pending.push(trimmed);
		}
	}

	private drainPending(): string[] {
		const out = this.pending;
		this.pending = [];
		return out;
	}

	private takePendingJoined(): string {
		const drained = this.drainPending();
		return drained.length > 0 ? drained.join('\n\n') : '';
	}

	/** Emit an approval request and resolve when the TUI answers (or after 10 min → denied). */
	private requestApproval(req: {tool: string; command: string; description: string; binary: string}): Promise<ApprovalDecision> {
		this.approvalSeq += 1;
		const id = `approval-${this.approvalSeq}`;
		return new Promise<ApprovalDecision>(resolve => {
			let done = false;
			const settle = (decision: ApprovalDecision) => {
				if (done) {
					return;
				}
				done = true;
				this.approvals.delete(id);
				resolve(decision);
			};
			this.approvals.set(id, settle);
			this.emit({
				type: 'approval',
				activity: `Approve ${req.tool}`,
				detail: {id, tool: req.tool, command: req.command, description: req.description, binary: req.binary}
			});
			setTimeout(() => settle({approved: false, always: false}), 10 * 60_000);
		});
	}

	/** Called by the TUI when the user answers an approval modal. */
	answerApproval(id: string, approved: boolean, always: boolean): void {
		this.approvals.get(id)?.({approved, always});
	}

	cancel(): void {
		this.controller?.abort();
	}

	clearHistory(): void {
		this.history = [];
		this.persisted = 0;
		this.emit({type: 'append', kind: 'info', text: '(history cleared)'});
	}

	emitHistory(): void {
		if (this.history.length === 0) {
			this.emit({type: 'append', kind: 'info', text: '(no conversation history)'});
			return;
		}
		const lines = this.history.map((m, i) => {
			const label = m.toolCalls && m.toolCalls.length > 0 ? `${m.role} → tool_calls` : m.role;
			let body = (m.content ?? '').replace(/\n/g, ' ');
			if (body.length > 200) {
				body = body.slice(0, 200) + '…';
			}
			return `  [${i}] ${label}: ${body}`;
		});
		this.emit({type: 'append', kind: 'info', text: lines.join('\n')});
	}

	async save(path: string): Promise<void> {
		const target = path.trim();
		if (!target) {
			this.emit({type: 'append', kind: 'error', text: '/save: usage: /save <path>'});
			return;
		}
		try {
			const body = this.history.map(m => JSON.stringify(toDiskMessage(m))).join('\n') + '\n';
			await writeFile(target, body);
			this.emit({type: 'append', kind: 'info', text: `saved ${this.history.length} messages → ${target}`});
		} catch (error) {
			this.emit({type: 'append', kind: 'error', text: `/save: ${(error as Error).message}`});
		}
	}

	async reload(): Promise<void> {
		if (this.running) {
			this.emit({type: 'append', kind: 'error', text: 'cannot reload while a turn is running'});
			return;
		}
		this.ready = false;
		await this.init();
	}

	shutdown(): void {
		this.cancel();
		this.closed = true;
	}
}

// --- engine.Message ↔ on-disk ChatMessage (snake_case, raw-JSON args) ---

function toDiskMessage(m: Message): ChatMessage {
	const out: ChatMessage = {role: m.role};
	if (m.content !== undefined) {
		out.content = m.content;
	}
	if (m.toolCallId) {
		out.tool_call_id = m.toolCallId;
	}
	if (m.toolCalls && m.toolCalls.length > 0) {
		out.tool_calls = m.toolCalls.map(tc => ({id: tc.id, name: tc.name, arguments: parseArgs(tc.arguments)}));
	}
	return out;
}

function fromDiskMessage(c: ChatMessage): Message {
	const out: Message = {role: c.role, content: c.content ?? ''};
	if (c.tool_call_id) {
		out.toolCallId = c.tool_call_id;
	}
	if (c.tool_calls && c.tool_calls.length > 0) {
		out.toolCalls = c.tool_calls.map(
			(tc): ToolCall => ({
				id: tc.id ?? '',
				name: tc.name ?? '',
				arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments ?? {})
			})
		);
	}
	return out;
}

function parseArgs(raw: string): unknown {
	try {
		return JSON.parse(raw || '{}');
	} catch {
		return raw;
	}
}

// --- tracer text helpers (ported from cmd_runtime_bridge.go) ---

function compactToolResult(content: string): string {
	let obj: Record<string, unknown> | undefined;
	try {
		const parsed = JSON.parse(content);
		obj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return truncate(content, 220);
	}
	if (!obj) {
		return truncate(content, 220);
	}
	if ('error' in obj) {
		return `error: ${String(obj['error'])}`;
	}
	for (const key of ['path', 'file', 'output', 'summary', 'status']) {
		if (key in obj) {
			return truncate(`${key}: ${String(obj[key])}`, 220);
		}
	}
	return truncate(content, 220);
}

function finishSummary(content: string): string {
	try {
		const obj = JSON.parse(content) as {summary?: unknown};
		if (typeof obj.summary === 'string' && obj.summary.trim()) {
			return obj.summary;
		}
	} catch {
		/* fall through */
	}
	return content;
}

function truncate(s: string, n: number): string {
	const collapsed = s.split(/\s+/).filter(Boolean).join(' ');
	return collapsed.length <= n ? collapsed : collapsed.slice(0, n) + '…';
}
