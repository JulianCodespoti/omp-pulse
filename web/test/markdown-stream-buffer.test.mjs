import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { rolldown } from '../node_modules/rolldown/dist/index.mjs';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// Pure policy: the production helper, bundled as-is. Mounted section: the real
// Markdown component over the installed Streamdown/Shiki (jsdom proves DOM
// structure and text, not browser paint or layout).
const helperPath = resolve(root, 'web/src/components/markdown-stream-buffer.ts');
const build = await rolldown({
  input: 'stream-buffer-fixture', platform: 'node',
  plugins: [{
    name: 'stream-buffer-fixture',
    resolveId: id => id === 'stream-buffer-fixture' ? '\0stream-buffer-fixture' : null,
    load: id => id === '\0stream-buffer-fixture' ? `export { createLiveMarkdownBuffer } from ${JSON.stringify(helperPath)};` : null,
  }],
});
let createLiveMarkdownBuffer;
try {
  const out = await build.generate({ format: 'esm', codeSplitting: false });
  ({ createLiveMarkdownBuffer } = await import(`data:text/javascript;base64,${Buffer.from(out.output[0].code).toString('base64')}`));
} finally { await build.close(); }

const live = text => createLiveMarkdownBuffer()(text);
const prefixes = text => Array.from({ length: text.length + 1 }, (_, i) => text.slice(0, i));

const TABLE_DOC = 'Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nAfter';
const HEADER_END = TABLE_DOC.indexOf('| a | b |') + '| a | b |\n'.length;
const DELIM_END = TABLE_DOC.indexOf('|---|---|') + '|---|---|\n'.length;
const ROW1_END = TABLE_DOC.indexOf('| 1 | 2 |') + '| 1 | 2 |\n'.length;
const ROW2_END = TABLE_DOC.indexOf('| 3 | 4 |') + '| 3 | 4 |\n'.length;
const INTRO = 'Intro\n\n';

test('a trailing table stays hidden until its header AND delimiter rows are complete', () => {
  const buffer = createLiveMarkdownBuffer();
  for (const text of prefixes(TABLE_DOC)) {
    const view = buffer(text);
    assert.ok(text.startsWith(view.text), 'visible text is always a prefix of the source');
    assert.equal(view.fence === null, true);
    if (text.length > INTRO.length && text.length < DELIM_END) {
      assert.equal(view.text, INTRO, `nothing of the table is shown for ${JSON.stringify(text.slice(INTRO.length))}`);
    }
  }
  // The moment the delimiter row's newline lands, header + delimiter appear.
  assert.equal(live(TABLE_DOC.slice(0, DELIM_END)).text, TABLE_DOC.slice(0, DELIM_END));
  // The delimiter without its newline is not complete yet.
  assert.equal(live(TABLE_DOC.slice(0, DELIM_END - 1)).text, INTRO);
});

test('once a table is established only complete rows are shown', () => {
  const buffer = createLiveMarkdownBuffer();
  const rowText = '| 1 | 2 |\n';
  for (let n = 1; n < rowText.length; n++) {
    const text = TABLE_DOC.slice(0, DELIM_END) + rowText.slice(0, n);
    assert.equal(buffer(text).text, TABLE_DOC.slice(0, DELIM_END), `partial row ${JSON.stringify(rowText.slice(0, n))} is hidden`);
  }
  assert.equal(buffer(TABLE_DOC.slice(0, ROW1_END)).text, TABLE_DOC.slice(0, ROW1_END));
  assert.equal(buffer(TABLE_DOC.slice(0, ROW2_END - 3)).text, TABLE_DOC.slice(0, ROW1_END));
  assert.equal(buffer(TABLE_DOC.slice(0, ROW2_END)).text, TABLE_DOC.slice(0, ROW2_END));
});

