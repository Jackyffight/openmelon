import {promises as fs} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {outputsDir, stateDir} from '../core/project.js';
import {listSkills} from '../core/skillplus.js';
import {
	activateSpace,
	buildCompactionDraft,
	buildContextPacket,
	createEpisode,
	createSpace,
	listSpaces as listProjectSpaces,
	recordCompaction,
	recordDecision,
	recordJsonl,
	registerAsset,
	updateAssetWeight
} from '../core/space.js';
import {generateOpenAIImage, generateOpenRouterImage} from './openaiCompat.js';
import type {NativeRuntimeContext, NativeTool} from './nativeTypes.js';

export function buildNativeTools(ctx: NativeRuntimeContext): NativeTool[] {
	const tools = [
		listRegistryTool(ctx, 'character'),
		getRegistryTool(ctx, 'character'),
		listRegistryTool(ctx, 'reference'),
		getRegistryTool(ctx, 'reference'),
		searchTool(ctx),
		readFileTool(ctx),
		listSpacesTool(ctx),
		planWorkflowTool(ctx),
		createSpaceTool(ctx),
		getContextPacketTool(ctx),
		activateSpaceTool(ctx),
		jsonlContinuityTool(ctx, 'record_decision'),
		jsonlContinuityTool(ctx, 'record_feedback'),
		jsonlContinuityTool(ctx, 'record_memory_item'),
		promoteMemoryItemTool(ctx),
		createEpisodeTool(ctx),
		registerAssetTool(ctx),
		updateAssetWeightTool(ctx),
		recordCompactionTool(ctx),
		compileSkillTool(),
		generateImageTool(ctx),
		saveArtifactTool(ctx),
		bashTool(ctx),
		finishTool()
	];
	return tools;
}

function listRegistryTool(ctx: NativeRuntimeContext, kind: 'character' | 'reference'): NativeTool {
	const plural = kind === 'character' ? 'characters' : 'references';
	return {
		spec: {
			name: `list_${plural}`,
			description:
				kind === 'character'
					? 'List all characters registered in this project. Optional substring filter on name+description.'
					: 'List all reference images in this project - typically named scenes, lighting setups, or composition templates.',
			parameters: {type: 'object', properties: {query: {type: 'string'}}}
		},
		async dispatch(raw) {
			const args = objectArg<{query?: string}>(raw);
			const items = await listRegistry(ctx.workdir, kind);
			const query = (args.query ?? '').toLowerCase();
			return items
				.filter(item => !query || `${item.name} ${item.description}`.toLowerCase().includes(query))
				.map(item => ({slug: item.slug, name: item.name, description: item.description, tags: item.tags, images: item.images.length}));
		}
	};
}

function getRegistryTool(ctx: NativeRuntimeContext, kind: 'character' | 'reference'): NativeTool {
	return {
		spec: {
			name: `get_${kind}`,
			description:
				kind === 'character'
					? "Fetch a character's full details, including absolute paths to portrait images so you can pass them as references to generate_image."
					: "Fetch a reference image's full details, including absolute on-disk paths so you can pass them to generate_image.",
			parameters: {type: 'object', properties: {slug: {type: 'string'}}, required: ['slug']}
		},
		async dispatch(raw) {
			const args = objectArg<{slug?: string}>(raw);
			if (!args.slug) {
				return {error: 'slug is required'};
			}
			const item = await getRegistry(ctx.workdir, kind, args.slug);
			if (!item) {
				return {error: `${kind} ${args.slug} not found`};
			}
			return {
				...item,
				images: item.images.map(image => path.join(stateDir(ctx.workdir), registryDir(kind), item.slug, image))
			};
		}
	};
}

function searchTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'search',
			description: 'Grep across the project characters / references / materials. Supports substring queries and returns a ranked list.',
			parameters: {type: 'object', properties: {query: {type: 'string'}}, required: ['query']}
		},
		async dispatch(raw) {
			const args = objectArg<{query?: string}>(raw);
			const terms = (args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
			const items = [...(await listRegistry(ctx.workdir, 'character')), ...(await listRegistry(ctx.workdir, 'reference')), ...(await listRegistry(ctx.workdir, 'material'))];
			return items
				.map(item => {
					const hay = `${item.name}\n${item.description}\n${item.tags.join(' ')}`.toLowerCase();
					const score = terms.reduce((sum, term) => sum + (hay.includes(term) ? 2 : -100), 0);
					return {item, score};
				})
				.filter(hit => hit.score >= 0)
				.sort((a, b) => b.score - a.score || a.item.slug.localeCompare(b.item.slug))
				.slice(0, 20)
				.map(hit => ({kind: hit.item.kind, slug: hit.item.slug, name: hit.item.name, description: hit.item.description, tags: hit.item.tags, score: hit.score}));
		}
	};
}

function readFileTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'read_file',
			description: 'Read a UTF-8 text file from inside the project workdir. Paths are resolved relative to the project root and may not escape it.',
			parameters: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']}
		},
		async dispatch(raw) {
			const args = objectArg<{path?: string}>(raw);
			const abs = safeJoin(ctx.workdir, args.path ?? '');
			if (!abs) {
				return {error: 'path escapes project workdir'};
			}
			return {path: args.path, content: await fs.readFile(abs, 'utf8')};
		}
	};
}

function listSpacesTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'list_spaces',
			description: 'List or search creative continuity spaces. Use before starting or continuing a long-running series.',
			parameters: {type: 'object', properties: {query: {type: 'string'}}}
		},
		async dispatch(raw) {
			const args = objectArg<{query?: string}>(raw);
			const spaces = await listProjectSpaces(ctx.workdir);
			const terms = searchTerms(args.query ?? '');
			return spaces
				.map(space => ({space, score: scoreSpace(space, terms)}))
				.filter(hit => hit.score >= 0)
				.sort((a, b) => b.score - a.score || String(a.space.id).localeCompare(String(b.space.id)))
				.map(hit => ({score: hit.score, ...hit.space}));
		}
	};
}

function planWorkflowTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'plan_creator_workflow',
			description: "Plan whether a creative request starts a new space, confirms a draft, or continues an active space.",
			parameters: {type: 'object', properties: {intent: {type: 'string'}}, required: ['intent']}
		},
		async dispatch(raw) {
			const args = objectArg<{intent?: string}>(raw);
			const hits = (await listSpacesTool(ctx).dispatch({query: args.intent}, new AbortController().signal)) as Array<{id?: string; status?: string}>;
			if (hits.length === 0) {
				return {
					intent: args.intent ?? '',
					mode: 'new_space',
					needs_confirmation: true,
					reason: 'No matching active creative space was found; start with provisional assumptions and ask for confirmation.',
					steps: [
						{id: 'find-context', action: 'search existing spaces', tool: 'list_spaces'},
						{id: 'draft-space', action: 'create draft space', tool: 'create_space'},
						{id: 'ask-confirmation', action: 'ask concise confirmation questions'}
					]
				};
			}
			const best = hits[0]!;
			return {
				intent: args.intent ?? '',
				mode: best.status === 'draft' ? 'confirm_space' : 'continue_space',
				space_id: best.id,
				needs_confirmation: best.status === 'draft',
				reason: best.status === 'draft' ? 'A draft space matches; confirm or correct assumptions before production.' : 'An active creative space matches; load selected context and continue production.'
			};
		}
	};
}

function createSpaceTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'create_space',
			description: 'Create a draft creative continuity space with provisional assumptions. Ask clarification questions before treating assumptions as canon.',
			parameters: {
				type: 'object',
				properties: {
					id: {type: 'string'},
					name: {type: 'string'},
					platform: {type: 'string'},
					audience: {type: 'string'},
					description: {type: 'string'},
					tags: {type: 'array', items: {type: 'string'}},
					assumptions: {type: 'string'}
				},
				required: ['id', 'name']
			}
		},
		async dispatch(raw) {
			const args = objectArg<Record<string, unknown>>(raw);
			const id = String(args.id ?? '').trim();
			if (!validSlug(id)) {
				return {error: `invalid space id ${JSON.stringify(id)}`};
			}
			const space = await createSpace(ctx.workdir, {
				id,
				name: String(args.name ?? id),
				platform: String(args.platform ?? ''),
				audience: String(args.audience ?? ''),
				description: String(args.description ?? ''),
				tags: Array.isArray(args.tags) ? args.tags.map(String) : [],
				assumptions: String(args.assumptions ?? '')
			});
			return {...space, dir: spaceDir(ctx.workdir, id), next_action: 'Ask the user to confirm or correct provisional assumptions before recording decisions or creating episodes.'};
		}
	};
}

function getContextPacketTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'get_context_packet',
			description: 'Fetch model-readable continuity context for a creative space: assumptions, canon, plan, decisions, feedback, episodes, and assets.',
			parameters: {
				type: 'object',
				properties: {
					space_id: {type: 'string'},
					query: {type: 'string'},
					max_decisions: {type: 'number'},
					max_feedback: {type: 'number'},
					max_episodes: {type: 'number'},
					max_assets: {type: 'number'}
				},
				required: ['space_id']
			}
		},
		async dispatch(raw) {
			const args = objectArg<Record<string, unknown>>(raw);
			const id = String(args.space_id ?? '');
			const maxDecisions = numberArg(args.max_decisions, 8);
			const maxFeedback = numberArg(args.max_feedback, 8);
			const maxEpisodes = numberArg(args.max_episodes, 8);
			const maxAssets = numberArg(args.max_assets, 20);
			return buildContextPacket(ctx.workdir, ctx.projectId, id, {query: String(args.query ?? ''), maxDecisions, maxFeedback, maxEpisodes, maxAssets});
		}
	};
}

function activateSpaceTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'activate_space',
			description: 'Activate a draft creative space after explicit user confirmation. Records the confirmation as a decision.',
			parameters: {type: 'object', properties: {space_id: {type: 'string'}, decision: {type: 'string'}, reason: {type: 'string'}, weight: {type: 'number'}}, required: ['space_id', 'decision']}
		},
		async dispatch(raw) {
			const args = objectArg<Record<string, unknown>>(raw);
			const id = String(args.space_id ?? '');
			const result = await activateSpace(ctx.workdir, id, String(args.decision ?? ''), String(args.reason ?? ''), numberArg(args.weight, 1));
			return {id, name: result.space.name, status: result.space.status, decision: result.decision};
		}
	};
}

function jsonlContinuityTool(ctx: NativeRuntimeContext, name: 'record_decision' | 'record_feedback' | 'record_memory_item'): NativeTool {
	const specs = {
		record_decision: {
			description: 'Record a user-confirmed continuity decision for a creative space. Do not use for guesses.',
			file: 'decisions.jsonl',
			required: ['space_id', 'decision']
		},
		record_feedback: {
			description: 'Record user or audience feedback for a creative space so future production can adapt.',
			file: 'feedback.jsonl',
			required: ['space_id', 'signal']
		},
		record_memory_item: {
			description: 'Record a provisional memory item for observations, reusable patterns, preferences, risks, or open questions.',
			file: 'memory.jsonl',
			required: ['space_id', 'content']
		}
	} as const;
	return {
		spec: {
			name,
			description: specs[name].description,
			parameters: {type: 'object', properties: {space_id: {type: 'string'}}, required: specs[name].required}
		},
		async dispatch(raw) {
			const args = objectArg<Record<string, unknown>>(raw);
			const id = String(args.space_id ?? '');
			const record = {...args, id: String(args.id ?? `${prefixFor(name)}-${timestamp()}`)};
			if (name === 'record_decision') {
				return recordDecision(ctx.workdir, id, record);
			}
			return recordJsonl(ctx.workdir, id, specs[name].file as 'feedback.jsonl' | 'memory.jsonl', record, prefixFor(name));
		}
	};
}

function promoteMemoryItemTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'promote_memory_item',
			description: 'Promote a provisional memory item into a user-confirmed continuity decision.',
			parameters: {type: 'object', properties: {space_id: {type: 'string'}, item_id: {type: 'string'}, decision: {type: 'string'}, reason: {type: 'string'}, target: {type: 'string'}}, required: ['space_id', 'item_id', 'decision']}
		},
		async dispatch(raw) {
			const args = objectArg<Record<string, unknown>>(raw);
			return recordDecision(ctx.workdir, String(args.space_id ?? ''), {scope: 'memory', target: String(args.target ?? args.item_id ?? ''), decision: String(args.decision ?? ''), reason: String(args.reason ?? `Promoted from memory item ${args.item_id}`), weight: 1});
		}
	};
}

function createEpisodeTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'create_episode',
			description: 'Create or register an episode under an active creative space.',
			parameters: {type: 'object', properties: {space_id: {type: 'string'}, id: {type: 'string'}, title: {type: 'string'}, topic: {type: 'string'}, status: {type: 'string'}, brief: {type: 'string'}}, required: ['space_id', 'topic']}
		},
		async dispatch(raw) {
			const args = objectArg<Record<string, unknown>>(raw);
			const packet = await buildContextPacket(ctx.workdir, ctx.projectId, String(args.space_id ?? ''));
			if ((packet.space as Record<string, unknown>).status === 'draft') {
				return {error: `space ${args.space_id} is draft; confirm and activate before creating durable episodes`};
			}
			return createEpisode(ctx.workdir, String(args.space_id ?? ''), args);
		}
	};
}

function registerAssetTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'register_asset',
			description: 'Register a reusable continuity asset under a creative space.',
			parameters: {type: 'object', properties: {space_id: {type: 'string'}, id: {type: 'string'}, kind: {type: 'string'}, status: {type: 'string'}, description: {type: 'string'}, reuse_policy: {type: 'string'}, files: {type: 'array', items: {type: 'string'}}, tags: {type: 'array', items: {type: 'string'}}, weight: {type: 'number'}}, required: ['space_id', 'description']}
		},
		async dispatch(raw) {
			const args = objectArg<Record<string, unknown>>(raw);
			return registerAsset(ctx.workdir, String(args.space_id ?? ''), args);
		}
	};
}

function updateAssetWeightTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'update_asset_weight',
			description: 'Adjust a reusable continuity asset weight or status after feedback.',
			parameters: {type: 'object', properties: {space_id: {type: 'string'}, asset_id: {type: 'string'}, weight: {type: 'number'}, status: {type: 'string'}}, required: ['space_id', 'asset_id', 'weight']}
		},
		async dispatch(raw) {
			const args = objectArg<Record<string, unknown>>(raw);
			return updateAssetWeight(ctx.workdir, String(args.space_id ?? ''), String(args.asset_id ?? ''), numberArg(args.weight, 1), String(args.status ?? ''));
		}
	};
}

function recordCompactionTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'record_compaction',
			description: 'Record a compact summary of a creative space long-running state.',
			parameters: {type: 'object', properties: {space_id: {type: 'string'}, summary: {type: 'string'}, scope: {type: 'string'}}, required: ['space_id', 'summary']}
		},
		async dispatch(raw) {
			const args = objectArg<Record<string, unknown>>(raw);
			return recordCompaction(ctx.workdir, String(args.space_id ?? ''), String(args.summary ?? ''), String(args.scope ?? 'space'));
		}
	};
}

function compileSkillTool(): NativeTool {
	return {
		spec: {
			name: 'compile_skill',
			description: 'Compile a skillplus package and return its compiled prompt + output schema. Pass the bare skill slug, not skillplus:<slug>.',
			parameters: {type: 'object', properties: {skill: {type: 'string'}, locale: {type: 'string', enum: ['zh-CN', 'en']}, model_profile: {type: 'string'}, vars: {type: 'object', additionalProperties: {type: 'string'}}}, required: ['skill']}
		},
		async dispatch(raw, signal) {
			const args = objectArg<Record<string, unknown>>(raw);
			const skill = String(args.skill ?? '').replace(/^skillplus:/, '').replace(/^path:/, '');
			const skills = await listSkills().catch(() => []);
			const found = skills.find(item => item.id === skill || item.name === skill);
			return {
				skill,
				locale: normalizeLocale(String(args.locale ?? 'zh-CN')),
				model_profile: String(args.model_profile ?? 'gpt-image-family'),
				vars: args.vars && typeof args.vars === 'object' ? args.vars : {},
				found: Boolean(found),
				metadata: found ?? null,
				note:
					'TS native runtime no longer shells out to a compiler here. Use this metadata as a lightweight skill hint, then continue with the project system prompt and available tools.'
			};
		}
	};
}

function generateImageTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'generate_image',
			description: 'Generate a single image and save it into a visible project outputs directory for the current session.',
			parameters: {type: 'object', properties: {prompt: {type: 'string'}, reference_images: {type: 'array', items: {type: 'string'}}, size: {type: 'string'}, label: {type: 'string'}, output_dir: {type: 'string'}}, required: ['prompt']}
		},
		async dispatch(raw, signal) {
			if (!ctx.image) {
				return {error: 'image generation is not configured; use /model-image to enable it'};
			}
			const args = objectArg<Record<string, unknown>>(raw);
			const prompt = String(args.prompt ?? '');
			const refs = Array.isArray(args.reference_images) ? await Promise.all(args.reference_images.map(item => fs.readFile(String(item)))) : [];
			const image =
				ctx.image.provider === 'openrouter'
					? await generateOpenRouterImage({...ctx.image, reasoning: ''}, prompt, refs, signal)
					: await generateOpenAIImage({...ctx.image, reasoning: ''}, prompt, String(args.size ?? ''), signal);
			const label = slugFromText(String(args.label ?? 'image'));
			const ext = extensionFor(image.contentType);
			const outDir = resolveOutputDir(ctx.workdir, String(args.output_dir ?? ''), ctx.outputDir);
			await fs.mkdir(outDir, {recursive: true});
			const outPath = path.join(outDir, `${label}-${timeOnly()}${ext}`);
			await fs.writeFile(outPath, image.data);
			return {path: outPath, label, sha256: createHash('sha256').update(image.data).digest('hex'), size_bytes: image.data.length, prompt};
		}
	};
}

function saveArtifactTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'save_artifact',
			description: 'Promote a generated image to a permanent visible project artifact under outputs/artifacts/<slug>/<timestamp>/, or a project-relative output_dir.',
			parameters: {type: 'object', properties: {slug: {type: 'string'}, image_path: {type: 'string'}, prompt: {type: 'string'}, output_dir: {type: 'string'}}, required: ['slug', 'image_path']}
		},
		async dispatch(raw) {
			const args = objectArg<Record<string, unknown>>(raw);
			const slug = slugFromText(String(args.slug ?? 'artifact'));
			const source = String(args.image_path ?? '');
			const data = await fs.readFile(source);
			const outDir = resolveOutputDir(ctx.workdir, String(args.output_dir ?? ''), path.join(outputsDir(ctx.workdir), 'artifacts', slug, fullTimestamp()));
			await fs.mkdir(outDir, {recursive: true});
			const outPath = path.join(outDir, `image${path.extname(source) || '.png'}`);
			await fs.writeFile(outPath, data);
			if (args.prompt) {
				await fs.writeFile(path.join(outDir, 'prompt.txt'), String(args.prompt));
			}
			return {path: outPath, sha256: createHash('sha256').update(data).digest('hex')};
		}
	};
}

function bashTool(ctx: NativeRuntimeContext): NativeTool {
	return {
		spec: {
			name: 'bash',
			description: 'Run a shell command inside the project workdir and return combined stdout/stderr. In strict and auto modes, native runtime asks for approval; trusted mode runs without asking.',
			parameters: {type: 'object', properties: {command: {type: 'string'}, description: {type: 'string'}, timeout_seconds: {type: 'number'}}, required: ['command', 'description']}
		},
		async dispatch(raw, signal) {
			const args = objectArg<Record<string, unknown>>(raw);
			const command = String(args.command ?? '');
			const description = String(args.description ?? '');
			const binary = firstBinary(command);
			const decision =
				ctx.bashMode === 'trusted'
					? {approved: true, always: false}
					: await ctx.approve({id: '', tool: 'bash', command, description, binary});
			if (!decision.approved) {
				return {error: 'user denied execution'};
			}
			const timeout = Math.max(1, Math.min(300, numberArg(args.timeout_seconds, 30))) * 1000;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeout);
			signal.addEventListener('abort', () => controller.abort(), {once: true});
			try {
				const result = await runProcess('/bin/sh', ['-c', command], ctx.workdir, controller.signal);
				return {
					stdout: result.stdout + result.stderr,
					exit_code: result.code,
					approved_via: ctx.bashMode === 'trusted' ? 'trusted' : decision.always ? 'user-approved-always' : 'user-approved'
				};
			} finally {
				clearTimeout(timer);
			}
		}
	};
}

