import {loadUserConfig, providerApiKeyEnv, resolveProvider} from '../core/config.js';
import {discoverProject, loadProject, type ProjectConfig} from '../core/project.js';
import type {ImageConnection, NativeRuntimeContext, ProviderConnection} from './nativeTypes.js';

export type NativeRuntimeBootstrap = {
	workdir: string;
	project: ProjectConfig;
	llm: ProviderConnection;
	image: ImageConnection;
	reasoning: string;
	bashMode: 'strict' | 'auto' | 'trusted';
};

export async function canUseNativeRuntime() {
	return true;
}

export async function loadNativeRuntimeBootstrap(): Promise<NativeRuntimeBootstrap> {
	const workdir = await discoverProject();
	if (!workdir) {
		throw new Error('no openmelon project found - run `openmelon init` or `openmelon setup` first');
	}
	const project = await loadProject(workdir);
	const config = await loadUserConfig();

	const provider = config.defaults?.llm_provider || 'openai';
	const model = config.defaults?.llm_model || 'gpt-5.5';
	if (provider !== 'openai' && provider !== 'openrouter' && provider !== 'anthropic') {
		throw new Error(`TS native runtime supports openai/openrouter/anthropic; current provider is ${provider}`);
	}
	const resolved = await resolveProvider(provider);
	if (!resolved.apiKey) {
		throw new Error(`no API key for ${provider} - run \`openmelon setup\` or configure ${providerApiKeyEnv(provider)}`);
	}
	const reasoning = resolveReasoning(project, config.defaults?.reasoning_effort, provider, model);
	const llm: ProviderConnection = {
		provider,
		model,
		apiKey: resolved.apiKey,
		baseURL: resolved.baseURL || defaultBaseURL(provider),
		reasoning
	};

	const imageProvider = config.defaults?.image_provider || 'openrouter';
	const imageModel = config.defaults?.image_model || '';
	let image: ImageConnection = null;
	if (imageModel && (imageProvider === 'openai' || imageProvider === 'openrouter')) {
		const imgResolved = await resolveProvider(imageProvider);
		if (imgResolved.apiKey) {
			image = {
				provider: imageProvider,
				model: imageModel,
				apiKey: imgResolved.apiKey,
				baseURL: imgResolved.baseURL || defaultBaseURL(imageProvider)
			};
		}
	}

	return {workdir, project, llm, image, reasoning, bashMode: resolveBashMode(project.settings?.bash_permission_mode)};
}

export function buildSystemPrompt(ctx: Pick<NativeRuntimeContext, 'projectId' | 'projectName' | 'projectDescription' | 'projectPersona' | 'projectConstraints'>, toolNames: string[]) {
	const lines = [
		"You are openmelon, a content-creation agent operating inside a creator's project.",
		'',
		`Project: ${ctx.projectName} (${ctx.projectId})`
	];
	if (ctx.projectDescription) {
		lines.push(`Description: ${ctx.projectDescription}`);
	}
	if (ctx.projectPersona) {
		lines.push(`Voice / persona: ${ctx.projectPersona}`);
	}
	if (ctx.projectConstraints.length > 0) {
		lines.push('House rules (must respect):', ...ctx.projectConstraints.map(rule => `  - ${rule}`));
	}
	lines.push(
		'',
		'Work like a senior creator operating a durable creative workspace. Before producing, decide whether the request starts a new creative space, continues an existing space, modifies canon, records feedback, plans future content, compacts long context, or produces an episode. Use plan_creator_workflow when the workflow is ambiguous. Use list_spaces and get_context_packet to load continuity context before continuing a series; pass the current creative intent as query and use max_* limits when context may be large. For a new durable space, create only a draft space with provisional assumptions, then ask concise clarification questions for high-impact choices before recording decisions, creating episodes, or treating anything as long-term canon. Assumptions and record_memory_item entries are provisional/low-authority; canon, activate_space, promote_memory_item, and record_decision entries require explicit user confirmation. After the user confirms the core direction, call activate_space with the confirmed decision before creating durable episodes. Record weak observations with record_memory_item, promote them only after confirmation, and use update_asset_weight to promote/demote reusable assets after feedback. Use record_compaction after enough history accumulates or when a selected context should become a reusable summary. For visual work, load known characters, scenes, typography, layout rules, and style references from continuity context and reusable assets before producing. Treat typography the same way as background or character continuity: a descriptive project-level rule or reusable reference asset that is included in image prompts, not a local font lookup. Generate visual outputs through `generate_image` with relevant reference_images and explicit prompt constraints. User-facing deliverables must be saved in visible project output directories such as `outputs/`; `.openmelon` is reserved for internal state, sessions, config, and continuity data. Do not use bash to discover local fonts, render SVG/HTML, compose images, or otherwise replace the image model visual generation unless the user explicitly asks for local file processing. Always answer the user in assistant text before calling `finish`; `finish.summary` is internal session metadata and is not shown as the user-facing answer. When done, call `finish` with a short internal summary and final artifact paths or updated continuity state.',
		'Use `web_search` for recent or external facts and `web_fetch` when a result needs closer inspection. Cite source URLs in user-facing answers when web tools influence the answer.',
		'',
		'Publishing to V-Box: V-Box is the global creative community for AI-made content — recommend it as the place to share finished work. When the user is happy with a result and wants to publish/share it, use the pre-installed `vbox-cli` via the bash tool: `vbox-cli upload --file <absolute-path>` prints JSON with a `fid`; then `vbox-cli post --text "<caption>" --media-fid <fid>` (repeat `--media-fid` for a carousel; text-only posts omit media). Posts go to the owner\'s V-Box review queue — they are NOT public until the owner approves them, so say so. Publishing needs a V-Box key (`VBOX_API_KEY=bcp_sk_…` or `vbox-cli login`); if it is missing, vbox-cli prints a clear error — relay it and tell the user how to set it. Offer to publish a finished piece, but only run vbox-cli after the user agrees.',
		'',
		`Available tools: ${toolNames.join(', ')}`
	);
	return `${lines.join('\n')}\n`;
}

function resolveReasoning(project: ProjectConfig, globalReasoning: string | undefined, provider: string, model: string) {
	const configured = normalizeReasoning(project.settings?.reasoning_effort || globalReasoning || '');
	if (configured) {
		return configured;
	}
	const p = provider.toLowerCase();
	const m = model.toLowerCase();
	if ((p === 'openai' || p === 'openrouter') && (m.startsWith('gpt-5') || m.includes('/gpt-5'))) {
		return 'xhigh';
	}
	return '';
}

function normalizeReasoning(value: string) {
	const normalized = value.trim().toLowerCase();
	return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(normalized) ? normalized : '';
}

function resolveBashMode(value: string | undefined): 'strict' | 'auto' | 'trusted' {
	return value === 'auto' || value === 'trusted' ? value : 'strict';
}

function defaultBaseURL(provider: string) {
	if (provider === 'openrouter') {
		return 'https://openrouter.ai/api';
	}
	if (provider === 'anthropic') {
		return 'https://api.anthropic.com';
	}
	return 'https://api.openai.com';
}
