import path from 'node:path';
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {Box, Text, render, useApp, useInput, useStdin, useStdout} from 'ink';
import stringWidth from 'string-width';
import {inspectBootstrap, type BootstrapState} from '../core/bootstrap.js';
import {addTrustedDir, loadCredentials, loadUserConfig, registerProject, saveCredentials, saveUserConfig} from '../core/config.js';
import {initProject, slugFromBase, validateProjectId} from '../core/project.js';
import {providerBySlug, providers, type ProviderOption} from '../core/providers.js';
import {clearCursorAnchor} from '../terminal/cursorAnchor.js';
import {accentColor} from '../theme.js';

type Step =
	| 'trust'
	| 'authProvider'
	| 'authReuseEnv'
	| 'authKey'
	| 'authLLMModel'
	| 'authImageModel'
	| 'projectConfirm'
	| 'projectID'
	| 'projectName'
	| 'projectDesc'
	| 'saving';

type FieldMode = 'plain' | 'password';

type OnboardingState = {
	step: Step;
	cursor: number;
	fieldValue: string;
	fieldCursor: number;
	error: string;
	providerIndex: number;
	envKey: string;
	apiKey: string;
	llmModel: string;
	imageModel: string;
	projectID: string;
	projectName: string;
	projectDesc: string;
};

type Props = {
	bootstrap: BootstrapState;
	onComplete: () => Promise<BootstrapState>;
	onReady?: () => void;
	forceAuth?: boolean;
};

