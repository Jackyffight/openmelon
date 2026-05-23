// Headless one-shot agent run (`openmelon -p "<intent>"`), ported from
// cmd/openmelon/agent_runtime.go. Same engine as the TUI (localRuntime), but
// runs a single Runtime turn without Ink, streaming progress to stderr.
//
// Bash: judge LLM is wired, but there's no approval modal — strict mode will
// error per-call on ASK commands; use bash_permission_mode auto/trusted in
// project.json for headless bash.

import {discoverProject, loadProject, sessionOutputDir, type ProjectConfig} from '../core/project.js';
import {resolveProvider} from '../core/config.js';
import {createSession, type ChatMessage} from '../core/session.js';
import {Runtime} from '../engine/runtime.js';
import {newLLM} from '../engine/llm/factory.js';
import {newImageGenerator, type ImageGenerator} from '../engine/imagegen.js';
import {buildRegistry} from '../engine/tools/builtin.js';
import {judgeBashWithLLM, type BashMode} from '../engine/tools/bash.js';
import {buildProjectSystemPrompt, resolveDefaults, resolveReasoningEffort} from '../engine/systemPrompt.js';
import type {Message} from '../engine/llm/types.js';

type HeadlessOptions = {
	intent: string;
	imageEnabled: boolean;
	llmProvider?: string;
	llmModel?: string;
	imageModel?: string;
};

/** Parse `-p <intent>` + headless flags from argv. Returns null if -p absent. */
export function parseHeadless(argv: string[]): HeadlessOptions | null {
	let intent = '';
	let imageEnabled = true;
	let llmProvider: string | undefined;
	let llmModel: string | undefined;
	let imageModel: string | undefined;
	let hasP = false;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		const eq = a.indexOf('=');
		const name = eq >= 0 ? a.slice(0, eq) : a;
		const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
		const next = () => inline ?? argv[++i] ?? '';
		switch (name) {
			case '-p':
			case '--prompt':
				hasP = true;
				intent = next();
				break;
			case '--image':
				imageEnabled = (inline ?? 'true') !== 'false';
				break;
			case '--llm':
				llmProvider = next();
				break;
			case '--llm-model':
				llmModel = next();
				break;
			case '--image-model':
				imageModel = next();
				break;
			default:
				if (!a.startsWith('-') && hasP && !intent) {
					intent = a;
				}
		}
	}
	if (!hasP) {
		return null;
	}
	return {intent, imageEnabled, llmProvider, llmModel, imageModel};
}

export async function runHeadless(opts: HeadlessOptions): Promise<void> {
	const intent = opts.intent.trim();
	if (!intent) {
		throw new Error('usage: openmelon -p "<intent>"');
	}
	const workdir = await discoverProject();
	if (!workdir) {
		throw new Error('-p requires an openmelon project — run `openmelon init` first');
	}
	const project: ProjectConfig = await loadProject(workdir);

	const defaults = await resolveDefaults(project);
	const llmProvider = opts.llmProvider || defaults.llmProvider || 'auto';
	const llmModel = opts.llmModel || defaults.llmModel;
	const imageProvider = defaults.imageProvider || 'openrouter';
	const imageModel = opts.imageModel || defaults.imageModel;

	const llmCreds = llmProvider === 'auto' ? {apiKey: '', baseURL: ''} : await resolveProvider(workdir, llmProvider);
	const llm = newLLM(llmProvider, llmCreds.apiKey, llmCreds.baseURL, llmModel);

	let imageGen: ImageGenerator | undefined;
	if (opts.imageEnabled && imageModel) {
		const imgCreds = await resolveProvider(workdir, imageProvider);
		imageGen = newImageGenerator(imageProvider, imgCreds.apiKey, imgCreds.baseURL, imageModel);
	}

	const session = await createSession(workdir, project.id, intent);
	await session.setRuntimeInfo(llm.provider(), llm.model());

	const registry = buildRegistry({
		workdir,
		project,
		outputDir: sessionOutputDir(workdir, session.id),
		imageGen,
		bashMode: (project.settings?.bash_permission_mode as BashMode) ?? 'strict',
		judgeBash: judgeBashWithLLM(llm)
		// no `approve`: ASK-tier bash errors per-call in headless (matches Go)
	});

	const runtime = new Runtime({
		llm,
		registry,
		maxSteps: 24,
		reasoningEffort: await resolveReasoningEffort(project, llm.provider(), llm.model()),
		tracer: {
			onToolCall: call => {
				if (call.name !== 'finish') {
					process.stderr.write(`  ● ${call.name} ${call.arguments.trim()}\n`);
				}
			},
			onToolResult: (call, content, err) => {
				if (call.name === 'finish') {
					return;
				}
				process.stderr.write(err ? `    └ error: ${err.message}\n` : `    └ ${oneLine(content, 200)}\n`);
			},
			onText: delta => process.stderr.write(delta)
		}
	});

	let info = `[openmelon] project=${project.id} session=${session.id} llm=${llm.provider()}/${llm.model()}`;
	if (imageGen) {
		info += ` image=${imageGen.provider()}/${imageGen.model()}`;
	}
	process.stderr.write(info + '\n');
	process.stderr.write(`[openmelon] intent: ${intent}\n`);

	const result = await runtime.run({systemPrompt: buildProjectSystemPrompt(project, registry.names()), userInput: intent});
	await session.appendMessages(result.messages.map(toDiskMessage));
	await session.writeSummary(result.finishSummary ?? '', result.finishArtifacts ?? [], result.finished);

	if (result.finishSummary) {
		process.stderr.write(`\n[openmelon] ${result.finishSummary}\n`);
	}
	for (const artifact of result.finishArtifacts ?? []) {
		process.stderr.write(`[openmelon] artifact: ${artifact}\n`);
	}
	process.stderr.write(`[openmelon] session: ${session.dir}\n`);
}

function toDiskMessage(m: Message): ChatMessage {
	const out: ChatMessage = {role: m.role};
	if (m.content !== undefined) {
		out.content = m.content;
	}
	if (m.toolCallId) {
		out.tool_call_id = m.toolCallId;
	}
	if (m.toolCalls && m.toolCalls.length > 0) {
		out.tool_calls = m.toolCalls.map(tc => ({id: tc.id, name: tc.name, arguments: safeParse(tc.arguments)}));
	}
	return out;
}

function safeParse(raw: string): unknown {
	try {
		return JSON.parse(raw || '{}');
	} catch {
		return raw;
	}
}

function oneLine(s: string, max: number): string {
	const collapsed = s.split(/\s+/).filter(Boolean).join(' ');
	return collapsed.length > max ? collapsed.slice(0, max) + '…' : collapsed;
}
