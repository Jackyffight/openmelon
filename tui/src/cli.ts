import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {discoverProject} from './core/project.js';
import {listSessions, validateSessionWorkspace} from './core/session.js';
import {runTui} from './main.js';
import {runInitCommand} from './commands/init.js';
import {runSetupCommand} from './commands/setup.js';

const legacySubcommands = new Set([
	'project',
	'character',
	'reference',
	'material',
	'search',
	'space',
	'session',
	'runtime-bridge',
	'help',
	'-h',
	'--help'
]);

export async function main(argv = process.argv.slice(2)) {
	const [command, ...rest] = argv;

	if (!command || command === 'repl') {
		await runTui({argv: []});
		return;
	}

	if (command === 'init') {
		await runInitCommand(rest);
		return;
	}

	if (command === 'setup') {
		await runSetupCommand(rest);
		return;
	}

	if (command === 'resume') {
		await handleResume(rest);
		return;
	}

	if (legacySubcommands.has(command) || command.startsWith('-')) {
		await runLegacy(argv);
		return;
	}

	await runTui({argv});
}

async function handleResume(args: string[]) {
	const workdir = await discoverProject();
	if (!workdir) {
		throw new Error('resume: not inside an openmelon project');
	}

	const id = args[0];
	if (!id) {
		const sessions = await listSessions(workdir, 10);
		if (sessions.length === 0) {
			console.log('No prior sessions in this project.');
			return;
		}
		console.log('ID\tWHEN\tTURNS\tFIRST');
		for (const session of sessions) {
			const when = formatWhen(session.startedAt);
			const first = truncate(session.firstUserMessage.replace(/\s+/g, ' '), 60);
			console.log(`${session.id}\t${when}\t${session.turnCount}\t${first}`);
		}
		console.error('');
		console.error('Resume one with: openmelon resume <id>');
		return;
	}

	await validateSessionWorkspace(workdir, id);
	await runTui({argv: [], resumeId: id});
}

async function runLegacy(args: string[]) {
	const binary = resolveLegacyBinary();
	await new Promise<void>((resolve, reject) => {
		const child = spawn(binary, args, {stdio: 'inherit', cwd: process.cwd(), env: process.env});
		child.on('error', reject);
		child.on('exit', (code, signal) => {
			if (signal) {
				process.kill(process.pid, signal);
				return;
			}
			if (code && code !== 0) {
				process.exitCode = code;
				resolve();
				return;
			}
			resolve();
		});
	});
}

function resolveLegacyBinary() {
	if (process.env.OPENMELON_RUNTIME_BIN) {
		return process.env.OPENMELON_RUNTIME_BIN;
	}

	const here = path.dirname(fileURLToPath(import.meta.url));
	const repoBinary = path.resolve(here, '..', '..', 'openmelon');
	if (existsSync(repoBinary)) {
		return repoBinary;
	}
	return 'openmelon';
}

function formatWhen(date: Date) {
	if (Number.isNaN(date.getTime())) {
		return '(unknown)';
	}
	return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function truncate(text: string, max: number) {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

main().catch(error => {
	console.error(`openmelon: ${(error as Error).message}`);
	process.exit(1);
});