function finishTool(): NativeTool {
	return {
		spec: {
			name: 'finish',
			description: 'Signal that you completed the task. Provide a one- to two-paragraph summary and final artifact paths.',
			parameters: {type: 'object', properties: {summary: {type: 'string'}, artifacts: {type: 'array', items: {type: 'string'}}}, required: ['summary']}
		},
		async dispatch(raw) {
			const args = objectArg<{summary?: string; artifacts?: unknown}>(raw);
			return {summary: args.summary ?? '', artifacts: Array.isArray(args.artifacts) ? args.artifacts.map(String) : [], ok: true};
		}
	};
}

async function listRegistry(workdir: string, kind: 'character' | 'reference' | 'material') {
	const root = path.join(stateDir(workdir), registryDir(kind));
	const entries = await readdirDirs(root);
	const out = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const item = await getRegistry(workdir, kind, entry.name);
		if (item) {
			out.push(item);
		}
	}
	return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

async function getRegistry(workdir: string, kind: 'character' | 'reference' | 'material', slug: string) {
	const root = path.join(stateDir(workdir), registryDir(kind), slug);
	const item = await readJsonMaybe<Record<string, unknown> | null>(path.join(root, `${kind}.json`), null);
	if (!item) {
		return null;
	}
	const {description, tags} = await readSearchFile(path.join(root, '.search'));
	const images = await listImageBasenames(root);
	return {
		kind,
		slug,
		name: String(item.name ?? slug),
		description: description || String(item.description ?? ''),
		tags,
		images,
		extra: item.extra ?? {}
	};
}

async function readSearchFile(filePath: string) {
	const body = await readTextMaybe(filePath);
	const lines = body.split('\n');
	const tagsLine = lines.find(line => line.toLowerCase().startsWith('tags:'));
	const tags = tagsLine ? tagsLine.slice(5).split(/[,\s]+/).map(tag => tag.trim()).filter(Boolean) : [];
	const description = lines.filter(line => !line.toLowerCase().startsWith('tags:')).join('\n').trim();
	return {description, tags};
}

async function listImageBasenames(root: string) {
	try {
		const entries = await fs.readdir(root, {withFileTypes: true});
		return entries.filter(entry => entry.isFile() && /\.(png|jpe?g|webp|gif)$/i.test(entry.name)).map(entry => entry.name).sort();
	} catch {
		return [];
	}
}

async function readdirDirs(root: string) {
	try {
		return await fs.readdir(root, {withFileTypes: true});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

async function readJsonMaybe<T>(filePath: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return fallback;
		}
		throw error;
	}
}

async function readTextMaybe(filePath: string) {
	try {
		return await fs.readFile(filePath, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return '';
		}
		throw error;
	}
}

function objectArg<T extends Record<string, unknown>>(raw: unknown): T {
	return raw && typeof raw === 'object' ? (raw as T) : ({} as T);
}

function registryDir(kind: string) {
	return kind === 'character' ? 'characters' : kind === 'reference' ? 'references' : 'materials';
}

function safeJoin(root: string, requested: string) {
	const absRoot = path.resolve(root);
	const abs = path.resolve(absRoot, requested);
	const rel = path.relative(absRoot, abs);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) ? abs : '';
}

function spaceDir(workdir: string, id: string) {
	return path.join(stateDir(workdir), 'spaces', id);
}