export function Onboarding({bootstrap, onComplete, onReady, forceAuth = false}: Props) {
	const {exit} = useApp();
	const {stdout} = useStdout();
	const {isRawModeSupported} = useStdin();
	const [state, setState] = useState(() => createInitialState(bootstrap, forceAuth));
	const [screenReady, setScreenReady] = useState(() => !stdout.isTTY);
	const cwd = bootstrap.cwd || process.cwd();
	const width = Math.max(40, stdout.columns ?? 88);

	useEffect(() => {
		clearCursorAnchor();
		if (!stdout.isTTY) {
			setScreenReady(true);
			return;
		}
		stdout.write('\u001B[?1049h\u001B[2J\u001B[H\u001B[?25l');
		setScreenReady(true);
		return () => {
			clearCursorAnchor();
			stdout.write('\u001B[?25h\u001B[?1049l');
		};
	}, [stdout]);

	const selectedProvider = providers[state.providerIndex] ?? providers[0]!;

	const finish = useCallback(async () => {
		setState(current => ({...current, step: 'saving', error: ''}));
		try {
			const next = await onComplete();
			if (!next.ready && !forceAuth) {
				setState({...createInitialState(next, forceAuth), error: next.issues.join('\n') || 'setup is still incomplete'});
			} else {
				if (onReady) {
					onReady();
					exit();
				}
			}
		} catch (error) {
			setState(current => ({...current, step: nextStepAfterSave(bootstrap, forceAuth), error: (error as Error).message}));
		}
	}, [bootstrap, exit, forceAuth, onComplete, onReady]);

	const afterTrust = useCallback(() => {
		if (forceAuth || bootstrap.needsKey) {
			setState(current => ({...current, step: 'authProvider', cursor: current.providerIndex, error: ''}));
			return;
		}
		if (bootstrap.needsProject) {
			setState(current => ({...current, step: 'projectConfirm', cursor: 0, error: ''}));
			return;
		}
		void finish();
	}, [bootstrap.needsKey, bootstrap.needsProject, finish, forceAuth]);

	const afterAuth = useCallback(() => {
		if (!forceAuth && bootstrap.needsProject) {
			setState(current => ({...current, step: 'projectConfirm', cursor: 0, error: ''}));
			return;
		}
		void finish();
	}, [bootstrap.needsProject, finish, forceAuth]);

	const persistAuth = useCallback(
		async (current: OnboardingState) => {
			const provider = providers[current.providerIndex] ?? providers[0]!;
			const llmModel = current.llmModel.trim() || provider.defaultLLMModel;
			const imageModel = provider.imageProvider ? current.imageModel.trim() : '';
			const credentials = await loadCredentials();
			credentials.api_keys = {...credentials.api_keys, [provider.slug]: current.apiKey};
			await saveCredentials(credentials);

			const config = await loadUserConfig();
			config.defaults = {
				...config.defaults,
				llm_provider: provider.slug,
				llm_model: llmModel,
				image_provider: imageModel ? provider.imageProvider : '',
				image_model: imageModel
			};
			await saveUserConfig(config);
		},
		[]
	);

	const persistProject = useCallback(
		async (current: OnboardingState) => {
			const id = current.projectID.trim() || slugFromBase(path.basename(cwd));
			validateProjectId(id);
			const name = current.projectName.trim() || id;
			const description = current.projectDesc.trim();
			await initProject(cwd, {
				id,
				name,
				description: description || undefined,
				created_at: new Date().toISOString()
			});
			await registerProject(id, name, cwd);
		},
		[cwd]
	);

	const choose = useCallback(
		(index: number) => {
			if (state.step === 'saving') {
				return;
			}
			switch (state.step) {
				case 'trust':
					if (index !== 0) {
						exit();
						return;
					}
					setState(current => ({...current, step: 'saving', error: ''}));
					addTrustedDir(cwd)
						.then(afterTrust)
						.catch(error => {
							setState(current => ({...current, step: 'trust', error: `trust: ${(error as Error).message}`}));
						});
					return;

				case 'authProvider': {
					const provider = providers[index] ?? providers[0]!;
					const envKey = process.env[provider.envVar] ?? '';
					if (envKey) {
						setState(current => ({
							...current,
							step: 'authReuseEnv',
							providerIndex: index,
							cursor: 0,
							envKey,
							error: ''
						}));
						return;
					}
					setState(current => ({
						...current,
						step: 'authKey',
						providerIndex: index,
						fieldValue: '',
						fieldCursor: 0,
						error: ''
					}));
					return;
				}

				case 'authReuseEnv':
					if (index === 0) {
						const provider = providers[state.providerIndex] ?? providers[0]!;
						setState(current => ({
							...current,
							step: 'authLLMModel',
							apiKey: current.envKey,
							fieldValue: provider.defaultLLMModel,
							fieldCursor: Array.from(provider.defaultLLMModel).length,
							error: ''
						}));
						return;
					}
					setState(current => ({...current, step: 'authKey', fieldValue: '', fieldCursor: 0, error: ''}));
					return;

				case 'projectConfirm':
					if (index !== 0) {
						exit();
						return;
					}
					setState(current => {
						const value = slugFromBase(path.basename(cwd));
						return {
							...current,
							step: 'projectID',
							fieldValue: value,
							fieldCursor: Array.from(value).length,
							error: ''
						};
					});
					return;
			}
		},
		[afterTrust, cwd, exit, state.providerIndex, state.step]
	);

	const submitField = useCallback(() => {
		switch (state.step) {
			case 'authKey': {
				const key = state.fieldValue.trim();
				if (!key) {
					setState(current => ({...current, error: 'API key is required'}));
					return;
				}
				const provider = providers[state.providerIndex] ?? providers[0]!;
				setState(current => ({
					...current,
					step: 'authLLMModel',
					apiKey: key,
					fieldValue: provider.defaultLLMModel,
					fieldCursor: Array.from(provider.defaultLLMModel).length,
					error: ''
				}));
				return;
			}

			case 'authLLMModel': {
				const llmModel = state.fieldValue.trim() || selectedProvider.defaultLLMModel;
				if (selectedProvider.imageProvider) {
					const image = selectedProvider.defaultImageModel ?? '';
					setState(current => ({
						...current,
						step: 'authImageModel',
						llmModel,
						fieldValue: image,
						fieldCursor: Array.from(image).length,
						error: ''
					}));
					return;
				}
				const current = {...state, llmModel};
				setState(prev => ({...prev, step: 'saving', error: ''}));
				persistAuth(current)
					.then(afterAuth)
					.catch(error => {
						setState(prev => ({...prev, step: 'authLLMModel', error: `auth: ${(error as Error).message}`}));
					});
				return;
			}

			case 'authImageModel': {
				const imageModel = state.fieldValue.trim();
				const current = {...state, imageModel};
				setState(prev => ({...prev, step: 'saving', error: ''}));
				persistAuth(current)
					.then(afterAuth)
					.catch(error => {
						setState(prev => ({...prev, step: 'authImageModel', error: `auth: ${(error as Error).message}`}));
					});
				return;
			}

			case 'projectID': {
				const id = state.fieldValue.trim() || slugFromBase(path.basename(cwd));
				try {
					validateProjectId(id);
				} catch (error) {
					setState(current => ({...current, error: (error as Error).message}));
					return;
				}
				setState(current => ({
					...current,
					step: 'projectName',
					projectID: id,
					fieldValue: id,
					fieldCursor: Array.from(id).length,
					error: ''
				}));
				return;
			}

			case 'projectName': {
				const name = state.fieldValue.trim() || state.projectID;
				setState(current => ({
					...current,
					step: 'projectDesc',
					projectName: name,
					fieldValue: '',
					fieldCursor: 0,
					error: ''
				}));
				return;
			}

			case 'projectDesc': {
				const current = {...state, projectDesc: state.fieldValue.trim()};
				setState(prev => ({...prev, step: 'saving', error: ''}));
				persistProject(current)
					.then(finish)
					.catch(error => {
						setState(prev => ({...prev, step: 'projectDesc', error: `project init: ${(error as Error).message}`}));
					});
				return;
			}
		}
	}, [afterAuth, cwd, finish, persistAuth, persistProject, selectedProvider, state]);

	useInput((input, key) => {
		if (state.step === 'saving') {
			return;
		}

		const options = optionsFor(state, cwd);

		if ((key.ctrl && input === 'c') || key.escape || (options.length > 0 && input === 'q')) {
			exit();
			return;
		}

		if (options.length > 0) {
			if (key.upArrow || input === 'k') {
				setState(current => ({...current, cursor: Math.max(0, current.cursor - 1), error: ''}));
				return;
			}
			if (key.downArrow || input === 'j') {
				setState(current => ({...current, cursor: Math.min(options.length - 1, current.cursor + 1), error: ''}));
				return;
			}
			if (/^[1-9]$/.test(input)) {
				const index = Number(input) - 1;
				if (index < options.length) {
					choose(index);
				}
				return;
			}
			if (key.return) {
				choose(state.cursor);
				return;
			}
			return;
		}

		if (key.return) {
			submitField();
			return;
		}
		if (key.leftArrow) {
			setState(current => ({...current, fieldCursor: Math.max(0, current.fieldCursor - 1)}));
			return;
		}
		if (key.rightArrow) {
			setState(current => ({
				...current,
				fieldCursor: Math.min(Array.from(current.fieldValue).length, current.fieldCursor + 1)
			}));
			return;
		}
		if (key.backspace || key.delete) {
			setState(current => removeBeforeCursor(current));
			return;
		}
		if (key.ctrl) {
			return;
		}
		const text = normalizeTextInput(input);
		if (text.length > 0) {
			setState(current => insertAtCursor(current, text));
		}
	}, {isActive: isRawModeSupported});

	const view = useMemo(() => viewFor(state, bootstrap, selectedProvider, cwd), [bootstrap, cwd, selectedProvider, state]);

	if (!screenReady) {
		return null;
	}

	return (
		<Box flexDirection="column" width={width}>
			<Text bold>{view.title}</Text>
			{view.body.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					{view.body.map(line => (
						<Text key={line}>{line}</Text>
					))}
				</Box>
			)}
			{view.options.length > 0 && (
				<Box flexDirection="column" marginTop={2}>
					{view.options.map((option, index) => (
						<OptionRow key={option.title} option={option} index={index} active={index === state.cursor} />
					))}
				</Box>
			)}
			{view.field && (
				<Box flexDirection="column" marginTop={2}>
					<FieldLine state={state} mode={view.field.mode} placeholder={view.field.placeholder} width={width - 4} />
				</Box>
			)}
			{state.error && (
				<Box marginTop={2} flexDirection="column">
					{state.error.split('\n').map(line => (
						<Text key={line} color="red">
							{line}
						</Text>
					))}
				</Box>
			)}
			<Box marginTop={2}>
				<Text color="gray">{view.help}</Text>
			</Box>
		</Box>
	);
}

