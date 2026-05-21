import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, symlink} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {isTrusted, type UserConfig} from './config.js';

test('trust accepts symlink-equivalent project paths', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'openmelon-trust-'));
	const real = path.join(root, 'real');
	const link = path.join(root, 'link');
	await mkdir(real);
	await symlink(real, link);

	const config: UserConfig = {trusted_dirs: [link]};
	assert.equal(await isTrusted(config, real), true);
	assert.equal(await isTrusted(config, path.join(real, 'child')), true);
});

test('trust does not accept prefix-only sibling paths', async () => {
	const config: UserConfig = {trusted_dirs: ['/work/bigone']};
	assert.equal(await isTrusted(config, '/work/bigone-other'), false);
});
