// TS ports of the legacy management CLI subcommands, replacing the Go
// shell-out (`runLegacy`) for: character / reference / material / search /
// session. (project + space are still routed to Go pending their port.)
//
// Flag/output surfaces mirror cmd_registry.go, cmd_search.go, cmd_session.go.

import {discoverProject, loadProject, type ProjectConfig} from '../core/project.js';
import {add, addMaterial, get, list, remove, type Item, type Kind} from '../engine/registry.js';
import {parse as parseQuery, run as runQuery} from '../engine/search.js';
import {loadSessionEvents} from '../core/session.js';
import * as cont from '../engine/continuity.js';
import {
	loadCredentials,
	loadProjects,
	loadUserConfig,
	lookup,
	markUsed,
	maskKey,
	NoCurrentProjectError,
	resolveApiKey,
	resolveProvider,
	saveCredentials,
	setCurrent,
	setProjectApiKey,
	unsetProjectApiKey
} from '../core/config.js';

/** Subcommands handled in TS. Others fall back to the Go binary in cli.ts. */
export const tsManagedCommands = new Set(['character', 'reference', 'material', 'search', 'session', 'project', 'space']);

const keyProviders = ['openrouter', 'openai', 'anthropic'];

export async function runManage(command: string, args: string[]): Promise<void> {
	switch (command) {
		case 'character':
			return runRegistry('character', args);
		case 'reference':
			return runRegistry('reference', args);
		case 'material':
			return runMaterial(args);
		case 'search':
			return runSearch(args);
		case 'session':
			return runSession(args);
		case 'project':
			return runProject(args);
		case 'space':
			return runSpace(args);
		default:
			throw new Error(`unknown management command: ${command}`);
	}
}

async function runSpace(args: string[]): Promise<void> {
	const [sub, ...rest] = args;
	switch (sub) {
		case 'create':
			return spaceCreate(rest);
		case 'activate':
			return spaceActivate(rest);
		case 'list':
			return spaceList();
		case 'show':
			return spaceShow(rest);
		case 'context':
			return spaceContext(rest);
		case 'search':
			return spaceSearch(rest);
		case 'decision':
			return spaceDecision(rest);
		case 'feedback':
			return spaceFeedback(rest);
		case 'memory':
			return spaceMemory(rest);
		case 'promote':
			return spacePromote(rest);
		case 'episode':
			return spaceEpisode(rest);
		case 'asset':
			return spaceAsset(rest);
		case 'asset-weight':
			return spaceAssetWeight(rest);
		case 'compact':
			return spaceCompact(rest);
		default:
			throw new Error(
				'usage: openmelon space <create|activate|list|show|context|search|decision|feedback|memory|promote|episode|asset|asset-weight|compact> ...'
			);
	}
}

async function projectIdFor(wd: string): Promise<string> {
	return (await loadProject(wd)).id;
}

async function spaceCreate(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: [], repeatable: ['tag'], valued: ['name', 'platform', 'audience', 'description', 'assumptions']});
	const id = p.positionals[0];
	if (!id || p.positionals.length !== 1) {
		throw new Error('usage: openmelon space create <id> [--name ...] [--description ...] [--tag t]...');
	}
	const wd = await resolveProjectWorkdir();
	const sp = await cont.createSpace(wd, {
		id,
		name: p.value('name'),
		platform: p.value('platform'),
		audience: p.value('audience'),
		description: p.value('description'),
		tags: p.repeated('tag'),
		assumptions: p.value('assumptions')
	});
	console.log(`Created space ${sp.id}`);
	console.log(`  dir: ${cont.spaceDir(wd, sp.id)}`);
}

async function spaceActivate(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: [], repeatable: [], valued: ['reason', 'weight']});
	if (p.positionals.length < 2) {
		throw new Error('usage: openmelon space activate <space-id> <confirmed decision...>');
	}
	const wd = await resolveProjectWorkdir();
	const res = await cont.activateSpace(wd, p.positionals[0]!, {
		decision: p.positionals.slice(1).join(' '),
		reason: p.value('reason'),
		weight: Number.parseFloat(p.value('weight')) || 1.0
	});
	console.log(`Activated space ${res.space.id} with decision ${res.decision.id}`);
}

