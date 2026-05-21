import React from 'react';
import {Box, Text} from 'ink';
import stringWidth from 'string-width';
import {accentColor} from '../theme.js';
import {markCursorAnchor} from '../terminal/cursorAnchor.js';
import {wrapInput} from '../state/inputEditor.js';

type Props = {
	input: string;
	cursor: number;
	placeholder: string;
	width: number;
};

export function PromptInput({input, cursor, placeholder, width}: Props) {
	const prompt = '› ';
	const rightBuffer = 6;
	const available = Math.max(12, width - 2 - rightBuffer);
	const lines = wrapInput(input, available);
	const cursorLineIndex = Math.max(0, lines.findIndex(line => cursor >= line.start && cursor <= line.end));
	const cursorLine = lines[cursorLineIndex] ?? lines.at(-1)!;
	const cursorColumn = prompt.length + stringWidth(Array.from(input).slice(cursorLine.start, Math.min(cursor, cursorLine.end)).join(''));
	// Ink leaves the terminal cursor after the final status line boundary, so
	// the input anchor has to move up past that boundary and the status line.
	const rowFromBottom = lines.length - cursorLineIndex + 1;
	const anchor = {column: cursorColumn, rowFromBottom};

	return (
		<Box flexDirection="column" marginTop={1}>
			{lines.map((line, index) => (
				<Box key={index}>
					<Text color={accentColor}>{index === 0 ? prompt : '  '}</Text>
					{input.length === 0 ? (
						<Text color="gray">
							{index === cursorLineIndex ? markCursorAnchor(anchor) : ''}
							{` ${placeholder}`}
						</Text>
					) : (
						<Text color="white">
							{line.text}
							{index === cursorLineIndex ? markCursorAnchor(anchor) : ''}
						</Text>
					)}
				</Box>
			))}
		</Box>
	);
}
