// On-disk store for project-scoped content libraries: characters, references,
// materials. Ported from internal/registry (read side — List/Get/validate).
//
// Each item lives at <project>/.openmelon/<kind-dir>/<slug>/ with a JSON
// metadata file, a `.search` file (description + tags, source of truth), and
// one or more image files. The write side (add/remove) backs the CLI and is
// ported with the CLI slice.

import {promises as fs} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {stateDir} from '../core/project.js';

export type Kind = 'character' | 'reference' | 'material';

export type Item = {
	kind: Kind;
	slug: string;
	name: string;
	description?: string;
	tags?: string[];
	/** Image basenames inside the item dir. */
	images?: string[];
	/** Kind-specific scalar metadata. */
	extra?: Record<string, string>;
	created_at?: string;
	updated_at?: string;
};

const searchFileName = '.search';
const slugRe = /^[a-z][a-z0-9-]*$/;
const imageExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

export class RegistryError extends Error {}

function dirFor(kind: Kind): string {
	switch (kind) {
		case 'character':
			return 'characters';
		case 'reference':
			return 'references';
		case 'material':
			return 'materials';
	}
}

function metaFileFor(kind: Kind): string {
	switch (kind) {
		case 'character':
			return 'character.json';
		case 'reference':
			return 'reference.json';
		case 'material':
			return 'material.json';
	}
}

/** kebab-case rule shared with projectx + skillplus. Throws on invalid. */
export function validateSlug(slug: string): void {
	if (slug.length < 2 || slug.length > 64) {
		throw new RegistryError(`registry: slug ${JSON.stringify(slug)} must be 2..64 chars`);
	}
	if (!slugRe.test(slug)) {
		throw new RegistryError(`registry: slug ${JSON.stringify(slug)} must be kebab-case ([a-z][a-z0-9-]*)`);
	}
	if (slug.endsWith('-') || slug.includes('--')) {
		throw new RegistryError(`registry: slug ${JSON.stringify(slug)} must not have trailing or doubled hyphens`);
	}
}

function itemDir(workdir: string, kind: Kind, slug: string): string {
	return path.join(stateDir(workdir), dirFor(kind), slug);
}

/** The on-disk directory holding an item's images — used to build absolute reference paths. */
export function itemImageDir(workdir: string, kind: Kind, slug: string): string {
	return itemDir(workdir, kind, slug);
}

/** Absolute paths to an item's images, in sorted order. */
export function absoluteImagePaths(workdir: string, kind: Kind, item: Item): string[] {
	const base = itemDir(workdir, kind, item.slug);
	return (item.images ?? []).map(n => path.join(base, n));
}

/** All items of a kind, in slug order. Missing dir → empty list. */
export async function list(workdir: string, kind: Kind): Promise<Item[]> {
	const root = path.join(stateDir(workdir), dirFor(kind));
	let entries: import('node:fs').Dirent[];
	try {
		entries = await fs.readdir(root, {withFileTypes: true});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
	const out: Item[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		try {
			out.push(await get(workdir, kind, entry.name));
		} catch {
			// Skip half-written items; don't fail the whole list.
		}
	}
	out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
	return out;
}

/** Read a single item, re-filling description/tags from .search and images from disk. */
export async function get(workdir: string, kind: Kind, slug: string): Promise<Item> {
	validateSlug(slug);
	const metaPath = path.join(itemDir(workdir, kind, slug), metaFileFor(kind));
	let raw: string;
	try {
		raw = await fs.readFile(metaPath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new RegistryError(`registry: not found: ${kind}/${slug}`);
		}
		throw error;
	}
	const item = JSON.parse(raw) as Item;
	item.kind = kind;
	item.slug = slug;

	const {description, tags} = await readSearch(path.join(itemDir(workdir, kind, slug), searchFileName));
	item.description = description;
	item.tags = tags;

	const dir = itemDir(workdir, kind, slug);
	try {
		const entries = await fs.readdir(dir, {withFileTypes: true});
		const images = entries
			.filter(e => e.isFile() && imageExts.has(path.extname(e.name).toLowerCase()))
			.map(e => e.name)
			.sort();
		item.images = images;
	} catch {
		item.images = [];
	}
	return item;
}

/**
 * `.search` is a tiny line-oriented format we own both ends of:
 *   description: <single line>
 *   tags: tag-a, tag-b
 * Missing file → empty.
 */
async function readSearch(filePath: string): Promise<{description: string; tags: string[]}> {
	let body: string;
	try {
		body = await fs.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return {description: '', tags: []};
		}
		throw error;
	}
	let description = '';
	const tags: string[] = [];
	for (const rawLine of body.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) {
			continue;
		}
		const idx = line.indexOf(':');
		if (idx < 0) {
			continue;
		}
		const key = line.slice(0, idx).trim();
		const val = line.slice(idx + 1).trim();
		if (key === 'description') {
			description = val;
		} else if (key === 'tags') {
			for (const t of val.split(',')) {
				const trimmed = t.trim();
				if (trimmed) {
					tags.push(trimmed);
				}
			}
		}
	}
	return {description, tags};
}

