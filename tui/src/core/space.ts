import {promises as fs} from 'node:fs';
import path from 'node:path';
import {stateDir} from './project.js';
import {validateSlug} from './registry.js';

export type SpaceMeta = {
	id?: string;
	name?: string;
	status?: string;
	description?: string;
};

export type SpaceSummary = {
	meta: SpaceMeta;
	decisions: number;
	feedback: number;
	episodes: number;
	assets: number;
};

export type CreateSpaceOptions = {
	id: string;
	name?: string;
	platform?: string;
	audience?: string;
	description?: string;
	tags?: string[];
	assumptions?: string;
};

type Decision = {
	decision?: string;
	target?: string;
};

type Feedback = {
	signal?: string;
	recommendation?: string;
};

type Episode = {
	id?: string;
	topic?: string;
	title?: string;
	updated_at?: string;
	created_at?: string;
};

type Asset = {
	id?: string;
	status?: string;
	weight?: number;
	description?: string;
	kind?: string;
	tags?: string[];
	updated_at?: string;
	created_at?: string;
};

export async function summarizeSpace(workdir: string, id: string): Promise<SpaceSummary> {
	const root = path.join(stateDir(workdir), 'spaces', id);
	const meta = await readJsonMaybe<SpaceMeta>(path.join(root, 'space.json'));
	return {
		meta: {...meta, id: meta.id || id},
		decisions: await countJsonl(path.join(root, 'decisions.jsonl')),
		feedback: await countJsonl(path.join(root, 'feedback.jsonl')),
		episodes: await countDirs(path.join(root, 'episodes')),
		assets: await countDirs(path.join(root, 'assets'))
	};
}

export async function createSpace(workdir: string, options: CreateSpaceOptions) {
	validateSlug(options.id, 'continuity');
	const root = path.join(stateDir(workdir), 'spaces', options.id);
	if (await exists(path.join(root, 'space.json'))) {
		throw new Error(`continuity: already exists: ${options.id}`);
	}
	const now = new Date().toISOString();
	const space = {
		id: options.id,
		name: options.name || options.id,
		platform: options.platform || '',
		audience: options.audience || '',
		status: 'draft',
		description: options.description || '',
		tags: options.tags ?? [],
		created_at: now,
		updated_at: now
	};
	await fs.mkdir(path.join(root, 'episodes'), {recursive: true});
	await fs.mkdir(path.join(root, 'assets'), {recursive: true});
	await writeJson(path.join(root, 'space.json'), space);
	await fs.writeFile(path.join(root, 'assumptions.md'), ensureNL(options.assumptions?.trim() || defaultAssumptionsBody));
	await fs.writeFile(path.join(root, 'canon.md'), defaultCanonBody);
	await fs.writeFile(path.join(root, 'memory.md'), defaultMemoryBody);
	await fs.writeFile(path.join(root, 'plan.md'), defaultPlanBody);
	return space;
}

export async function listSpaces(workdir: string) {
	const root = path.join(stateDir(workdir), 'spaces');
	const entries = await readdirDirs(root);
	const spaces = await Promise.all(entries.map(entry => readJsonMaybe<Record<string, unknown> | null>(path.join(root, entry.name, 'space.json'), null)));
	return spaces.filter((space): space is Record<string, unknown> => space !== null).sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
}

export async function buildContextPacket(
	workdir: string,
	projectId: string,
	id: string,
	options: {query?: string; maxDecisions?: number; maxFeedback?: number; maxEpisodes?: number; maxAssets?: number} = {}
) {
	const root = path.join(stateDir(workdir), 'spaces', id);
	const space = await readJsonMaybe<Record<string, unknown> | null>(path.join(root, 'space.json'), null);
	if (!space) {
		throw new Error(`continuity: not found: space ${id}`);
	}
	const maxDecisions = options.maxDecisions ?? 8;
	const maxFeedback = options.maxFeedback ?? 8;
	const maxEpisodes = options.maxEpisodes ?? 8;
	const maxAssets = options.maxAssets ?? 20;
	return {
		project_id: projectId,
		authority: 'canon and recent_decisions are confirmed/high-authority; assumptions are provisional/low-authority',
		space,
		selection: {
			query: options.query ?? '',
			decision_limit: maxDecisions,
			feedback_limit: maxFeedback,
			episode_limit: maxEpisodes,
			asset_limit: maxAssets
		},
		assumptions: await readTextMaybe(path.join(root, 'assumptions.md')),
		canon: await readTextMaybe(path.join(root, 'canon.md')),
		memory: await readTextMaybe(path.join(root, 'memory.md')),
		plan: await readTextMaybe(path.join(root, 'plan.md')),
		recent_decisions: await readJsonl(path.join(root, 'decisions.jsonl'), maxDecisions),
		recent_feedback: await readJsonl(path.join(root, 'feedback.jsonl'), maxFeedback),
		recent_episodes: await readChildJson<Record<string, unknown>>(path.join(root, 'episodes'), 'episode.json').then(items => items.slice(0, maxEpisodes)),
		assets: await readChildJson<Record<string, unknown>>(path.join(root, 'assets'), 'asset.json').then(items => items.slice(0, maxAssets))
	};
}