async function spaceList(): Promise<void> {
	const spaces = await cont.listSpaces(await resolveProjectWorkdir());
	if (spaces.length === 0) {
		console.log('No creative spaces in this project.');
		return;
	}
	printTable(
		['ID', 'NAME', 'STATUS', 'TAGS', 'DESCRIPTION'],
		spaces.map(sp => [sp.id, sp.name, sp.status ?? '', (sp.tags ?? []).join(','), clip(sp.description ?? '', 72)])
	);
}

async function spaceShow(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: ['json'], repeatable: [], valued: []});
	const id = p.positionals[0];
	if (!id || p.positionals.length !== 1) {
		throw new Error('usage: openmelon space show <id> [--json]');
	}
	const wd = await resolveProjectWorkdir();
	const packet = await cont.buildSelectedContextPacket(wd, await projectIdFor(wd), id, {});
	if (p.bool('json')) {
		console.log(JSON.stringify(packet, null, 2));
		return;
	}
	const sp = packet.space;
	console.log(`ID:          ${sp.id}`);
	console.log(`Name:        ${sp.name}`);
	if (sp.platform) {
		console.log(`Platform:    ${sp.platform}`);
	}
	if (sp.audience) {
		console.log(`Audience:    ${sp.audience}`);
	}
	if (sp.description) {
		console.log(`Description: ${sp.description}`);
	}
	if ((sp.tags ?? []).length > 0) {
		console.log(`Tags:        ${sp.tags!.join(', ')}`);
	}
	if (packet.assumptions?.trim()) {
		console.log('\nAssumptions:');
		process.stdout.write(packet.assumptions);
	}
	if (packet.canon?.trim()) {
		console.log('\nCanon:');
		process.stdout.write(packet.canon);
	}
	console.log(
		`\nRecent: ${packet.recent_decisions.length} decisions, ${packet.recent_feedback.length} feedback items, ${packet.recent_episodes.length} episodes, ${packet.assets.length} assets`
	);
}

async function spaceContext(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: [], repeatable: [], valued: ['query', 'max-decisions', 'max-feedback', 'max-episodes', 'max-assets']});
	const id = p.positionals[0];
	if (!id || p.positionals.length !== 1) {
		throw new Error('usage: openmelon space context <id> [--query ...] [--max-assets n] [--max-decisions n]');
	}
	const wd = await resolveProjectWorkdir();
	const packet = await cont.buildSelectedContextPacket(wd, await projectIdFor(wd), id, {
		query: p.value('query'),
		maxDecisions: Number.parseInt(p.value('max-decisions'), 10) || 0,
		maxFeedback: Number.parseInt(p.value('max-feedback'), 10) || 0,
		maxEpisodes: Number.parseInt(p.value('max-episodes'), 10) || 0,
		maxAssets: Number.parseInt(p.value('max-assets'), 10) || 0
	});
	console.log(JSON.stringify(packet, null, 2));
}

async function spaceSearch(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: [], repeatable: [], valued: []});
	if (p.positionals.length === 0) {
		throw new Error('usage: openmelon space search <query>...');
	}
	const hits = await cont.searchSpaces(await resolveProjectWorkdir(), p.positionals.join(' '));
	if (hits.length === 0) {
		console.log('No matches.');
		return;
	}
	printTable(
		['SCORE', 'ID', 'NAME', 'DESCRIPTION'],
		hits.map(h => [String(h.score), h.space.id, h.space.name, clip(h.space.description ?? '', 72)])
	);
}

