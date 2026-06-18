// The standard openmelon tool set, ported from internal/tools/builtin.go.
//
// Tool param schemas + JSON result shapes are copied verbatim from the Go
// source so the model sees an identical contract.
//
// NOT YET PORTED (tracked in ENGINE_MIGRATION.md):
//   - the 13 creative-continuity tools (need a `continuity` TS port)
//   - bash (needs the judge + approval round-trip; lands with the runtime adapter)

import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {absoluteImagePaths, get, list, validateSlug, type Item, type Kind} from '../registry.js';
import {parse, run} from '../search.js';
import {compileSkill} from '../../core/skillplus.js';
import {artifactOutputDir, resolveOutputDir, sessionOutputDir, outputsDir} from '../../core/project.js';
import type {ImageGenerator} from '../imagegen.js';
import {Registry, type ToolDef} from './registry.js';
import {bashTool, type ApprovalDecision, type ApprovalRequest, type BashJudgement, type BashMode} from './bash.js';
import {registerContinuityTools} from './continuity.js';
import {webFetchTool, webSearchTool} from './web.js';

export type ToolEnv = {
	workdir: string;
	project?: {id?: string};
	/** Visible output directory for the current session (defaults to outputs/sessions/<id>). */
	outputDir?: string;
	/** When set, generate_image is registered. */
	imageGen?: ImageGenerator;
	// --- bash gating (all optional; absent → bash asks for approval, or is unavailable without `approve`) ---
	bashMode?: BashMode;
	isBashAllowed?: (binary: string) => boolean;
	allowBash?: (binary: string) => void;
	judgeBash?: (command: string, description: string, signal?: AbortSignal) => Promise<BashJudgement>;
	approve?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
};

/** Register the standard tool set into a fresh registry. */
export function buildRegistry(env: ToolEnv): Registry {
	const reg = new Registry();
	reg.register(listLibraryTool('list_characters', 'character', 'List all characters registered in this project. Optional substring filter on name+description.', env));
	reg.register(getLibraryTool('get_character', 'character', "Fetch a character's full details, including absolute paths to its portrait images so you can pass them as references to generate_image.", env));
	reg.register(listLibraryTool('list_references', 'reference', 'List all reference images in this project — typically named scenes, lighting setups, or composition templates.', env));
	reg.register(getLibraryTool('get_reference', 'reference', "Fetch a reference image's full details, including its absolute on-disk path so you can pass it to generate_image.", env));
	reg.register(searchTool(env));
	reg.register(webSearchTool({approve: env.approve}));
	reg.register(webFetchTool({approve: env.approve}));
	reg.register(readFileTool(env));
	registerContinuityTools(reg, {workdir: env.workdir, projectId: env.project?.id ?? ''});
	reg.register(compileSkillTool());
	if (env.imageGen) {
		reg.register(generateImageTool(env, env.imageGen));
	}
	reg.register(saveArtifactTool(env));
	reg.register(
		bashTool({
			workdir: env.workdir,
			bashMode: env.bashMode,
			isBashAllowed: env.isBashAllowed,
			allowBash: env.allowBash,
			judgeBash: env.judgeBash,
			approve: env.approve
		})
	);
	reg.register(finishTool());
	return reg;
}

// --- read-only library tools ---

function listLibraryTool(name: string, kind: Kind, description: string, env: ToolEnv): ToolDef {
	return {
		spec: {
			name,
			description,
			parameters: {
				type: 'object',
				properties: {query: {type: 'string', description: 'Optional substring to filter by'}}
			}
		},
		handler: async args => {
			const query = str(args, 'query');
			const items = await list(env.workdir, kind);
			return items
				.filter(it => {
					if (!query) {
						return true;
					}
					return `${it.name} ${it.description ?? ''}`.toLowerCase().includes(query.toLowerCase());
				})
				.map(it => ({
					slug: it.slug,
					name: it.name,
					description: it.description,
					tags: it.tags,
					images: (it.images ?? []).length
				}));
		}
	};
}

function getLibraryTool(name: string, kind: Kind, description: string, env: ToolEnv): ToolDef {
	return {
		spec: {
			name,
			description,
			parameters: {type: 'object', properties: {slug: {type: 'string'}}, required: ['slug']}
		},
		handler: async args => {
			const slug = str(args, 'slug');
			let it: Item;
			try {
				it = await get(env.workdir, kind, slug);
			} catch (error) {
				return {error: (error as Error).message};
			}
			return {
				slug: it.slug,
				name: it.name,
				description: it.description,
				tags: it.tags,
				extra: it.extra,
				image_paths: absoluteImagePaths(env.workdir, kind, it)
			};
		}
	};
}

