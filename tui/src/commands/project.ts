import {
	loadProjects,
	loadUserConfig,
	markProjectUsed,
	providerApiKeyEnv,
	resolveApiKey,
	saveUserConfig,
	setGlobalApiKey,
	setGlobalBaseUrl,
	unsetGlobalApiKey
} from '../core/config.js';
import {providers} from '../core/providers.js';
import {formatTable, maskKey, parseArgs, resolveProjectWorkdir, stringFlag} from './common.js';

export async function runProjectCommand(args: string[]) {
	const [subcommand, ...rest] = args;
	switch (subcommand) {
		case 'list':
			return projectList();
		case 'use':
			return projectUse(rest);
		case 'show':
			return projectShow(rest);
		case 'set-key':
			return projectSetKey(rest);
		case 'unset-key':
			return projectUnsetKey(rest);
		case 'keys':
			return projectKeys();
		default:
			throw new Error('usage: openmelon project <list|use|show|set-key|unset-key|keys>');
	}
}

async function projectList() {
	const [projects, config] = await Promise.all([loadProjects(), loadUserConfig()]);
	if (projects.entries.length === 0) {
		console.log('No projects registered. Run `openmelon init` in a project dir.');
		return;
	}
	console.log(formatTable(['ID', 'NAME', 'WORKDIR', 'CURRENT'], projects.entries.map(entry => [entry.id, entry.name, entry.workdir, entry.id === config.current_project ? '*' : ''])));
}

async function projectUse(args: string[]) {
	if (args.length !== 1) {
		throw new Error('usage: openmelon project use <id>');
	}
	const projects = await loadProjects();
	if (!projects.entries.some(entry => entry.id === args[0])) {
		throw new Error(`project ${args[0]} is not registered`);
	}
	const config = await loadUserConfig();
	config.current_project = args[0];
	await saveUserConfig(config);
	await markProjectUsed(args[0]!);
	console.log(`Current project: ${args[0]}`);
}

async function projectShow(args: string[]) {
	const {workdir, project} = await resolveProjectWorkdir(args);
	console.log(`ID:           ${project.id}`);
	console.log(`Name:         ${project.name}`);
	console.log(`Workdir:      ${workdir}`);
	if (project.description) {
		console.log(`Description:  ${project.description}`);
	}
	if (project.persona) {
		console.log(`Persona:      ${project.persona}`);
	}
	if (project.constraints?.length) {
		console.log('Constraints:');
		for (const item of project.constraints) {
			console.log(`  - ${item}`);
		}
	}
	// Model / provider / image defaults are GLOBAL, not per-project.
	const config = await loadUserConfig();
	if (config.defaults && Object.keys(config.defaults).length > 0) {
		console.log('Defaults (global):');
		for (const [key, value] of Object.entries(config.defaults)) {
			if (value) {
				console.log(`  ${key}: ${value}`);
			}
		}
	}
	if (project.settings && Object.keys(project.settings).length > 0) {
		console.log('Settings (project):');
		for (const [key, value] of Object.entries(project.settings)) {
			if (value) {
				console.log(`  ${key}: ${value}`);
			}
		}
	}
	await printKeySources();
}

async function projectSetKey(args: string[]) {
	const parsed = parseArgs(args, {'api-key': 'string', key: 'string', 'base-url': 'string'});
	const provider = parsed.positionals[0] || stringFlag(parsed, 'provider', '');
	if (!provider) {
		throw new Error('usage: openmelon project set-key <provider> --api-key <key> [--base-url <url>]');
	}
	const key = stringFlag(parsed, 'api-key') || stringFlag(parsed, 'key') || process.env[providerApiKeyEnv(provider)] || '';
	if (!key) {
		throw new Error(`set-key: pass --api-key or set ${providerApiKeyEnv(provider)}`);
	}
	// Keys / base_url live in GLOBAL config — there is no project-scoped store.
	await setGlobalApiKey(provider, key);
	const baseURL = stringFlag(parsed, 'base-url');
	if (baseURL) {
		await setGlobalBaseUrl(provider, baseURL);
	}
	console.log(`Saved global key for ${provider}.`);
}

async function projectUnsetKey(args: string[]) {
	if (args.length !== 1) {
		throw new Error('usage: openmelon project unset-key <provider>');
	}
	const removed = await unsetGlobalApiKey(args[0]!);
	console.log(removed ? `Removed global key for ${args[0]}.` : `No key set for ${args[0]} (nothing to remove).`);
}

async function projectKeys() {
	await printKeySources(true);
}

async function printKeySources(includeMissing = false) {
	const config = await loadUserConfig();
	const rows: string[][] = [];
	for (const provider of providers.map(item => item.slug)) {
		const {key, source} = await resolveApiKey(provider);
		const baseURL = config.providers?.[provider]?.base_url || '';
		if (key || includeMissing) {
			rows.push([provider, source === 'none' ? '(none)' : source, key ? maskKey(key) : '', baseURL]);
		}
	}
	if (rows.length > 0) {
		console.log('Credentials (global):');
		console.log(formatTable(['PROVIDER', 'SOURCE', 'KEY', 'BASE_URL'], rows));
	}
}
