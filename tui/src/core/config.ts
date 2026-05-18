import {promises as fs} from 'node:fs';
import path from 'node:path';
import {openmelonHome, readJsonFile, writeJsonFile} from './fs.js';
import type {ProjectDefaults, ProviderConfig} from './project.js';

export type UserConfig = {
	current_project?: string;
	defaults?: ProjectDefaults & {reasoning_effort?: string};
	providers?: Record<string, ProviderConfig>;
	trusted_dirs?: string[];
};

export type Credentials = {
	api_keys?: Record<string, string>;
};

export type ProjectEntry = {
	id: string;
	name: string;
	workdir: string;
	created_at: string;
	last_used_at?: string;
};

export type ProjectsConfig = {
	entries: ProjectEntry[];
};

export async function ensureHome() {
	const home = openmelonHome();
	await fs.mkdir(path.join(home, 'cache'), {recursive: true});
	return home;
}

export async function loadUserConfig() {
	return readJsonFile<UserConfig>(path.join(openmelonHome(), 'config.json'), {});
}

export async function saveUserConfig(config: UserConfig) {
	await ensureHome();
	await writeJsonFile(path.join(openmelonHome(), 'config.json'), config);
}

export async function loadCredentials() {
	return readJsonFile<Credentials>(path.join(openmelonHome(), 'credentials.json'), {api_keys: {}});
}

export async function saveCredentials(credentials: Credentials) {
	await ensureHome();
	await writeJsonFile(path.join(openmelonHome(), 'credentials.json'), credentials, 0o600);
}

export async function loadProjects() {
	return readJsonFile<ProjectsConfig>(path.join(openmelonHome(), 'projects.json'), {entries: []});
}

export async function saveProjects(projects: ProjectsConfig) {
	projects.entries.sort((a, b) => a.id.localeCompare(b.id));
	await ensureHome();
	await writeJsonFile(path.join(openmelonHome(), 'projects.json'), projects);
}

export function isTrusted(config: UserConfig, candidate: string) {
	const current = path.resolve(candidate);
	for (const dir of config.trusted_dirs ?? []) {
		const trusted = path.resolve(dir);
		const rel = path.relative(trusted, current);
		if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`))) {
			return true;
		}
	}
	return false;
}

export async function addTrustedDir(candidate: string) {
	const config = await loadUserConfig();
	const abs = path.resolve(candidate);
	const trusted = config.trusted_dirs ?? [];
	if (!trusted.includes(abs)) {
		config.trusted_dirs = [...trusted, abs];
		await saveUserConfig(config);
	}
}

export async function registerProject(id: string, name: string, workdir: string, options: {setCurrent?: boolean} = {}) {
	const projects = await loadProjects();
	const now = new Date().toISOString();
	const abs = path.resolve(workdir);
	const existing = projects.entries.find(entry => entry.id === id);
	if (existing) {
		existing.name = name;
		existing.workdir = abs;
		existing.last_used_at = now;
	} else {
		projects.entries.push({id, name, workdir: abs, created_at: now, last_used_at: now});
	}
	await saveProjects(projects);
	if (options.setCurrent === false) {
		return;
	}
	const config = await loadUserConfig();
	config.current_project = id;
	await saveUserConfig(config);
}

export function providerApiKeyEnv(provider: string) {
	switch (provider) {
		case 'anthropic':
			return 'ANTHROPIC_API_KEY';
		case 'openrouter':
			return 'OPENROUTER_API_KEY';
		default:
			return 'OPENAI_API_KEY';
	}
}
