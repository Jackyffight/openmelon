import React from 'react';
import {Box, Text} from 'ink';
import type {TranscriptItem} from '../state/types.js';
import {accentColor} from '../theme.js';
import {renderMarkdownLines, renderMarkdownPlain} from '../terminal/markdown.js';
import {wrapBlock} from '../terminal/wrap.js';

type Props = {
	items: TranscriptItem[];
	width: number;
	maxRenderedLines?: number;
};

export function Transcript({items, width, maxRenderedLines}: Props) {
	return (
		<Box flexDirection="column">
			{items.map(item => (
				<TranscriptBlock key={item.id} item={item} width={width} maxRenderedLines={maxRenderedLines} />
			))}
		</Box>
	);
}

function TranscriptBlock({item, width, maxRenderedLines}: {item: TranscriptItem; width: number; maxRenderedLines?: number}) {
	if (item.markdown) {
		return <MarkdownBlock item={item} width={width} maxRenderedLines={maxRenderedLines} />;
	}
	const color = colorForKind(item.kind);
	const prefixWidth = gutterWidth(item.kind);
	const rightBuffer = 8;
	const lines = clampLines(wrapBlock(cleanTextForKind(item.kind, item.text), width - prefixWidth - rightBuffer), maxRenderedLines);
	const marginBottom = marginBottomForKind(item.kind);
	const bold = item.kind === 'tool';

	return (
		<Box flexDirection="column" marginBottom={marginBottom}>
			{lines.map((line, index) => (
				<Text key={`${item.id}-${index}`} color={color} bold={bold && index === 0} dimColor={isSoftKind(item.kind)}>
					{gutterForKind(item.kind, index)}
					{line}
				</Text>
			))}
		</Box>
	);
}

function MarkdownBlock({item, width, maxRenderedLines}: {item: TranscriptItem; width: number; maxRenderedLines?: number}) {
	const rightBuffer = 8;
	const rendered = renderMarkdownLines(item.text);
	const lines = rendered.flatMap((line, lineIndex) =>
		wrapBlock(line.text, width - gutterWidth(item.kind) - rightBuffer).map((wrapped, wrappedIndex) => ({
			key: `${item.id}-${lineIndex}-${wrappedIndex}`,
			text: wrapped,
			color: line.color,
			bold: line.bold,
			gutterIndex: lineIndex === 0 && wrappedIndex === 0 ? 0 : 1
		}))
	);
	const visibleLines = clampLines(lines, maxRenderedLines);
	return (
		<Box flexDirection="column" marginBottom={1}>
			{visibleLines.map(line => (
				<Text key={line.key} color={line.color ?? colorForKind(item.kind)} bold={line.bold} dimColor={isSoftKind(item.kind)}>
					{gutterForKind(item.kind, line.gutterIndex)}
					{line.text}
				</Text>
			))}
		</Box>
	);
}

export function transcriptItemPlainText(item: TranscriptItem) {
	return item.markdown ? renderMarkdownPlain(item.text) : item.text;
}

function gutterForKind(kind: TranscriptItem['kind'], index: number) {
	if (kind === 'user') {
		return index === 0 ? '›  ' : '   ';
	}
	if (kind === 'error') {
		return index === 0 ? '!  ' : '   ';
	}
	if (kind === 'tool') {
		return index === 0 ? '●  ' : '   ';
	}
	if (kind === 'result') {
		return index === 0 ? '   ' : '   ';
	}
	if (kind === 'info') {
		return '   ';
	}
	if (kind === 'assistant') {
		return '   ';
	}
	return '';
}

function gutterWidth(kind: TranscriptItem['kind']) {
	switch (kind) {
		case 'user':
		case 'error':
		case 'tool':
		case 'info':
		case 'result':
		case 'assistant':
			return 3;
		default:
			return 0;
	}
}

function marginBottomForKind(kind: TranscriptItem['kind']) {
	switch (kind) {
		case 'user':
		case 'assistant':
			return 1;
		case 'tool':
			return 1;
		case 'result':
			return 1;
		default:
			return 0;
	}
}

function colorForKind(kind: TranscriptItem['kind']) {
	switch (kind) {
		case 'user':
			return accentColor;
		case 'tool':
			return 'cyan';
		case 'result':
		case 'info':
			return 'white';
		case 'error':
			return 'red';
		case 'assistant':
		default:
			return 'white';
	}
}

function isSoftKind(kind: TranscriptItem['kind']) {
	return kind === 'result' || kind === 'info';
}

function cleanTextForKind(kind: TranscriptItem['kind'], text: string) {
	if (kind === 'tool') {
		return text.replace(/^\s*[●•]\s+/, '');
	}
	if (kind === 'result') {
		return text.replace(/^\s*(?:└|L)\s*/, '');
	}
	return text;
}

function clampLines<T>(lines: T[], limit?: number) {
	if (!limit || lines.length <= limit) {
		return lines;
	}
	return lines.slice(-limit);
}