async function spaceDecision(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: [], repeatable: [], valued: ['scope', 'target', 'reason', 'weight']});
	if (p.positionals.length < 2) {
		throw new Error('usage: openmelon space decision <space-id> <decision text...>');
	}
	const d = await cont.recordDecision(await resolveProjectWorkdir(), p.positionals[0]!, {
		scope: p.value('scope') || 'space',
		target: p.value('target'),
		decision: p.positionals.slice(1).join(' '),
		reason: p.value('reason'),
		weight: Number.parseFloat(p.value('weight')) || 1.0
	});
	console.log(`Recorded decision ${d.id}`);
}

async function spaceFeedback(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: [], repeatable: [], valued: ['episode', 'source', 'evidence', 'recommendation']});
	if (p.positionals.length < 2) {
		throw new Error('usage: openmelon space feedback <space-id> <signal> [--evidence ...] [--recommendation ...]');
	}
	const f = await cont.recordFeedback(await resolveProjectWorkdir(), p.positionals[0]!, {
		episode_id: p.value('episode'),
		source: p.value('source') || 'user',
		signal: p.positionals[1]!,
		evidence: p.value('evidence'),
		recommendation: p.value('recommendation')
	});
	console.log(`Recorded feedback ${f.id}`);
}

async function spaceMemory(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: [], repeatable: [], valued: ['id', 'kind', 'scope', 'target', 'source', 'weight', 'status']});
	if (p.positionals.length < 2) {
		throw new Error('usage: openmelon space memory <space-id> <content...> [--id mem-x] [--kind observation]');
	}
	const item = await cont.recordMemoryItem(await resolveProjectWorkdir(), p.positionals[0]!, {
		id: p.value('id') || undefined,
		kind: p.value('kind') || 'observation',
		scope: p.value('scope'),
		target: p.value('target'),
		content: p.positionals.slice(1).join(' '),
		source: p.value('source') || 'user',
		weight: Number.parseFloat(p.value('weight')) || 0.5,
		status: p.value('status') || 'provisional'
	});
	console.log(`Recorded memory item ${item.id}`);
}

async function spacePromote(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: [], repeatable: [], valued: ['reason', 'target']});
	if (p.positionals.length < 3) {
		throw new Error('usage: openmelon space promote <space-id> <memory-id> <decision...>');
	}
	const d = await cont.promoteMemoryItem(await resolveProjectWorkdir(), p.positionals[0]!, {
		item_id: p.positionals[1]!,
		decision: p.positionals.slice(2).join(' '),
		reason: p.value('reason'),
		target: p.value('target')
	});
	console.log(`Promoted memory into decision ${d.id}`);
}

async function spaceEpisode(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: [], repeatable: [], valued: ['id', 'title', 'status', 'brief']});
	if (p.positionals.length < 2) {
		throw new Error('usage: openmelon space episode <space-id> <topic...> [--id ...] [--brief ...]');
	}
	const ep = await cont.createEpisode(await resolveProjectWorkdir(), p.positionals[0]!, {
		id: p.value('id') || undefined,
		title: p.value('title'),
		topic: p.positionals.slice(1).join(' '),
		status: p.value('status') || 'draft',
		brief: p.value('brief')
	});
	console.log(`Created episode ${ep.id}`);
}

async function spaceAsset(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: [], repeatable: ['file', 'tag'], valued: ['id', 'kind', 'status', 'reuse', 'weight']});
	if (p.positionals.length < 2) {
		throw new Error('usage: openmelon space asset <space-id> <description...> [--kind ...] [--file path]...');
	}
	const a = await cont.registerAsset(await resolveProjectWorkdir(), p.positionals[0]!, {
		id: p.value('id') || undefined,
		kind: p.value('kind'),
		status: p.value('status') || 'active',
		description: p.positionals.slice(1).join(' '),
		reuse_policy: p.value('reuse'),
		files: p.repeated('file'),
		tags: p.repeated('tag'),
		weight: Number.parseFloat(p.value('weight')) || 1.0
	});
	console.log(`Registered asset ${a.id}`);
}

