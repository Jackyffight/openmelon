#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distEntry = join(__dirname, '..', 'dist', 'cli.js');
const sourceEntry = join(__dirname, '..', 'src', 'cli.ts');

let command = process.execPath;
let args;

if (existsSync(distEntry)) {
	args = [distEntry, ...process.argv.slice(2)];
} else {
	args = ['--import', 'tsx', sourceEntry, ...process.argv.slice(2)];
}

const child = spawn(command, args, {stdio: 'inherit'});
child.on('exit', (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
child.on('error', error => {
	console.error(`[openmelon] failed to launch TS TUI: ${error.message}`);
	process.exit(1);
});
