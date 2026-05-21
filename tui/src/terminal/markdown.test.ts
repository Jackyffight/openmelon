import test from 'node:test';
import assert from 'node:assert/strict';
import {renderMarkdownLines, renderMarkdownPlain} from './markdown.js';

test('renders common markdown blocks into terminal lines', () => {
	const lines = renderMarkdownLines(`# Plan

- one
1. two
> quote

\`\`\`ts
const value = 1;
\`\`\`

| A | B |
|---|---|
| x | y |`);

	assert.deepEqual(
		lines.map(line => line.text),
		['Plan', '', '- one', '1. two', '> quote', '', '  ts', '  const value = 1;', '', 'A  |  B', 'x  |  y']
	);
});

test('plain markdown removes inline markers and expands links', () => {
	assert.equal(renderMarkdownPlain('Use **bold**, `code`, and [OpenMelon](https://example.test).'), 'Use bold, code, and OpenMelon (https://example.test).');
});

test('renders nested and task lists without losing hierarchy', () => {
	const lines = renderMarkdownLines(`- top
  - child
    1. ordered
- [x] done
- [ ] todo`);

	assert.deepEqual(
		lines.map(line => line.text),
		['- top', '  - child', '    1. ordered', '[x] done', '[ ] todo']
	);
});

test('renders setext headings, tilde fences, images, autolinks, and html as plain terminal text', () => {
	const plain = renderMarkdownPlain(`Title
=====

![alt](image.png)
<https://example.test>
<span>inline</span> ~~strike~~

~~~json
{"ok": true}
~~~`);

	assert.equal(plain, 'Title\n\nalt (image.png)\nhttps://example.test\ninline strike\n\n  json\n  {"ok": true}');
});
