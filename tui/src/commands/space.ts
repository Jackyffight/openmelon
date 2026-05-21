import {
	activateSpace,
	buildCompactionDraft,
	buildContextPacket,
	createEpisode,
	createSpace,
	listSpaces,
	recordCompaction,
	recordDecision,
	recordJsonl,
	registerAsset,
	updateAssetWeight
} from '../core/space.js';
import {boolFlag, formatTable, numberFlag, parseArgs, repeatFlag, resolveProjectWorkdir, stringFlag, truncate} from './common.js';

export async function runSpaceCommand(args: string[]) {
	const [subcommand, ...rest] = args;
	switch (subcommand) {
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
			throw new Error('usage: openmelon space <create|activate|list|show|context|search|decision|feedback|memory|promote|episode|asset|asset-weight|compact> ...');
	}
}

async function spaceCreate(args: string[]) {
	const parsed = parseArgs(args, {name: 'string', platform: 'string', audience: 'string', description: 'string', assumptions: 'string', tag: 'repeat'});
	const id = parsed.positionals[0];
	if (!id) {
		throw new Error('usage: openmelon space create <id> [--name ...] [--description ...] [--tag t]...');
	}
	const {workdir} = await resolveProjectWorkdir();
	const space = await createSpace(workdir, {
		id,
		name: stringFlag(parsed, 'name'),
		platform: stringFlag(parsed, 'platform'),
		audience: stringFlag(parsed, 'audience'),
		description: stringFlag(parsed, 'description'),
		assumptions: stringFlag(parsed, 'assumptions'),
		tags: repeatFlag(parsed, 'tag')
	});
	console.log(`Created space ${space.id}`);
	console.log(`  dir: ${workdir}/.openmelon/spaces/${space.id}`);
}

async function spaceActivate(args: string[]) {
	const parsed = parseArgs(args, {reason: 'string', weight: 'number'});
	if (parsed.positionals.length < 2) {
		throw new Error('usage: openmelon space activate <space-id> <confirmed decision...>');
	}
	const {workdir} = await resolveProjectWorkdir();
	const result = await activateSpace(workdir, parsed.positionals[0]!, parsed.positionals.slice(1).join(' '), stringFlag(parsed, 'reason'), numberFlag(parsed, 'weight', 1));
	console.log(`Activated space ${result.space.id} with decision ${result.decision.id}`);
}

async function spaceList() {
	const {workdir} = await resolveProjectWorkdir();
	const spaces = await listSpaces(workdir);
	if (spaces.length === 0) {
		console.log('No creative spaces in this project.');
		return;
	}
	console.log(formatTable(['ID', 'NAME', 'STATUS', 'TAGS', 'DESCRIPTION'], spaces.map(space => [String(space.id ?? ''), String(space.name ?? ''), String(space.status ?? ''), Array.isArray(space.tags) ? space.tags.join(',') : '', truncate(String(space.description ?? ''))])));
}

async function spaceShow(args: string[]) {
	const parsed = parseArgs(args, {json: 'boolean'});
	const id = parsed.positionals[0];
	if (!id) {
		throw new Error('usage: openmelon space show <id> [--json]');
	}
	const {workdir, project} = await resolveProjectWorkdir();
	const packet = await buildContextPacket(workdir, project.id, id);
	if (boolFlag(parsed, 'json')) {
		console.log(JSON.stringify(packet, null, 2));
		return;
	}
	const space = packet.space as Record<string, unknown>;
	console.log(`ID:          ${space.id ?? id}`);
	console.log(`Name:        ${space.name ?? ''}`);
	if (space.platform) {
		console.log(`Platform:    ${space.platform}`);
	}
	if (space.audience) {
		console.log(`Audience:    ${space.audience}`);
	}
	if (space.description) {
		console.log(`Description: ${space.description}`);
	}
	if (Array.isArray(space.tags) && space.tags.length > 0) {
		console.log(`Tags:        ${space.tags.join(', ')}`);
	}
	if (String(packet.assumptions ?? '').trim()) {
		console.log(`\nAssumptions:\n${String(packet.assumptions).trim()}`);
	}
	if (String(packet.canon ?? '').trim()) {
		console.log(`\nCanon:\n${String(packet.canon).trim()}`);
	}
	console.log(`\nRecent: ${packet.recent_decisions.length} decisions, ${packet.recent_feedback.length} feedback items, ${packet.recent_episodes.length} episodes, ${packet.assets.length} assets`);
}