test('held-back table text returns when the block ends, and visible length never shrinks across a table', () => {
  const buffer = createLiveMarkdownBuffer();
  let previous = 0;
  for (const text of prefixes(TABLE_DOC)) {
    const { text: visible } = buffer(text);
    assert.ok(visible.length >= previous, `visible text shrank at ${JSON.stringify(text.slice(-12))}`);
    previous = visible.length;
  }
  // Blank line closes the block: even a table whose last row lacks a newline is complete.
  assert.equal(live('| a |\n|---|\n| 1 |\n\n').text, '| a |\n|---|\n| 1 |\n\n');
  assert.equal(buffer(TABLE_DOC).text, TABLE_DOC);
});

test('ordinary prose with a pipe, or a table after prose, is not over-held', () => {
  assert.equal(live('Run `ls | grep x` to list').text, 'Run `ls | grep x` to list');
  assert.equal(live('a | b is prose\nnext').text, 'a | b is prose\nnext');
  assert.equal(live('Line one\n| a | b |\n|---|---|\n| 1 |').text, 'Line one\n| a | b |\n|---|---|\n');
  assert.equal(live('Line one\n| a | b |\n').text, 'Line one\n');
  assert.equal(live('Line one\n| a | b |\nnot a delimiter').text, 'Line one\n| a | b |\nnot a delimiter');
  assert.equal(live('Intro\n\n| a | b |\n-- ').text, 'Intro\n\n');
  assert.equal(live('Intro\n\n| a | b |\n|:--|--:|\n').text, 'Intro\n\n| a | b |\n|:--|--:|\n');
});

const FENCE_BODY = 'const a = **1;\nconst b = `x\n__y\n';
test('an open fence is one stable plain block that never reaches the repairing renderer', () => {
  const opening = 'Before **bold** text.\n\n```ts\n';
  const buffer = createLiveMarkdownBuffer();
  const heads = new Set();
  for (const text of prefixes(opening + FENCE_BODY).filter(t => t.length >= opening.length)) {
    const view = buffer(text);
    assert.ok(view.fence, 'fence stays open');
    heads.add(view.text);
    assert.equal(view.fence.marker, '```');
    assert.equal(view.fence.info, 'ts');
    assert.ok((opening + FENCE_BODY).startsWith(opening + view.fence.code));
  }
  assert.deepEqual([...heads], ['Before **bold** text.\n\n'], 'text handed to the renderer is constant while the fence grows');
  assert.equal(buffer(opening + FENCE_BODY).fence.code, FENCE_BODY, 'body is verbatim, `**` untouched');
});

test('fence opener is withheld until its line is complete; closer/partial-closer handling', () => {
  assert.deepEqual(live('Before\n\n```'), { text: 'Before\n\n', fence: null });
  assert.deepEqual(live('Before\n\n```ts'), { text: 'Before\n\n', fence: null });
  assert.equal(live('Before\n\n```ts\n').fence.code, '');
  assert.equal(live('```ts\ncode\n``').fence.code, 'code\n', 'a bare run of fence characters may be the closer being typed');
  assert.equal(live('```ts\ncode\n```').fence.code, 'code\n');
  // Shorter or other-character fence lines inside a longer fence do not close it.
  const four = '````md\n```\n~~~\nx\n';
  assert.equal(live(four).fence.code, '```\n~~~\nx\n');
  assert.equal(live(four).fence.marker, '````');
  // A closed fence is ordinary text for the renderer again, at that exact frame.
  const closed = '```ts\ncode\n```\nAfter';
  assert.deepEqual(live(closed), { text: closed, fence: null });
  assert.deepEqual(live('~~~\nx\n~~~\n\n| a |\n|---|\n'), { text: '~~~\nx\n~~~\n\n| a |\n|---|\n', fence: null });
  // Tilde fence, CRLF line endings.
  assert.equal(live('~~~py\r\nx = 1\r\n').fence.info, 'py');
  assert.equal(live('~~~py\r\nx = 1\r\n~~~\r\ndone').fence === null, true);
  // Backtick info strings cannot contain a backtick: not a fence.
  assert.equal(live('```a`b\ncode\n').fence === null, true);
  // Indented fences (possible list/quote content) stay with the renderer.
  assert.equal(live('- item\n\n  ```ts\n  code\n').fence === null, true);
});

