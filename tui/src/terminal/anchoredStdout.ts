import ansiRegex from 'ansi-regex';
import stringWidth from 'string-width';
import {cursorAnchorMarker} from './cursorAnchor.js';

const esc = '\u001B[';
const cursorLeft = `${esc}G`;
const cursorShow = `${esc}?25h`;
const steadyBarCursor = `${esc}6 q`;

function cursorUp(count: number) {
	return count > 0 ? `${esc}${count}A` : '';
}

function cursorDown(count: number) {
	return count > 0 ? `${esc}${count}B` : '';
}

function cursorToColumn(column: number) {
	return `${esc}${column + 1}G`;
}

export function createAnchoredStdout(stdout: NodeJS.WriteStream): NodeJS.WriteStream {
	if (!stdout.isTTY) {
		return stdout;
	}

	let anchored = false;
	let anchorRowFromBottom = 0;

	const proxy = new Proxy(stdout, {
		get(target, property, receiver) {
			if (property !== 'write') {
				const value = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			}

			return (chunk: unknown, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
				const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
				const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
				const raw = Buffer.isBuffer(chunk) ? chunk.toString(encoding) : String(chunk);
				const rendered = extractCursorAnchor(raw);
				const restore = anchored ? `${cursorDown(anchorRowFromBottom)}${cursorLeft}` : '';
				const place = rendered.anchor
					? `${cursorShow}${steadyBarCursor}${cursorUp(rendered.anchor.rowFromBottom)}${cursorToColumn(rendered.anchor.column)}`
					: cursorShow;

				anchored = Boolean(rendered.anchor);
				anchorRowFromBottom = rendered.anchor?.rowFromBottom ?? 0;

				return target.write(`${restore}${rendered.text}${place}`, done);
			};
		}
	});

	return proxy as NodeJS.WriteStream;
}

function extractCursorAnchor(text: string) {
	const markerIndex = text.indexOf(cursorAnchorMarker);
	if (markerIndex < 0) {
		return {text};
	}

	const before = text.slice(0, markerIndex);
	const after = text.slice(markerIndex + cursorAnchorMarker.length);
	const lines = before.split('\n');
	const row = lines.length - 1;
	const column = stringWidth(stripAnsi(lines.at(-1) ?? ''));
	const totalRows = before.split('\n').length + after.split('\n').length - 1;
	const rowFromBottom = Math.max(0, totalRows - row - 1);

	return {
		text: `${before}${after}`,
		anchor: {
			column,
			rowFromBottom
		}
	};
}

function stripAnsi(text: string) {
	return text.replace(ansiRegex(), '');
}