function searchTerms(query: string) {
	const stop = new Set(['continue', 'again', 'yesterday', 'today', 'tomorrow', 'next', 'series', 'episode', 'post', 'the', 'a', 'an']);
	return query
		.toLowerCase()
		.split(/\s+/)
		.map(term => term.replace(/^[^\w]+|[^\w]+$/g, ''))
		.filter(term => term && !stop.has(term));
}

function scoreSpace(space: Record<string, unknown>, terms: string[]) {
	if (terms.length === 0) {
		return 1;
	}
	const hay = [space.id, space.name, space.description, space.platform, space.audience, ...(Array.isArray(space.tags) ? space.tags : [])].join('\n').toLowerCase();
	let score = 0;
	for (const term of terms) {
		if (String(space.id).toLowerCase() === term) {
			score += 10;
		} else if (hay.includes(term)) {
			score += 2;
		} else {
			return -1;
		}
	}
	if (space.status === 'active') {
		score += 3;
	}
	return score;
}

function validSlug(value: string) {
	return /^[a-z][a-z0-9-]{1,63}$/.test(value) && !value.endsWith('-') && !value.includes('--');
}

function slugFromText(value: string) {
	const slug = value
		.toLowerCase()
		.replace(/[^a-z0-9._ -]/g, '')
		.replace(/[._ -]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64)
		.replace(/-+$/g, '');
	if (/^[a-z]/.test(slug) && slug.length >= 2) {
		return slug;
	}
	return 'item';
}

function numberArg(value: unknown, fallback: number) {
	const num = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(num) ? num : fallback;
}

function timestamp() {
	const date = new Date();
	return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function fullTimestamp() {
	return timestamp();
}

function timeOnly() {
	const date = new Date();
	return `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function pad(value: number) {
	return String(value).padStart(2, '0');
}

function prefixFor(name: string) {
	switch (name) {
		case 'record_feedback':
			return 'fb';
		case 'record_memory_item':
			return 'mem';
		default:
			return 'dec';
	}
}

function extensionFor(contentType: string) {
	if (contentType.includes('jpeg')) {
		return '.jpg';
	}
	if (contentType.includes('webp')) {
		return '.webp';
	}
	if (contentType.includes('gif')) {
		return '.gif';
	}
	return '.png';
}

function resolveOutputDir(workdir: string, requested: string, fallback: string) {
	const root = path.resolve(workdir);
	const out = requested ? (path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(root, requested)) : path.resolve(fallback || outputsDir(root));
	const rel = path.relative(root, out);
	if (rel.startsWith('..') || path.isAbsolute(rel)) {
		throw new Error(`output dir ${requested} escapes project workdir`);
	}
	const state = path.resolve(stateDir(root));
	const stateRel = path.relative(state, out);
	if (stateRel === '' || (!stateRel.startsWith('..') && !path.isAbsolute(stateRel))) {
		throw new Error('output dir is inside .openmelon; choose a visible project directory');
	}
	return out;
}

function normalizeLocale(value: string) {
	const normalized = value.toLowerCase();
	if (!normalized || ['zh', 'zh-cn', 'zh_cn', 'chinese', 'cn'].includes(normalized)) {
		return 'zh-CN';
	}
	if (['en', 'en-us', 'english', 'us'].includes(normalized)) {
		return 'en';
	}
	return value;
}

function runProcess(command: string, args: string[], cwd: string, signal: AbortSignal) {
	return new Promise<{stdout: string; stderr: string; code: number}>((resolve, reject) => {
		const child = spawn(command, args, {cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], signal});
		let stdout = '';
		let stderr = '';
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', chunk => {
			stdout += String(chunk);
		});
		child.stderr.on('data', chunk => {
			stderr += String(chunk);
		});
		child.on('error', reject);
		child.on('exit', code => {
			resolve({stdout, stderr, code: code ?? 0});
		});
	});
}

function firstBinary(command: string) {
	for (const token of command.split(/\s+/)) {
		if (!token || (token.includes('=') && !/[\\/]/.test(token))) {
			continue;
		}
		if (['sudo', 'time', 'exec', 'nohup', 'env'].includes(token)) {
			continue;
		}
		return path.basename(token);
	}
	return '';
}
