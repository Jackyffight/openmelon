// The bash tool + its safety gating, ported from internal/tools/bash.go,
// bash_judge.go, and internal/policy/policy.go.
//
// Four-tier gate: trusted-mode bypass → per-session allowlist → judge LLM
// (AUTO/ASK/BLOCK) → user approval modal. Returning 'ask' on any judge error
// keeps it fail-safe.

import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import type {LLMClient} from '../llm/types.js';
import type {ToolDef} from './registry.js';

export type BashMode = 'strict' | 'auto' | 'trusted';
export type BashJudgement = 'ask' | 'auto' | 'block';

export type ApprovalRequest = {tool: string; command: string; description: string; binary: string};
export type ApprovalDecision = {approved: boolean; always: boolean};

/** Bash dependencies supplied by the runtime adapter. All optional. */
export type BashEnv = {
	workdir: string;
	bashMode?: BashMode;
	isBashAllowed?: (binary: string) => boolean;
	allowBash?: (binary: string) => void;
	judgeBash?: (command: string, description: string, signal?: AbortSignal) => Promise<BashJudgement>;
	/** Resolves the user's decision; absent → bash is unavailable (headless). */
	approve?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
};

export function bashTool(env: BashEnv): ToolDef {
	return {
		spec: {
			name: 'bash',
			description:
				"Run a shell command inside the project workdir and return its combined stdout/stderr. Use sparingly — for inspecting files (file, ls, du), checking output (open, identify), or quick text edits. Do not use bash to discover fonts, render SVG/HTML, compose images, or substitute for image generation; typography/style should be handled as image prompt constraints. Each call is gated by the project's bash permission policy.",
			parameters: {
				type: 'object',
				properties: {
					command: {type: 'string', description: 'The shell command to run. Will be passed to /bin/sh -c.'},
					description: {
						type: 'string',
						description: "One-line plain-English explanation of why you're running this. Shown to the user in the approval modal."
					},
					timeout_seconds: {type: 'number', description: 'Kill the command after this many seconds. Default 30, max 300.'}
				},
				required: ['command', 'description']
			}
		},
		handler: async (args, signal) => {
			const command = typeof args['command'] === 'string' ? args['command'] : '';
			const description = typeof args['description'] === 'string' ? args['description'] : '';
			const timeoutSeconds = typeof args['timeout_seconds'] === 'number' ? args['timeout_seconds'] : 0;
			if (!command) {
				return {error: 'command is required'};
			}
			const binary = firstBinary(command);
			const mode = env.bashMode ?? 'strict';

			// Tier 1–3: compute a policy decision.
			let decision: 'allow' | 'ask' | 'deny';
			let via = '';
			if (mode === 'trusted') {
				decision = 'allow';
				via = 'trusted';
			} else if (env.isBashAllowed?.(binary)) {
				decision = 'allow';
				via = 'allowlisted';
			} else {
				const verdict = env.judgeBash ? await env.judgeBash(command, description, signal).catch(() => 'ask' as const) : 'ask';
				if (verdict === 'block') {
					decision = 'deny';
					via = 'blocked by safety judge';
				} else if (mode === 'auto' && verdict === 'auto') {
					decision = 'allow';
					via = 'judge:auto';
				} else {
					decision = 'ask';
				}
			}

			if (decision === 'deny') {
				return {error: via || 'blocked by policy'};
			}
			if (decision === 'allow') {
				return runBash(env.workdir, command, timeoutSeconds, via || 'policy', signal);
			}

			// Tier 4: user approval modal.
			if (!env.approve) {
				return {error: 'bash is unavailable: no approval gate is wired (running headless?)'};
			}
			const answer = await env.approve({tool: 'bash', command, description, binary});
			if (!answer.approved) {
				return {error: 'user denied execution'};
			}
			if (answer.always) {
				env.allowBash?.(binary);
			}
			return runBash(env.workdir, command, timeoutSeconds, 'user-approved', signal);
		}
	};
}