export async function activateSpace(workdir: string, id: string, decisionText: string, reason = '', weight = 1) {
	const root = path.join(stateDir(workdir), 'spaces', id);
	const space = await readJsonMaybe<Record<string, unknown> | null>(path.join(root, 'space.json'), null);
	if (!space) {
		throw new Error(`continuity: not found: space ${id}`);
	}
	const decision = await appendDecision(root, {scope: 'space', target: 'space_activation', decision: decisionText, reason, weight});
	space.status = 'active';
	space.updated_at = new Date().toISOString();
	await writeJson(path.join(root, 'space.json'), space);
	return {space, decision};
}

export async function recordDecision(workdir: string, spaceId: string, value: Record<string, unknown>) {
	return appendDecision(await ensureSpaceRoot(workdir, spaceId), value);
}

export async function recordJsonl(workdir: string, spaceId: string, file: 'feedback.jsonl' | 'memory.jsonl', value: Record<string, unknown>, prefix: string) {
	const root = await ensureSpaceRoot(workdir, spaceId);
	const record = {id: String(value.id ?? `${prefix}-${timestamp()}`), created_at: new Date().toISOString(), ...value};
	await appendJsonl(path.join(root, file), record);
	return record;
}

export async function createEpisode(workdir: string, spaceId: string, value: Record<string, unknown>) {
	const root = await ensureSpaceRoot(workdir, spaceId);
	const id = String(value.id ?? '') || slugFromText(String(value.topic ?? value.title ?? 'episode'));
	const now = new Date().toISOString();
	const episode = {id, title: String(value.title ?? ''), topic: String(value.topic ?? ''), status: String(value.status ?? 'draft'), brief: String(value.brief ?? ''), created_at: now, updated_at: now};
	const dir = path.join(root, 'episodes', id);
	await fs.mkdir(dir, {recursive: true});
	await writeJson(path.join(dir, 'episode.json'), episode);
	if (episode.brief) {
		await fs.writeFile(path.join(dir, 'brief.md'), ensureNL(episode.brief));
	}
	return episode;
}

export async function registerAsset(workdir: string, spaceId: string, value: Record<string, unknown>) {
	const root = await ensureSpaceRoot(workdir, spaceId);
	const id = String(value.id ?? '') || slugFromText(String(value.description ?? value.kind ?? 'asset'));
	const now = new Date().toISOString();
	const asset = {
		id,
		space_id: spaceId,
		kind: String(value.kind ?? ''),
		status: String(value.status ?? 'active'),
		description: String(value.description ?? ''),
		reuse_policy: String(value.reuse_policy ?? value.reuse ?? ''),
		files: Array.isArray(value.files) ? value.files.map(String) : [],
		tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
		weight: numberArg(value.weight, 1),
		created_at: now,
		updated_at: now
	};
	const dir = path.join(root, 'assets', id);
	await fs.mkdir(dir, {recursive: true});
	await writeJson(path.join(dir, 'asset.json'), asset);
	return asset;
}

export async function updateAssetWeight(workdir: string, spaceId: string, assetId: string, weight: number, status = '') {
	const root = await ensureSpaceRoot(workdir, spaceId);
	const filePath = path.join(root, 'assets', assetId, 'asset.json');
	const asset = await readJsonMaybe<Record<string, unknown> | null>(filePath, null);
	if (!asset) {
		throw new Error(`asset ${assetId} not found`);
	}
	asset.weight = weight;
	if (status) {
		asset.status = status;
	}
	asset.updated_at = new Date().toISOString();
	await writeJson(filePath, asset);
	return asset;
}

export async function recordCompaction(workdir: string, spaceId: string, summary: string, scope = 'space') {
	const root = await ensureSpaceRoot(workdir, spaceId);
	const record = {id: `cmp-${timestamp()}`, summary, scope, created_at: new Date().toISOString()};
	await appendJsonl(path.join(root, 'compactions.jsonl'), record);
	return record;
}

export async function buildCompactionDraft(workdir: string, id: string) {
	const root = path.join(stateDir(workdir), 'spaces', id);
	const [space, canon, decisions, feedback, episodes, assets] = await Promise.all([
		readJsonMaybe<SpaceMeta>(path.join(root, 'space.json')),
		readTextMaybe(path.join(root, 'canon.md')),
		readJsonl<Decision>(path.join(root, 'decisions.jsonl'), 12),
		readJsonl<Feedback>(path.join(root, 'feedback.jsonl'), 12),
		listEpisodeSummaries(path.join(root, 'episodes'), 12),
		listAssetSummaries(path.join(root, 'assets'), 12)
	]);

	const title = space.name || space.id || id;
	const sections: string[] = [`# ${title} Compaction`, `Space: ${space.id || id} (${space.status || ''})`];
	if (canon.trim()) {
		sections.push(`## Canon\n${canon.trim()}`);
	}
	if (decisions.length > 0) {
		sections.push(`## Confirmed Decisions\n${decisions.map(item => `- ${item.decision ?? ''}${item.target ? ` [${item.target}]` : ''}`).join('\n')}`);
	}
	if (feedback.length > 0) {
		sections.push(`## Feedback Signals\n${feedback.map(item => `- ${item.signal ?? ''}${item.recommendation ? `: ${item.recommendation}` : ''}`).join('\n')}`);
	}
	if (assets.length > 0) {
		sections.push(`## Reusable Assets\n${assets.map(item => `- ${item.id ?? ''} (${item.status ?? ''}, weight ${(item.weight ?? 0).toFixed(2)}): ${item.description ?? ''}`).join('\n')}`);
	}
	if (episodes.length > 0) {
		sections.push(`## Recent Episodes\n${episodes.map(item => `- ${item.id ?? ''}: ${item.topic || item.title || ''}`).join('\n')}`);
	}
	return sections.join('\n\n');
}