async function spaceContext(args: string[]) {
	const parsed = parseArgs(args, {query: 'string', 'max-decisions': 'number', 'max-feedback': 'number', 'max-episodes': 'number', 'max-assets': 'number'});
	const id = parsed.positionals[0];
	if (!id) {
		throw new Error('usage: openmelon space context <id> [--query ...] [--max-assets n] [--max-decisions n]');
	}
	const {workdir, project} = await resolveProjectWorkdir();
	const packet = await buildContextPacket(workdir, project.id, id, {
		query: stringFlag(parsed, 'query'),
		maxDecisions: numberFlag(parsed, 'max-decisions', 8),
		maxFeedback: numberFlag(parsed, 'max-feedback', 8),
		maxEpisodes: numberFlag(parsed, 'max-episodes', 8),
		maxAssets: numberFlag(parsed, 'max-assets', 20)
	});
	console.log(JSON.stringify(packet, null, 2));
}

async function spaceSearch(args: string[]) {
	if (args.length === 0) {
		throw new Error('usage: openmelon space search <query>...');
	}
	const query = args.join(' ').toLowerCase();
	const terms = query.split(/\s+/).filter(Boolean);
	const {workdir} = await resolveProjectWorkdir();
	const hits = (await listSpaces(workdir))
		.map(space => ({space, score: scoreSpace(space, terms)}))
		.filter(hit => hit.score >= 0)
		.sort((a, b) => b.score - a.score || String(a.space.id ?? '').localeCompare(String(b.space.id ?? '')));
	if (hits.length === 0) {
		console.log('No matches.');
		return;
	}
	console.log(formatTable(['SCORE', 'ID', 'NAME', 'DESCRIPTION'], hits.map(hit => [hit.score, String(hit.space.id ?? ''), String(hit.space.name ?? ''), truncate(String(hit.space.description ?? ''))])));
}

async function spaceDecision(args: string[]) {
	const parsed = parseArgs(args, {scope: 'string', target: 'string', reason: 'string', weight: 'number'});
	if (parsed.positionals.length < 2) {
		throw new Error('usage: openmelon space decision <space-id> <decision text...>');
	}
	const {workdir} = await resolveProjectWorkdir();
	const decision = await recordDecision(workdir, parsed.positionals[0]!, {
		scope: stringFlag(parsed, 'scope', 'space'),
		target: stringFlag(parsed, 'target'),
		decision: parsed.positionals.slice(1).join(' '),
		reason: stringFlag(parsed, 'reason'),
		weight: numberFlag(parsed, 'weight', 1)
	});
	console.log(`Recorded decision ${decision.id}`);
}

async function spaceFeedback(args: string[]) {
	const parsed = parseArgs(args, {episode: 'string', source: 'string', evidence: 'string', recommendation: 'string'});
	if (parsed.positionals.length < 2) {
		throw new Error('usage: openmelon space feedback <space-id> <signal> [--evidence ...] [--recommendation ...]');
	}
	const {workdir} = await resolveProjectWorkdir();
	const feedback = await recordJsonl(
		workdir,
		parsed.positionals[0]!,
		'feedback.jsonl',
		{episode_id: stringFlag(parsed, 'episode'), source: stringFlag(parsed, 'source', 'user'), signal: parsed.positionals[1], evidence: stringFlag(parsed, 'evidence'), recommendation: stringFlag(parsed, 'recommendation')},
		'fb'
	);
	console.log(`Recorded feedback ${feedback.id}`);
}

async function spaceMemory(args: string[]) {
	const parsed = parseArgs(args, {id: 'string', kind: 'string', scope: 'string', target: 'string', source: 'string', weight: 'number', status: 'string'});
	if (parsed.positionals.length < 2) {
		throw new Error('usage: openmelon space memory <space-id> <content...> [--id mem-x] [--kind observation]');
	}
	const {workdir} = await resolveProjectWorkdir();
	const item = await recordJsonl(
		workdir,
		parsed.positionals[0]!,
		'memory.jsonl',
		{
			id: stringFlag(parsed, 'id') || undefined,
			kind: stringFlag(parsed, 'kind', 'observation'),
			scope: stringFlag(parsed, 'scope'),
			target: stringFlag(parsed, 'target'),
			content: parsed.positionals.slice(1).join(' '),
			source: stringFlag(parsed, 'source', 'user'),
			weight: numberFlag(parsed, 'weight', 0.5),
			status: stringFlag(parsed, 'status', 'provisional'),
			updated_at: new Date().toISOString()
		},
		'mem'
	);
	console.log(`Recorded memory item ${item.id}`);
}

