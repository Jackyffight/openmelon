import path from 'node:path';
import {readJsonFile, writeJsonFile} from './fs.js';
import {stateDir} from './project.js';

export type ApprovalRequest = {
	tool: string;
	binary: string;
	command: string;
	description: string;
};

export type ApprovalRule = {
	id: string;
	scope: 'project';
	effect: 'allow';
	tool: string;
	binary: string;
	created_at: string;
	last_used_at?: string;
};

type ApprovalStore = {
	version: 1;
	rules: ApprovalRule[];
};

export async function findProjectApproval(workdir: string, request: ApprovalRequest) {
	const store = await loadApprovalStore(workdir);
	const rule = store.rules.find(item => item.effect === 'allow' && item.tool === request.tool && item.binary === request.binary);
	if (!rule) {
		return null;
	}
	rule.last_used_at = new Date().toISOString();
	await saveApprovalStore(workdir, store);
	return rule;
}

export async function recordProjectApproval(workdir: string, request: ApprovalRequest) {
	const store = await loadApprovalStore(workdir);
	const existing = store.rules.find(item => item.effect === 'allow' && item.tool === request.tool && item.binary === request.binary);
	const now = new Date().toISOString();
	if (existing) {
		existing.last_used_at = now;
		await saveApprovalStore(workdir, store);
		return existing;
	}
	const rule: ApprovalRule = {
		id: `${request.tool}:${request.binary}:${Date.now()}`,
		scope: 'project',
		effect: 'allow',
		tool: request.tool,
		binary: request.binary,
		created_at: now,
		last_used_at: now
	};
	store.rules.push(rule);
	await saveApprovalStore(workdir, store);
	return rule;
}

async function loadApprovalStore(workdir: string): Promise<ApprovalStore> {
	return readJsonFile<ApprovalStore>(approvalPath(workdir), {version: 1, rules: []});
}

async function saveApprovalStore(workdir: string, store: ApprovalStore) {
	store.rules.sort((a, b) => `${a.tool}:${a.binary}`.localeCompare(`${b.tool}:${b.binary}`));
	await writeJsonFile(approvalPath(workdir), store);
}

function approvalPath(workdir: string) {
	return path.join(stateDir(workdir), 'approvals.json');
}