// --- write side (ported from internal/registry; backs the management CLI) ---

export type AddOptions = {
	kind: Kind;
	slug: string;
	name?: string;
	description?: string;
	tags?: string[];
	extra?: Record<string, string>;
	/** Copied into the item dir; basenamed (or `imageName` + ext). */
	imagePath?: string;
	imageName?: string;
	/** Idempotent re-add: merge metadata + append image instead of erroring. */
	allowExists?: boolean;
};

/** Create or update an item. Throws if it exists and `allowExists` is false. */
export async function add(workdir: string, opts: AddOptions): Promise<Item> {
	validateSlug(opts.slug);
	const dir = itemDir(workdir, opts.kind, opts.slug);
	const metaPath = path.join(dir, metaFileFor(opts.kind));
	const now = new Date().toISOString();

	let persisted: {kind: Kind; slug: string; name: string; extra?: Record<string, string>; created_at: string; updated_at: string};
	const existing = await readJsonMaybe<typeof persisted>(metaPath);
	if (existing) {
		if (!opts.allowExists) {
			throw new RegistryError(`registry: already exists: ${opts.kind}/${opts.slug}`);
		}
		persisted = existing;
	} else {
		persisted = {kind: opts.kind, slug: opts.slug, name: opts.slug, created_at: now, updated_at: now};
	}

	if (opts.name?.trim()) {
		persisted.name = opts.name.trim();
	}
	if (opts.extra && Object.keys(opts.extra).length > 0) {
		persisted.extra = {...(persisted.extra ?? {}), ...opts.extra};
	}
	persisted.kind = opts.kind;
	persisted.slug = opts.slug;
	persisted.updated_at = now;

	await fs.mkdir(dir, {recursive: true});
	if (opts.imagePath) {
		await copyImageInto(dir, opts.imagePath, opts.imageName);
	}
	// .search is the source of truth for description + tags.
	const desc = opts.description ?? (await readSearch(path.join(dir, searchFileName))).description;
	const tags = opts.tags && opts.tags.length > 0 ? opts.tags : (await readSearch(path.join(dir, searchFileName))).tags;
	await writeSearch(path.join(dir, searchFileName), desc, tags);
	await fs.writeFile(metaPath, `${JSON.stringify(persisted, null, 2)}\n`);
	return get(workdir, opts.kind, opts.slug);
}

/** Update only description + tags (vision auto-describe path). */
export async function setSearch(workdir: string, kind: Kind, slug: string, description: string, tags: string[]): Promise<void> {
	validateSlug(slug);
	const dir = itemDir(workdir, kind, slug);
	const metaPath = path.join(dir, metaFileFor(kind));
	if (!(await readJsonMaybe(metaPath))) {
		throw new RegistryError(`registry: not found: ${kind}/${slug}`);
	}
	await writeSearch(path.join(dir, searchFileName), description, tags);
	const meta = (await readJsonMaybe<{updated_at?: string}>(metaPath)) ?? {};
	meta.updated_at = new Date().toISOString();
	await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

/** Delete the item directory and everything in it. */
export async function remove(workdir: string, kind: Kind, slug: string): Promise<void> {
	validateSlug(slug);
	const dir = itemDir(workdir, kind, slug);
	try {
		await fs.access(path.join(dir, metaFileFor(kind)));
	} catch {
		throw new RegistryError(`registry: not found: ${kind}/${slug}`);
	}
	await fs.rm(dir, {recursive: true, force: true});
}

/** Add a material keyed by file sha256 (m-<hex16>), so duplicates collapse. */
export async function addMaterial(workdir: string, srcPath: string, tags: string[]): Promise<Item> {
	const hash = createHash('sha256').update(await fs.readFile(srcPath)).digest('hex');
	const slug = `m-${hash.slice(0, 16)}`;
	return add(workdir, {kind: 'material', slug, name: slug, tags, extra: {sha256: hash}, imagePath: srcPath, imageName: 'image', allowExists: true});
}

async function readJsonMaybe<T>(filePath: string): Promise<T | null> {
	try {
		return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

async function writeSearch(filePath: string, description: string, tags: string[]): Promise<void> {
	await fs.mkdir(path.dirname(filePath), {recursive: true});
	let body = `description: ${description.trim().replace(/\n/g, ' ')}\n`;
	if (tags.length > 0) {
		body += `tags: ${tags.join(', ')}\n`;
	}
	await fs.writeFile(filePath, body);
}

async function copyImageInto(dir: string, src: string, destBaseName?: string): Promise<void> {
	const srcBase = path.basename(src);
	const ext = path.extname(srcBase);
	if (!imageExts.has(ext.toLowerCase())) {
		throw new RegistryError(`registry: ${JSON.stringify(src)} is not an image (ext ${JSON.stringify(ext)})`);
	}
	const base = destBaseName || srcBase.slice(0, srcBase.length - ext.length);
	let candidate = path.join(dir, base + ext);
	for (let i = 2; await pathExists(candidate); i++) {
		candidate = path.join(dir, `${base}-${i}${ext}`);
	}
	await fs.copyFile(src, candidate);
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
