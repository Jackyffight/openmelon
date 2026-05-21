export const cursorAnchorMarker = '\u001B]1337;OpenMelonCursorAnchor\u0007';

export type CursorAnchor = {
	active: boolean;
	column: number;
	rowFromBottom: number;
};

export function markCursorAnchor() {
	return cursorAnchorMarker;
}

export function clearCursorAnchor() {
	return;
}