async function spaceAssetWeight(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: [], repeatable: [], valued: ['status']});
	if (p.positionals.length !== 3) {
		throw new Error('usage: openmelon space asset-weight <space-id> <asset-id> <weight> [--status archived]');
	}
	const weight = Number.parseFloat(p.positionals[2]!);
	if (Number.isNaN(weight)) {
		throw new Error(`asset-weight: invalid weight ${JSON.stringify(p.positionals[2])}`);
	}
	const a = await cont.updateAssetWeight(await resolveProjectWorkdir(), p.positionals[0]!, p.positionals[1]!, weight, p.value('status'));
	let line = `Updated asset ${a.id} weight to ${(a.weight ?? 0).toFixed(2)}`;
	if (a.status) {
		line += ` (${a.status})`;
	}
	console.log(line);
}

async function spaceCompact(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: ['draft'], repeatable: [], valued: ['summary', 'scope']});
	const id = p.positionals[0];
	if (!id || p.positionals.length !== 1) {
		throw new Error('usage: openmelon space compact <space-id> [--draft | --summary ...]');
	}
	const wd = await resolveProjectWorkdir();
	const draft = p.bool('draft');
	const summary = p.value('summary').trim();
	if (draft || !summary) {
		const body = await cont.buildCompactionDraft(wd, await projectIdFor(wd), id);
		process.stdout.write(body);
		if (draft) {
			return;
		}
		throw new Error('space compact: pass --summary to record a compaction, or --draft to only print the draft');
	}
	const c = await cont.recordSpaceCompaction(wd, id, {summary, scope: p.value('scope') || 'space'});
	console.log(`Recorded compaction ${c.id}`);
}

/** Workdir resolution: cwd project → current registered project. */
async function resolveProjectWorkdir(): Promise<string> {
	const wd = await discoverProject();
	if (wd) {
		return wd;
	}
	const cfg = await loadUserConfig();
	if (!cfg.current_project) {
		throw new NoCurrentProjectError();
	}
	return (await lookup(cfg.current_project)).workdir;
}

async function runProject(args: string[]): Promise<void> {
	const [sub, ...rest] = args;
	switch (sub) {
		case 'list':
			return projectList();
		case 'use':
			return projectUse(rest);
		case 'show':
			return projectShow();
		case 'keys':
			return projectKeys();
		case 'set-key':
			return projectSetKey(rest);
		case 'unset-key':
			return projectUnsetKey(rest);
		default:
			throw new Error('usage: openmelon project <list|use|show|set-key|unset-key|keys> ...');
	}
}

async function projectList(): Promise<void> {
	const projects = await loadProjects();
	const cfg = await loadUserConfig();
	if (projects.entries.length === 0) {
		console.log('No projects registered. Run `openmelon init` in a project dir.');
		return;
	}
	printTable(
		['ID', 'NAME', 'WORKDIR', 'CURRENT'],
		projects.entries.map(e => [e.id, e.name, e.workdir, e.id === cfg.current_project ? '*' : ''])
	);
}

async function projectUse(args: string[]): Promise<void> {
	const id = args[0];
	if (!id || args.length !== 1) {
		throw new Error('usage: openmelon project use <id>');
	}
	await lookup(id); // validate it exists
	await setCurrent(id);
	await markUsed(id);
	console.log(`Current project: ${id}`);
}

