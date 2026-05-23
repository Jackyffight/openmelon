// Long-running creative spaces, ported from internal/continuity.
//
// File-backed: .openmelon/spaces/<id>/ holds space.json, assumptions.md,
// canon.md, memory.md, plan.md, decisions.jsonl, feedback.jsonl, memory.jsonl,
// compactions.jsonl, episodes/<id>/episode.json, assets/<id>/asset.json.

import {promises as fs} from 'node:fs';
import path from 'node:path';
import {stateDir} from '../core/project.js';

const spacesDirName = 'spaces';
const spaceFile = 'space.json';
const assumptionsFile = 'assumptions.md';
const canonFile = 'canon.md';
const memoryFile = 'memory.md';
const memoryItemsFile = 'memory.jsonl';
const compactionFile = 'compactions.jsonl';
const planFile = 'plan.md';
const decisionsFile = 'decisions.jsonl';
const feedbackFile = 'feedback.jsonl';
const episodesDirName = 'episodes';
const assetsDirName = 'assets';

const defaultAssumptionsBody =
	'# Assumptions\n\nModel-generated setup assumptions live here until the user confirms, rejects, or edits them. These are lower authority than canon and decisions.\n';
const defaultCanonBody =
	'# Canon\n\nConfirmed long-term rules live here. Do not infer new canon without user confirmation.\n\n## Voice\n- TBD\n\n## Visual Style\n- TBD\n\n## Episode Structure\n- TBD\n';
const defaultMemoryBody = '# Memory\n\n';
const defaultPlanBody = '# Plan\n\n## Backlog\n- TBD\n';

const slugRe = /^[a-z][a-z0-9-]*$/;

export class ContinuityError extends Error {}

export type Space = {
	id: string;
	name: string;
	platform?: string;
	audience?: string;
	status?: string;
	description?: string;
	tags?: string[];
	created_at: string;
	updated_at: string;
};

export type Decision = {
	id?: string;
	scope?: string;
	target?: string;
	decision: string;
	reason?: string;
	weight?: number;
	status?: string;
	created_at?: string;
};

export type Feedback = {
	id?: string;
	episode_id?: string;
	source?: string;
	signal: string;
	evidence?: string;
	recommendation?: string;
	created_at?: string;
};

export type Episode = {
	id?: string;
	title?: string;
	topic?: string;
	status?: string;
	brief?: string;
	created_at?: string;
	updated_at?: string;
};

export type Asset = {
	id?: string;
	kind?: string;
	space_id?: string;
	status?: string;
	description?: string;
	reuse_policy?: string;
	files?: string[];
	tags?: string[];
	weight?: number;
	created_at?: string;
	updated_at?: string;
};

export type MemoryItem = {
	id?: string;
	kind?: string;
	scope?: string;
	target?: string;
	content: string;
	source?: string;
	weight?: number;
	status?: string;
	created_at?: string;
	updated_at?: string;
};

export type SpaceCompaction = {id?: string; summary: string; scope?: string; created_at?: string};
export type Hit = {space: Space; score: number};

export type SelectionOptions = {
	query?: string;
	maxDecisions?: number;
	maxFeedback?: number;
	maxEpisodes?: number;
	maxAssets?: number;
};

export type ContextPacket = {
	project_id: string;
	authority: string;
	space: Space;
	selection: {
		query?: string;
		decision_limit: number;
		feedback_limit: number;
		episode_limit: number;
		asset_limit: number;
		reasons: string[];
		truncated: string[];
	};
	assumptions?: string;
	canon?: string;
	memory?: string;
	plan?: string;
	recent_decisions: Decision[];
	recent_feedback: Feedback[];
	recent_episodes: Episode[];
	assets: Asset[];
};

export type WorkflowStep = {id: string; action: string; tool?: string; reason: string};
export type WorkflowPlan = {
	intent: string;
	mode: string;
	space_id?: string;
	needs_confirmation: boolean;
	reason: string;
	steps: WorkflowStep[];
};

