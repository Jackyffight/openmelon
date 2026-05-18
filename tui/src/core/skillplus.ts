import {spawn} from 'node:child_process';

export type SkillInfo = {
	id: string;
	version?: string;
	name?: string;
	description?: string;
	tags?: string[];
	path?: string;
	source?: string;
};

export async function listSkills(timeoutMs = 5000): Promise<SkillInfo[]> {
	const output = await runSkillplus(['list', '--json'], timeoutMs).catch(error => {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return '';
		}
		throw error;
	});
	if (!output.trim()) {
		return [];
	}
	return JSON.parse(output) as SkillInfo[];
}

function runSkillplus(args: string[], timeoutMs: number) {
	return new Promise<string>((resolve, reject) => {
		const child = spawn('skillplus', args, {stdio: ['ignore', 'pipe', 'pipe'], env: process.env});
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error('skillplus list timed out'));
		}, timeoutMs);
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => {
			stdout += String(chunk);
		});
		child.stderr.on('data', chunk => {
			stderr += String(chunk);
		});
		child.on('error', error => {
			clearTimeout(timer);
			reject(error);
		});
		child.on('exit', code => {
			clearTimeout(timer);
			if (code && code !== 0) {
				reject(new Error(stderr.trim() || `skillplus exited with code ${code}`));
				return;
			}
			resolve(stdout);
		});
	});
}
