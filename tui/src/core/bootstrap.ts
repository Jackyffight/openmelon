import {discoverProject, loadProject, type ProjectConfig} from './project.js';
import {isTrusted, loadUserConfig, resolveApiKey} from './config.js';

export type BootstrapState = {
	cwd: string;
	workdir: string | null;
	projectId: string;
	projectName: string;
	model: string;
	reasoning: string;
	provider: string;
	imageModel: string;
	imageProvider: string;
	project?: ProjectConfig;
	ready: boolean;
	issues: string[];
	needsTrust: boolean;
	needsProject: boolean;
	needsKey: boolean;
};

export async function inspectBootstrap(): Promise<BootstrapState> {
	const cwd = process.cwd();
	const workdir = await discoverProject();
	const config = await loadUserConfig();
	const issues: string[] = [];

	// Model / provider / image model are GLOBAL only (~/.openmelon/config.json).
	const provider = config.defaults?.llm_provider || 'openai';
	const model = config.defaults?.llm_model || 'gpt-5.5';
	const imageProvider = config.defaults?.image_provider || '';
	const imageModel = config.defaults?.image_model || '';
	const {key: resolvedKey} = await resolveApiKey(provider);
	const hasKey = Boolean(resolvedKey);

	if (!workdir) {
		const needsTrust = !(await isTrusted(config, cwd));
		if (needsTrust) {
			issues.push(`trust ${cwd} before OpenMelon reads project files`);
		}
		if (!hasKey) {
			issues.push('no API key configured');
		}
		issues.push('no openmelon project found');
		return {
			cwd,
			workdir: null,
			projectId: '',
			projectName: '',
			model,
			reasoning: config.defaults?.reasoning_effort || 'xhigh',
			provider,
			imageModel,
			imageProvider,
			project: undefined,
			ready: false,
			issues,
			needsTrust,
			needsProject: true,
			needsKey: !hasKey
		};
	}

	const project = await loadProject(workdir);
	let needsTrust = false;
	if (!(await isTrusted(config, cwd))) {
		needsTrust = true;
		issues.push(`trust ${cwd} before OpenMelon reads project files`);
	}

	// reasoning_effort stays a per-project behaviour knob; everything else global.
	const reasoning = project.settings?.reasoning_effort || config.defaults?.reasoning_effort || 'xhigh';

	if (!hasKey && provider !== 'auto') {
		issues.push(`no API key for ${provider} - run \`openmelon setup\` or configure the provider's API key env var`);
	}

	return {
		cwd,
		workdir,
		projectId: project.id,
		projectName: project.name,
		model,
		reasoning,
		provider,
		imageModel,
		imageProvider,
		project,
		ready: issues.length === 0,
		issues,
		needsTrust,
		needsProject: false,
		needsKey: !hasKey && provider !== 'auto'
	};
}