function spacesDir(workdir: string): string {
	return path.join(stateDir(workdir), spacesDirName);
}

export function spaceDir(workdir: string, id: string): string {
	return path.join(spacesDir(workdir), id);
}

export function validateId(id: string): void {
	if (id.length < 2 || id.length > 64) {
		throw new ContinuityError(`continuity: id ${JSON.stringify(id)} must be 2..64 chars`);
	}
	if (!slugRe.test(id)) {
		throw new ContinuityError(`continuity: id ${JSON.stringify(id)} must be kebab-case ([a-z][a-z0-9-]*)`);
	}
	if (id.endsWith('-') || id.includes('--')) {
		throw new ContinuityError(`continuity: id ${JSON.stringify(id)} must not have trailing or doubled hyphens`);
	}
}

export type CreateSpaceOptions = {
	id: string;
	name?: string;
	platform?: string;
	audience?: string;
	status?: string;
	description?: string;
	tags?: string[];
	assumptions?: string;
};

export async function createSpace(workdir: string, opts: CreateSpaceOptions): Promise<Space> {
	validateId(opts.id);
	const dir = spaceDir(workdir, opts.id);
	if (await exists(path.join(dir, spaceFile))) {
		throw new ContinuityError(`continuity: already exists: ${opts.id}`);
	}
	await fs.mkdir(path.join(dir, episodesDirName), {recursive: true});
	await fs.mkdir(path.join(dir, assetsDirName), {recursive: true});
	const now = new Date().toISOString();
	const sp: Space = {
		id: opts.id,
		name: opts.name?.trim() || opts.id,
		platform: opts.platform?.trim() || undefined,
		audience: opts.audience?.trim() || undefined,
		status: opts.status?.trim() || 'draft',
		description: opts.description?.trim() || undefined,
		tags: cleanTags(opts.tags ?? []),
		created_at: now,
		updated_at: now
	};
	await writeJson(path.join(dir, spaceFile), sp);
	let assumptions = (opts.assumptions ?? '').trim();
	assumptions = assumptions ? ensureNL(assumptions) : defaultAssumptionsBody;
	await fs.writeFile(path.join(dir, assumptionsFile), assumptions);
	await fs.writeFile(path.join(dir, canonFile), defaultCanonBody);
	await fs.writeFile(path.join(dir, memoryFile), defaultMemoryBody);
	await fs.writeFile(path.join(dir, planFile), defaultPlanBody);
	return sp;
}

export async function listSpaces(workdir: string): Promise<Space[]> {
	let entries: import('node:fs').Dirent[];
	try {
		entries = await fs.readdir(spacesDir(workdir), {withFileTypes: true});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
	const out: Space[] = [];
	for (const e of entries) {
		if (!e.isDirectory()) {
			continue;
		}
		try {
			out.push(await getSpace(workdir, e.name));
		} catch {
			/* skip half-written */
		}
	}
	out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	return out;
}

export async function getSpace(workdir: string, id: string): Promise<Space> {
	validateId(id);
	try {
		return JSON.parse(await fs.readFile(path.join(spaceDir(workdir, id), spaceFile), 'utf8')) as Space;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new ContinuityError(`continuity: not found: space ${id}`);
		}
		throw error;
	}
}

const stopWords = new Set(['continue', 'again', 'yesterday', 'today', 'tomorrow', 'next', 'series', 'episode', 'post', 'the', 'a', 'an']);

