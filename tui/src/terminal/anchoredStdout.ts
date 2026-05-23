import {getCursorAnchor} from './cursorAnchor.js';

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
	let anchoredRowsToBottom = 0;

	const proxy = new Proxy(stdout, {
		get(target, property, receiver) {
			if (property !== 'write') {
				const value = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			}

			return (chunk: unknown, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
				const encoding = typeof encodingOrCallback === 'string' ? encodingOrCallback : undefined;
				const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback;
				const text = Buffer.isBuffer(chunk) ? chunk.toString(encoding) : String(chunk);
				const restore = anchored ? `${cursorDown(anchoredRowsToBottom)}${cursorLeft}` : '';
				const anchor = getCursorAnchor();
				const place = anchor.active
					? `${cursorShow}${steadyBarCursor}${cursorUp(anchor.rowsToBottom)}${cursorToColumn(anchor.column)}`
					: cursorShow;

				anchored = anchor.active;
				anchoredRowsToBottom = anchor.rowsToBottom;

				return target.write(`${restore}${text}${place}`, done);
			};
		}
	});

	return proxy as NodeJS.WriteStream;
}
