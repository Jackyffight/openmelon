import {discoverProject, loadProject, type ProjectConfig} from './project.js';
import {isTrusted, loadCredentials, loadUserConfig, providerApiKeyEnv} from './config.js';

export type BootstrapState = {
	cwd: string;
	workdir: string | null;
	projectId: string;
	projectName: string;
	model: string;
	reasoning: string;
	provider: string;
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
	const credentials = await loadCredentials();
	const issues: string[] = [];
	const globallyConfiguredKey = Object.keys(credentials.api_keys ?? {}).length > 0;

	if (!workdir) {
		const needsTrust = !isTrusted(config, cwd);
		const provider = config.defaults?.llm_provider || 'openrouter';
		const model = config.defaults?.llm_model || 'openai/gpt-5.5';
		const reasoning = config.defaults?.reasoning_effort || 'xhigh';
		if (needsTrust) {
			issues.push(`trust ${cwd} before OpenMelon reads project files`);
		}
		if (!globallyConfiguredKey) {
			issues.push('no API key configured');
		}
		issues.push('no openmelon project found');
		return {
			cwd,
			workdir: null,
			projectId: '',
			projectName: '',
			model,
			reasoning,
			provider,
			project: undefined,
			ready: false,
			issues,
			needsTrust,
			needsProject: true,
			needsKey: !globallyConfiguredKey
		};
	}

	const project = await loadProject(workdir);
	let needsTrust = false;
	if (!isTrusted(config, cwd)) {
		needsTrust = true;
		issues.push(`trust ${cwd} before OpenMelon reads project files`);
	}

	const provider = project.defaults?.llm_provider || config.defaults?.llm_provider || 'openai';
	const model = project.defaults?.llm_model || config.defaults?.llm_model || 'gpt-5.5';
	const reasoning = project.settings?.reasoning_effort || config.defaults?.reasoning_effort || 'xhigh';
	const projectProvider = project.providers?.[provider];
	const globalProvider = config.providers?.[provider];
	const hasKey =
		globallyConfiguredKey ||
		Boolean(projectProvider?.api_key) ||
		Boolean(globalProvider?.api_key) ||
		Boolean(credentials.api_keys?.[provider]) ||
		Boolean(process.env[providerApiKeyEnv(provider)]);

	if (!hasKey && provider !== 'auto') {
		issues.push(`no API key for ${provider} - run \`openmelon setup\` or configure ${providerApiKeyEnv(provider)}`);
	}

	return {
		cwd,
		workdir,
		projectId: project.id,
		projectName: project.name,
		model,
		reasoning,
		provider,
		project,
		ready: issues.length === 0,
		issues,
		needsTrust,
		needsProject: false,
		needsKey: !hasKey && provider !== 'auto'
	};
}