test('an open fence does not block or hold a table that ended before it', () => {
  const text = '| a |\n|---|\n| 1 |\n\n```\ncode';
  const view = live(text);
  assert.equal(view.text, '| a |\n|---|\n| 1 |\n\n');
  assert.equal(view.fence.code, 'code');
  // A header directly before a fence is plain paragraph text, not a pending table.
  assert.equal(live('| a | b |\n```\ncode').text, '| a | b |\n');
});

test('a dangling ** / __ / backtick at the end of the live line is withheld, partnered ones are not', () => {
  const cases = [
    ['Hello **', 'Hello '],
    ['Hello __', 'Hello '],
    ['Hello `', 'Hello '],
    ['Hello ``', 'Hello '],
    ['x **a** and **', 'x **a** and '],
    ['Intro\n\n- **', 'Intro\n\n'],
    ['Intro\n\n- ok\n- __', 'Intro\n\n- ok\n'],
    // Not dangling: a closer, content after the opener, or literal inside code.
    ['**bold**', '**bold**'],
    ['__init__', '__init__'],
    ['`code`', '`code`'],
    ['**bold', '**bold'],
    ['`a **', '`a **'],
    ['***', '***'],
    // Only the final incomplete line is considered.
    ['a **\nb', 'a **\nb'],
    ['a **\n', 'a **\n'],
  ];
  for (const [source, expected] of cases) assert.equal(live(source).text, expected, JSON.stringify(source));
});

test('the settled render is always the full text, including everything live withheld', () => {
  const docs = [TABLE_DOC, 'Intro\n\n| a | b |\n|---|---|\n| 1 | 2', 'x **', '```ts\n' + FENCE_BODY, 'Before\n\n```', 'a\n\n```ts\ncode\n```', ''];
  for (const doc of docs) {
    const buffer = createLiveMarkdownBuffer();
    let sawWithholding = false;
    for (const text of prefixes(doc)) {
      const view = buffer(text);
      if (view.text !== text || view.fence) sawWithholding = true;
      // Settling at ANY frame yields exactly the source, with nothing parked.
      assert.deepEqual(buffer(text, false), { text, fence: null });
    }
    assert.deepEqual(buffer(doc, false), { text: doc, fence: null });
    if (doc !== '' && doc !== 'a\n\n```ts\ncode\n```') assert.ok(sawWithholding, JSON.stringify(doc));
  }
});

test('incremental folding equals a fresh scan, also after non-append replacement', () => {
  const doc = [
    'Intro **b**\n\n```ts\nconst a = 1;\n```\n\n| h | i |\n|---|---|\n| 1 | 2 |\n\n',
    '````md\n```\ninner\n```\n````\n\n~~~\nx\n~~~\n\n- item **\n\n| z |\n|---|\n| 9 |',
  ].join('');
  const incremental = createLiveMarkdownBuffer();
  for (const text of prefixes(doc)) assert.deepEqual(incremental(text), live(text), JSON.stringify(text.slice(-20)));
  // Replacement with unrelated text (and then a shorter prefix) rescans from scratch.
  assert.deepEqual(incremental('```\nopen\n'), live('```\nopen\n'));
  assert.deepEqual(incremental('plain paragraph'), live('plain paragraph'));
  assert.deepEqual(incremental('Intro **b**\n\n```ts\nconst'), live('Intro **b**\n\n```ts\nconst'));
});

test('per-frame work follows the appended text, not the message length', () => {
  const block = 'Paragraph with some words in it.\n\n```ts\nconst x = 1;\n```\n\n';
  const base = block.repeat(20000); // ~1.2 MB of closed blocks
  const frames = 200, line = 'Streaming a new line of prose.\n';
  const buffer = createLiveMarkdownBuffer();
  buffer(base);
  let text = base, incremental = 0;
  for (let i = 0; i < frames; i++) {
    text += line;
    text.charCodeAt(0); // flatten the concatenation outside the timed region; the renderer pays that anyway
    const start = performance.now();
    buffer(text);
    incremental += performance.now() - start;
  }
  const fresh = performance.now();
  for (let i = 0; i < 5; i++) createLiveMarkdownBuffer()(text);
  const fullScan = (performance.now() - fresh) / 5;
  assert.ok(incremental / frames < fullScan / 5,
    `an appended frame (${(incremental / frames).toFixed(3)}ms) costs a fraction of a whole-message scan (${fullScan.toFixed(1)}ms)`);
});

