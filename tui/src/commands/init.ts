import path from 'node:path';
import {initProject, loadProject, slugFromBase, validateProjectId} from '../core/project.js';
import {registerProject} from '../core/config.js';

export async function runInitCommand(args: string[]) {
	const parsed = parseInitArgs(args);
	const workdir = path.resolve(parsed.workdir || process.cwd());
	const id = parsed.id || slugFromBase(path.basename(workdir));
	validateProjectId(id);
	const name = parsed.name || id;
	const project = {
		id,
		name,
		description: parsed.description || undefined,
		created_at: new Date().toISOString()
	};

	const result = await initProject(workdir, project);
	const saved = result.created ? project : await loadProject(workdir);
	await registerProject(saved.id, saved.name, workdir, {setCurrent: parsed.setCurrent});

	console.log(`${result.created ? 'Initialized' : 'Registered existing'} project ${JSON.stringify(saved.id)} at ${workdir}`);
	if (parsed.setCurrent) {
		console.log('Set as current project.');
	}
}

function parseInitArgs(args: string[]) {
	const out: {id?: string; name?: string; description?: string; workdir?: string; setCurrent: boolean} = {setCurrent: true};
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		switch (arg) {
			case '--name':
				out.name = args[++index];
				break;
			case '--description':
				out.description = args[++index];
				break;
			case '--workdir':
				out.workdir = args[++index];
				break;
			case '--set-current':
				out.setCurrent = true;
				break;
			case '--no-set-current':
				out.setCurrent = false;
				break;
			default:
				if (!arg.startsWith('-') && !out.id) {
					out.id = arg;
				} else {
					throw new Error(`unknown init argument ${arg}`);
				}
		}
	}
	return out;
}
