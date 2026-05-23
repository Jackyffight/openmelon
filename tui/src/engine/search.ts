// Grep-style search across the project's content libraries. Ported from
// internal/search. Deliberately not vector: the corpus is small and queries
// are operator-style (tags + substring).
//
// Query language (terms AND'd, order-independent):
//   bare token       substring match in name OR description (case-insensitive)
//   tag:foo          require tag "foo" exactly
//   kind:character   restrict to one kind
//   -token           negative substring match
//   "quoted phrase"  one token with internal whitespace

import {type Item, type Kind, list} from './registry.js';

export type Hit = {item: Item; score: number};

export type Query = {
	substrings: string[];
	negatives: string[];
	tags: string[];
	kinds: Kind[];
};

export class SearchError extends Error {}

/** Parse a raw query string. Throws SearchError on unbalanced quotes / unknown kind. */
export function parse(raw: string): Query {
	const tokens = tokenize(raw);
	const q: Query = {substrings: [], negatives: [], tags: [], kinds: []};
	for (const t of tokens) {
		if (!t) {
			continue;
		}
		if (t.startsWith('tag:')) {
			const val = t.slice(4).toLowerCase();
			if (val) {
				q.tags.push(val);
			}
		} else if (t.startsWith('kind:')) {
			const val = t.slice(5).toLowerCase();
			switch (val) {
				case 'character':
				case 'characters':
					q.kinds.push('character');
					break;
				case 'reference':
				case 'references':
				case 'ref':
				case 'refs':
					q.kinds.push('reference');
					break;
				case 'material':
				case 'materials':
					q.kinds.push('material');
					break;
				default:
					throw new SearchError(`search: unknown kind: ${JSON.stringify(val)}`);
			}
		} else if (t.startsWith('-') && t.length > 1) {
			q.negatives.push(t.slice(1).toLowerCase());
		} else {
			q.substrings.push(t.toLowerCase());
		}
	}
	return q;
}

/** Execute a parsed query against a project's registry. */
export async function run(workdir: string, q: Query): Promise<Hit[]> {
	const kinds = q.kinds.length > 0 ? q.kinds : (['character', 'reference', 'material'] as Kind[]);
	const hits: Hit[] = [];
	for (const kind of kinds) {
		for (const item of await list(workdir, kind)) {
			const hit = score(item, q);
			if (hit) {
				hits.push(hit);
			}
		}
	}
	hits.sort((a, b) => {
		if (a.score !== b.score) {
			return b.score - a.score;
		}
		if (a.item.kind !== b.item.kind) {
			return a.item.kind < b.item.kind ? -1 : 1;
		}
		return a.item.slug < b.item.slug ? -1 : a.item.slug > b.item.slug ? 1 : 0;
	});
	return hits;
}

function score(item: Item, q: Query): Hit | null {
	const hay = `${item.name}\n${item.description ?? ''}`.toLowerCase();
	for (const neg of q.negatives) {
		if (hay.includes(neg)) {
			return null;
		}
	}
	const tags = item.tags ?? [];
	for (const want of q.tags) {
		if (!tags.some(have => have.toLowerCase() === want)) {
			return null;
		}
	}
	let total = 0;
	for (const sub of q.substrings) {
		const hits = countOccurrences(hay, sub);
		if (hits === 0) {
			return null;
		}
		total += hits;
		for (const t of tags) {
			if (t.toLowerCase().includes(sub)) {
				total += 2;
			}
		}
	}
	if (q.substrings.length === 0 && q.tags.length === 0) {
		total = 0;
	}
	return {item, score: total};
}

function countOccurrences(hay: string, needle: string): number {
	if (!needle) {
		return 0;
	}
	let count = 0;
	let idx = hay.indexOf(needle);
	while (idx >= 0) {
		count++;
		idx = hay.indexOf(needle, idx + needle.length);
	}
	return count;
}

/** Split on whitespace, honoring "double-quoted" spans. Throws on unbalanced quotes. */
function tokenize(raw: string): string[] {
	const tokens: string[] = [];
	let buf = '';
	let inQuote = false;
	for (const c of raw) {
		if (c === '"') {
			inQuote = !inQuote;
			continue;
		}
		if (!inQuote && (c === ' ' || c === '\t' || c === '\n')) {
			if (buf.length > 0) {
				tokens.push(buf);
				buf = '';
			}
			continue;
		}
		buf += c;
	}
	if (inQuote) {
		throw new SearchError('search: unbalanced quote in query');
	}
	if (buf.length > 0) {
		tokens.push(buf);
	}
	return tokens;
}
