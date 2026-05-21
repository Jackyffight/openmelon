import {promises as fs} from 'node:fs';
import path from 'node:path';
import {loadProjects, loadUserConfig} from '../core/config.js';
import {discoverProject, loadProject, projectPath, type ProjectConfig} from '../core/project.js';

export type ResolvedProject = {
	workdir: string;
	project: ProjectConfig;
};

export type FlagSpec = Record<string, 'string' | 'boolean' | 'number' | 'repeat'>;

export type ParsedArgs = {
	flags: Record<string, string | boolean | number | string[]>;
	positionals: string[];
};

export async function resolveProjectWorkdir(args: string[] = []): Promise<ResolvedProject> {
	if (args.length >= 2 && args[0] === '-C') {
		const workdir = path.resolve(args[1]!);
		return {workdir, project: await loadProject(workdir)};
	}

	const discovered = await discoverProject();
	if (discovered) {
		return {workdir: discovered, project: await loadProject(discovered)};
	}

	const config = await loadUserConfig();
	if (!config.current_project) {
		throw new Error('no current project; run `openmelon init` in a project dir');
	}
	const projects = await loadProjects();
	const entry = projects.entries.find(item => item.id === config.current_project);
	if (!entry) {
		throw new Error(`current project ${config.current_project} is not registered`);
	}
	return {workdir: entry.workdir, project: await loadProject(entry.workdir)};
}

export function parseArgs(args: string[], spec: FlagSpec = {}): ParsedArgs {
	const flags: ParsedArgs['flags'] = {};
	const positionals: string[] = [];
	let endOfFlags = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (endOfFlags) {
			positionals.push(arg);
			continue;
		}
		if (arg === '--') {
			endOfFlags = true;
			continue;
		}
		if (!arg.startsWith('-') || arg === '-') {
			positionals.push(arg);
			continue;
		}

		const [rawName, inlineValue] = arg.replace(/^-+/, '').split('=', 2);
		const name = rawName ?? '';
		const kind = spec[name] ?? 'string';
		if (kind === 'boolean') {
			flags[name] = inlineValue === undefined ? true : inlineValue !== 'false';
			continue;
		}
		const rawValue = inlineValue ?? args[++index];
		if (rawValue === undefined) {
			throw new Error(`missing value for --${name}`);
		}
		if (kind === 'number') {
			const value = Number(rawValue);
			if (!Number.isFinite(value)) {
				throw new Error(`invalid number for --${name}: ${rawValue}`);
			}
			flags[name] = value;
			continue;
		}
		if (kind === 'repeat') {
			const existing = flags[name];
			flags[name] = [...(Array.isArray(existing) ? existing : []), rawValue];
			continue;
		}
		flags[name] = rawValue;
	}

	return {flags, positionals};
}

export function stringFlag(parsed: ParsedArgs, name: string, fallback = '') {
	const value = parsed.flags[name];
	return typeof value === 'string' ? value : fallback;
}

export function boolFlag(parsed: ParsedArgs, name: string, fallback = false) {
	const value = parsed.flags[name];
	return typeof value === 'boolean' ? value : fallback;
}

export function numberFlag(parsed: ParsedArgs, name: string, fallback: number) {
	const value = parsed.flags[name];
	return typeof value === 'number' ? value : fallback;
}

export function repeatFlag(parsed: ParsedArgs, name: string) {
	const value = parsed.flags[name];
	return Array.isArray(value) ? value : [];
}

export function formatTable(headers: string[], rows: Array<Array<string | number>>) {
	const widths = headers.map((header, index) => Math.max(header.length, ...rows.map(row => String(row[index] ?? '').length)));
	const formatRow = (row: Array<string | number>) => row.map((cell, index) => String(cell ?? '').padEnd(widths[index]!)).join('  ').trimEnd();
	return [formatRow(headers), ...rows.map(formatRow)].join('\n');
}

export function truncate(value: string, max = 72) {
	return value.length > max ? `${value.slice(0, max)}...` : value;
}

export function maskKey(value: string) {
	if (value.length <= 8) {
		return '***';
	}
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export async function writeJson(filePath: string, value: unknown, mode?: number) {
	await fs.mkdir(path.dirname(filePath), {recursive: true});
	await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, mode === undefined ? undefined : {mode});
	if (mode !== undefined) {
		await fs.chmod(filePath, mode);
	}
}

export async function readJsonMaybe<T>(filePath: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return fallback;
		}
		throw error;
	}
}

export async function pathExists(filePath: string) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export function projectCredentialsPath(workdir: string) {
	return path.join(path.dirname(projectPath(workdir)), 'credentials.json');
}
