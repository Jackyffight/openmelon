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

export async function markProjectUsed(id: string) {
	const projects = await loadProjects();
	const entry = projects.entries.find(item => item.id === id);
	if (entry) {
		entry.last_used_at = new Date().toISOString();
		await saveProjects(projects);
	}
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

export async function isTrusted(config: UserConfig, candidate: string) {
	const current = path.resolve(candidate);
	const currentReal = await realpathBestEffort(current);
	for (const dir of config.trusted_dirs ?? []) {
		const trusted = path.resolve(dir);
		const trustedReal = await realpathBestEffort(trusted);
		if (
			sameOrSubdir(trusted, current) ||
			sameOrSubdir(trustedReal, currentReal) ||
			sameOrSubdir(trusted, currentReal) ||
			sameOrSubdir(trustedReal, current)
		) {
			return true;
		}
	}
	return false;
}

export async function addTrustedDir(candidate: string) {
	const config = await loadUserConfig();
	const abs = path.resolve(candidate);
	const canonical = await realpathBestEffort(abs);
	const trusted = config.trusted_dirs ?? [];
	if (!(await isTrusted(config, canonical))) {
		config.trusted_dirs = [...trusted, canonical];
		await saveUserConfig(config);
	}
}

export async function registerProject(id: string, name: string, workdir: string, options: {setCurrent?: boolean} = {}) {
	const projects = await loadProjects();
	const now = new Date().toISOString();
	const abs = await realpathBestEffort(path.resolve(workdir));
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

async function realpathBestEffort(candidate: string) {
	try {
		return await fs.realpath(candidate);
	} catch {
		return candidate;
	}
}

function sameOrSubdir(parent: string, child: string) {
	if (!parent || !child) {
		return false;
	}
	if (child === parent) {
		return true;
	}
	const rel = path.relative(parent, child);
	return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
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

// ---------------------------------------------------------------------------
// GLOBAL config is the single source of truth for model / provider / key /
// base_url. There is intentionally no project-level override: the project file
// only carries identity, persona, constraints, continuity, and the per-project
// `reasoning_effort` behaviour knob. Everything below resolves from
// ~/.openmelon/{config,credentials}.json and env vars ONLY — never the workdir.
// ---------------------------------------------------------------------------

/** Resolve a provider's api key + base url from global config only:
 *  config.json providers[] (base_url) → credentials.json (key) → env. */
export async function resolveProvider(provider: string): Promise<{apiKey: string; baseURL: string}> {
	const config = await loadUserConfig();
	const credentials = await loadCredentials();
	const globalProvider = config.providers?.[provider];
	const apiKey =
		globalProvider?.api_key || credentials.api_keys?.[provider] || process.env[providerApiKeyEnv(provider)] || '';
	const baseURL = globalProvider?.base_url || process.env[providerBaseUrlEnv(provider)] || '';
	return {apiKey, baseURL};
}

export async function resolveApiKey(provider: string): Promise<{key: string; source: KeySource}> {
	const config = await loadUserConfig();
	const credentials = await loadCredentials();
	const globalKey = config.providers?.[provider]?.api_key || credentials.api_keys?.[provider];
	if (globalKey) {
		return {key: globalKey, source: 'global'};
	}
	const envKey = process.env[providerApiKeyEnv(provider)];
	if (envKey) {
		return {key: envKey, source: 'env'};
	}
	return {key: '', source: 'none'};
}

/** Patch the global default model / provider / image-model / reasoning. */
export async function setGlobalDefaults(patch: Partial<NonNullable<UserConfig['defaults']>>) {
	const config = await loadUserConfig();
	config.defaults = {...config.defaults, ...patch};
	await saveUserConfig(config);
}

/** Set (or, with an empty url, clear) a provider's global base_url. */
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
	credentials.api_keys = {...credentials.api_keys, [provider]: key};
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
