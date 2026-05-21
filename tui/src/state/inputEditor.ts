import stringWidth from 'string-width';
import {wrapBlock} from '../terminal/wrap.js';

export type InputEditor = {
	text: string;
	cursor: number;
	preferredColumn: number | null;
};

export type WrappedInputLine = {
	text: string;
	start: number;
	end: number;
};

export function emptyEditor(): InputEditor {
	return {text: '', cursor: 0, preferredColumn: null};
}

export function editorWithText(text: string): InputEditor {
	return {text, cursor: charLength(text), preferredColumn: null};
}

export function insertText(editor: InputEditor, text: string): InputEditor {
	const chars = toChars(editor.text);
	const insert = toChars(text);
	const next = [...chars.slice(0, editor.cursor), ...insert, ...chars.slice(editor.cursor)].join('');
	return {text: next, cursor: editor.cursor + insert.length, preferredColumn: null};
}

export function backspace(editor: InputEditor): InputEditor {
	if (editor.cursor <= 0) {
		return editor;
	}
	const chars = toChars(editor.text);
	const next = [...chars.slice(0, editor.cursor - 1), ...chars.slice(editor.cursor)].join('');
	return {text: next, cursor: editor.cursor - 1, preferredColumn: null};
}

export function deleteForward(editor: InputEditor): InputEditor {
	const chars = toChars(editor.text);
	if (editor.cursor >= chars.length) {
		return editor;
	}
	const next = [...chars.slice(0, editor.cursor), ...chars.slice(editor.cursor + 1)].join('');
	return {text: next, cursor: editor.cursor, preferredColumn: null};
}

export function moveCursor(editor: InputEditor, movement: 'left' | 'right' | 'start' | 'end'): InputEditor {
	const length = charLength(editor.text);
	switch (movement) {
		case 'left':
			return {...editor, cursor: Math.max(0, editor.cursor - 1), preferredColumn: null};
		case 'right':
			return {...editor, cursor: Math.min(length, editor.cursor + 1), preferredColumn: null};
		case 'start':
			return {...editor, cursor: 0, preferredColumn: null};
		case 'end':
			return {...editor, cursor: length, preferredColumn: null};
	}
}

export function moveLineBoundary(editor: InputEditor, boundary: 'start' | 'end'): InputEditor {
	const chars = toChars(editor.text);
	const before = chars.slice(0, editor.cursor);
	const after = chars.slice(editor.cursor);
	const previousBreak = before.lastIndexOf('\n');
	const nextBreak = after.indexOf('\n');
	const cursor = boundary === 'start' ? previousBreak + 1 : nextBreak < 0 ? chars.length : editor.cursor + nextBreak;
	return {...editor, cursor, preferredColumn: null};
}

export function moveVertical(editor: InputEditor, direction: -1 | 1, width: number): InputEditor {
	const lines = wrapInput(editor.text, width);
	const currentIndex = lineIndexForCursor(lines, editor.cursor);
	const targetIndex = currentIndex + direction;
	if (targetIndex < 0 || targetIndex >= lines.length) {
		return editor;
	}
	const currentColumn = editor.preferredColumn ?? visualColumn(editor.text, lines[currentIndex]!, editor.cursor);
	const targetCursor = cursorAtColumn(editor.text, lines[targetIndex]!, currentColumn);
	return {...editor, cursor: targetCursor, preferredColumn: currentColumn};
}

export function wrapInput(text: string, width: number): WrappedInputLine[] {
	const columns = Math.max(12, width);
	if (text.length === 0) {
		return [{text: '', start: 0, end: 0}];
	}

	const blocks = text.split('\n');
	const out: WrappedInputLine[] = [];
	let offset = 0;

	for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
		const block = blocks[blockIndex] ?? '';
		if (block.length === 0) {
			out.push({text: '', start: offset, end: offset});
		} else {
			for (const segment of wrapBlock(block, columns)) {
				const length = charLength(segment);
				out.push({text: segment, start: offset, end: offset + length});
				offset += length;
			}
		}
		if (blockIndex < blocks.length - 1) {
			offset += 1;
		}
	}

	return out;
}

export function charLength(text: string) {
	return toChars(text).length;
}

function lineIndexForCursor(lines: WrappedInputLine[], cursor: number) {
	const exact = lines.findIndex(line => cursor >= line.start && cursor <= line.end);
	return exact >= 0 ? exact : Math.max(0, lines.length - 1);
}

function visualColumn(text: string, line: WrappedInputLine, cursor: number) {
	const chars = toChars(text);
	return stringWidth(chars.slice(line.start, Math.min(cursor, line.end)).join(''));
}

function cursorAtColumn(text: string, line: WrappedInputLine, column: number) {
	const chars = toChars(text);
	let width = 0;
	for (let index = line.start; index < line.end; index++) {
		const next = width + stringWidth(chars[index] ?? '');
		if (next > column) {
			return index;
		}
		width = next;
	}
	return line.end;
}

function toChars(text: string) {
	return Array.from(text);
}
