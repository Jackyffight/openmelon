import React from 'react';
import {Box, Text} from 'ink';
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

	return (
		<Box flexDirection="column" marginTop={1}>
			{lines.map((line, index) => (
				<Box key={index}>
					<Text color={accentColor}>{index === 0 ? prompt : '  '}</Text>
					{input.length === 0 ? (
						<Text color="gray">
							{markCursorAnchor()}
							{` ${placeholder}`}
						</Text>
					) : (
						<Text color="white">
							{line}
							{index === lines.length - 1 ? markCursorAnchor() : ''}
						</Text>
					)}
				</Box>
			))}
		</Box>
	);
}
