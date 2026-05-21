const prefix = '\u001B]1337;OpenMelonCursorAnchor';
const suffix = '\u0007';

export const cursorAnchorMarker = `${prefix}${suffix}`;
export const cursorAnchorPattern = /\u001B\]1337;OpenMelonCursorAnchor(?:;(\d+);(\d+))?\u0007/;

export type CursorAnchor = {
	active: boolean;
	column: number;
	rowFromBottom: number;
};

export function markCursorAnchor(anchor?: {column: number; rowFromBottom: number}) {
	if (anchor) {
		return `${prefix};${Math.max(0, anchor.column)};${Math.max(0, anchor.rowFromBottom)}${suffix}`;
	}
	return cursorAnchorMarker;
}

export function clearCursorAnchor() {
	return;
}