function searchTerms(query: string): string[] {
	const out: string[] = [];
	for (const raw of query.toLowerCase().split(/\s+/)) {
		const term = raw.replace(/^[ \t\r\n.,;:!?()[\]{}"']+|[ \t\r\n.,;:!?()[\]{}"']+$/g, '');
		if (term && !stopWords.has(term)) {
			out.push(term);
		}
	}
	return out;
}

export async function searchSpaces(workdir: string, query: string): Promise<Hit[]> {
	const spaces = await listSpaces(workdir);
	const terms = searchTerms(query);
	const hits: Hit[] = [];
	for (const sp of spaces) {
		let score = 0;
		const hay = [sp.id, sp.name, sp.description ?? '', sp.platform ?? '', sp.audience ?? '', (sp.tags ?? []).join(' ')]
			.join('\n')
			.toLowerCase();
		if (!query.trim()) {
			score = 1;
		}
		for (const term of terms) {
			if (sp.id === term) {
				score += 10;
			} else if (hay.includes(term)) {
				score += 2;
			} else {
				score = -1;
			}
			if (score < 0) {
				break;
			}
		}
		if (sp.status === 'active' && score >= 0) {
			score += 3;
		}
		if (score >= 0) {
			hits.push({space: sp, score});
		}
	}
	hits.sort((a, b) => (a.score !== b.score ? b.score - a.score : a.space.id < b.space.id ? -1 : 1));
	return hits;
}

export async function activateSpace(workdir: string, id: string, d: Decision): Promise<{space: Space; decision: Decision}> {
	const sp = await getSpace(workdir, id);
	if (!d.decision?.trim()) {
		throw new ContinuityError('continuity: activation decision is required');
	}
	const decision = await recordDecision(workdir, id, {...d, scope: d.scope || 'space', target: d.target || 'space_activation'});
	sp.status = 'active';
	sp.updated_at = new Date().toISOString();
	await writeJson(path.join(spaceDir(workdir, id), spaceFile), sp);
	return {space: sp, decision};
}

export async function recordDecision(workdir: string, spaceId: string, d: Decision): Promise<Decision> {
	await getSpace(workdir, spaceId);
	if (!d.decision?.trim()) {
		throw new ContinuityError('continuity: decision is required');
	}
	const now = new Date().toISOString();
	const rec: Decision = {
		id: d.id || `dec-${stamp()}`,
		scope: d.scope || 'space',
		target: d.target,
		decision: d.decision,
		reason: d.reason,
		weight: d.weight || 1.0,
		status: d.status || 'active',
		created_at: now
	};
	await appendJsonl(path.join(spaceDir(workdir, spaceId), decisionsFile), rec);
	return rec;
}

export async function recordFeedback(workdir: string, spaceId: string, f: Feedback): Promise<Feedback> {
	await getSpace(workdir, spaceId);
	if (!f.signal?.trim()) {
		throw new ContinuityError('continuity: signal is required');
	}
	const rec: Feedback = {
		id: f.id || `fb-${stamp()}`,
		episode_id: f.episode_id,
		source: f.source || 'user',
		signal: f.signal,
		evidence: f.evidence,
		recommendation: f.recommendation,
		created_at: new Date().toISOString()
	};
	await appendJsonl(path.join(spaceDir(workdir, spaceId), feedbackFile), rec);
	return rec;
}

export async function recordMemoryItem(workdir: string, spaceId: string, item: MemoryItem): Promise<MemoryItem> {
	await getSpace(workdir, spaceId);
	if (!item.content?.trim()) {
		throw new ContinuityError('continuity: memory content is required');
	}
	const now = new Date().toISOString();
	const id = item.id || `mem-${stamp()}`;
	validateId(id);
	const rec: MemoryItem = {
		id,
		kind: item.kind || 'observation',
		scope: item.scope,
		target: item.target,
		content: item.content,
		source: item.source || 'model',
		weight: item.weight || 0.5,
		status: item.status || 'provisional',
		created_at: now,
		updated_at: now
	};
	await appendJsonl(path.join(spaceDir(workdir, spaceId), memoryItemsFile), rec);
	return rec;
}

export async function promoteMemoryItem(
	workdir: string,
	spaceId: string,
	p: {item_id: string; decision: string; reason?: string; target?: string}
): Promise<Decision> {
	if (!p.item_id?.trim()) {
		throw new ContinuityError('continuity: memory item_id is required');
	}
	if (!p.decision?.trim()) {
		throw new ContinuityError('continuity: promotion decision is required');
	}
	return recordDecision(workdir, spaceId, {
		scope: 'memory',
		target: firstNonEmpty(p.target, p.item_id),
		decision: p.decision,
		reason: p.reason?.trim() || `Promoted from memory item ${p.item_id}`,
		weight: 1.0
	});
}

export async function recordSpaceCompaction(workdir: string, spaceId: string, c: SpaceCompaction): Promise<SpaceCompaction> {
	await getSpace(workdir, spaceId);
	if (!c.summary?.trim()) {
		throw new ContinuityError('continuity: compaction summary is required');
	}
	const id = c.id || `cmp-${stamp()}`;
	validateId(id);
	const rec: SpaceCompaction = {id, summary: c.summary, scope: c.scope || 'space', created_at: new Date().toISOString()};
	await appendJsonl(path.join(spaceDir(workdir, spaceId), compactionFile), rec);
	return rec;
}

export async function createEpisode(workdir: string, spaceId: string, ep: Episode): Promise<Episode> {
	const sp = await getSpace(workdir, spaceId);
	if (sp.status === 'draft') {
		throw new ContinuityError(
			`continuity: space ${spaceId} is draft; ask the user to confirm core assumptions and activate the space before creating durable episodes`
		);
	}
	const id = ep.id?.trim() || slugFromText(firstNonEmpty(ep.topic, ep.title, 'episode'));
	validateId(id);
	const now = new Date().toISOString();
	const rec: Episode = {id, title: ep.title, topic: ep.topic, status: ep.status || 'draft', created_at: now, updated_at: now};
	const dir = path.join(spaceDir(workdir, spaceId), episodesDirName, id);
	await fs.mkdir(dir, {recursive: true});
	await writeJson(path.join(dir, 'episode.json'), rec);
	if (ep.brief) {
		await fs.writeFile(path.join(dir, 'brief.md'), ensureNL(ep.brief));
	}
	return rec;
}

export async function registerAsset(workdir: string, spaceId: string, a: Asset): Promise<Asset> {
	await getSpace(workdir, spaceId);
	const id = a.id?.trim() || slugFromText(firstNonEmpty(a.description, a.kind, 'asset'));
	validateId(id);
	const now = new Date().toISOString();
	const rec: Asset = {
		id,
		kind: a.kind,
		space_id: spaceId,
		status: a.status || 'active',
		description: a.description,
		reuse_policy: a.reuse_policy,
		files: a.files,
		tags: a.tags,
		weight: a.weight || 1.0,
		created_at: now,
		updated_at: now
	};
	const dir = path.join(spaceDir(workdir, spaceId), assetsDirName, id);
	await fs.mkdir(dir, {recursive: true});
	await writeJson(path.join(dir, 'asset.json'), rec);
	return rec;
}

export async function updateAssetWeight(workdir: string, spaceId: string, assetId: string, weight: number, status: string): Promise<Asset> {
	await getSpace(workdir, spaceId);
	validateId(assetId);
	const file = path.join(spaceDir(workdir, spaceId), assetsDirName, assetId, 'asset.json');
	let a: Asset;
	try {
		a = JSON.parse(await fs.readFile(file, 'utf8')) as Asset;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new ContinuityError(`continuity: not found: asset ${assetId}`);
		}
		throw error;
	}
	a.weight = weight;
	if (status.trim()) {
		a.status = status.trim();
	}
	a.updated_at = new Date().toISOString();
	await writeJson(file, a);
	return a;
}

export async function planWorkflow(workdir: string, intentRaw: string): Promise<WorkflowPlan> {
	const intent = intentRaw.trim();
	const hits = await searchSpaces(workdir, intent);
	const plan: WorkflowPlan = {
		intent,
		mode: 'new_space',
		reason: 'No matching active creative space was found; start with provisional assumptions and ask for confirmation.',
		needs_confirmation: true,
		steps: [
			{id: 'find-context', action: 'search existing spaces', tool: 'list_spaces', reason: 'Avoid creating duplicate continuity spaces.'},
			{id: 'draft-space', action: 'create draft space', tool: 'create_space', reason: 'Store provisional assumptions without polluting canon.'},
			{id: 'ask-confirmation', action: 'ask concise confirmation questions', reason: 'Confirmed direction is required before durable episodes or decisions.'}
		]
	};
	if (hits.length === 0) {
		return plan;
	}
	const best = hits[0]!.space;
	plan.space_id = best.id;
	if (best.status === 'draft') {
		plan.mode = 'confirm_space';
		plan.reason = 'A draft space matches; confirm or correct assumptions before production.';
		plan.steps = [
			{id: 'load-context', action: 'load selected context', tool: 'get_context_packet', reason: 'Review assumptions and open context.'},
			{id: 'ask-confirmation', action: 'ask user to confirm or correct core direction', reason: 'Draft spaces cannot create durable episodes.'},
			{id: 'activate', action: 'activate after confirmation', tool: 'activate_space', reason: 'Promotion requires explicit confirmation.'}
		];
		plan.needs_confirmation = true;
		return plan;
	}
	plan.mode = 'continue_space';
	plan.reason = 'An active creative space matches; load selected context and continue production.';
	plan.steps = [
		{id: 'load-context', action: 'load selected context', tool: 'get_context_packet', reason: 'Reuse canon, decisions, feedback, recent episodes, and ranked assets.'},
		{id: 'adapt', action: 'adapt plan using feedback and memory', reason: 'Keep continuity while responding to recent performance or user direction.'},
		{id: 'produce', action: 'create or update episode/assets', tool: 'create_episode', reason: 'Record durable production units after context is loaded.'},
		{id: 'finish', action: 'summarize updates', tool: 'finish', reason: 'Return concise output and updated continuity state.'}
	];
	plan.needs_confirmation = false;
	return plan;
}

export async function buildSelectedContextPacket(
	workdir: string,
	projectId: string,
	spaceId: string,
	optsIn: SelectionOptions
): Promise<ContextPacket> {
	const sp = await getSpace(workdir, spaceId);
	const opts = {
		query: (optsIn.query ?? '').trim(),
		maxDecisions: optsIn.maxDecisions && optsIn.maxDecisions > 0 ? optsIn.maxDecisions : 8,
		maxFeedback: optsIn.maxFeedback && optsIn.maxFeedback > 0 ? optsIn.maxFeedback : 8,
		maxEpisodes: optsIn.maxEpisodes && optsIn.maxEpisodes > 0 ? optsIn.maxEpisodes : 8,
		maxAssets: optsIn.maxAssets && optsIn.maxAssets > 0 ? optsIn.maxAssets : 20
	};
	const dir = spaceDir(workdir, spaceId);
	const recentDecisions = await readJsonl<Decision>(path.join(dir, decisionsFile), opts.maxDecisions);
	const recentFeedback = await readJsonl<Feedback>(path.join(dir, feedbackFile), opts.maxFeedback);
	const recentEpisodes = await listEpisodes(workdir, spaceId, opts.maxEpisodes);
	let assets = await listAssets(workdir, spaceId, opts.maxAssets);
	if (opts.query) {
		assets = rankAssetsForQuery(assets, opts.query);
	}
	const truncated: string[] = [];
	if ((await countJsonlLines(path.join(dir, decisionsFile))) > recentDecisions.length) {
		truncated.push('recent_decisions');
	}
	if ((await countJsonlLines(path.join(dir, feedbackFile))) > recentFeedback.length) {
		truncated.push('recent_feedback');
	}
	if ((await countDirs(path.join(dir, episodesDirName))) > recentEpisodes.length) {
		truncated.push('recent_episodes');
	}
	if ((await countDirs(path.join(dir, assetsDirName))) > assets.length) {
		truncated.push('assets');
	}
	return {
		project_id: projectId,
		authority:
			'canon and recent_decisions are confirmed/high-authority; assumptions are provisional/low-authority and must be confirmed before becoming long-term rules',
		space: sp,
		selection: {
			query: opts.query || undefined,
			decision_limit: opts.maxDecisions,
			feedback_limit: opts.maxFeedback,
			episode_limit: opts.maxEpisodes,
			asset_limit: opts.maxAssets,
			reasons: [
				'canon and decisions have highest authority',
				'feedback and asset weights influence future production',
				'recent episodes preserve continuity'
			],
			truncated
		},
		assumptions: await readTextMaybe(path.join(dir, assumptionsFile)),
		canon: await readTextMaybe(path.join(dir, canonFile)),
		memory: await readTextMaybe(path.join(dir, memoryFile)),
		plan: await readTextMaybe(path.join(dir, planFile)),
		recent_decisions: recentDecisions,
		recent_feedback: recentFeedback,
		recent_episodes: recentEpisodes,
		assets
	};
}

/** Build a markdown compaction draft from the selected context. Ported from Go BuildCompactionDraft. */
export async function buildCompactionDraft(workdir: string, projectId: string, spaceId: string): Promise<string> {
	const p = await buildSelectedContextPacket(workdir, projectId, spaceId, {
		maxDecisions: 12,
		maxFeedback: 12,
		maxEpisodes: 12,
		maxAssets: 12
	});
	const lines: string[] = [`# ${p.space.name} Compaction`, '', `Space: ${p.space.id} (${p.space.status ?? ''})`];
	if (p.canon?.trim()) {
		lines.push('', '## Canon', p.canon.trim());
	}
	if (p.recent_decisions.length > 0) {
		lines.push('', '## Confirmed Decisions');
		for (const d of p.recent_decisions) {
			lines.push(`- ${d.decision}${d.target ? ` [${d.target}]` : ''}`);
		}
	}
	if (p.recent_feedback.length > 0) {
		lines.push('', '## Feedback Signals');
		for (const f of p.recent_feedback) {
			lines.push(`- ${f.signal}${f.recommendation ? `: ${f.recommendation}` : ''}`);
		}
	}
	if (p.assets.length > 0) {
		lines.push('', '## Reusable Assets');
		for (const a of p.assets) {
			lines.push(`- ${a.id} (${a.status ?? ''}, weight ${(a.weight ?? 0).toFixed(2)}): ${a.description ?? ''}`);
		}
	}
	if (p.recent_episodes.length > 0) {
		lines.push('', '## Recent Episodes');
		for (const ep of p.recent_episodes) {
			lines.push(`- ${ep.id}: ${ep.topic || ep.title || ''}`);
		}
	}
	return lines.join('\n').trim() + '\n';
}

function rankAssetsForQuery(assets: Asset[], query: string): Asset[] {
	const terms = searchTerms(query);
	return [...assets].sort((a, b) => {
		const sa = assetQueryScore(a, terms);
		const sb = assetQueryScore(b, terms);
		if (sa !== sb) {
			return sb - sa;
		}
		if ((a.weight ?? 0) !== (b.weight ?? 0)) {
			return (b.weight ?? 0) - (a.weight ?? 0);
		}
		return Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? '');
	});
}