function searchTool(env: ToolEnv): ToolDef {
	return {
		spec: {
			name: 'search',
			description:
				'Grep across the project\'s characters / references / materials. Supports tag:foo, kind:character, -negative, "quoted phrases". Returns a ranked list.',
			parameters: {type: 'object', properties: {query: {type: 'string'}}, required: ['query']}
		},
		handler: async args => {
			const query = str(args, 'query');
			try {
				const hits = await run(env.workdir, parse(query));
				return hits.map(h => ({
					kind: h.item.kind,
					slug: h.item.slug,
					name: h.item.name,
					description: h.item.description,
					tags: h.item.tags,
					score: h.score
				}));
			} catch (error) {
				return {error: (error as Error).message};
			}
		}
	};
}

function readFileTool(env: ToolEnv): ToolDef {
	return {
		spec: {
			name: 'read_file',
			description:
				'Read a UTF-8 text file from inside the project workdir. Paths are resolved relative to the project root and may not escape it.',
			parameters: {type: 'object', properties: {path: {type: 'string'}}, required: ['path']}
		},
		handler: async args => {
			const rel = str(args, 'path');
			let abs: string;
			try {
				abs = safeJoin(env.workdir, rel);
			} catch (error) {
				return {error: (error as Error).message};
			}
			try {
				const content = await fs.readFile(abs, 'utf8');
				return {path: rel, content};
			} catch (error) {
				return {error: (error as Error).message};
			}
		}
	};
}

// --- side-effecting tools ---

function compileSkillTool(): ToolDef {
	return {
		spec: {
			name: 'compile_skill',
			description:
				'Compile a skillplus package and return its compiled prompt + output schema. Pass the BARE skill slug (e.g. "brand-logo"), not "skillplus:brand-logo".',
			parameters: {
				type: 'object',
				properties: {
					skill: {
						type: 'string',
						description:
							'Bare skill slug (e.g. "brand-logo", "food-street-realism") OR an absolute path to a .skillplus directory. Do NOT prefix with "skillplus:".'
					},
					locale: {type: 'string', description: 'Locale to compile for. Allowed: "zh-CN" or "en". Default zh-CN.', enum: ['zh-CN', 'en']},
					model_profile: {type: 'string', description: 'Per-skill prompt overlay slug. Default "gpt-image-family".'},
					vars: {type: 'object', additionalProperties: {type: 'string'}}
				},
				required: ['skill']
			}
		},
		handler: async args => {
			let skill = str(args, 'skill');
			skill = skill.replace(/^skillplus:/, '').replace(/^path:/, '');
			try {
				return await compileSkill({
					packagePath: skill,
					target: 'openmelon',
					modelProfile: str(args, 'model_profile') || 'gpt-image-family',
					locale: normalizeLocale(str(args, 'locale')),
					vars: strMap(args, 'vars')
				});
			} catch (error) {
				return {error: (error as Error).message};
			}
		}
	};
}

function generateImageTool(env: ToolEnv, imageGen: ImageGenerator): ToolDef {
	return {
		spec: {
			name: 'generate_image',
			description:
				'Generate a single image and save it into the visible project outputs directory for the current session. Include continuity constraints for characters, scenes, typography, layout, and style in the prompt. Optionally pass reference_images (absolute paths) to anchor the result to known characters or scenes.',
			parameters: {
				type: 'object',
				properties: {
					prompt: {type: 'string'},
					reference_images: {type: 'array', items: {type: 'string', description: 'absolute path'}},
					size: {type: 'string', description: 'WxH, vendor-default if omitted'},
					label: {type: 'string', description: 'short label saved into the session metadata, e.g. "draft-1"'},
					output_dir: {
						type: 'string',
						description:
							'optional project-relative visible directory for this output; defaults to outputs/sessions/<session-id>. Do not use .openmelon.'
					}
				},
				required: ['prompt']
			}
		},
		handler: async (args, signal) => {
			const prompt = str(args, 'prompt');
			const referenceImages = strArr(args, 'reference_images');
			const refs: Uint8Array[] = [];
			for (const p of referenceImages) {
				try {
					refs.push(new Uint8Array(await fs.readFile(p)));
				} catch (error) {
					return {error: `read reference ${p}: ${(error as Error).message}`};
				}
			}
			let res;
			try {
				res = await imageGen.generate({prompt, size: str(args, 'size'), referenceImages: refs}, signal);
			} catch (error) {
				return {error: (error as Error).message};
			}
			const label = str(args, 'label') || 'image';
			const outName = `${label}-${stamp('time')}${extensionFor(res.contentType)}`;
			const fallback = env.outputDir || outputsDir(env.workdir);
			let outDir: string;
			try {
				outDir = resolveOutputDir(env.workdir, str(args, 'output_dir'), fallback);
			} catch (error) {
				return {error: (error as Error).message};
			}
			const outPath = path.join(outDir, outName);
			await fs.mkdir(outDir, {recursive: true});
			await fs.writeFile(outPath, res.data);
			return {
				path: outPath,
				label,
				sha256: sha256Hex(res.data),
				size_bytes: res.sizeBytes,
				prompt
			};
		}
	};
}

