import {discoverProject} from './core/project.js';
import {listSessions, validateSessionWorkspace} from './core/session.js';
import {runTui} from './main.js';
import {runInitCommand} from './commands/init.js';
import {runSetupCommand} from './commands/setup.js';
import {runProjectCommand} from './commands/project.js';
import {runRegistryCommand} from './commands/registry.js';
import {runSearchCommand} from './commands/search.js';
import {runSessionCommand} from './commands/session.js';
import {runSpaceCommand} from './commands/space.js';
import {createRuntimeClient, type RuntimeClient, type RuntimeEvent} from './runtime/index.js';

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

	if (command === 'project') {
		await runProjectCommand(rest);
		return;
	}

	if (command === 'character' || command === 'reference' || command === 'material') {
		await runRegistryCommand(command, rest);
		return;
	}

	if (command === 'search') {
		await runSearchCommand(rest);
		return;
	}

	if (command === 'space') {
		await runSpaceCommand(rest);
		return;
	}

	if (command === 'session') {
		await runSessionCommand(rest);
		return;
	}

	if (command === 'runtime-bridge') {
		throw new Error('runtime-bridge was retired; the TypeScript runtime is native now');
	}

	if (command === 'help' || command === '-h' || command === '--help') {
		printHelp();
		return;
	}

	if (command === 'run' || command === '-p') {
		const prompt = command === 'run' ? rest.join(' ') : rest.join(' ');
		if (!prompt.trim()) {
			throw new Error(command === '-p' ? 'usage: openmelon -p <prompt>' : 'usage: openmelon run <prompt>');
		}
		await runHeadless(prompt);
		return;
	}

	if (command.startsWith('-')) {
		throw new Error('unknown flag; use `openmelon --help` for TS-native commands');
	}

	await runTui({argv});
}

async function runHeadless(prompt: string) {
	let client: RuntimeClient | null = null;
	let assistantStreaming = false;
	let started = false;
	await new Promise<void>((resolve, reject) => {
		const emit = (event: RuntimeEvent) => {
			switch (event.type) {
				case 'ready':
					if (!started) {
						started = true;
						client?.run(prompt);
					}
					break;
				case 'append':
					if (event.kind === 'user') {
						return;
					}
					if (event.delta && event.kind === 'assistant') {
						process.stdout.write(event.text);
						assistantStreaming = true;
						return;
					}
					if (assistantStreaming) {
						process.stdout.write('\n');
						assistantStreaming = false;
					}
					if (event.kind === 'assistant') {
						console.log(event.text);
					} else if (event.kind === 'error') {
						console.error(event.text);
					} else {
						console.error(`[${event.kind}] ${event.text}`);
					}
					break;
				case 'approval':
					console.error(`[approval denied] ${event.detail?.description || event.detail?.command || event.detail?.tool || 'tool call'}`);
					if (event.detail?.id) {
						client?.approval(event.detail.id, false, false);
					}
					break;
				case 'done':
					if (assistantStreaming) {
						process.stdout.write('\n');
						assistantStreaming = false;
					}
					client?.shutdown();
					resolve();
					break;
				case 'error':
					if (assistantStreaming) {
						process.stdout.write('\n');
						assistantStreaming = false;
					}
					reject(new Error(event.error));
					break;
			}
		};
		client = createRuntimeClient(emit);
	});
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

function printHelp() {
	console.log('openmelon - content-creation agent for the terminal');
	console.log('');
	console.log('Interactive:');
	console.log('  openmelon                            Enter the TUI');
	console.log('  openmelon repl                       Same; explicit form');
	console.log('  openmelon resume [<id>]              Resume a prior session');
	console.log('');
	console.log('Subcommands:');
	console.log('  init [<id>]                          Set up cwd as an openmelon project');
	console.log('  setup                                Run trust/auth/project setup');
	console.log('  project list|use|show|set-key|unset-key|keys');
	console.log('  character add|list|show|rm           Project character library');
	console.log('  reference add|list|show|rm           Project reference-image library');
	console.log('  material add|list                    Hash-addressed material pool');
	console.log('  space create|activate|list|show|context|search|decision|feedback|memory|promote|episode|asset|asset-weight|compact');
	console.log('  session events <id>                  Inspect session lifecycle events');
	console.log('  search "<query>"                     Search project libraries');
	console.log('');
	console.log('Runtime: TypeScript native only. Non-TS runtimes are not used by this entrypoint.');
}

function truncate(text: string, max: number) {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

main().catch(error => {
	console.error(`openmelon: ${(error as Error).message}`);
	process.exit(1);
});