function assetQueryScore(a: Asset, terms: string[]): number {
	if (terms.length === 0) {
		return 0;
	}
	const hay = [a.id ?? '', a.kind ?? '', a.status ?? '', a.description ?? '', a.reuse_policy ?? '', (a.tags ?? []).join(' ')]
		.join('\n')
		.toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (hay.includes(term)) {
			score += 3;
		}
	}
	if (a.status === 'canonical') {
		score++;
	}
	return score;
}

async function listEpisodes(workdir: string, spaceId: string, limit: number): Promise<Episode[]> {
	const out = await readChildJson<Episode>(path.join(spaceDir(workdir, spaceId), episodesDirName), 'episode.json');
	out.sort((a, b) => Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? ''));
	return limit > 0 && out.length > limit ? out.slice(0, limit) : out;
}

async function listAssets(workdir: string, spaceId: string, limit: number): Promise<Asset[]> {
	const out = await readChildJson<Asset>(path.join(spaceDir(workdir, spaceId), assetsDirName), 'asset.json');
	out.sort((a, b) => {
		if ((a.weight ?? 0) !== (b.weight ?? 0)) {
			return (b.weight ?? 0) - (a.weight ?? 0);
		}
		return Date.parse(b.updated_at ?? '') - Date.parse(a.updated_at ?? '');
	});
	return limit > 0 && out.length > limit ? out.slice(0, limit) : out;
}

