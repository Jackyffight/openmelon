const orderedList = /^(\s*)(\d+)[.)]\s+(.*)$/;
const unorderedList = /^(\s*)[-*+]\s+(.*)$/;
const taskList = /^(\s*)[-*+]\s+\[([ xX])]\s+(.*)$/;
const blockquote = /^(\s*)>+\s?(.*)$/;
const link = /!?\[([^\]]*)]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const autolink = /<((?:https?:\/\/|mailto:)[^>]+)>/g;
const htmlTag = /<\/?[a-z][^>]*>/gi;

export type MarkdownLine = {
	text: string;
	color?: string;
	bold?: boolean;
};

export function renderMarkdownLines(source: string): MarkdownLine[] {
	const normalized = source.replace(/\r\n/g, '\n');
	const lines = normalized.split('\n');
	const out: MarkdownLine[] = [];
	let inFence = false;
	let fenceLang = '';

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? '';
		const trimmed = line.trim();
		const fence = fenceMarker(trimmed);
		if (fence) {
			if (inFence) {
				inFence = false;
				fenceLang = '';
			} else {
				inFence = true;
				fenceLang = fence.lang;
				if (fenceLang) {
					out.push({text: `  ${fenceLang}`, color: 'gray'});
				}
			}
			continue;
		}

		if (inFence) {
			out.push({text: `  ${line}`, color: 'cyan'});
			continue;
		}

		if (trimmed === '') {
			out.push({text: ''});
			continue;
		}

		const next = lines[index + 1]?.trim();
		if (next && isSetextHeading(next)) {
			out.push({text: renderInline(trimmed), bold: true, color: next.startsWith('=') ? 'white' : 'gray'});
			index++;
			continue;
		}

		if (isHeading(trimmed)) {
			const {level, text} = splitHeading(trimmed);
			out.push({text: renderInline(text), bold: true, color: level <= 2 ? 'white' : 'gray'});
			continue;
		}

		if (isRule(trimmed)) {
			out.push({text: '─'.repeat(40), color: 'gray'});
			continue;
		}

		if (isTableDelimiter(trimmed)) {
			continue;
		}

		if (isTableRow(trimmed)) {
			out.push({text: renderTableRow(trimmed), color: 'white'});
			continue;
		}

		const quote = blockquote.exec(line);
		if (quote) {
			out.push({text: `${indentFor(quote[1] ?? '')}> ${renderInline(quote[2]?.trim() ?? '')}`, color: 'gray'});
			continue;
		}

		const task = taskList.exec(line);
		if (task) {
			const checked = task[2]?.toLowerCase() === 'x';
			out.push({text: `${indentFor(task[1] ?? '')}${checked ? '[x]' : '[ ]'} ${renderInline(task[3]?.trim() ?? '')}`, color: checked ? 'gray' : 'white'});
			continue;
		}

		const unordered = unorderedList.exec(line);
		if (unordered) {
			out.push({text: `${indentFor(unordered[1] ?? '')}- ${renderInline(unordered[2]?.trim() ?? '')}`, color: 'white'});
			continue;
		}

		const ordered = orderedList.exec(line);
		if (ordered) {
			out.push({text: `${indentFor(ordered[1] ?? '')}${ordered[2]}. ${renderInline(ordered[3]?.trim() ?? '')}`, color: 'white'});
			continue;
		}

		out.push({text: renderInline(line), color: 'white'});
	}

	while (out.length > 0 && out.at(-1)?.text === '') {
		out.pop();
	}
	return out.length > 0 ? out : [{text: ''}];
}

export function renderMarkdownPlain(source: string) {
	return renderMarkdownLines(source)
		.map(line => line.text)
		.join('\n')
		.trimEnd();
}

function isHeading(line: string) {
	return /^#{1,6}\s+/.test(line);
}

function splitHeading(line: string) {
	const match = /^(#{1,6})\s+(.*)$/.exec(line);
	const text = (match?.[2]?.trim() ?? line).replace(/\s+#+$/, '').trim();
	return {level: match?.[1]?.length ?? 1, text};
}

function isSetextHeading(line: string) {
	return /^=+$/.test(line) || /^-+$/.test(line);
}

function isRule(line: string) {
	return line.length >= 3 && /^[-*_]+$/.test(line);
}

function isTableRow(line: string) {
	return line.startsWith('|') && line.endsWith('|') && line.split('|').length >= 3;
}

function isTableDelimiter(line: string) {
	if (!isTableRow(line)) {
		return false;
	}
	return line
		.slice(1, -1)
		.split('|')
		.every(cell => /^:?-{3,}:?$/.test(cell.trim()));
}

function renderTableRow(line: string) {
	return line
		.slice(1, -1)
		.split('|')
		.map(cell => renderInline(cell.trim()))
		.join('  |  ');
}

function renderInline(value: string) {
	return value
		.replace(link, (_match, label: string, target: string) => (label ? `${label} (${target})` : target))
		.replace(autolink, '$1')
		.replace(htmlTag, '')
		.replace(/\\([\\`*_[\]{}()#+\-.!|>])/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
		.replace(/___([^_]+)___/g, '$1')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/__([^_]+)__/g, '$1')
		.replace(/\*([^*\n]+)\*/g, '$1')
		.replace(/_([^_\n]+)_/g, '$1')
		.replace(/~~([^~]+)~~/g, '$1');
}

function fenceMarker(line: string) {
	const match = /^(`{3,}|~{3,})(.*)$/.exec(line);
	if (!match) {
		return null;
	}
	return {marker: match[1]!, lang: (match[2] ?? '').trim()};
}

function indentFor(raw: string) {
	const spaces = raw.replace(/\t/g, '    ').length;
	return ' '.repeat(Math.min(8, Math.floor(spaces / 2) * 2));
}