async function spacePromote(args: string[]) {
	const parsed = parseArgs(args, {reason: 'string', target: 'string'});
	if (parsed.positionals.length < 3) {
		throw new Error('usage: openmelon space promote <space-id> <memory-id> <decision...>');
	}
	const {workdir} = await resolveProjectWorkdir();
	const decision = await recordDecision(workdir, parsed.positionals[0]!, {
		scope: 'memory',
		target: stringFlag(parsed, 'target') || parsed.positionals[1],
		decision: parsed.positionals.slice(2).join(' '),
		reason: stringFlag(parsed, 'reason') || `Promoted from memory item ${parsed.positionals[1]}`,
		weight: 1
	});
	console.log(`Promoted memory into decision ${decision.id}`);
}

async function spaceEpisode(args: string[]) {
	const parsed = parseArgs(args, {id: 'string', title: 'string', status: 'string', brief: 'string'});
	if (parsed.positionals.length < 2) {
		throw new Error('usage: openmelon space episode <space-id> <topic...> [--id ...] [--brief ...]');
	}
	const {workdir} = await resolveProjectWorkdir();
	const episode = await createEpisode(workdir, parsed.positionals[0]!, {
		id: stringFlag(parsed, 'id'),
		title: stringFlag(parsed, 'title'),
		status: stringFlag(parsed, 'status', 'draft'),
		brief: stringFlag(parsed, 'brief'),
		topic: parsed.positionals.slice(1).join(' ')
	});
	console.log(`Created episode ${episode.id}`);
}

async function spaceAsset(args: string[]) {
	const parsed = parseArgs(args, {id: 'string', kind: 'string', status: 'string', reuse: 'string', weight: 'number', file: 'repeat', tag: 'repeat'});
	if (parsed.positionals.length < 2) {
		throw new Error('usage: openmelon space asset <space-id> <description...> [--kind ...] [--file path]...');
	}
	const {workdir} = await resolveProjectWorkdir();
	const asset = await registerAsset(workdir, parsed.positionals[0]!, {
		id: stringFlag(parsed, 'id'),
		kind: stringFlag(parsed, 'kind'),
		status: stringFlag(parsed, 'status', 'active'),
		reuse: stringFlag(parsed, 'reuse'),
		weight: numberFlag(parsed, 'weight', 1),
		files: repeatFlag(parsed, 'file'),
		tags: repeatFlag(parsed, 'tag'),
		description: parsed.positionals.slice(1).join(' ')
	});
	console.log(`Registered asset ${asset.id}`);
}

async function spaceAssetWeight(args: string[]) {
	const parsed = parseArgs(args, {status: 'string'});
	if (parsed.positionals.length !== 3) {
		throw new Error('usage: openmelon space asset-weight <space-id> <asset-id> <weight> [--status archived]');
	}
	const weight = Number(parsed.positionals[2]);
	if (!Number.isFinite(weight)) {
		throw new Error(`asset-weight: invalid weight ${parsed.positionals[2]}`);
	}
	const {workdir} = await resolveProjectWorkdir();
	const asset = await updateAssetWeight(workdir, parsed.positionals[0]!, parsed.positionals[1]!, weight, stringFlag(parsed, 'status'));
	console.log(`Updated asset ${asset.id} weight to ${Number(asset.weight ?? weight).toFixed(2)}${asset.status ? ` (${asset.status})` : ''}`);
}

async function spaceCompact(args: string[]) {
	const parsed = parseArgs(args, {draft: 'boolean', summary: 'string', scope: 'string'});
	const id = parsed.positionals[0];
	if (!id) {
		throw new Error('usage: openmelon space compact <space-id> [--draft | --summary ...]');
	}
	const {workdir} = await resolveProjectWorkdir();
	const summary = stringFlag(parsed, 'summary');
	if (boolFlag(parsed, 'draft') || !summary.trim()) {
		const body = await buildCompactionDraft(workdir, id);
		console.log(body);
		if (boolFlag(parsed, 'draft')) {
			return;
		}
		throw new Error('space compact: pass --summary to record a compaction, or --draft to only print the draft');
	}
	const compaction = await recordCompaction(workdir, id, summary, stringFlag(parsed, 'scope', 'space'));
	console.log(`Recorded compaction ${compaction.id}`);
}

function scoreSpace(space: Record<string, unknown>, terms: string[]) {
	if (terms.length === 0) {
		return 1;
	}
	const hay = [space.id, space.name, space.description, space.platform, space.audience, ...(Array.isArray(space.tags) ? space.tags : [])].join('\n').toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (String(space.id).toLowerCase() === term) {
			score += 10;
		} else if (hay.includes(term)) {
			score += 2;
		} else {
			return -1;
		}
	}
	if (space.status === 'active') {
		score += 3;
	}
	return score;
}
