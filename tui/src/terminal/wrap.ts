import wrapAnsi from 'wrap-ansi';

export function wrapBlock(text: string, width: number): string[] {
	const columns = Math.max(12, width);
	return text.split('\n').flatMap(line => {
		if (line.length === 0) {
			return [''];
		}
		return wrapAnsi(line, columns, {hard: true, trim: false}).split('\n');
	});
}

export function formatTokenCount(value: number): string {
	if (value >= 1_000_000) {
		return `${(value / 1_000_000).toFixed(1)}m`;
	}
	if (value >= 1_000) {
		return `${(value / 1_000).toFixed(1)}k`;
	}
	return String(value);
}
