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
		state.totalPromptTokens > 0 || state.totalCompletionTokens > 0
			? ` · ${formatTokenCount(state.totalPromptTokens)} in / ${formatTokenCount(state.totalCompletionTokens)} out`
			: '';
	const pending = state.pendingInputs.length > 0 ? ` · ${state.pendingInputs.length} pending` : '';
	const left = `${state.model}${state.reasoning ? ` ${state.reasoning}` : ''} · ${state.project}${tokens}${pending}`;
	const right = state.notice || 'vbox-cli can publish generated posts';
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
	const rightMax = Math.max(0, Math.min(right.length, Math.floor(columns * 0.36)));
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