// --- low-level helpers ---

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

async function writeJson(p: string, v: unknown): Promise<void> {
	await fs.writeFile(p, `${JSON.stringify(v, null, 2)}\n`);
}

async function appendJsonl(p: string, v: unknown): Promise<void> {
	await fs.mkdir(path.dirname(p), {recursive: true});
	await fs.appendFile(p, `${JSON.stringify(v)}\n`);
}

async function readJsonl<T>(p: string, limit: number): Promise<T[]> {
	let body: string;
	try {
		body = await fs.readFile(p, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
	const lines = body
		.trim()
		.split('\n')
		.filter(l => l.trim());
	const start = limit > 0 && lines.length > limit ? lines.length - limit : 0;
	const out: T[] = [];
	for (const line of lines.slice(start)) {
		try {
			out.push(JSON.parse(line) as T);
		} catch {
			/* skip */
		}
	}
	return out;
}

async function readChildJson<T>(dir: string, fileName: string): Promise<T[]> {
	let entries: import('node:fs').Dirent[];
	try {
		entries = await fs.readdir(dir, {withFileTypes: true});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
	const out: T[] = [];
	for (const e of entries) {
		if (!e.isDirectory()) {
			continue;
		}
		try {
			out.push(JSON.parse(await fs.readFile(path.join(dir, e.name, fileName), 'utf8')) as T);
		} catch {
			/* skip */
		}
	}
	return out;
}

async function countJsonlLines(p: string): Promise<number> {
	try {
		const body = await fs.readFile(p, 'utf8');
		return body
			.trim()
			.split('\n')
			.filter(l => l.trim()).length;
	} catch {
		return 0;
	}
}

async function countDirs(p: string): Promise<number> {
	try {
		const entries = await fs.readdir(p, {withFileTypes: true});
		return entries.filter(e => e.isDirectory()).length;
	} catch {
		return 0;
	}
}

async function readTextMaybe(p: string): Promise<string | undefined> {
	try {
		return await fs.readFile(p, 'utf8');
	} catch {
		return undefined;
	}
}

function cleanTags(tags: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of tags) {
		const t = raw.trim().toLowerCase();
		if (t && !seen.has(t)) {
			seen.add(t);
			out.push(t);
		}
	}
	return out;
}

function slugFromText(s: string): string {
	let out = '';
	let prevHy = false;
	for (const r of s.toLowerCase()) {
		if ((r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')) {
			out += r;
			prevHy = false;
		} else if (r === ' ' || r === '_' || r === '-' || r === '.') {
			if (!prevHy && out.length > 0) {
				out += '-';
				prevHy = true;
			}
		}
	}
	out = out.replace(/^-+|-+$/g, '');
	if (!out || out[0]! < 'a' || out[0]! > 'z') {
		out = `item-${out}`.replace(/-+$/g, '');
	}
	if (out.length > 64) {
		out = out.slice(0, 64).replace(/-+$/g, '');
	}
	if (out.length < 2) {
		out = 'item';
	}
	return out;
}

function firstNonEmpty(...vals: (string | undefined)[]): string {
	for (const v of vals) {
		if (v && v.trim()) {
			return v.trim();
		}
	}
	return '';
}

function ensureNL(s: string): string {
	return s.endsWith('\n') ? s : s + '\n';
}

/** Compact UTC stamp YYYYMMDD-HHMMSS for generated ids. */
function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}