async function readJsonMaybe<T>(filePath: string, fallback?: T): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return fallback !== undefined ? fallback : ({} as T);
		}
		throw error;
	}
}

async function writeJson(filePath: string, value: unknown) {
	await fs.mkdir(path.dirname(filePath), {recursive: true});
	await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendJsonl(filePath: string, value: unknown) {
	await fs.mkdir(path.dirname(filePath), {recursive: true});
	await fs.appendFile(filePath, `${JSON.stringify(value)}\n`);
}

async function appendDecision(root: string, fields: Record<string, unknown>) {
	const record = {id: `dec-${timestamp()}`, status: 'active', created_at: new Date().toISOString(), ...fields};
	await appendJsonl(path.join(root, 'decisions.jsonl'), record);
	return record;
}

async function ensureSpaceRoot(workdir: string, spaceId: string) {
	const root = path.join(stateDir(workdir), 'spaces', spaceId);
	if (!(await exists(path.join(root, 'space.json')))) {
		throw new Error(`continuity: not found: space ${spaceId}`);
	}
	return root;
}

async function readTextMaybe(filePath: string) {
	try {
		return await fs.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return '';
		}
		throw error;
	}
}

async function countJsonl(filePath: string) {
	const body = await readTextMaybe(filePath);
	return body
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean).length;
}

async function readJsonl<T>(filePath: string, limit: number) {
	const body = await readTextMaybe(filePath);
	const rows = body
		.split('\n')
		.map(line => line.trim())
		.filter(Boolean)
		.map(line => JSON.parse(line) as T);
	return limit > 0 ? rows.slice(-limit) : rows;
}

async function listEpisodeSummaries(dirPath: string, limit: number) {
	const entries = await readChildJson<Episode>(dirPath, 'episode.json');
	return entries
		.sort(compareDated)
		.slice(0, limit);
}

async function listAssetSummaries(dirPath: string, limit: number) {
	const entries = await readChildJson<Asset>(dirPath, 'asset.json');
	return entries
		.sort((a, b) => {
			const weight = (b.weight ?? 0) - (a.weight ?? 0);
			return weight !== 0 ? weight : compareDated(a, b);
		})
		.slice(0, limit);
}

async function readChildJson<T>(dirPath: string, fileName: string) {
	try {
		const entries = await fs.readdir(dirPath, {withFileTypes: true});
		const out: T[] = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			try {
				out.push(JSON.parse(await fs.readFile(path.join(dirPath, entry.name, fileName), 'utf8')) as T);
			} catch {}
		}
		return out;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

function compareDated(a: {updated_at?: string; created_at?: string}, b: {updated_at?: string; created_at?: string}) {
	const at = Date.parse(a.updated_at || a.created_at || '');
	const bt = Date.parse(b.updated_at || b.created_at || '');
	return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
}

async function countDirs(dirPath: string) {
	try {
		const entries = await fs.readdir(dirPath, {withFileTypes: true});
		return entries.filter(entry => entry.isDirectory()).length;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return 0;
		}
		throw error;
	}
}

async function readdirDirs(root: string) {
	try {
		const entries = await fs.readdir(root, {withFileTypes: true});
		return entries.filter(entry => entry.isDirectory());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

async function exists(filePath: string) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

function ensureNL(value: string) {
	return value.endsWith('\n') ? value : `${value}\n`;
}

function numberArg(value: unknown, fallback: number) {
	const num = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(num) ? num : fallback;
}

function slugFromText(value: string) {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9._ -]/g, '')
		.replace(/[._ -]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
		.replace(/-+$/g, '');
	return /^[a-z]/.test(slug) && slug.length >= 2 ? slug : 'item';
}

function timestamp() {
	const date = new Date();
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function pad(value: number) {
	return String(value).padStart(2, '0');
}

const defaultAssumptionsBody = '# Assumptions\n\nModel-generated setup assumptions live here until the user confirms, rejects, or edits them. These are lower authority than canon and decisions.\n';
const defaultCanonBody = '# Canon\n\nConfirmed long-term rules live here. Do not infer new canon without user confirmation.\n\n## Voice\n- TBD\n\n## Visual Style\n- TBD\n\n## Episode Structure\n- TBD\n';
const defaultMemoryBody = '# Memory\n\n';
const defaultPlanBody = '# Plan\n\n## Backlog\n- TBD\n';