export async function runOnboardingWizard(options: {forceAuth?: boolean} = {}) {
	let done = false;
	const rawBootstrap = await inspectBootstrap();
	const bootstrap = options.forceAuth
		? {
				...rawBootstrap,
				needsTrust: false,
				needsProject: false,
				needsKey: true,
				ready: false,
				issues: []
			}
		: rawBootstrap;
	if (bootstrap.ready && !options.forceAuth) {
		return;
	}
	if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
		throw new Error('interactive setup requires a TTY; use `openmelon setup --provider <provider> --api-key <key>` in non-interactive shells');
	}

	const app = render(
		<Onboarding
			bootstrap={bootstrap}
			onComplete={async () => {
				const next = await inspectBootstrap();
				return options.forceAuth ? {...next, ready: true, issues: [], needsKey: false} : next;
			}}
			forceAuth={options.forceAuth}
			onReady={() => {
				done = true;
			}}
		/>,
		{exitOnCtrlC: false}
	);

	await app.waitUntilExit();
	if (done) {
		console.error('setup complete.');
	} else {
		console.error('setup cancelled.');
	}
}

type ViewModel = {
	title: string;
	body: string[];
	options: Array<{title: string; subtitle?: string}>;
	field?: {placeholder: string; mode: FieldMode};
	help: string;
};