async function projectShow(): Promise<void> {
	const wd = await resolveProjectWorkdir();
	const p: ProjectConfig = await loadProject(wd);
	console.log(`ID:           ${p.id}`);
	console.log(`Name:         ${p.name}`);
	console.log(`Workdir:      ${wd}`);
	if (p.description) {
		console.log(`Description:  ${p.description}`);
	}
	if (p.persona) {
		console.log(`Persona:      ${p.persona}`);
	}
	if (p.constraints && p.constraints.length > 0) {
		console.log('Constraints:');
		for (const c of p.constraints) {
			console.log(`  - ${c}`);
		}
	}
	const d = p.defaults ?? {};
	const dEntries = Object.entries({
		'llm_provider:   ': d.llm_provider,
		'llm_model:      ': d.llm_model,
		'image_provider: ': d.image_provider,
		'image_model:    ': d.image_model,
		'locale:         ': d.locale
	}).filter(([, v]) => v);
	if (dEntries.length > 0) {
		console.log('Defaults:');
		for (const [label, v] of dEntries) {
			console.log(`  ${label}${v}`);
		}
	}
	const s = p.settings ?? {};
	if (s.bash_permission_mode || s.reasoning_effort) {
		console.log('Settings:');
		if (s.bash_permission_mode) {
			console.log(`  bash_permission_mode: ${s.bash_permission_mode}`);
		}
		if (s.reasoning_effort) {
			console.log(`  reasoning_effort:    ${s.reasoning_effort}`);
		}
	}
	await printKeySources(wd);
}

async function printKeySources(wd: string): Promise<void> {
	const rows: string[][] = [];
	for (const provider of keyProviders) {
		const resolved = await resolveProvider(wd, provider);
		if (resolved.apiKey) {
			rows.push([`${provider}:`, resolved.keySource || 'unknown', maskKey(resolved.apiKey)]);
		}
	}
	if (rows.length === 0) {
		return;
	}
	console.log('Credentials:');
	for (const [prov, src, val] of rows) {
		console.log(`  ${prov.padEnd(11)} ${src}  (${val})`);
	}
}

async function projectKeys(): Promise<void> {
	const wd = await resolveProjectWorkdir();
	let any = false;
	for (const provider of keyProviders) {
		const {key, source} = await resolveApiKey(wd, provider);
		if (source === 'none') {
			console.log(`  ${(provider + ':').padEnd(11)} (none)`);
			continue;
		}
		any = true;
		console.log(`  ${(provider + ':').padEnd(11)} ${source}  (${maskKey(key)})`);
	}
	if (!any) {
		console.error('No API keys configured. Run `openmelon setup` (global) or `openmelon project set-key` (project-scoped).');
	}
}

async function projectSetKey(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: ['global'], repeatable: [], valued: ['key']});
	const provider = p.positionals[0];
	const key = p.value('key');
	if (!provider || !key) {
		throw new Error(
			'usage: openmelon project set-key <provider> --key <value> [--global]\n' +
				'  (the interactive key wizard is not yet ported to TS; pass --key explicitly for now)'
		);
	}
	const wd = await resolveProjectWorkdir();
	if (p.bool('global')) {
		const creds = await loadCredentials();
		creds.api_keys = {...(creds.api_keys ?? {}), [provider]: key};
		await saveCredentials(creds);
		console.log(`Set global key for ${provider}.`);
	} else {
		await setProjectApiKey(wd, provider, key);
		console.log(`Set project key for ${provider}.`);
	}
}

async function projectUnsetKey(args: string[]): Promise<void> {
	const provider = args[0];
	if (!provider || args.length !== 1) {
		throw new Error('usage: openmelon project unset-key <provider>');
	}
	const wd = await resolveProjectWorkdir();
	const removed = await unsetProjectApiKey(wd, provider);
	console.log(removed ? `Removed project key for ${provider}.` : `No project-scoped key set for ${provider} (nothing to remove).`);
}

async function workdir(): Promise<string> {
	const wd = await discoverProject();
	if (!wd) {
		throw new Error('not inside an openmelon project — run `openmelon init` first');
	}
	return wd;
}

// --- character / reference ---

async function runRegistry(kind: Kind, args: string[]): Promise<void> {
	const [sub, ...rest] = args;
	switch (sub) {
		case 'add':
			return registryAdd(kind, rest);
		case 'list':
			return registryList(kind, rest);
		case 'show':
			return registryShow(kind, rest);
		case 'rm':
		case 'remove':
			return registryRm(kind, rest);
		default:
			throw new Error(`usage: openmelon ${kind} <add|list|show|rm> ...`);
	}
}

