import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {stateDir} from './project.js';

export type RegistryKind = 'character' | 'reference' | 'material';

export type RegistryItem = {
	kind: RegistryKind;
	slug: string;
	name: string;
	description?: string;
	tags?: string[];
	images?: string[];
	extra?: Record<string, string>;
	created_at?: string;
	updated_at?: string;
};

export type RegistryAddOptions = {
	kind: RegistryKind;
	slug: string;
	name?: string;
	description?: string;
	tags?: string[];
	extra?: Record<string, string>;
	imagePath?: string;
	imageName?: string;
	allowExists?: boolean;
};

export async function listRegistry(workdir: string, kind: RegistryKind) {
	const root = path.join(stateDir(workdir), registryDir(kind));
	const entries = await readdirDirs(root);
	const items = await Promise.all(entries.map(entry => getRegistry(workdir, kind, entry.name).catch(() => null)));
	return items.filter((item): item is RegistryItem => item !== null).sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function getRegistry(workdir: string, kind: RegistryKind, slug: string): Promise<RegistryItem> {
	validateSlug(slug, 'registry');
	const root = itemDir(workdir, kind, slug);
	const meta = await readJson<RegistryItem>(path.join(root, `${kind}.json`));
	const {description, tags} = await readSearch(path.join(root, '.search'));
	return {
		...meta,
		kind,
		slug,
		name: meta.name || slug,
		description: description || meta.description || '',
		tags: tags.length > 0 ? tags : meta.tags ?? [],
		images: await listImages(root)
	};
}

export async function addRegistry(workdir: string, options: RegistryAddOptions) {
	validateSlug(options.slug, 'registry');
	const root = itemDir(workdir, options.kind, options.slug);
	const metaPath = path.join(root, `${options.kind}.json`);
	const now = new Date().toISOString();
	let item: RegistryItem;
	try {
		item = await readJson<RegistryItem>(metaPath);
		if (!options.allowExists) {
			throw new Error(`registry: already exists: ${options.kind}/${options.slug}`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
		item = {kind: options.kind, slug: options.slug, name: options.name || options.slug, created_at: now};
	}

	item.name = options.name || item.name || options.slug;
	item.description = options.description || item.description || '';
	item.tags = options.tags && options.tags.length > 0 ? options.tags : item.tags ?? [];
	item.extra = {...item.extra, ...options.extra};
	item.updated_at = now;

	await fs.mkdir(root, {recursive: true});
	if (options.imagePath) {
		await copyImageInto(root, options.imagePath, options.imageName);
	}
	await writeSearch(path.join(root, '.search'), item.description, item.tags);
	const persisted = {...item};
	delete persisted.description;
	delete persisted.tags;
	delete persisted.images;
	await writeJson(metaPath, persisted);
	return getRegistry(workdir, options.kind, options.slug);
}

export async function removeRegistry(workdir: string, kind: RegistryKind, slug: string) {
	validateSlug(slug, 'registry');
	await fs.rm(itemDir(workdir, kind, slug), {recursive: true, force: false});
}

export async function addMaterial(workdir: string, sourcePath: string, tags: string[]) {
	const data = await fs.readFile(sourcePath);
	const hash = createHash('sha256').update(data).digest('hex');
	return addRegistry(workdir, {
		kind: 'material',
		slug: `m-${hash.slice(0, 16)}`,
		name: `m-${hash.slice(0, 16)}`,
		tags,
		extra: {sha256: hash},
		imagePath: sourcePath,
		imageName: 'image',
		allowExists: true
	});
}

export function registryDir(kind: RegistryKind) {
	return kind === 'character' ? 'characters' : kind === 'reference' ? 'references' : 'materials';
}

export function validateSlug(value: string, scope = 'id') {
	if (value.length < 2 || value.length > 64) {
		throw new Error(`${scope}: slug ${JSON.stringify(value)} must be 2..64 chars`);
	}
	if (!/^[a-z][a-z0-9-]*$/.test(value)) {
		throw new Error(`${scope}: slug ${JSON.stringify(value)} must be kebab-case`);
	}
	if (value.endsWith('-') || value.includes('--')) {
		throw new Error(`${scope}: slug ${JSON.stringify(value)} must not end with '-' or contain '--'`);
	}
}

async function copyImageInto(dir: string, sourcePath: string, imageName = '') {
	const ext = path.extname(sourcePath).toLowerCase();
	if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
		throw new Error(`registry: ${sourcePath} is not a supported image`);
	}
	const base = imageName || path.basename(sourcePath, ext);
	let target = path.join(dir, `${base}${ext}`);
	for (let index = 2; await exists(target); index++) {
		target = path.join(dir, `${base}-${index}${ext}`);
	}
	await fs.copyFile(sourcePath, target);
}

async function listImages(root: string) {
	try {
		const entries = await fs.readdir(root, {withFileTypes: true});
		return entries.filter(entry => entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name)).map(entry => entry.name).sort();
	} catch {
		return [];
	}
}

async function readSearch(filePath: string) {
	let body = '';
	try {
		body = await fs.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return {description: '', tags: [] as string[]};
		}
		throw error;
	}
	let description = '';
	const tags: string[] = [];
	for (const raw of body.split('\n')) {
		const [key, ...rest] = raw.split(':');
		const value = rest.join(':').trim();
		if (key?.trim() === 'description') {
			description = value;
		}
		if (key?.trim() === 'tags') {
			tags.push(...value.split(',').map(tag => tag.trim()).filter(Boolean));
		}
	}
	return {description, tags};
}

async function writeSearch(filePath: string, description = '', tags: string[] = []) {
	const lines = [`description: ${description.trim().replace(/\s+/g, ' ')}`];
	if (tags.length > 0) {
		lines.push(`tags: ${tags.join(', ')}`);
	}
	await fs.writeFile(filePath, `${lines.join('\n')}\n`);
}

async function readdirDirs(root: string) {
	try {
		const entries = await fs.readdir(root, {withFileTypes: true});
		return entries.filter(entry => entry.isDirectory());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

async function exists(filePath: string) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

async function readJson<T>(filePath: string) {
	return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function writeJson(filePath: string, value: unknown) {
	await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function itemDir(workdir: string, kind: RegistryKind, slug: string) {
	return path.join(stateDir(workdir), registryDir(kind), slug);
}
