// The 13 creative-continuity tools, ported from internal/tools/builtin.go.
// Specs are copied verbatim; handlers call the engine/continuity store.
// (The Go hook/policy wrapping around continuity writes is a no-op by default,
// so it's omitted here.)

import * as c from '../continuity.js';
import type {Registry, ToolDef} from './registry.js';

export type ContinuityEnv = {workdir: string; projectId: string};

export function registerContinuityTools(reg: Registry, env: ContinuityEnv): void {
	for (const def of continuityTools(env)) {
		reg.register(def);
	}
}

function continuityTools(env: ContinuityEnv): ToolDef[] {
	const wd = env.workdir;
	const guard = async (fn: () => Promise<unknown>): Promise<unknown> => {
		try {
			return await fn();
		} catch (error) {
			return {error: (error as Error).message};
		}
	};

	return [
		{
			spec: {
				name: 'list_spaces',
				description:
					'List or search creative continuity spaces. Use this before starting a long-running series, continuing one, or deciding whether a request belongs to an existing space.',
				parameters: {
					type: 'object',
					properties: {query: {type: 'string', description: 'Optional search query over space id, name, description, platform, audience, and tags'}}
				}
			},
			handler: args =>
				guard(async () => {
					const query = str(args, 'query');
					if (query.trim()) {
						return (await c.searchSpaces(wd, query)).map(h => ({score: h.score, ...spaceView(h.space)}));
					}
					return (await c.listSpaces(wd)).map(spaceView);
				})
		},
		{
			spec: {
				name: 'plan_creator_workflow',
				description:
					"Plan how to handle the user's creative request: start a new space, confirm a draft space, or continue an active space. Use before making durable continuity writes when the workflow is ambiguous.",
				parameters: {type: 'object', properties: {intent: {type: 'string'}}, required: ['intent']}
			},
			handler: args => guard(() => c.planWorkflow(wd, str(args, 'intent')))
		},
		{
			spec: {
				name: 'create_space',
				description:
					'Create a draft creative continuity space for a durable series/account/campaign context. This tool stores only provisional assumptions, not confirmed canon. Ask concise clarification questions before treating assumptions as long-term rules.',
				parameters: {
					type: 'object',
					properties: {
						id: {type: 'string', description: 'kebab-case space id'},
						name: {type: 'string'},
						platform: {type: 'string'},
						audience: {type: 'string'},
						description: {type: 'string'},
						tags: {type: 'array', items: {type: 'string'}},
						assumptions: {type: 'string', description: 'Provisional setup assumptions and open questions. Low authority until the user confirms them.'}
					},
					required: ['id', 'name']
				}
			},
			handler: args =>
				guard(async () => {
					const sp = await c.createSpace(wd, {
						id: str(args, 'id'),
						name: str(args, 'name'),
						platform: str(args, 'platform'),
						audience: str(args, 'audience'),
						description: str(args, 'description'),
						tags: strArr(args, 'tags'),
						assumptions: str(args, 'assumptions')
					});
					return {
						id: sp.id,
						name: sp.name,
						status: sp.status,
						description: sp.description,
						dir: c.spaceDir(wd, sp.id),
						next_action: 'Ask the user to confirm or correct the provisional assumptions before recording decisions or treating them as canon.'
					};
				})
		},
		{
			spec: {
				name: 'get_context_packet',
				description:
					'Fetch the model-readable continuity context packet for a creative space: authority notes, provisional assumptions, confirmed canon, memory, plan, recent decisions, feedback, episodes, and assets. Use before producing or continuing content in that space.',
				parameters: {
					type: 'object',
					properties: {
						space_id: {type: 'string'},
						query: {type: 'string', description: 'Current creative intent or retrieval hint for ranking assets'},
						max_decisions: {type: 'number'},
						max_feedback: {type: 'number'},
						max_episodes: {type: 'number'},
						max_assets: {type: 'number'}
					},
					required: ['space_id']
				}
			},
			handler: args =>
				guard(() =>
					c.buildSelectedContextPacket(wd, env.projectId, str(args, 'space_id'), {
						query: str(args, 'query'),
						maxDecisions: num(args, 'max_decisions'),
						maxFeedback: num(args, 'max_feedback'),
						maxEpisodes: num(args, 'max_episodes'),
						maxAssets: num(args, 'max_assets')
					})
				)
		},
		{
			spec: {
				name: 'activate_space',
				description:
					'Activate a draft creative space after the user explicitly confirms the core direction. Records the confirmation as a decision. Use before creating durable episodes in a new space.',
				parameters: {
					type: 'object',
					properties: {
						space_id: {type: 'string'},
						decision: {type: 'string', description: 'What the user confirmed'},
						reason: {type: 'string'},
						weight: {type: 'number'}
					},
					required: ['space_id', 'decision']
				}
			},
			handler: args =>
				guard(async () => {
					const res = await c.activateSpace(wd, str(args, 'space_id'), {
						decision: str(args, 'decision'),
						reason: str(args, 'reason'),
						weight: num(args, 'weight')
					});
					return {id: res.space.id, name: res.space.name, status: res.space.status, decision: res.decision};
				})
		},
		{
			spec: {
				name: 'record_decision',
				description:
					'Record a user-confirmed continuity decision for a creative space. Do not use for guesses; only record decisions the user accepted or clearly instructed.',
				parameters: {
					type: 'object',
					properties: {
						space_id: {type: 'string'},
						scope: {type: 'string', description: 'space, episode, asset, style, character, scene'},
						target: {type: 'string'},
						decision: {type: 'string'},
						reason: {type: 'string'},
						weight: {type: 'number'}
					},
					required: ['space_id', 'decision']
				}
			},
			handler: args =>
				guard(() =>
					c.recordDecision(wd, str(args, 'space_id'), {
						scope: str(args, 'scope'),
						target: str(args, 'target'),
						decision: str(args, 'decision'),
						reason: str(args, 'reason'),
						weight: num(args, 'weight')
					})
				)
		},
		{
			spec: {
				name: 'record_feedback',
				description:
					'Record user or audience feedback for a creative space so future production can adapt strategy, pacing, style, assets, or planning.',
				parameters: {
					type: 'object',
					properties: {
						space_id: {type: 'string'},
						episode_id: {type: 'string'},
						source: {type: 'string'},
						signal: {type: 'string', description: 'normalized signal, e.g. pace_too_fast, style_worked, asset_drift'},
						evidence: {type: 'string'},
						recommendation: {type: 'string'}
					},
					required: ['space_id', 'signal']
				}
			},
			handler: args =>
				guard(() =>
					c.recordFeedback(wd, str(args, 'space_id'), {
						episode_id: str(args, 'episode_id'),
						source: str(args, 'source'),
						signal: str(args, 'signal'),
						evidence: str(args, 'evidence'),
						recommendation: str(args, 'recommendation')
					})
				)
		},
		{
			spec: {
				name: 'record_memory_item',
				description:
					'Record a provisional memory item for a creative space. Use for observations, reusable patterns, weak preferences, or unresolved continuity notes that should not become confirmed canon yet.',
				parameters: {
					type: 'object',
					properties: {
						space_id: {type: 'string'},
						id: {type: 'string'},
						kind: {type: 'string', description: 'observation, pattern, preference, risk, open_question'},
						scope: {type: 'string'},
						target: {type: 'string'},
						content: {type: 'string'},
						source: {type: 'string'},
						weight: {type: 'number'},
						status: {type: 'string', description: 'provisional, active, promoted, rejected'}
					},
					required: ['space_id', 'content']
				}
			},
			handler: args =>
				guard(() =>
					c.recordMemoryItem(wd, str(args, 'space_id'), {
						id: str(args, 'id') || undefined,
						kind: str(args, 'kind'),
						scope: str(args, 'scope'),
						target: str(args, 'target'),
						content: str(args, 'content'),
						source: str(args, 'source'),
						weight: num(args, 'weight'),
						status: str(args, 'status')
					})
				)
		},
		{
			spec: {
				name: 'promote_memory_item',
				description:
					'Promote a provisional memory item into a user-confirmed continuity decision. Use only after the user explicitly confirms the memory should become durable guidance.',
				parameters: {
					type: 'object',
					properties: {
						space_id: {type: 'string'},
						item_id: {type: 'string'},
						decision: {type: 'string'},
						reason: {type: 'string'},
						target: {type: 'string'}
					},
					required: ['space_id', 'item_id', 'decision']
				}
			},
			handler: args =>
				guard(() =>
					c.promoteMemoryItem(wd, str(args, 'space_id'), {
						item_id: str(args, 'item_id'),
						decision: str(args, 'decision'),
						reason: str(args, 'reason'),
						target: str(args, 'target')
					})
				)
		},
		{
			spec: {
				name: 'create_episode',
				description:
					'Create or register an episode under a creative space. Use for durable production units such as daily posts, videos, chapters, or content installments.',
				parameters: {
					type: 'object',
					properties: {
						space_id: {type: 'string'},
						id: {type: 'string'},
						title: {type: 'string'},
						topic: {type: 'string'},
						status: {type: 'string'},
						brief: {type: 'string', description: 'Brief markdown'}
					},
					required: ['space_id', 'topic']
				}
			},
			handler: args =>
				guard(() =>
					c.createEpisode(wd, str(args, 'space_id'), {
						id: str(args, 'id') || undefined,
						title: str(args, 'title'),
						topic: str(args, 'topic'),
						status: str(args, 'status'),
						brief: str(args, 'brief')
					})
				)
		},
		{
			spec: {
				name: 'register_asset',
				description:
					'Register a reusable continuity asset under a creative space. Assets can be images, backgrounds, characters, props, typography rules, prompt fragments, shot specs, masks, or PSD/layered files.',
				parameters: {
					type: 'object',
					properties: {
						space_id: {type: 'string'},
						id: {type: 'string'},
						kind: {type: 'string'},
						status: {type: 'string', description: 'active, canonical, experimental, rejected, archived'},
						description: {type: 'string'},
						reuse_policy: {type: 'string'},
						files: {type: 'array', items: {type: 'string'}},
						tags: {type: 'array', items: {type: 'string'}},
						weight: {type: 'number'}
					},
					required: ['space_id', 'description']
				}
			},
			handler: args =>
				guard(() =>
					c.registerAsset(wd, str(args, 'space_id'), {
						id: str(args, 'id') || undefined,
						kind: str(args, 'kind'),
						status: str(args, 'status'),
						description: str(args, 'description'),
						reuse_policy: str(args, 'reuse_policy'),
						files: strArr(args, 'files'),
						tags: strArr(args, 'tags'),
						weight: num(args, 'weight')
					})
				)
		},
		{
			spec: {
				name: 'update_asset_weight',
				description:
					"Adjust a reusable continuity asset's weight or status after user/audience feedback. Use higher weights for assets that should be reused more often; lower or archive assets that drift or perform poorly.",
				parameters: {
					type: 'object',
					properties: {
						space_id: {type: 'string'},
						asset_id: {type: 'string'},
						weight: {type: 'number'},
						status: {type: 'string', description: 'active, canonical, experimental, rejected, archived'}
					},
					required: ['space_id', 'asset_id', 'weight']
				}
			},
			handler: args => guard(() => c.updateAssetWeight(wd, str(args, 'space_id'), str(args, 'asset_id'), num(args, 'weight'), str(args, 'status')))
		},
		{
			spec: {
				name: 'record_compaction',
				description:
					"Record a compact summary of a creative space's long-running state. Use after reviewing selected context or when a series has accumulated enough history to need a reusable summary.",
				parameters: {
					type: 'object',
					properties: {space_id: {type: 'string'}, summary: {type: 'string'}, scope: {type: 'string'}},
					required: ['space_id', 'summary']
				}
			},
			handler: args => guard(() => c.recordSpaceCompaction(wd, str(args, 'space_id'), {summary: str(args, 'summary'), scope: str(args, 'scope')}))
		}
	];
}

function spaceView(sp: c.Space) {
	return {
		id: sp.id,
		name: sp.name,
		status: sp.status,
		platform: sp.platform,
		audience: sp.audience,
		description: sp.description,
		tags: sp.tags
	};
}

function str(args: Record<string, unknown>, key: string): string {
	const v = args[key];
	return typeof v === 'string' ? v : '';
}

function num(args: Record<string, unknown>, key: string): number {
	const v = args[key];
	return typeof v === 'number' ? v : 0;
}

function strArr(args: Record<string, unknown>, key: string): string[] {
	const v = args[key];
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
