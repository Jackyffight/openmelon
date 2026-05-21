import {loadCredentials, loadProjects, loadUserConfig, markProjectUsed, providerApiKeyEnv, saveUserConfig} from '../core/config.js';
import {loadProject, saveProject, type ProjectConfig} from '../core/project.js';
import {providers} from '../core/providers.js';
import {formatTable, maskKey, parseArgs, projectCredentialsPath, readJsonMaybe, resolveProjectWorkdir, stringFlag, writeJson} from './common.js';

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
	if (project.defaults && Object.keys(project.defaults).length > 0) {
		console.log('Defaults:');
		for (const [key, value] of Object.entries(project.defaults)) {
			if (value) {
				console.log(`  ${key}: ${value}`);
			}
		}
	}
	if (project.settings && Object.keys(project.settings).length > 0) {
		console.log('Settings:');
		for (const [key, value] of Object.entries(project.settings)) {
			if (value) {
				console.log(`  ${key}: ${value}`);
			}
		}
	}
	await printKeySources(workdir, project);
}

async function projectSetKey(args: string[]) {
	const parsed = parseArgs(args, {'api-key': 'string', key: 'string', 'base-url': 'string'});
	const provider = parsed.positionals[0] || stringFlag(parsed, 'provider', '');
	if (!provider) {
		throw new Error('usage: openmelon project set-key <provider> --api-key <key> [--base-url <url>]');
	}
	const key = stringFlag(parsed, 'api-key') || stringFlag(parsed, 'key') || process.env[providerApiKeyEnv(provider)] || '';
	if (!key) {
		throw new Error(`project set-key: pass --api-key or set ${providerApiKeyEnv(provider)}`);
	}
	const {workdir} = await resolveProjectWorkdir();
	const credentials = await readJsonMaybe<{api_keys?: Record<string, string>}>(projectCredentialsPath(workdir), {api_keys: {}});
	credentials.api_keys = {...credentials.api_keys, [provider]: key};
	await writeJson(projectCredentialsPath(workdir), credentials, 0o600);
	const baseURL = stringFlag(parsed, 'base-url');
	if (baseURL) {
		const project = await loadProject(workdir);
		project.providers = {...project.providers, [provider]: {...project.providers?.[provider], base_url: baseURL}};
		await saveProject(workdir, project);
	}
	console.log(`Saved project key for ${provider}.`);
}

async function projectUnsetKey(args: string[]) {
	if (args.length !== 1) {
		throw new Error('usage: openmelon project unset-key <provider>');
	}
	const {workdir} = await resolveProjectWorkdir();
	const credentials = await readJsonMaybe<{api_keys?: Record<string, string>}>(projectCredentialsPath(workdir), {api_keys: {}});
	if (!credentials.api_keys?.[args[0]!]) {
		console.log(`No project-scoped key set for ${args[0]} (nothing to remove).`);
		return;
	}
	delete credentials.api_keys[args[0]!];
	await writeJson(projectCredentialsPath(workdir), credentials, 0o600);
	console.log(`Removed project key for ${args[0]}.`);
}

async function projectKeys() {
	const {workdir, project} = await resolveProjectWorkdir();
	await printKeySources(workdir, project, true);
}

async function printKeySources(workdir: string, project: ProjectConfig, includeMissing = false) {
	const config = await loadUserConfig();
	const credentials = await loadCredentials();
	const projectCredentials = await readJsonMaybe<{api_keys?: Record<string, string>}>(projectCredentialsPath(workdir), {api_keys: {}});
	const rows: string[][] = [];
	for (const provider of providers.map(item => item.slug)) {
		const projectProvider = project.providers?.[provider];
		const globalProvider = config.providers?.[provider];
		let source = '';
		let key = '';
		if (projectProvider?.api_key) {
			source = 'project';
			key = projectProvider.api_key;
		} else if (projectCredentials.api_keys?.[provider]) {
			source = 'project';
			key = projectCredentials.api_keys[provider]!;
		} else if (globalProvider?.api_key) {
			source = 'global';
			key = globalProvider.api_key;
		} else if (credentials.api_keys?.[provider]) {
			source = 'global';
			key = credentials.api_keys[provider]!;
		} else if (process.env[providerApiKeyEnv(provider)]) {
			source = 'env';
			key = process.env[providerApiKeyEnv(provider)]!;
		}
		if (key || includeMissing) {
			rows.push([provider, source || '(none)', key ? maskKey(key) : '']);
		}
	}
	if (rows.length > 0) {
		console.log('Credentials:');
		console.log(formatTable(['PROVIDER', 'SOURCE', 'VALUE'], rows));
	}
}