// ── Mounted: real Markdown, Streamdown and code plugin ───────────────────────
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { Markdown } from ${JSON.stringify(resolve(root, 'web/src/components/markdown.tsx'))};
import { Streamdown } from ${JSON.stringify(resolve(root, 'web/node_modules/streamdown/dist/index.js'))};
window.fixture = { act,
  stock(text) { const host = document.createElement('section'); const r = createRoot(host); r.render(h(Streamdown, {}, text)); return { host, unmount: () => r.unmount() }; },
  mount(props) { const r = createRoot(document.getElementById('root')); r.render(h(Markdown, props)); return { render: props => r.render(h(Markdown, props)), unmount: () => r.unmount() }; } };
`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function mounted(t, props) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  w.HTMLElement.prototype.scrollTo = () => {}; // jsdom has no scrolling geometry
  const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await sleep(5); }); };
  let handle;
  await act(async () => { handle = w.fixture.mount(props); });
  await settle();
  let done = false;
  t.after(async () => { try { if (!done) await act(async () => handle.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  return { w, d: w.document, act, settle, render: async next => { await act(async () => handle.render(next)); await settle(); } };
}
const textOf = node => node?.textContent ?? '';

test('mounted: a live table appears only after its delimiter row and never shows a partial row', async t => {
  const f = await mounted(t, { children: INTRO + '| a | b |\n|---|---', isAnimating: true });
  assert.equal(f.d.querySelectorAll('table').length, 0);
  assert.ok(!textOf(f.d.body).includes('|'), 'no raw pipes while the table is withheld');
  assert.ok(textOf(f.d.body).includes('Intro'));
  await f.render({ children: TABLE_DOC.slice(0, DELIM_END), isAnimating: true });
  assert.equal(f.d.querySelectorAll('table').length, 1);
  assert.deepEqual([...f.d.querySelectorAll('th')].map(textOf), ['a', 'b']);
  assert.equal(f.d.querySelectorAll('tbody tr').length, 0);
  await f.render({ children: TABLE_DOC.slice(0, DELIM_END) + '| 1 | 2', isAnimating: true });
  assert.equal(f.d.querySelectorAll('tbody tr').length, 0, 'partial last row hidden');
  await f.render({ children: TABLE_DOC.slice(0, ROW1_END), isAnimating: true });
  assert.deepEqual([...f.d.querySelectorAll('tbody td')].map(textOf), ['1', '2']);
  await f.render({ children: TABLE_DOC.slice(0, ROW1_END) + '| 3 | 4', isAnimating: false });
  assert.deepEqual([...f.d.querySelectorAll('tbody td')].map(textOf), ['1', '2', '3', '4'], 'settling shows the final partial row');
});

test('mounted: a live open fence is one plain block without repair, highlighted once when it closes', async t => {
  const body = 'const a = **1;\nconst b = 2;\n';
  const f = await mounted(t, { children: 'Intro\n\n```ts\n' + body, isAnimating: true });
  const pre = () => f.d.querySelectorAll('pre');
  // Rows carry no newlines and the trailing one is trimmed, as in the settled block.
  const rows = () => [...pre()[0].querySelectorAll('code > span')].map(textOf).join('\n');
  const header = () => f.d.querySelector('[data-streamdown="code-block-header"]');
  const copy = () => f.d.querySelector('[data-streamdown="code-block-copy-button"]');
  assert.equal(pre().length, 1);
  assert.equal(rows(), body.trimEnd());
  assert.equal(textOf(header()), 'ts', 'the open fence already has the settled block header');
  assert.equal(copy().disabled, true, 'Copy waits for the closing fence');
  assert.equal(f.d.querySelectorAll('[data-streamdown=strong]').length, 0, 'no ** repair inside the fence');
  assert.equal(pre()[0].querySelector('span[style]') === null, true, 'plain while open');
  const node = pre()[0];
  for (const more of ['const c = 3;\n', 'const d = **4;\n']) {
    await f.render({ children: 'Intro\n\n```ts\n' + body + more, isAnimating: true });
    assert.equal(pre().length, 1);
    assert.equal(pre()[0], node, 'the same block is reused as the fence grows (no plain/highlight flip)');
    assert.equal(pre()[0].querySelector('span[style]') === null, true);
    assert.equal(rows(), (body + more).trimEnd());
  }
  const closed = 'Intro\n\n```ts\n' + body + '```\n\nDone.';
  await f.render({ children: closed, isAnimating: true });
  assert.equal(pre().length, 1);
  await f.render({ children: closed, isAnimating: false });
  assert.equal(pre().length, 1);
  assert.ok(pre()[0].querySelector('span[style]'), 'highlighted after the fence closes');
  assert.equal(textOf(header()), 'ts', 'the header is the same before and after');
  assert.equal(copy().disabled, false);
  assert.ok(textOf(f.d.body).endsWith('Done.'));
});

