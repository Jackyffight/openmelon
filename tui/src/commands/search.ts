import {listRegistry, type RegistryItem, type RegistryKind} from '../core/registry.js';
import {formatTable, numberFlag, parseArgs, resolveProjectWorkdir, truncate} from './common.js';

export async function runSearchCommand(args: string[]) {
	const parsed = parseArgs(args, {limit: 'number'});
	if (parsed.positionals.length === 0) {
		throw new Error('usage: openmelon search <query>... - supports tag:foo, kind:character, -negative, "quoted phrase"');
	}
	const limit = numberFlag(parsed, 'limit', 50);
	const query = parseQuery(parsed.positionals.join(' '));
	const {workdir} = await resolveProjectWorkdir();
	const items = [
		...(await listRegistry(workdir, 'character')),
		...(await listRegistry(workdir, 'reference')),
		...(await listRegistry(workdir, 'material'))
	];
	let hits = items
		.map(item => ({item, score: scoreItem(item, query)}))
		.filter(hit => hit.score > 0)
		.sort((a, b) => b.score - a.score || a.item.slug.localeCompare(b.item.slug));
	if (limit > 0) {
		hits = hits.slice(0, limit);
	}
	if (hits.length === 0) {
		console.log('No matches.');
		return;
	}
	console.log(formatTable(['SCORE', 'KIND', 'SLUG', 'NAME', 'DESCRIPTION'], hits.map(hit => [hit.score, hit.item.kind, hit.item.slug, hit.item.name, truncate(hit.item.description ?? '')])));
}

type Query = {
	terms: string[];
	negative: string[];
	tags: string[];
	kind?: RegistryKind;
};

function parseQuery(value: string): Query {
	const tokens = value.match(/"[^"]+"|\S+/g)?.map(token => token.replace(/^"|"$/g, '')) ?? [];
	const query: Query = {terms: [], negative: [], tags: []};
	for (const token of tokens) {
		if (token.startsWith('kind:')) {
			const kind = token.slice(5);
			if (kind === 'character' || kind === 'reference' || kind === 'material') {
				query.kind = kind;
			}
			continue;
		}
		if (token.startsWith('tag:')) {
			query.tags.push(token.slice(4).toLowerCase());
			continue;
		}
		if (token.startsWith('-') && token.length > 1) {
			query.negative.push(token.slice(1).toLowerCase());
			continue;
		}
		query.terms.push(token.toLowerCase());
	}
	return query;
}

function scoreItem(item: RegistryItem, query: Query) {
	if (query.kind && item.kind !== query.kind) {
		return 0;
	}
	const tags = item.tags?.map(tag => tag.toLowerCase()) ?? [];
	if (query.tags.some(tag => !tags.includes(tag))) {
		return 0;
	}
	const hay = `${item.slug}\n${item.name}\n${item.description ?? ''}\n${tags.join(' ')}`.toLowerCase();
	if (query.negative.some(term => hay.includes(term))) {
		return 0;
	}
	let score = query.tags.length * 3 + (query.kind ? 1 : 0);
	for (const term of query.terms) {
		if (item.slug.toLowerCase() === term) {
			score += 8;
		} else if (item.name.toLowerCase().includes(term)) {
			score += 4;
		} else if (hay.includes(term)) {
			score += 2;
		} else {
			return 0;
		}
	}
	return score || 1;
}
