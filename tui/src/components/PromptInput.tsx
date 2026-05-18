import React from 'react';
import {Box, Text} from 'ink';
import stringWidth from 'string-width';
import {accentColor} from '../theme.js';
import {setCursorAnchor} from '../terminal/cursorAnchor.js';
import {wrapBlock} from '../terminal/wrap.js';

type Props = {
	input: string;
	placeholder: string;
	width: number;
};

export function PromptInput({input, placeholder, width}: Props) {
	const prompt = '› ';
	const rightBuffer = 6;
	const available = Math.max(12, width - stringWidth(prompt) - rightBuffer);
	const lines = input.length === 0 ? [''] : wrapBlock(input, available);
	const lastLine = lines.at(-1) ?? '';
	setCursorAnchor({
		column: stringWidth(prompt) + stringWidth(lastLine),
		rowsToBottom: 2
	});

	return (
		<Box flexDirection="column">
			{lines.map((line, index) => (
				<Box key={index}>
					<Text color={accentColor}>{index === 0 ? prompt : '  '}</Text>
					<Text color={input.length === 0 ? 'gray' : 'white'}>{input.length === 0 ? ` ${placeholder}` : line}</Text>
				</Box>
			))}
		</Box>
	);
}