function viewFor(state: OnboardingState, bootstrap: BootstrapState, provider: ProviderOption, cwd: string): ViewModel {
	switch (state.step) {
		case 'trust':
			return {
				title: `> You are in ${cwd}`,
				body: [
					'Do you trust the contents of this directory?',
					'OpenMelon will read project files, registered characters and references,',
					'and may invoke tools the agent decides to call. Only continue if you trust',
					'the contents here.'
				],
				options: [{title: 'Yes, continue'}, {title: 'No, quit'}],
				help: '↑/↓ to choose · 1/2 shortcut · enter to continue · ctrl+c to quit'
			};
		case 'authProvider':
			return {
				title: 'Welcome to openmelon',
				body: [
					'OpenMelon needs an API key to talk to a model.',
					'Pick one provider — you can change later with `openmelon setup`.'
				],
				options: providers.map(item => ({title: item.title, subtitle: item.subtitle})),
				help: '↑/↓ to choose · 1/2/3 shortcut · enter to continue · ctrl+c to cancel'
			};
		case 'authReuseEnv': {
			const masked = maskKey(state.envKey);
			return {
				title: `Detected ${provider.envVar} in your environment`,
				body: [`Use ${masked} as the ${provider.title.replace(/^Use /, '')} key?`],
				options: [{title: 'Yes, use it'}, {title: 'No, paste a different one'}],
				help: 'enter to continue · esc to cancel'
			};
		}
		case 'authKey':
			return {
				title: `Paste your ${provider.title.replace(/^Use /, '')} API key`,
				body: ['It will be stored at ~/.openmelon/credentials.json (mode 0600).'],
				options: [],
				field: {placeholder: provider.envVar, mode: 'password'},
				help: 'enter to continue · esc to cancel'
			};
		case 'authLLMModel':
			return {
				title: 'LLM model',
				body: [`Default: ${provider.defaultLLMModel}. Enter to accept, or edit the line.`],
				options: [],
				field: {placeholder: provider.defaultLLMModel, mode: 'plain'},
				help: 'enter to continue · esc to cancel'
			};
		case 'authImageModel':
			return {
				title: 'Image model (leave blank to skip image generation)',
				body: [`Default: ${provider.defaultImageModel ?? ''}. Enter to accept, or edit the line.`],
				options: [],
				field: {placeholder: provider.defaultImageModel ?? '', mode: 'plain'},
				help: 'enter to continue · esc to cancel'
			};
		case 'projectConfirm':
			return {
				title: `> No openmelon project found in ${cwd}`,
				body: [
					'Create one here? It just adds a `.openmelon/` directory with a project.json,',
					'plus subdirs for characters, references, materials, and sessions.'
				],
				options: [{title: 'Yes, initialize a new project here'}, {title: 'No, quit'}],
				help: 'enter to continue · esc to cancel'
			};
		case 'projectID':
			return {
				title: 'Project id (kebab-case, the registry key)',
				body: [],
				options: [],
				field: {placeholder: slugFromBase(path.basename(cwd)), mode: 'plain'},
				help: 'enter to continue · esc to cancel'
			};
		case 'projectName':
			return {
				title: 'Project name (free text shown in the UI)',
				body: [],
				options: [],
				field: {placeholder: state.projectID, mode: 'plain'},
				help: 'enter to continue · esc to cancel'
			};
		case 'projectDesc':
			return {
				title: 'One-line description (optional)',
				body: [],
				options: [],
				field: {placeholder: '', mode: 'plain'},
				help: 'enter to continue · esc to cancel'
			};
		case 'saving':
			return {
				title: 'Saving setup',
				body: ['Writing OpenMelon configuration...'],
				options: [],
				help: 'please wait'
			};
	}
}

