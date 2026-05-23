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
	const output = await runProcess('skillplus', ['list', '--json'], timeoutMs).catch(error => {
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

export type CompileRequest = {
	/** Bare skill slug or absolute path to a .skillplus directory. */
	packagePath: string;
	target?: string;
	modelProfile?: string;
	locale?: string;
	vars?: Record<string, string>;
};

/**
 * Compile a skillplus package and return its full compiled JSON object.
 * Prefers the `skillplus` console script on PATH; falls back to
 * `python3 -m skillplus`. Throws with the compiler's stderr on failure.
 */
export async function compileSkill(req: CompileRequest, timeoutMs = 60000): Promise<unknown> {
	const args = [
		req.packagePath,
		'--target',
		req.target ?? 'openmelon',
		'--model-profile',
		req.modelProfile ?? 'gpt-image-family'
	];
	if (req.locale) {
		args.push('--locale', req.locale);
	}
	for (const [k, v] of Object.entries(req.vars ?? {})) {
		args.push('--var', `${k}=${v}`);
	}
	let output: string;
	try {
		output = await runProcess('skillplus', args, timeoutMs);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			output = await runProcess('python3', ['-m', 'skillplus', ...args], timeoutMs);
		} else {
			throw error;
		}
	}
	return JSON.parse(output);
}

function runProcess(command: string, args: string[], timeoutMs: number) {
	return new Promise<string>((resolve, reject) => {
		const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe'], env: process.env});
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`${command} ${args[0] ?? ''} timed out`));
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
				reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
				return;
			}
			resolve(stdout);
		});
	});
}
