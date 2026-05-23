import {promises as fs} from 'node:fs';
import path from 'node:path';
import {stateDir} from './project.js';

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

async function readJsonMaybe<T>(filePath: string): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return {} as T;
		}
		throw error;
	}
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