async function registryAdd(kind: Kind, args: string[]): Promise<void> {
	const imageFlag = kind === 'reference' ? 'image' : 'portrait';
	const p = parseFlags(args, {bool: ['update'], repeatable: ['tag'], valued: ['name', 'description', imageFlag]});
	const slug = p.positionals[0];
	if (!slug) {
		throw new Error(`usage: openmelon ${kind} add <slug> [--name ...] [--description ...] [--${imageFlag} path] [--tag t]...`);
	}
	const item = await add(await workdir(), {
		kind,
		slug,
		name: p.value('name'),
		description: p.value('description'),
		tags: p.repeated('tag'),
		imagePath: p.value(imageFlag) || undefined,
		imageName: imageFlag,
		allowExists: p.bool('update')
	});
	console.log(`Added ${kind} ${item.slug}`);
	if ((item.images ?? []).length > 0) {
		console.log(`  images: ${item.images!.join(', ')}`);
	}
}

async function registryList(kind: Kind, _args: string[]): Promise<void> {
	const items = await list(await workdir(), kind);
	if (items.length === 0) {
		console.log(`No ${kind}s in this project.`);
		return;
	}
	printTable(
		['SLUG', 'NAME', 'IMAGES', 'TAGS', 'DESCRIPTION'],
		items.map(it => [it.slug, it.name, String((it.images ?? []).length), (it.tags ?? []).join(','), clip(it.description ?? '', 72)])
	);
}

async function registryShow(kind: Kind, args: string[]): Promise<void> {
	const slug = args[0];
	if (!slug || args.length !== 1) {
		throw new Error(`usage: openmelon ${kind} show <slug>`);
	}
	const item = await get(await workdir(), kind, slug);
	console.log(`Kind:        ${item.kind}`);
	console.log(`Slug:        ${item.slug}`);
	console.log(`Name:        ${item.name}`);
	if (item.description) {
		console.log(`Description: ${item.description}`);
	}
	if ((item.tags ?? []).length > 0) {
		console.log(`Tags:        ${item.tags!.join(', ')}`);
	}
	if ((item.images ?? []).length > 0) {
		console.log('Images:');
		for (const img of item.images!) {
			console.log(`  ${img}`);
		}
	}
	if (item.extra && Object.keys(item.extra).length > 0) {
		console.log('Metadata:');
		for (const [k, v] of Object.entries(item.extra)) {
			console.log(`  ${k}: ${v}`);
		}
	}
}

async function registryRm(kind: Kind, args: string[]): Promise<void> {
	const slug = args[0];
	if (!slug || args.length !== 1) {
		throw new Error(`usage: openmelon ${kind} rm <slug>`);
	}
	await remove(await workdir(), kind, slug);
	console.log(`Removed ${kind} ${slug}`);
}

// --- material ---

async function runMaterial(args: string[]): Promise<void> {
	const [sub, ...rest] = args;
	if (sub === 'add') {
		const p = parseFlags(rest, {bool: [], repeatable: ['tag'], valued: []});
		const path = p.positionals[0];
		if (!path || p.positionals.length !== 1) {
			throw new Error('usage: openmelon material add <path> [--tag t]...');
		}
		const item = await addMaterial(await workdir(), path, p.repeated('tag'));
		console.log(`Added material ${item.slug}`);
		return;
	}
	if (sub === 'list') {
		return registryList('material', rest);
	}
	throw new Error('usage: openmelon material <add|list> ...');
}

// --- search ---

