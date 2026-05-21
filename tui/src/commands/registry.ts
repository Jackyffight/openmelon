import {addMaterial, addRegistry, getRegistry, listRegistry, removeRegistry, type RegistryKind} from '../core/registry.js';
import {formatTable, parseArgs, repeatFlag, resolveProjectWorkdir, stringFlag, truncate} from './common.js';

export async function runRegistryCommand(kind: RegistryKind, args: string[]) {
	const [subcommand, ...rest] = args;
	if (kind === 'material') {
		switch (subcommand) {
			case 'add':
				return materialAdd(rest);
			case 'list':
				return registryList(kind);
			default:
				throw new Error('usage: openmelon material <add|list> ...');
		}
	}
	switch (subcommand) {
		case 'add':
			return registryAdd(kind, rest);
		case 'list':
			return registryList(kind);
		case 'show':
			return registryShow(kind, rest);
		case 'rm':
		case 'remove':
			return registryRemove(kind, rest);
		default:
			throw new Error(`usage: openmelon ${kind} <add|list|show|rm> ...`);
	}
}

async function registryAdd(kind: 'character' | 'reference', args: string[]) {
	const imageFlag = kind === 'character' ? 'portrait' : 'image';
	const parsed = parseArgs(args, {name: 'string', description: 'string', [imageFlag]: 'string', tag: 'repeat', update: 'boolean'});
	const slug = parsed.positionals[0];
	if (!slug) {
		throw new Error(`usage: openmelon ${kind} add <slug> [--name ...] [--description ...] [--${imageFlag} path] [--tag t]...`);
	}
	const {workdir} = await resolveProjectWorkdir();
	const item = await addRegistry(workdir, {
		kind,
		slug,
		name: stringFlag(parsed, 'name'),
		description: stringFlag(parsed, 'description'),
		tags: repeatFlag(parsed, 'tag'),
		imagePath: stringFlag(parsed, imageFlag),
		imageName: imageFlag,
		allowExists: Boolean(parsed.flags.update)
	});
	console.log(`Added ${kind} ${item.slug}`);
	if (item.images?.length) {
		console.log(`  images: ${item.images.join(', ')}`);
	}
}

async function registryList(kind: RegistryKind) {
	const {workdir} = await resolveProjectWorkdir();
	const items = await listRegistry(workdir, kind);
	if (items.length === 0) {
		console.log(`No ${kind}s in this project.`);
		return;
	}
	console.log(
		formatTable(
			['SLUG', 'NAME', 'IMAGES', 'TAGS', 'DESCRIPTION'],
			items.map(item => [item.slug, item.name, item.images?.length ?? 0, item.tags?.join(',') ?? '', truncate(item.description ?? '')])
		)
	);
}

async function registryShow(kind: RegistryKind, args: string[]) {
	if (args.length !== 1) {
		throw new Error(`usage: openmelon ${kind} show <slug>`);
	}
	const {workdir} = await resolveProjectWorkdir();
	const item = await getRegistry(workdir, kind, args[0]!);
	console.log(`Kind:        ${item.kind}`);
	console.log(`Slug:        ${item.slug}`);
	console.log(`Name:        ${item.name}`);
	if (item.description) {
		console.log(`Description: ${item.description}`);
	}
	if (item.tags?.length) {
		console.log(`Tags:        ${item.tags.join(', ')}`);
	}
	if (item.images?.length) {
		console.log('Images:');
		for (const image of item.images) {
			console.log(`  ${image}`);
		}
	}
	if (item.extra && Object.keys(item.extra).length > 0) {
		console.log('Metadata:');
		for (const [key, value] of Object.entries(item.extra)) {
			console.log(`  ${key}: ${value}`);
		}
	}
}

async function registryRemove(kind: RegistryKind, args: string[]) {
	if (args.length !== 1) {
		throw new Error(`usage: openmelon ${kind} rm <slug>`);
	}
	const {workdir} = await resolveProjectWorkdir();
	await removeRegistry(workdir, kind, args[0]!);
	console.log(`Removed ${kind} ${args[0]}`);
}

async function materialAdd(args: string[]) {
	const parsed = parseArgs(args, {tag: 'repeat'});
	const sourcePath = parsed.positionals[0];
	if (!sourcePath) {
		throw new Error('usage: openmelon material add <path> [--tag t]...');
	}
	const {workdir} = await resolveProjectWorkdir();
	const item = await addMaterial(workdir, sourcePath, repeatFlag(parsed, 'tag'));
	console.log(`Added material ${item.slug}`);
}
