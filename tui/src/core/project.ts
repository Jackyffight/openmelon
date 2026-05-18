import {promises as fs} from 'node:fs';
import path from 'node:path';
import {findUp, readJsonFile, writeJsonFile} from './fs.js';

export type ProjectDefaults = {
	llm_provider?: string;
	llm_model?: string;
	image_provider?: string;
	image_model?: string;
	vision_model?: string;
	locale?: string;
};

export type ProviderConfig = {
	api_key?: string;
	base_url?: string;
};

export type ProjectSettings = {
	bash_permission_mode?: 'strict' | 'auto' | 'trusted';
	reasoning_effort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
};

export type ProjectConfig = {
	id: string;
	name: string;
	description?: string;
	persona?: string;
	constraints?: string[];
	defaults?: ProjectDefaults;
	providers?: Record<string, ProviderConfig>;
	settings?: ProjectSettings;
	created_at?: string;
};

export const stateDirName = '.openmelon';
export const projectFileName = 'project.json';

export async function discoverProject(start = process.cwd()) {
	return findUp(start, path.join(stateDirName, projectFileName));
}

export async function loadProject(workdir: string) {
	return readJsonFile<ProjectConfig>(projectPath(workdir), {id: '', name: ''});
}

export async function saveProject(workdir: string, project: ProjectConfig) {
	await writeJsonFile(projectPath(workdir), project);
}

export function projectPath(workdir: string) {
	return path.join(workdir, stateDirName, projectFileName);
}

export function stateDir(workdir: string) {
	return path.join(workdir, stateDirName);
}

export function outputsDir(workdir: string) {
	return path.join(workdir, 'outputs');
}

export async function initProject(workdir: string, project: ProjectConfig) {
	const existing = await discoverProject(workdir);
	if (existing === path.resolve(workdir)) {
		return {created: false};
	}
	for (const subdir of ['characters', 'references', 'materials', 'sessions', 'spaces']) {
		await fs.mkdir(path.join(stateDir(workdir), subdir), {recursive: true});
	}
	await fs.mkdir(outputsDir(workdir), {recursive: true});
	await writeJsonFile(projectPath(workdir), project);
	await ensureProjectGitignore(workdir);
	return {created: true};
}

export function slugFromBase(base: string) {
	const slug = base
		.toLowerCase()
		.replace(/[^a-z0-9._ -]/g, '')
		.replace(/[._ -]+/g, '-')
		.replace(/^-+|-+$/g, '');
	const normalized = /^[a-z]/.test(slug) ? slug : `project-${slug}`.replace(/-+$/g, '');
	return normalized.length >= 2 ? normalized : 'project';
}

export function validateProjectId(id: string) {
	if (id.length < 2 || id.length > 64) {
		throw new Error(`project id ${JSON.stringify(id)} must be 2..64 chars`);
	}
	if (!/^[a-z][a-z0-9-]*$/.test(id)) {
		throw new Error(`project id ${JSON.stringify(id)} must be kebab-case`);
	}
	if (id.endsWith('-') || id.includes('--')) {
		throw new Error(`project id ${JSON.stringify(id)} must not end with '-' or contain '--'`);
	}
}

export async function ensureProjectGitignore(workdir: string) {
	const target = path.join(stateDir(workdir), '.gitignore');
	try {
		await fs.access(target);
		return;
	} catch {}
	await fs.mkdir(stateDir(workdir), {recursive: true});
	await fs.writeFile(target, gitignoreContent);
}

const gitignoreContent = `# openmelon - auto-generated. Edit if you want different defaults.
# These paths are relative to this .openmelon/ directory.

# API keys.
credentials.json

# Per-run conversation transcripts + generated images.
sessions/

# Legacy hidden outputs. User-facing outputs go under ../outputs/.
artifacts/
`;
