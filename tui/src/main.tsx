import React from 'react';
import {render} from 'ink';
import {App} from './App.js';
import {createAnchoredStdout} from './terminal/anchoredStdout.js';

export type TuiOptions = {
	argv?: string[];
	resumeId?: string;
};

export function runTui(options: TuiOptions = {}) {
	render(<App resumeId={options.resumeId} />, {exitOnCtrlC: false, stdout: createAnchoredStdout(process.stdout)});
}
