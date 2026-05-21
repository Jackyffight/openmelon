import {marked, type Token, type Tokens} from 'marked';
import {accentColor} from '../theme.js';

export type MarkdownLine = {
	text: string;
	color?: string;
	bold?: boolean;
};

type RenderContext = {
	indent: string;
	quote: boolean;
};

export function renderMarkdownLines(source: string): MarkdownLine[] {
	const tokens = marked.lexer(source.replace(/\r\n/g, '\n'));
	const out = renderTokens(tokens, {indent: '', quote: false});

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

function renderTokens(tokens: readonly Token[], context: RenderContext): MarkdownLine[] {
	const out: MarkdownLine[] = [];

	for (const token of tokens) {
		switch (token.type) {
			case 'space':
				pushBlank(out);
				break;
			case 'heading':
				out.push({
					text: `${context.indent}${context.quote ? '> ' : ''}${inlineText(token.tokens ?? [])}`,
					color: context.quote ? accentColor : headingColor(token.depth),
					bold: true
				});
				break;
			case 'paragraph':
				out.push({
					text: `${context.indent}${context.quote ? '> ' : ''}${inlineText(token.tokens ?? [])}`,
					color: context.quote ? accentColor : 'white',
					bold: context.quote || isStrongOnly(token.tokens ?? [])
				});
				break;
			case 'blockquote':
				out.push(...renderTokens(token.tokens ?? [], {...context, quote: true}));
				break;
			case 'list':
				if (isListToken(token)) {
					out.push(...renderList(token, context));
				}
				break;
			case 'code':
				if (token.lang) {
					out.push({text: `${context.indent}  ${token.lang}`, color: 'gray'});
				}
				for (const line of token.text.split('\n')) {
					out.push({text: `${context.indent}  ${line}`, color: 'cyan'});
				}
				break;
			case 'table':
				if (isTableToken(token)) {
					out.push(...renderTable(token, context));
				}
				break;
			case 'hr':
				out.push({text: `${context.indent}${'─'.repeat(40)}`, color: 'gray'});
				break;
			case 'html':
				if (token.text.trim()) {
					out.push({text: `${context.indent}${plainText(token.text)}`, color: 'white'});
				}
				break;
			case 'text':
				out.push({text: `${context.indent}${inlineText(token.tokens ?? [token])}`, color: 'white'});
				break;
			default:
				break;
		}
	}

	return out;
}

function renderList(token: Tokens.List, context: RenderContext) {
	const out: MarkdownLine[] = [];
	const start = typeof token.start === 'number' ? token.start : 1;

	token.items.forEach((item, index) => {
		const marker = item.task ? `[${item.checked ? 'x' : ' '}]` : token.ordered ? `${start + index}.` : '-';
		const prefix = `${context.indent}${marker} `;
		const textLines = itemText(item);
		const color = item.task && item.checked ? 'gray' : 'white';

		if (textLines.length === 0) {
			out.push({text: prefix.trimEnd(), color});
		} else {
			textLines.forEach((text, lineIndex) => {
				out.push({
					text: `${lineIndex === 0 ? prefix : ' '.repeat(prefix.length)}${text}`,
					color,
					bold: lineIndex === 0 && isStrongOnly(item.tokens)
				});
			});
		}

		for (const child of nestedBlockTokens(item.tokens)) {
			out.push(...renderTokens([child], {...context, indent: `${context.indent}  `}));
		}
	});

	return out;
}

function itemText(item: Tokens.ListItem) {
	const first = item.tokens[0];
	if (first?.type === 'text') {
		return inlineText(first.tokens ?? [first]).split('\n');
	}
	if (first?.type === 'paragraph') {
		return inlineText(first.tokens ?? []).split('\n');
	}
	return plainText(item.text).split('\n').filter(Boolean);
}

function nestedBlockTokens(tokens: Token[]) {
	return tokens.filter(token => token.type !== 'text' && token.type !== 'paragraph');
}

function renderTable(token: Tokens.Table, context: RenderContext) {
	const rows = [token.header, ...token.rows];
	const renderedRows = rows.map(row => row.map(cell => inlineText(cell.tokens ?? [])));
	const widths = renderedRows[0]?.map((_, column) => Math.max(...renderedRows.map(row => stringLength(row[column] ?? '')))) ?? [];
	const out: MarkdownLine[] = [];

	renderedRows.forEach((row, rowIndex) => {
		out.push({
			text: `${context.indent}${row.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join('  |  ')}`,
			color: rowIndex === 0 ? accentColor : 'white',
			bold: rowIndex === 0
		});
	});

	return out;
}

function inlineText(tokens: readonly Token[]) {
	return tokens.map(token => inlineTokenText(token)).join('');
}

function inlineTokenText(token: Token): string {
	switch (token.type) {
			case 'strong':
			case 'em':
			case 'del':
				return inlineText(token.tokens ?? []);
		case 'codespan':
			return token.text;
		case 'br':
			return '\n';
		case 'link': {
			const label = inlineText(token.tokens ?? []);
			return token.href && token.href !== label ? `${label} (${token.href})` : label;
		}
		case 'image':
			return token.href ? `${token.text} (${token.href})` : token.text;
		case 'html':
			return plainText(token.text);
		case 'text':
			return token.tokens ? inlineText(token.tokens) : token.text;
		case 'escape':
			return token.text;
		default:
			return 'text' in token && typeof token.text === 'string' ? plainText(token.text) : '';
	}
}

function plainText(value: string) {
	return value.replace(/<\/?[a-z][^>]*>/gi, '');
}

function isListToken(token: Token): token is Tokens.List {
	return token.type === 'list' && 'items' in token && Array.isArray(token.items);
}

function isTableToken(token: Token): token is Tokens.Table {
	return token.type === 'table' && 'header' in token && Array.isArray(token.header) && 'rows' in token && Array.isArray(token.rows);
}

function headingColor(level: number) {
	return level <= 2 ? 'white' : accentColor;
}

function isStrongOnly(tokens: readonly Token[]) {
	const meaningful = tokens.filter(token => token.type !== 'space' && token.raw.trim() !== '');
	return meaningful.length === 1 && meaningful[0]?.type === 'strong';
}

function pushBlank(lines: MarkdownLine[]) {
	if (lines.length > 0 && lines.at(-1)?.text !== '') {
		lines.push({text: ''});
	}
}

function stringLength(value: string) {
	return Array.from(value).length;
}
