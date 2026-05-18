export type CursorAnchor = {
	active: boolean;
	column: number;
	rowsToBottom: number;
};

let cursorAnchor: CursorAnchor = {
	active: false,
	column: 0,
	rowsToBottom: 0
};

export function setCursorAnchor(anchor: Omit<CursorAnchor, 'active'>) {
	cursorAnchor = {
		active: true,
		column: Math.max(0, anchor.column),
		rowsToBottom: Math.max(1, anchor.rowsToBottom)
	};
}

export function clearCursorAnchor() {
	cursorAnchor = {
		active: false,
		column: 0,
		rowsToBottom: 0
	};
}

export function getCursorAnchor() {
	return cursorAnchor;
}