test('mounted: a dangling live ** is withheld, and the settled reply keeps every character', async t => {
  const f = await mounted(t, { children: 'Result: **', isAnimating: true });
  assert.ok(!textOf(f.d.body).includes('*'));
  assert.ok(textOf(f.d.body).includes('Result:'));
  await f.render({ children: 'Result: **ok', isAnimating: true });
  assert.equal(textOf(f.d.querySelector('[data-streamdown=strong]')), 'ok');
  await f.render({ children: 'Result: **', isAnimating: false });
  assert.ok(textOf(f.d.body).includes('Result: **'), 'settled text is the full source');
});

test('mounted: the settled render of a withheld stream equals stock Streamdown of the full text', async t => {
  const full = TABLE_DOC;
  const f = await mounted(t, { children: full.slice(0, ROW2_END - 4), isAnimating: true });
  await f.render({ children: full, isAnimating: false });
  let stock;
  await f.act(async () => { stock = f.w.fixture.stock(full); });
  await f.settle();
  assert.equal(textOf(f.d.querySelector('table')), textOf(stock.host.querySelector('table')));
  assert.equal(f.d.querySelectorAll('tbody tr').length, stock.host.querySelectorAll('tbody tr').length);
  assert.ok(textOf(f.d.body).endsWith('After'));
  await f.act(async () => stock.unmount());
});

// ── Mounted through MessageParts: only the streaming TAIL withholds ──────────
const partsCode = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { MessageParts } from ${JSON.stringify(resolve(root, 'web/src/app/parts/MessageParts.tsx'))};
window.fixture = { act, mount(parts) {
  const r = createRoot(document.getElementById('root'));
  const render = parts => r.render(h(MessageParts, { message: { id: 'live', role: 'assistant', text: '', parts }, isStreaming: true, finalReply: false }));
  render(parts);
  return { render, unmount: () => r.unmount() };
} };
`);
test('mounted MessageParts: text followed by a running tool shows its last table row; the streaming tail still withholds it', async t => {
  const dom = createDomFixture(partsCode), w = dom.window, { act } = w.fixture;
  w.HTMLElement.prototype.scrollTo = () => {}; // jsdom has no scrolling geometry
  const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await sleep(5); }); };
  const text = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4';
  const text$ = { kind: 'text', text };
  const tool = { kind: 'tool', callId: 'call-1', name: 'bash', args: { command: 'ls' }, state: 'running' };
  let handle;
  await act(async () => { handle = w.fixture.mount([text$]); });
  await settle();
  t.after(async () => { try { await act(async () => handle.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const cells = () => [...w.document.querySelectorAll('tbody td')].map(textOf);
  assert.deepEqual(cells(), ['1', '2'], 'while it is the streaming tail, the partial last row is withheld');
  await act(async () => handle.render([text$, tool]));
  await settle();
  assert.deepEqual(cells(), ['1', '2', '3', '4'], 'a following running tool settles the text part: its last row shows');
});
