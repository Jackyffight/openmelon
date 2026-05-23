import React from 'react';
import {Box, Text} from 'ink';
import type {TuiState} from '../state/types.js';
import {accentColor} from '../theme.js';

const boxWidth = 56;

type Props = {
	state: TuiState;
};

export function HeaderCard({state}: Props) {
	const reasoning = state.reasoning ? ` ${state.reasoning}` : '';
	return (
		<Box flexDirection="column" marginBottom={1}>
			<Text color="gray">{`╭${'─'.repeat(boxWidth)}╮`}</Text>
			<Text color={accentColor} bold>
				{boxLine('>_ OpenMelon')}
			</Text>
			<Text color="gray">{boxLine('')}</Text>
			<Text color="white">{boxLine(`model:     ${state.model}${reasoning}   /model to change`)}</Text>
			<Text color="white">{boxLine(`directory: ${process.cwd()}`)}</Text>
			<Text color="gray">{`╰${'─'.repeat(boxWidth)}╯`}</Text>
			<Text> </Text>
			<Text color="white">  Tip: use vbox-cli to publish generated posts and let global audiences see your ideas.</Text>
			<Text> </Text>
		</Box>
	);
}

function boxLine(text: string) {
	return `│ ${fitText(text, boxWidth - 2)} │`;
}

function fitText(text: string, width: number) {
	if (text.length > width) {
		return `…${text.slice(-(width - 1))}`;
	}
	return text.padEnd(width);
}
