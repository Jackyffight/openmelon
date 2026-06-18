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

export function providerBaseUrlEnv(provider: string) {
	switch (provider) {
		case 'anthropic':
			return 'ANTHROPIC_BASE_URL';
		case 'openrouter':
			return 'OPENROUTER_BASE_URL';
		default:
			return 'OPENAI_BASE_URL';
	}
}

export type KeySource = 'global' | 'env' | 'none';

/**
 * Resolve a provider's API key from global config/credentials/env only.
 * Accepts the old `(workdir, provider)` call shape for compatibility, but
 * intentionally ignores workdir: provider connection settings are global.
 */
export async function resolveApiKey(providerOrWorkdir: string, maybeProvider?: string): Promise<{key: string; source: KeySource}> {
	const provider = maybeProvider ?? providerOrWorkdir;
	const config = await loadUserConfig();
	const globalKey = config.providers?.[provider]?.api_key || (await loadCredentials()).api_keys?.[provider];
	if (globalKey) {
		return {key: globalKey, source: 'global'};
	}
	const envKey = process.env[providerApiKeyEnv(provider)];
	if (envKey) {
		return {key: envKey, source: 'env'};
	}
	return {key: '', source: 'none'};
}

/**
 * Resolve a provider's effective {apiKey, baseURL, keySource} from global
 * config/credentials/env only. Accepts `(workdir, provider)` for old callers.
 */
export async function resolveProvider(providerOrWorkdir: string, maybeProvider?: string): Promise<{apiKey: string; baseURL: string; keySource: string}> {
	const provider = maybeProvider ?? providerOrWorkdir;
	const config = await loadUserConfig();
	const gpc = config.providers?.[provider];
	let apiKey = '';
	let keySource = '';
	if (gpc?.api_key) {
		apiKey = gpc.api_key;
		keySource = 'global.config';
	}
	if (!apiKey) {
		const {key, source} = await resolveApiKey(provider);
		if (key) {
			apiKey = key;
			keySource = source === 'env' ? 'env' : `${source}.credentials`;
		}
	}
	const baseURL = gpc?.base_url || process.env[providerBaseUrlEnv(provider)] || '';
	return {apiKey, baseURL, keySource};
}

/** Patch global default model/provider/image/reasoning settings. */
export async function setGlobalDefaults(patch: Partial<NonNullable<UserConfig['defaults']>>) {
	const config = await loadUserConfig();
	config.defaults = {...config.defaults, ...patch};
	await saveUserConfig(config);
}

export async function setGlobalBaseUrl(provider: string, url: string) {
	const config = await loadUserConfig();
	const providers = {...config.providers};
	const entry = {...providers[provider]};
	if (url) {
		entry.base_url = url;
	} else {
		delete entry.base_url;
	}
	if (Object.keys(entry).length === 0) {
		delete providers[provider];
	} else {
		providers[provider] = entry;
	}
	config.providers = providers;
	await saveUserConfig(config);
}

export async function setGlobalApiKey(provider: string, key: string) {
	const credentials = await loadCredentials();
	credentials.api_keys = {...(credentials.api_keys ?? {}), [provider]: key};
	await saveCredentials(credentials);
}

export async function unsetGlobalApiKey(provider: string): Promise<boolean> {
	const credentials = await loadCredentials();
	if (!credentials.api_keys?.[provider]) {
		return false;
	}
	delete credentials.api_keys[provider];
	await saveCredentials(credentials);
	return true;
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
