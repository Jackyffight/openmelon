import {promises as fs} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

export async function pathExists(filePath: string) {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export function openmelonHome() {
	return process.env.OPENMELON_HOME || path.join(homedir(), '.openmelon');
}

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
	try {
		const body = await fs.readFile(filePath, 'utf8');
		return JSON.parse(body) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return fallback;
		}
		throw error;
	}
}

export async function writeJsonFile(filePath: string, value: unknown, mode?: number) {
	await fs.mkdir(path.dirname(filePath), {recursive: true});
	const temp = path.join(path.dirname(filePath), `.tmp-${process.pid}-${Date.now()}`);
	await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {mode});
	if (mode !== undefined) {
		await fs.chmod(temp, mode);
	}
	await fs.rename(temp, filePath);
}

export async function findUp(start: string, relative: string) {
	let current = path.resolve(start);
	for (;;) {
		const candidate = path.join(current, relative);
		if (await pathExists(candidate)) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return null;
		}
		current = parent;
	}
}
