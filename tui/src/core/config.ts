import {promises as fs} from 'node:fs';
import path from 'node:path';
import {openmelonHome, readJsonFile, writeJsonFile} from './fs.js';
import {loadProject, stateDir, type ProjectDefaults, type ProviderConfig} from './project.js';

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

function providerBaseUrlEnv(provider: string) {
	switch (provider) {
		case 'anthropic':
			return 'ANTHROPIC_BASE_URL';
		case 'openrouter':
			return 'OPENROUTER_BASE_URL';
		default:
			return 'OPENAI_BASE_URL';
	}
}

// --- project-scoped credentials (<workdir>/.openmelon/credentials.json) ---

function projectCredentialsPath(workdir: string) {
	return path.join(stateDir(workdir), 'credentials.json');
}

export async function loadProjectCredentials(workdir: string): Promise<Credentials> {
	return readJsonFile<Credentials>(projectCredentialsPath(workdir), {api_keys: {}});
}

export async function saveProjectCredentials(workdir: string, credentials: Credentials) {
	await writeJsonFile(projectCredentialsPath(workdir), {api_keys: credentials.api_keys ?? {}}, 0o600);
}

export async function setProjectApiKey(workdir: string, provider: string, key: string) {
	const creds = await loadProjectCredentials(workdir);
	creds.api_keys = {...(creds.api_keys ?? {}), [provider]: key};
	await saveProjectCredentials(workdir, creds);
}

/** Remove a provider's project-scoped key. Returns true if one was removed. */
export async function unsetProjectApiKey(workdir: string, provider: string): Promise<boolean> {
	const creds = await loadProjectCredentials(workdir);
	if (!creds.api_keys?.[provider]) {
		return false;
	}
	delete creds.api_keys[provider];
	await saveProjectCredentials(workdir, creds);
	return true;
}

export type KeySource = 'project' | 'global' | 'none';

/**
 * Resolve a provider's API key with project-overrides-global semantics
 * (project credentials.json → global credentials.json). Env vars are NOT
 * consulted here (the factories apply that fallback). Mirrors Go ResolveAPIKey.
 */
export async function resolveApiKey(workdir: string, provider: string): Promise<{key: string; source: KeySource}> {
	if (workdir) {
		const projectKey = (await loadProjectCredentials(workdir)).api_keys?.[provider];
		if (projectKey) {
			return {key: projectKey, source: 'project'};
		}
	}
	const globalKey = (await loadCredentials()).api_keys?.[provider];
	if (globalKey) {
		return {key: globalKey, source: 'global'};
	}
	return {key: '', source: 'none'};
}

/**
 * Resolve a provider's effective {apiKey, baseURL, keySource}. Precedence:
 * project.json providers → global config providers → project/global
 * credentials.json → env. Mirrors Go userconfig.ResolveProvider.
 */
export async function resolveProvider(workdir: string, provider: string): Promise<{apiKey: string; baseURL: string; keySource: string}> {
	let apiKey = '';
	let baseURL = '';
	let keySource = '';

	if (workdir) {
		const project = await loadProject(workdir);
		const pc = project.providers?.[provider];
		if (pc?.api_key) {
			apiKey = pc.api_key;
			keySource = 'project.config';
		}
		if (pc?.base_url) {
			baseURL = pc.base_url;
		}
	}

	const config = await loadUserConfig();
	const gpc = config.providers?.[provider];
	if (!apiKey && gpc?.api_key) {
		apiKey = gpc.api_key;
		keySource = 'global.config';
	}
	if (!baseURL && gpc?.base_url) {
		baseURL = gpc.base_url;
	}

	if (!apiKey) {
		const {key, source} = await resolveApiKey(workdir, provider);
		if (key) {
			apiKey = key;
			keySource = `${source}.credentials`;
		}
	}
	if (!apiKey) {
		const envKey = process.env[providerApiKeyEnv(provider)];
		if (envKey) {
			apiKey = envKey;
			keySource = 'env';
		}
	}
	if (!baseURL) {
		baseURL = process.env[providerBaseUrlEnv(provider)] ?? '';
	}
	return {apiKey, baseURL, keySource};
}

// --- project registry (~/.openmelon/projects.json) ---

export class NoCurrentProjectError extends Error {
	constructor() {
		super('no current project — run `openmelon init` in a project directory or `openmelon project use <id>`');
		this.name = 'NoCurrentProjectError';
	}
}

/** Look up a registered project by id. Throws if not found. */
export async function lookup(id: string): Promise<ProjectEntry> {
	const entry = (await loadProjects()).entries.find(e => e.id === id);
	if (!entry) {
		throw new Error(`project ${JSON.stringify(id)} is not registered (run \`openmelon init\` in its directory)`);
	}
	return entry;
}

/** Set the current project. */
export async function setCurrent(id: string) {
	const config = await loadUserConfig();
	config.current_project = id;
	await saveUserConfig(config);
}

/** Bump a project's last_used_at timestamp. No-op if unregistered. */
export async function markUsed(id: string) {
	const projects = await loadProjects();
	const entry = projects.entries.find(e => e.id === id);
	if (entry) {
		entry.last_used_at = new Date().toISOString();
		await saveProjects(projects);
	}
}

/** Mask an API key for display: first 4 + … + last 4, or ••• if short. */
export function maskKey(key: string): string {
	return key.length <= 8 ? '•••' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}
