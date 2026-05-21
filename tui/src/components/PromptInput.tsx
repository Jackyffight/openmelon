import React from 'react';
import {Box, Text} from 'ink';
import stringWidth from 'string-width';
import {accentColor} from '../theme.js';
import {markCursorAnchor} from '../terminal/cursorAnchor.js';
import {wrapBlock} from '../terminal/wrap.js';

type Props = {
	input: string;
	placeholder: string;
	width: number;
};

export function PromptInput({input, placeholder, width}: Props) {
	const prompt = '› ';
	const rightBuffer = 6;
	const available = Math.max(12, width - 2 - rightBuffer);
	const lines = input.length === 0 ? [''] : wrapBlock(input, available);
	// Ink leaves the terminal cursor after the final status line boundary, so
	// the input anchor has to move up past that boundary and the status line.
	const rowFromBottom = 2;
	const anchor = input.length === 0
		? {column: prompt.length, rowFromBottom}
		: {column: prompt.length + stringWidth(lines.at(-1) ?? ''), rowFromBottom};

	return (
		<Box flexDirection="column" marginTop={1}>
			{lines.map((line, index) => (
				<Box key={index}>
					<Text color={accentColor}>{index === 0 ? prompt : '  '}</Text>
					{input.length === 0 ? (
						<Text color="gray">
							{markCursorAnchor(anchor)}
							{` ${placeholder}`}
						</Text>
					) : (
						<Text color="white">
							{line}
							{index === lines.length - 1 ? markCursorAnchor(anchor) : ''}
						</Text>
					)}
				</Box>
			))}
		</Box>
	);
}
