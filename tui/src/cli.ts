import {discoverProject} from './core/project.js';
import {listSessions, validateSessionWorkspace} from './core/session.js';
import {runTui} from './main.js';
import {runInitCommand} from './commands/init.js';
import {runSetupCommand} from './commands/setup.js';
import {runManage, tsManagedCommands} from './commands/manage.js';
import {parseHeadless, runHeadless} from './commands/headless.js';

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

	if (command === 'help' || command === '-h' || command === '--help') {
		printUsage();
		return;
	}

	// character / reference / material / search / session / project / space are now pure TS.
	if (tsManagedCommands.has(command)) {
		await runManage(command, rest);
		return;
	}

	// Headless one-shot: `openmelon -p "<intent>"` (pure TS).
	const headless = parseHeadless(argv);
	if (headless) {
		await runHeadless(headless);
		return;
	}

	if (command.startsWith('-')) {
		console.error(`openmelon: unknown flag ${command}`);
		printUsage();
		process.exitCode = 1;
		return;
	}

	// Anything else: treat the whole argv as a prompt and open the TUI.
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

function formatWhen(date: Date) {
	if (Number.isNaN(date.getTime())) {
		return '(unknown)';
	}
	return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function truncate(text: string, max: number) {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function printUsage() {
	console.log(`openmelon — a content-creation agent in your terminal.

Usage:
  openmelon                      open the interactive TUI (in a project)
  openmelon -p "<intent>"        headless one-shot agent run
  openmelon init                 create a project here
  openmelon setup                configure provider keys + model defaults
  openmelon resume [<id>]        resume a prior session
  openmelon project <list|use|show|keys|set-key|unset-key>
  openmelon character|reference|material <add|list|show|rm>
  openmelon search <query>...    grep characters/references/materials
  openmelon space <create|activate|list|show|context|search|decision|feedback|memory|promote|episode|asset|asset-weight|compact>
  openmelon session events <id>

Run \`openmelon <command>\` with no args for that command's usage.`);
}

main().catch(error => {
	console.error(`openmelon: ${(error as Error).message}`);
	process.exit(1);
});