async function runSearch(args: string[]): Promise<void> {
	const p = parseFlags(args, {bool: [], repeatable: [], valued: ['limit']});
	if (p.positionals.length === 0) {
		throw new Error('usage: openmelon search <query>... — supports tag:foo, kind:character, -negative, "quoted phrase"');
	}
	const limit = Number.parseInt(p.value('limit') || '50', 10) || 50;
	let hits = await runQuery(await workdir(), parseQuery(p.positionals.join(' ')));
	if (hits.length === 0) {
		console.log('No matches.');
		return;
	}
	if (limit > 0 && hits.length > limit) {
		hits = hits.slice(0, limit);
	}
	printTable(
		['SCORE', 'KIND', 'SLUG', 'NAME', 'DESCRIPTION'],
		hits.map(h => [String(h.score), h.item.kind, h.item.slug, h.item.name, clip(h.item.description ?? '', 72)])
	);
}

// --- session ---

async function runSession(args: string[]): Promise<void> {
	const [sub, ...rest] = args;
	if (sub !== 'events') {
		throw new Error('usage: openmelon session events <session-id> [-n 50]');
	}
	const p = parseFlags(rest, {bool: [], repeatable: [], valued: ['n']});
	const id = p.positionals[0];
	if (!id || p.positionals.length !== 1) {
		throw new Error('usage: openmelon session events <session-id> [-n 50]');
	}
	const limit = Number.parseInt(p.value('n') || '50', 10) || 50;
	const events = await loadSessionEvents(await workdir(), id, limit);
	if (events.length === 0) {
		console.log('No events recorded for this session.');
		return;
	}
	printTable(
		['TIME', 'TYPE', 'STEP', 'TOOL', 'SPACE', 'STATUS'],
		events.map(e => [
			e.at ? formatLocal(e.at) : '',
			e.type ?? '',
			String(e.step ?? 0),
			e.tool ?? '',
			e.space_id ?? '',
			e.status ?? ''
		])
	);
}

// --- helpers ---

type FlagSpec = {bool: string[]; repeatable: string[]; valued: string[]};

type ParsedFlags = {
	positionals: string[];
	value(name: string): string;
	bool(name: string): boolean;
	repeated(name: string): string[];
};

/** Parse args with interspersed positionals + flags (mirrors Go parseInterspersed). */
function parseFlags(args: string[], spec: FlagSpec): ParsedFlags {
	const boolSet = new Set(spec.bool);
	const repeatableSet = new Set(spec.repeatable);
	const positionals: string[] = [];
	const values = new Map<string, string>();
	const repeated = new Map<string, string[]>();
	let end = false;
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (end || a === '-' || !a.startsWith('-')) {
			if (a === '--') {
				end = true;
			} else {
				positionals.push(a);
			}
			continue;
		}
		const eq = a.indexOf('=');
		let name: string;
		let inlineVal: string | undefined;
		if (eq >= 0) {
			name = a.slice(0, eq).replace(/^-+/, '');
			inlineVal = a.slice(eq + 1);
		} else {
			name = a.replace(/^-+/, '');
		}
		if (boolSet.has(name)) {
			values.set(name, 'true');
			continue;
		}
		const val = inlineVal ?? args[++i] ?? '';
		if (repeatableSet.has(name)) {
			repeated.set(name, [...(repeated.get(name) ?? []), val]);
		} else {
			values.set(name, val);
		}
	}
	return {
		positionals,
		value: name => values.get(name) ?? '',
		bool: name => values.get(name) === 'true',
		repeated: name => repeated.get(name) ?? []
	};
}

function clip(s: string, max: number): string {
	return s.length > max ? s.slice(0, max) + '…' : s;
}

function formatLocal(iso: string): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) {
		return iso;
	}
	const p = (n: number) => String(n).padStart(2, '0');
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Print aligned columns (tabwriter-style: pad each column to its max width + 2 spaces). */
function printTable(headers: string[], rows: string[][]): void {
	const widths = headers.map((h, i) => Math.max(h.length, ...rows.map(r => (r[i] ?? '').length)));
	const fmt = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i]! + 2))).join('');
	console.log(fmt(headers));
	for (const row of rows) {
		console.log(fmt(row));
	}
}

// Item type re-export not needed; keep imports tidy.
export type {Item};
