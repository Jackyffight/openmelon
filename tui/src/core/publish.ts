import {promises as fs} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {BCPClient, uploadMedia, type MediaItem} from '@e8s/vbox-cli/dist/lib/index.js';
import {outputsDir} from './project.js';
import {loadCredentials} from './config.js';

const imageExtensions = new Set(['.png', '.webp', '.jpg', '.jpeg', '.gif']);

export type PublishOptions = {
	workdir: string;
	/** Post body / caption. May be empty for an image-only post. */
	text: string;
	/** Explicit image path (relative to workdir or absolute). Defaults to the newest image in outputs/. */
	file?: string;
};

export type PublishResult = {
	status: string;
	contentId?: string;
	/** Basename of the published image, or undefined for a text-only post. */
	imageName?: string;
	textLen: number;
};

/**
 * Resolve the V-Box (BCP) key. This is a separate credential namespace from the
 * LLM provider keys: env `VBOX_API_KEY` → openmelon credentials `api_keys.vbox`
 * → vbox-cli's own `~/.config/vbox/config.json`. Returns null if none is set.
 */
export async function resolveVboxKey(): Promise<string | null> {
	const fromEnv = process.env.VBOX_API_KEY?.trim();
	if (fromEnv) {
		return fromEnv;
	}
	const credentials = await loadCredentials();
	const fromOpenmelon = credentials.api_keys?.['vbox']?.trim();
	if (fromOpenmelon) {
		return fromOpenmelon;
	}
	try {
		const raw = await fs.readFile(path.join(os.homedir(), '.config', 'vbox', 'config.json'), 'utf8');
		const parsed = JSON.parse(raw) as {api_key?: string};
		const key = parsed.api_key?.trim();
		if (key) {
			return key;
		}
	} catch {}
	return null;
}

/** Newest image file in the project's user-facing outputs/ directory, or null. */
export async function findLatestImage(workdir: string): Promise<string | null> {
	const dir = outputsDir(workdir);
	let entries: import('node:fs').Dirent[];
	try {
		entries = await fs.readdir(dir, {withFileTypes: true});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw error;
	}
	let best: {path: string; mtime: number} | null = null;
	for (const entry of entries) {
		if (!entry.isFile() || !imageExtensions.has(path.extname(entry.name).toLowerCase())) {
			continue;
		}
		const full = path.join(dir, entry.name);
		const stat = await fs.stat(full);
		if (!best || stat.mtimeMs > best.mtime) {
			best = {path: full, mtime: stat.mtimeMs};
		}
	}
	return best?.path ?? null;
}

function contentTypeFor(file: string): string {
	switch (path.extname(file).toLowerCase()) {
		case '.png':
			return 'image/png';
		case '.webp':
			return 'image/webp';
		case '.gif':
			return 'image/gif';
		default:
			return 'image/jpeg';
	}
}

/**
 * Upload the chosen image to the BCP media worker and submit a post to the
 * owner's V-Box review queue. Throws with a user-facing message on any failure.
 */
export async function publishToVbox(options: PublishOptions): Promise<PublishResult> {
	const apiKey = await resolveVboxKey();
	if (!apiKey) {
		throw new Error('no V-Box key — set VBOX_API_KEY (bcp_sk_…) or run `vbox-cli login`');
	}
	if (!apiKey.startsWith('bcp_sk_')) {
		throw new Error('V-Box key must start with bcp_sk_');
	}

	const imagePath = options.file
		? path.resolve(options.workdir, options.file)
		: await findLatestImage(options.workdir);
	const text = options.text.trim();
	if (!imagePath && !text) {
		throw new Error('nothing to publish — generate an image first or pass caption text');
	}

	const mediaList: MediaItem[] = [];
	if (imagePath) {
		let bytes: Buffer;
		try {
			bytes = await fs.readFile(imagePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new Error(`image not found: ${imagePath}`);
			}
			throw error;
		}
		const item = await uploadMedia({
			apiKey,
			bytes,
			fileName: path.basename(imagePath),
			contentType: contentTypeFor(imagePath),
			category: 'image'
		});
		mediaList.push(item);
	}

	const client = new BCPClient({apiKey});
	const response = await client.post({
		textContent: text,
		mediaType: mediaList.length > 0 ? 'image' : 'text',
		idempotencyKey: randomUUID(),
		mediaList: mediaList.length > 0 ? mediaList : undefined
	});

	if (!response.success) {
		throw new Error(response.error_message || response.error_code || 'publish rejected by V-Box');
	}

	return {
		status: response.status || 'submitted',
		contentId: response.resource_id,
		imageName: imagePath ? path.basename(imagePath) : undefined,
		textLen: text.length
	};
}
