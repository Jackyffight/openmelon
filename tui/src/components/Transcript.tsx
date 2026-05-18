import React from 'react';
import {Box, Text} from 'ink';
import type {TranscriptItem} from '../state/types.js';
import {accentColor} from '../theme.js';
import {wrapBlock} from '../terminal/wrap.js';

type Props = {
	items: TranscriptItem[];
	width: number;
};

export function Transcript({items, width}: Props) {
	return (
		<Box flexDirection="column">
			{items.map(item => (
				<TranscriptBlock key={item.id} item={item} width={width} />
			))}
		</Box>
	);
}

function TranscriptBlock({item, width}: {item: TranscriptItem; width: number}) {
	const color = colorForKind(item.kind);
	const prefixWidth = item.kind === 'user' || item.kind === 'error' ? 2 : 0;
	const rightBuffer = 4;
	const lines = wrapBlock(item.text, width - prefixWidth - rightBuffer);
	const marginBottom = item.kind === 'tool' || item.kind === 'result' ? 1 : 0;

	return (
		<Box flexDirection="column" marginBottom={marginBottom}>
			{lines.map((line, index) => (
				<Text key={`${item.id}-${index}`} color={color}>
					{prefixForKind(item.kind, index)}
					{line}
				</Text>
			))}
		</Box>
	);
}

function prefixForKind(kind: TranscriptItem['kind'], index: number) {
	if (kind === 'user') {
		return index === 0 ? '› ' : '  ';
	}
	if (kind === 'error') {
		return index === 0 ? '! ' : '  ';
	}
	return '';
}

function colorForKind(kind: TranscriptItem['kind']) {
	switch (kind) {
		case 'user':
			return accentColor;
		case 'tool':
			return 'green';
		case 'result':
		case 'info':
			return 'gray';
		case 'error':
			return 'red';
		case 'assistant':
		default:
			return 'white';
	}
}