function saveArtifactTool(env: ToolEnv): ToolDef {
	return {
		spec: {
			name: 'save_artifact',
			description:
				'Promote a generated image to a permanent visible project artifact under outputs/artifacts/<slug>/<timestamp>/, or a project-relative output_dir if specified. Never write final deliverables under .openmelon.',
			parameters: {
				type: 'object',
				properties: {
					slug: {type: 'string', description: 'kebab-case label for this artifact bucket'},
					image_path: {type: 'string', description: 'absolute path returned by an earlier generate_image call'},
					prompt: {type: 'string', description: 'the prompt used; recorded for provenance'},
					output_dir: {type: 'string', description: 'optional project-relative visible directory for this artifact. Do not use .openmelon.'}
				},
				required: ['slug', 'image_path']
			}
		},
		handler: async args => {
			const slug = str(args, 'slug');
			const imagePath = str(args, 'image_path');
			try {
				validateSlug(slug);
			} catch (error) {
				return {error: (error as Error).message};
			}
			let bytes: Buffer;
			try {
				bytes = await fs.readFile(imagePath);
			} catch (error) {
				return {error: (error as Error).message};
			}
			const fallback = artifactOutputDir(env.workdir, slug, stamp('datetime'));
			let outDir: string;
			try {
				outDir = resolveOutputDir(env.workdir, str(args, 'output_dir'), fallback);
			} catch (error) {
				return {error: (error as Error).message};
			}
			await fs.mkdir(outDir, {recursive: true});
			const ext = path.extname(imagePath) || '.png';
			const outPath = path.join(outDir, `image${ext}`);
			await fs.writeFile(outPath, bytes);
			const prompt = str(args, 'prompt');
			if (prompt) {
				await fs.writeFile(path.join(outDir, 'prompt.txt'), prompt);
			}
			return {path: outPath, sha256: sha256Hex(bytes)};
		}
	};
}

function finishTool(): ToolDef {
	return {
		spec: {
			name: 'finish',
			description:
				"Signal that you've completed the task. Provide a one- to two-paragraph summary the user will see, plus any final artifact paths.",
			parameters: {
				type: 'object',
				properties: {
					summary: {type: 'string'},
					artifacts: {type: 'array', items: {type: 'string'}, description: 'Absolute paths to final outputs'}
				},
				required: ['summary']
			}
		},
		// Sentinel — the runtime reads summary/artifacts and exits the loop.
		handler: args => ({summary: str(args, 'summary'), artifacts: strArr(args, 'artifacts'), ok: true})
	};
}

// --- helpers ---

function str(args: Record<string, unknown>, key: string): string {
	const v = args[key];
	return typeof v === 'string' ? v : '';
}

function strArr(args: Record<string, unknown>, key: string): string[] {
	const v = args[key];
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function strMap(args: Record<string, unknown>, key: string): Record<string, string> {
	const v = args[key];
	if (!v || typeof v !== 'object') {
		return {};
	}
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
		if (typeof val === 'string') {
			out[k] = val;
		}
	}
	return out;
}

function normalizeLocale(input: string): string {
	const v = input.trim().toLowerCase();
	switch (v) {
		case '':
		case 'zh':
		case 'zh-cn':
		case 'zh_cn':
		case 'chinese':
		case 'cn':
			return 'zh-CN';
		case 'en':
		case 'en-us':
		case 'english':
		case 'us':
			return 'en';
		default:
			return input;
	}
}

function extensionFor(contentType: string): string {
	switch (contentType) {
		case 'image/png':
			return '.png';
		case 'image/jpeg':
			return '.jpg';
		case 'image/webp':
			return '.webp';
		default:
			return '.png';
	}
}

/** UTC timestamp: 'time' → HHMMSS, 'datetime' → YYYYMMDD-HHMMSS. Mirrors the Go formats. */
function stamp(kind: 'time' | 'datetime'): string {
	const d = new Date();
	const p = (n: number, w = 2) => String(n).padStart(w, '0');
	const hms = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
	if (kind === 'time') {
		return hms;
	}
	return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${hms}`;
}

function sha256Hex(data: Uint8Array): string {
	return createHash('sha256').update(data).digest('hex');
}

/** Resolve base/rel to an absolute path, rejecting escapes via "..". */
function safeJoin(base: string, rel: string): string {
	const clean = path.normalize(rel);
	if (path.isAbsolute(clean)) {
		const absBase = path.resolve(base);
		if (clean !== absBase && !clean.startsWith(absBase + path.sep)) {
			throw new Error(`path ${JSON.stringify(rel)} escapes project workdir`);
		}
		return clean;
	}
	const out = path.join(base, clean);
	const r = path.relative(base, out);
	if (r.startsWith('..')) {
		throw new Error(`path ${JSON.stringify(rel)} escapes project workdir`);
	}
	return out;
}

export {sessionOutputDir};
