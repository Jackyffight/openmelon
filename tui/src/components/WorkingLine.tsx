import React from 'react';
import {Box, Text} from 'ink';
import type {TuiState} from '../state/types.js';
import {wrapBlock} from '../terminal/wrap.js';

type Props = {
	state: TuiState;
};

export function WorkingLine({state}: Props) {
	if (state.status !== 'thinking' && state.status !== 'tool') {
		return null;
	}

	const elapsed = state.runStartedAt ? ` ${formatElapsed(Date.now() - state.runStartedAt)}` : '';
	const label = state.status === 'tool' && state.activity ? state.activity : 'Working';

	return (
		<Box flexDirection="column" marginTop={1} marginBottom={2}>
			<Text color="cyan">{`●  ${label}${elapsed ? ` (${elapsed} · esc to interrupt)` : ' (esc to interrupt)'}`}</Text>
			{state.pendingInputs.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					<Text color="yellow">{`◌  queued (${state.pendingInputs.length}) · ↑ to edit`}</Text>
					{state.pendingInputs.map((input, inputIndex) =>
						wrapBlock(input, 96).map((line, lineIndex) => (
							<Text key={`${inputIndex}-${lineIndex}`} color="gray">
								{`   ${line}`}
							</Text>
						))
					)}
				</Box>
			)}
		</Box>
	);
}

function formatElapsed(ms: number) {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) {
		return `${seconds}s`;
	}
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
