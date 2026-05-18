import React from 'react';
import {Box, Text} from 'ink';
import type {TuiState} from '../state/types.js';
import {formatTokenCount} from '../terminal/wrap.js';

type Props = {
	state: TuiState;
	width: number;
};

export function StatusLine({state, width}: Props) {
	const tokens =
		state.promptTokens > 0 || state.completionTokens > 0
			? ` · ${formatTokenCount(state.promptTokens)} in / ${formatTokenCount(state.completionTokens)} out`
			: '';
	const pending = state.pendingInputs.length > 0 ? ` · ${state.pendingInputs.length} pending` : '';
	const left = `${state.activity} · ${state.model} · ${state.reasoning} · ${state.project}${tokens}${pending}`;
	const right =
		state.notice || 'Tip: use vbox-cli to publish generated posts and let global audiences see your ideas.';
	const line = formatStatusLine(left, right, width);

	return (
		<Box width="100%">
			<Text color="white" wrap="truncate-end">
				{line.left}
			</Text>
			<Text color={state.notice ? 'yellow' : 'white'} wrap="truncate-end">
				{line.right}
			</Text>
		</Box>
	);
}

function formatStatusLine(left: string, right: string, width: number) {
	const columns = Math.max(24, width);
	const rightMax = Math.max(0, Math.min(right.length, Math.floor(columns * 0.45)));
	const trimmedRight = truncateStart(right, rightMax);
	const leftMax = Math.max(0, columns - trimmedRight.length);
	const trimmedLeft = truncateEnd(left, leftMax);
	const padding = Math.max(0, columns - trimmedLeft.length - trimmedRight.length);

	return {
		left: `${trimmedLeft}${' '.repeat(padding)}`,
		right: trimmedRight
	};
}

function truncateEnd(text: string, max: number) {
	if (max <= 0) {
		return '';
	}
	if (text.length <= max) {
		return text;
	}
	if (max === 1) {
		return '…';
	}
	return `${text.slice(0, max - 1)}…`;
}

function truncateStart(text: string, max: number) {
	if (max <= 0) {
		return '';
	}
	if (text.length <= max) {
		return text;
	}
	if (max === 1) {
		return '…';
	}
	return `…${text.slice(-(max - 1))}`;
}