/** Execute via /bin/sh -c, returning {stdout, exit_code, approved_via, error?}. */
function runBash(
	workdir: string,
	command: string,
	timeoutSec: number,
	via: string,
	signal?: AbortSignal
): Promise<Record<string, unknown>> {
	let timeout = timeoutSec * 1000;
	if (timeout <= 0) {
		timeout = 30_000;
	}
	if (timeout > 5 * 60_000) {
		timeout = 5 * 60_000;
	}
	return new Promise(resolve => {
		const child = spawn('/bin/sh', ['-c', command], {cwd: workdir, env: bashEnv(), signal});
		let output = '';
		let settled = false;
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			if (!settled) {
				settled = true;
				resolve({stdout: output, exit_code: -1, approved_via: via, error: `timed out after ${timeout / 1000}s`});
			}
		}, timeout);
		child.stdout?.on('data', c => (output += String(c)));
		child.stderr?.on('data', c => (output += String(c)));
		child.on('error', err => {
			clearTimeout(timer);
			if (!settled) {
				settled = true;
				resolve({stdout: output, exit_code: -1, approved_via: via, error: (err as Error).message});
			}
		});
		child.on('close', code => {
			clearTimeout(timer);
			if (!settled) {
				settled = true;
				resolve({stdout: output, exit_code: code ?? -1, approved_via: via});
			}
		});
	});
}

let cachedBashPath: string | undefined;

function bashEnv(): NodeJS.ProcessEnv {
	if (cachedBashPath === undefined) {
		const base = process.env.PATH ?? '';
		try {
			const pkgJson = createRequire(import.meta.url).resolve('@e8s/vbox-cli/package.json');
			const binDir = path.join(path.dirname(pkgJson), '..', '..', '.bin');
			cachedBashPath = `${binDir}${path.delimiter}${base}`;
		} catch {
			cachedBashPath = base;
		}
	}
	return {...process.env, PATH: cachedBashPath};
}

/**
 * Extract the first executable name from a shell command, stripping env
 * assignments + wrapper prefixes and basenaming the path. Best-effort: used
 * only for the allowlist key + modal label.
 */
export function firstBinary(command: string): string {
	for (const raw of command.split(/\s+/)) {
		if (!raw) {
			continue;
		}
		if (raw.includes('=') && !/[/\\]/.test(raw)) {
			continue; // env assignment
		}
		if (['sudo', 'time', 'exec', 'nohup', 'env'].includes(raw)) {
			continue;
		}
		const idx = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
		return idx >= 0 ? raw.slice(idx + 1) : raw;
	}
	return '';
}

const bashJudgeSystemPrompt = `You are a safety classifier for an AI agent's bash tool. Given a shell command, output EXACTLY one of:

AUTO   Read-only inspection commands. Examples: ls, cat, file, head, tail, du, df, wc, grep, find (without -delete/-exec), stat, identify, exiftool, magick identify, pdfinfo, ffprobe, jq (without -i), xmllint, sha256sum, md5sum, base64, date, uname, hostname, uptime, ps, lsof, which, pwd, env, command -v, open (macOS), xdg-open. Anything that reads but doesn't write or call out.
ASK    Writes inside the project workdir, normal-but-side-effecting commands during creative work. Examples: mkdir, touch, mv, cp, npm install, git commit, ImageMagick convert, ffmpeg encode, sed -i, python script.py, curl GET (read-only), pip install.
BLOCK  Destructive or exfiltrating. Examples: rm -rf, dd, mkfs, sudo, chmod 777 /, anything piping to /etc, modifying ~/.ssh, curl/wget POST/PUT to a non-localhost URL, scp/rsync to a remote, eval/exec of remote content, nc -l (network listener), iptables, anything that reads secrets and sends them out.

Respond with ONE WORD on a single line. No prose, no markdown, no explanation. If unsure, output ASK.
`;

/** A bash safety judge backed by the main LLM. Returns 'ask' on any error (fail-safe). */
export function judgeBashWithLLM(client: LLMClient): (command: string, description: string, signal?: AbortSignal) => Promise<BashJudgement> {
	return async (command, description, signal) => {
		try {
			const resp = await client.chat(
				{
					messages: [
						{role: 'system', content: bashJudgeSystemPrompt},
						{role: 'user', content: `Command: ${command}\nDescription: ${description}`}
					],
					temperature: 0,
					maxTokens: 8
				},
				signal
			);
			switch (firstWord(resp.message.content ?? '')) {
				case 'AUTO':
					return 'auto';
				case 'BLOCK':
					return 'block';
				default:
					return 'ask';
			}
		} catch {
			return 'ask';
		}
	};
}

function firstWord(s: string): string {
	for (const f of s.trim().toUpperCase().split(/\s+/)) {
		const cleaned = f.replace(/^[`*_.,;:!?"']+|[`*_.,;:!?"']+$/g, '');
		if (cleaned) {
			return cleaned;
		}
	}
	return '';
}
