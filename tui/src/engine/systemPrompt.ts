// Project system prompt + model/provider/effort defaults, ported from the
// cmd/openmelon helpers (buildProjectSystemPrompt, resolveDefaults,
// resolveReasoningEffort, defaultReasoningEffort).

import {loadUserConfig} from '../core/config.js';
import type {ProjectConfig} from '../core/project.js';
import {normalizeReasoningEffort} from './llm/types.js';

export type ResolvedDefaults = {
	llmProvider: string;
	llmModel: string;
	imageProvider: string;
	imageModel: string;
};

/** Read model + provider preferences from the project, falling back to ~/.openmelon/config.json. */
export async function resolveDefaults(project: ProjectConfig | undefined): Promise<ResolvedDefaults> {
	const d = project?.defaults ?? {};
	let llmProvider = d.llm_provider ?? '';
	let llmModel = d.llm_model ?? '';
	let imageProvider = d.image_provider ?? '';
	let imageModel = d.image_model ?? '';
	const cfg = await loadUserConfig();
	const cd = cfg.defaults ?? {};
	llmProvider ||= cd.llm_provider ?? '';
	llmModel ||= cd.llm_model ?? '';
	imageProvider ||= cd.image_provider ?? '';
	imageModel ||= cd.image_model ?? '';
	return {llmProvider, llmModel, imageProvider, imageModel};
}

/** Project setting → user-config default → model-derived default. */
export async function resolveReasoningEffort(
	project: ProjectConfig | undefined,
	provider: string,
	model: string
): Promise<string> {
	const fromProject = normalizeReasoningEffort(project?.settings?.reasoning_effort);
	if (fromProject) {
		return fromProject;
	}
	const cfg = await loadUserConfig();
	const fromConfig = normalizeReasoningEffort(cfg.defaults?.reasoning_effort);
	if (fromConfig) {
		return fromConfig;
	}
	return defaultReasoningEffort(provider, model);
}

function defaultReasoningEffort(provider: string, model: string): string {
	const p = provider.trim().toLowerCase();
	const m = model.trim().toLowerCase();
	if (p !== 'openai' && p !== 'openrouter') {
		return '';
	}
	if (m.startsWith('gpt-5') || m.includes('/gpt-5')) {
		return 'xhigh';
	}
	return '';
}

/** Build the agent's project system prompt. Verbatim port of buildProjectSystemPrompt. */
export function buildProjectSystemPrompt(project: ProjectConfig, toolNames: string[]): string {
	const lines: string[] = [];
	lines.push('You are openmelon, a content-creation agent operating inside a creator\'s project.\n');
	lines.push(`Project: ${project.name} (${project.id})`);
	if (project.description) {
		lines.push(`Description: ${project.description}`);
	}
	if (project.persona) {
		lines.push(`Voice / persona: ${project.persona}`);
	}
	if (project.constraints && project.constraints.length > 0) {
		lines.push('House rules (must respect):');
		for (const c of project.constraints) {
			lines.push(`  - ${c}`);
		}
	}
	// The full continuity-aware guidance only applies when the creative-space
	// tools are actually registered. On the current TS path they aren't yet
	// (task #10), so reference only available tools — otherwise the model calls
	// tools that don't exist.
	const hasContinuity = toolNames.includes('list_spaces');
	if (hasContinuity) {
		lines.push(
			'\nWork like a senior creator operating a durable creative workspace. Before producing, decide whether the request starts a new creative space, continues an existing space, modifies canon, records feedback, plans future content, compacts long context, or produces an episode. Use plan_creator_workflow when the workflow is ambiguous. Use list_spaces and get_context_packet to load continuity context before continuing a series; pass the current creative intent as query and use max_* limits when context may be large. For a new durable space, create only a draft space with provisional assumptions, then ask concise clarification questions for high-impact choices before recording decisions, creating episodes, or treating anything as long-term canon. Assumptions and record_memory_item entries are provisional/low-authority; canon, activate_space, promote_memory_item, and record_decision entries require explicit user confirmation. After the user confirms the core direction, call activate_space with the confirmed decision before creating durable episodes. Record weak observations with record_memory_item, promote them only after confirmation, and use update_asset_weight to promote/demote reusable assets after feedback. Use record_compaction after enough history accumulates or when a selected context should become a reusable summary. For visual work, load known characters, scenes, typography, layout rules, and style references from continuity context and reusable assets before producing. Treat typography the same way as background or character continuity: a descriptive project-level rule or reusable reference asset that is included in image prompts, not a local font lookup. Generate visual outputs through `generate_image` with relevant reference_images and explicit prompt constraints. User-facing deliverables must be saved in visible project output directories such as `outputs/`; `.openmelon` is reserved for internal state, sessions, config, and continuity data. Do not use bash to discover local fonts, render SVG/HTML, compose images, or otherwise replace the image model\'s visual generation unless the user explicitly asks for local file processing. When done, call `finish` with a short summary and final artifact paths or updated continuity state.'
		);
	} else {
		lines.push(
			'\nWork like a senior creator. Before producing visual work, load known characters, scenes, and style references via list_characters / get_character / list_references / get_reference / search, and pass their image paths as reference_images to anchor continuity. Generate visual outputs through `generate_image` with relevant reference_images and explicit prompt constraints (characters, scene, typography, layout, style). Treat typography as a descriptive prompt constraint, not a local font lookup. Save user-facing deliverables in visible project output directories such as `outputs/`; `.openmelon` is reserved for internal state. Use save_artifact to promote a final image. When done, call `finish` with a short summary and the final artifact paths.'
		);
	}
	lines.push(`\nAvailable tools: ${toolNames.join(', ')}`);
	return lines.join('\n') + '\n';
}