function OptionRow({
	option,
	index,
	active
}: {
	option: {title: string; subtitle?: string};
	index: number;
	active: boolean;
}) {
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Box>
				<Text color={active ? accentColor : undefined} bold={active}>
					{active ? '> ' : '  '}
					{index + 1}. {option.title}
				</Text>
			</Box>
			{option.subtitle && (
				<Box marginLeft={5}>
					<Text color="gray">{option.subtitle}</Text>
				</Box>
			)}
		</Box>
	);
}

function FieldLine({
	state,
	mode,
	placeholder,
	width
}: {
	state: OnboardingState;
	mode: FieldMode;
	placeholder: string;
	width: number;
}) {
	const rendered = renderFieldValue(state.fieldValue, state.fieldCursor, mode, placeholder);
	const clipped = clipStart(rendered, Math.max(20, width - 4));
	return (
		<Text>
			<Text color={accentColor}>› </Text>
			<Text color={state.fieldValue.length === 0 ? 'gray' : 'white'}>{clipped}</Text>
		</Text>
	);
}

function renderFieldValue(value: string, cursor: number, mode: FieldMode, placeholder: string) {
	const chars = Array.from(value);
	const visible = mode === 'password' ? chars.map(() => '•') : chars;
	if (visible.length === 0) {
		return `▌ ${placeholder}`;
	}
	const left = visible.slice(0, cursor).join('');
	const right = visible.slice(cursor).join('');
	return `${left}▌${right}`;
}

function createInitialState(bootstrap: BootstrapState, forceAuth = false): OnboardingState {
	const providerIndex = Math.max(
		0,
		providers.findIndex(provider => provider.slug === providerBySlug(bootstrap.provider)?.slug)
	);
	return {
		step: initialStep(bootstrap, forceAuth),
		cursor: providerIndex,
		fieldValue: '',
		fieldCursor: 0,
		error: '',
		providerIndex,
		envKey: '',
		apiKey: '',
		llmModel: '',
		imageModel: '',
		projectID: '',
		projectName: '',
		projectDesc: ''
	};
}

function initialStep(bootstrap: BootstrapState, forceAuth = false): Step {
	if (bootstrap.needsTrust) {
		return 'trust';
	}
	if (forceAuth || bootstrap.needsKey) {
		return 'authProvider';
	}
	if (bootstrap.needsProject) {
		return 'projectConfirm';
	}
	return 'saving';
}

function nextStepAfterSave(bootstrap: BootstrapState, forceAuth = false): Step {
	return initialStep(bootstrap, forceAuth);
}

function optionsFor(state: OnboardingState, cwd: string) {
	switch (state.step) {
		case 'trust':
		case 'authProvider':
		case 'authReuseEnv':
		case 'projectConfirm':
			return viewFor(state, {...emptyBootstrap, cwd}, providers[state.providerIndex] ?? providers[0]!, cwd).options;
		default:
			return [];
	}
}

const emptyBootstrap: BootstrapState = {
	cwd: '',
	workdir: null,
	projectId: '',
	projectName: '',
	model: '',
	reasoning: '',
	provider: 'openrouter',
	project: undefined,
	ready: false,
	issues: [],
	needsTrust: false,
	needsProject: false,
	needsKey: false
};

function insertAtCursor(state: OnboardingState, text: string) {
	const chars = Array.from(state.fieldValue);
	const insert = Array.from(text);
	chars.splice(state.fieldCursor, 0, ...insert);
	return {
		...state,
		fieldValue: chars.join(''),
		fieldCursor: state.fieldCursor + insert.length,
		error: ''
	};
}

function removeBeforeCursor(state: OnboardingState) {
	if (state.fieldCursor <= 0) {
		return state;
	}
	const chars = Array.from(state.fieldValue);
	chars.splice(state.fieldCursor - 1, 1);
	return {
		...state,
		fieldValue: chars.join(''),
		fieldCursor: state.fieldCursor - 1,
		error: ''
	};
}

function normalizeTextInput(input: string) {
	if (!input || input.includes('\u001B')) {
		return '';
	}
	return input
		.replace(/\r\n/g, '\n')
		.replace(/\r/g, '\n')
		.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
}

function maskKey(value: string) {
	if (value.length <= 8) {
		return '••••';
	}
	return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function clipStart(value: string, width: number) {
	if (stringWidth(value) <= width) {
		return value;
	}
	const chars = Array.from(value);
	let out = '';
	for (let index = chars.length - 1; index >= 0; index--) {
		const next = chars[index] + out;
		if (stringWidth(`…${next}`) > width) {
			break;
		}
		out = next;
	}
	return `…${out}`;
}
