import React from 'react';
import {render} from 'ink';
import {App} from './App.js';
import {createAnchoredStdout} from './terminal/anchoredStdout.js';

export type TuiOptions = {
	argv?: string[];
	resumeId?: string;
};

type TuiSessionInfo = {
	sessionId?: string;
	sessionDir?: string;
};

export async function runTui(options: TuiOptions = {}) {
	let sessionInfo: TuiSessionInfo = {};
	const instance = render(
		<App
			resumeId={options.resumeId}
			initialPrompt={options.argv?.join(' ').trim() || undefined}
			onSessionInfo={info => {
				sessionInfo = {...sessionInfo, ...info};
			}}
		/>,
		{exitOnCtrlC: false, stdout: createAnchoredStdout(process.stdout)}
	);
	await instance.waitUntilExit();
	const hint = resumeHint(sessionInfo);
	if (hint) {
		process.stderr.write(`\n${hint}\n`);
	}
}

function resumeHint(info: TuiSessionInfo) {
	if (!info.sessionId && !info.sessionDir) {
		return '';
	}
	const lines = [];
	if (info.sessionDir) {
		lines.push(`session saved at ${info.sessionDir}`);
	}
	if (info.sessionId) {
		lines.push(`to resume:    openmelon resume ${info.sessionId}`);
	}
	return lines.join('\n');
}
