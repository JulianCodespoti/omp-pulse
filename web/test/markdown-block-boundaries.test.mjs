import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// Mounted application + installed Streamdown/Shiki. jsdom proves React lifetime,
// structure and clipboard payloads, not browser layout, paint or native behavior.
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { MessageParts } from ${JSON.stringify(resolve(root, 'web/src/app/parts/MessageParts.tsx'))};
import { CopyButton } from ${JSON.stringify(resolve(root, 'web/src/app/parts/CopyButton.tsx'))};
import { groupMarkdownBlocks } from ${JSON.stringify(resolve(root, 'web/src/components/markdown-blocks.ts'))};
import { Streamdown, parseMarkdownIntoBlocks } from ${JSON.stringify(resolve(root, 'web/node_modules/streamdown/dist/index.js'))};
const writes = [];
Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { writes.push(text); } } });
function App({text, finalReply = true, isStreaming = false, id = 'reply'}) {
 const message = { id, role: 'assistant', text, parts: [{ kind: 'text', text }] };
 return h('main', {}, h(CopyButton, {text, label: 'Copy full reply'}), h(MessageParts, {key: id, message, finalReply, isStreaming}));
}
window.fixture = {act, writes, stock(text) {
 const host = document.createElement('section');
 const r = createRoot(host); r.render(h(Streamdown, {isAnimating: true}, text));
 return {host, unmount: () => r.unmount()};
}, groups: text => groupMarkdownBlocks(text, parseMarkdownIntoBlocks), mount(props) {
 const root = createRoot(document.getElementById('root'));
 root.render(h(App, props));
 return {render: props => root.render(h(App, props)), unmount: () => root.unmount()};
}};
`);

const rows = (n, prefix = 'CODE_ROW') => Array.from({length: n}, (_, i) => `const ${prefix}_${i} = "${'x'.repeat(80)}";`).join('\n');
const fenced = (n = 220) => `\`\`\`ts\n${rows(n)}\n\`\`\`\nAfter the code.`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, props) {
 const dom = createDomFixture(code), w = dom.window, {act, writes} = w.fixture;
 w.HTMLElement.prototype.scrollTo = () => {}; // jsdom has no scrolling geometry
 const frames = new Map(); let nextFrame = 0;
 w.requestAnimationFrame = callback => { const id = ++nextFrame; frames.set(id, callback); return id; };
 w.cancelAnimationFrame = id => frames.delete(id);
 let mounted;
 const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await sleep(5); }); };
 await act(async () => { mounted = w.fixture.mount(props); });
 await settle();
 let unmounted = false;
 const unmount = async () => { await act(async () => mounted.unmount()); unmounted = true; };
 t.after(async () => { try { if (!unmounted) await unmount(); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
 return {w, d: w.document, act, writes, frames, settle, unmount,
  render: async props => { await act(async () => mounted.render(props)); await settle(); },
  frame: async () => { const batch = [...frames.values()]; frames.clear(); await act(async () => { for (const callback of batch) callback(0); }); await settle(); },
  flush: async () => { for (let i = 0; frames.size && i < 100; i++) { const batch = [...frames.values()]; frames.clear(); await act(async () => { for (const callback of batch) callback(0); }); } await settle(); assert.equal(frames.size, 0); },
  click: async selector => { const button = w.document.querySelector(selector); assert.ok(button, selector); await act(async () => button.click()); await settle(); },
 };
}
const codeText = d => [...d.querySelectorAll('pre code')].map(node => node.querySelector(':scope > span.block') ? [...node.querySelectorAll(':scope > span.block')].map(line => line.textContent).join('\n') : node.textContent).join('\n');
const codeRows = d => (codeText(d).match(/CODE_ROW_/g) ?? []).length;

test('long reply keeps all 220 rows in one real highlighted code block and Copy stays exact', async t => {
 const text = fenced(); assert.equal(text.length, 23015);
 const f = await fixture(t, {text});
 assert.equal(f.d.querySelectorAll('pre').length, 1);
 assert.equal(codeRows(f.d), 220);
 assert.equal(codeText(f.d), rows(220));
 assert.ok(f.d.querySelector('pre span[style]'), 'installed code plugin produced highlighted tokens');
 await f.click('button[data-streamdown="code-block-copy-button"]');
 assert.equal(f.writes.at(-1), rows(220) + "\n");
 await f.click('button[aria-label="Copy full reply"]');
 assert.equal(f.writes.at(-1), text);
 assert.ok(f.d.body.textContent.includes('After the code.'));
});

const copyCode = async f => { const count = f.writes.length; await f.click('button[data-streamdown="code-block-copy-button"]'); assert.equal(f.writes.length, count + 1); return f.writes.at(-1); };
const groups = (f, text) => Array.from(f.w.fixture.groups(text));

test('real parser grouping preserves source at the 8k boundaries and never divides a fence', async t => {
 const f = await fixture(t, {text: 'Warm up'});
 for (const size of [7999, 8000, 8001, 15999, 16000, 16001, 32001]) {
  const text = 'a'.repeat(size) + '\n\n' + fenced();
  const parsed = groups(f, text);
  assert.equal(parsed.join(''), text);
  assert.ok(parsed.some(group => group.includes(rows(220))));
  await f.render({text, id: String(size)}); await f.flush();
  assert.equal(codeRows(f.d), 220, `prefix ${size}`);
  assert.equal(await copyCode(f), rows(220) + '\n');
 }
});

test('backtick/tilde lengths, language metadata, blank lines and surrounding prose stay intact', async t => {
 const f = await fixture(t, {text: 'Warm up'});
 const body = rows(90) + '\n\n\n```\n~~~\n\n' + rows(90, 'TAIL_ROW') + '\n\n';
 for (const [open, close] of [['````typescript title="fixture.ts"', '`````'], ['~~~~js', '~~~~'], ['```text', '```']]) {
  const value = open === '```text' ? 'a'.repeat(17000) + '\n\n<literal> & tabs\tend\n' : body;
  const text = `Before.\n\n${open}\n${value}${close}\n\nAfter.`;
  assert.equal(groups(f, text).join(''), text);
  await f.render({text, id: open}); await f.flush();
  assert.equal(f.d.querySelectorAll('pre').length, 1);
  assert.ok(f.d.body.textContent.startsWith('Before.'));
  assert.ok(f.d.body.textContent.endsWith('After.'));
  assert.equal(await copyCode(f), value);
 }
});

test('nested list and blockquote fences retain their container and highlighted code membership', async t => {
 const f = await fixture(t, {text: 'Warm up'});
 const body = rows(220) + '\n// src/keep.ts and /tmp/exact.bin must remain code\n\n';
 for (const [name, text, selector] of [
  ['list', '- Example\n\n  ~~~ts\n' + body.split('\n').map(line => '  ' + line).join('\n') + '~~~\n\nAfter list.', 'li pre'],
  ['quote', '> Example\n>\n> ````ts\n' + body.split('\n').map(line => '> ' + line).join('\n') + '````\n\nAfter quote.', 'blockquote pre'],
 ]) {
  assert.equal(groups(f, text).join(''), text);
  await f.render({text, id: name}); await f.flush();
  assert.equal(f.d.querySelectorAll(selector).length, 1, name);
  assert.equal(codeRows(f.d), 220, name);
  assert.ok(f.d.querySelector(`${selector} span[style]`), name);
  assert.equal(await copyCode(f), body, name);
  assert.equal(f.d.querySelectorAll('pre [data-testid=path-chip]').length, 0, name);
 }
});

test('live incomplete fences stay whole through append, closing fence and restored history', async t => {
 const opening = '~~~ts\n', initial = opening + rows(170);
 const f = await fixture(t, {text: initial, isStreaming: true});
 assert.equal(codeRows(f.d), 170);
 const appended = opening + rows(400);
 await f.render({text: appended, isStreaming: true});
 assert.equal(codeRows(f.d), 400);
 assert.equal(f.frames.size, 0, 'live content is never queued behind reveal frames');
 const completed = appended + '\n~~~\n\nFinished.';
 await f.render({text: completed, isStreaming: false}); await f.flush();
 assert.equal(codeRows(f.d), 400);
 assert.equal(await copyCode(f), rows(400) + '\n');
 await f.render({text: 'Another reply', id: 'other'});
 await f.render({text: completed, id: 'restored'}); await f.flush();
 assert.equal(codeRows(f.d), 400);
 assert.ok(f.d.body.textContent.endsWith('Finished.'));
});

test('a large table is indivisible and distant link/footnote definitions retain document context', async t => {
 const table = '| Name | Value |\n| --- | --- |\n' + Array.from({length: 240}, (_, i) => `| TABLE_ROW_${i} | ${'value '.repeat(12)} |`).join('\n');
 const f = await fixture(t, {text: table});
 assert.ok(table.length > 16000);
 assert.equal(f.d.querySelectorAll('table').length, 1);
 assert.equal(f.d.querySelectorAll('tbody tr').length, 240);
 assert.equal(groups(f, table).length, 1);
 const padding = ('Ordinary prose. '.repeat(80) + '\n\n').repeat(30);
 const reference = '[Distant reference][target]\n\n' + padding + '[target]: https://example.invalid/target "Reference title"\n';
 assert.deepEqual(groups(f, reference), [reference]);
 await f.render({text: reference});
 assert.equal(f.d.querySelector('a')?.getAttribute('href'), 'https://example.invalid/target');
 assert.equal(f.frames.size, 0, 'intact-document fallback is not artificially subdivided');
 const footnote = 'Document note[^note]\n\n' + padding + '[^note]: Exact note.\n';
 assert.deepEqual(groups(f, footnote), [footnote]);
 await f.render({text: footnote});
 assert.ok(f.d.querySelector('[data-footnotes]'));
 assert.ok(f.d.body.textContent.includes('Exact note.'));
});

test('CRLF, leading/trailing blank lines and Unicode stay byte-exact in full reply Copy', async t => {
 const text = '\r\n\r\n前置き 🦊\r\n\r\n```ts\r\n' + rows(220).replaceAll('\n', '\r\n') + '\r\n```\r\n\r\n';
 const f = await fixture(t, {text});
 assert.deepEqual(groups(f, text), [text]);
 assert.equal(codeRows(f.d), 220);
 await f.click('button[aria-label="Copy full reply"]');
 assert.equal(f.writes.at(-1), text);
});

const manyBlocks = (prefix = 'BLOCK') => Array.from({length: 16}, (_, i) => `## ${prefix}_${i}\n\n${('Paragraph ' + i + '. ').repeat(300)}\n\n`).join('');
test('large independent blocks reveal progressively while full Copy remains immediate', async t => {
 const text = manyBlocks(); const f = await fixture(t, {text});
 const parsed = groups(f, text);
 assert.equal(parsed.join(''), text);
 assert.ok(parsed.length > 4);
 assert.equal(f.d.querySelectorAll('[style*="contain-intrinsic-size: auto 400px"]').length, 1);
 assert.ok(f.frames.size > 0);
 await f.click('button[aria-label="Copy full reply"]');
 assert.equal(f.writes.at(-1), text);
 await f.frame();
 assert.equal(f.d.querySelectorAll('[style*="contain-intrinsic-size: auto 400px"]').length, 3);
 await f.flush();
 assert.equal(f.d.querySelectorAll('h2').length, 16);
 assert.equal(f.frames.size, 0);
});

test('collapse cancels pending reveal and re-expand restores every block', async t => {
 const text = manyBlocks(); const f = await fixture(t, {text, finalReply: false});
 assert.equal(f.d.querySelector('[data-testid="reply-expand"]')?.textContent, 'Read more');
 await f.click('[data-testid="reply-expand"]');
 assert.ok(f.frames.size > 0);
 await f.click('[data-testid="reply-expand"]');
 assert.equal(f.frames.size, 0);
 assert.equal(f.d.querySelector('[data-testid="reply-expand"]')?.textContent, 'Read more');
 await f.click('[data-testid="reply-expand"]'); await f.flush();
 assert.equal(f.d.querySelectorAll('h2').length, 16);
 assert.equal(f.d.querySelector('[data-testid="reply-expand"]')?.textContent, 'Show less');
});

test('replacement and unmount cannot reveal stale queued content', async t => {
 const f = await fixture(t, {text: manyBlocks('OLD')});
 assert.ok(f.frames.size > 0);
 await f.render({text: manyBlocks('NEW')}); await f.flush();
 assert.equal(f.d.querySelectorAll('h2').length, 16);
 assert.equal(f.d.body.textContent.includes('OLD_'), false);
 assert.ok(f.d.body.textContent.includes('NEW_15'));
 await f.render({text: 'Small replacement', id: 'small'});
 assert.equal(f.frames.size, 0);
 assert.ok(f.d.body.textContent.includes('Small replacement'));
 await f.render({text: manyBlocks('UNMOUNT'), id: 'large'});
 assert.ok(f.frames.size > 0);
 await f.unmount(); assert.equal(f.frames.size, 0);
 assert.equal(f.d.querySelector('main') === null, true);
});

test('switching a partially revealed reply to live text reveals its current tail immediately', async t => {
 const text = manyBlocks(); const f = await fixture(t, {text});
 assert.ok(f.frames.size > 0);
 await f.render({text: text + '\n\nCurrent live tail.', isStreaming: true});
 assert.equal(f.frames.size, 0);
 assert.equal(f.d.querySelectorAll('h2').length, 16);
 assert.ok(f.d.body.textContent.endsWith('Current live tail.'));
 await f.render({text: text + '\n\nCurrent live tail.', isStreaming: false});
 assert.equal(f.frames.size, 0);
 assert.equal(f.d.querySelectorAll('h2').length, 16);
 assert.ok(f.d.body.textContent.endsWith('Current live tail.'));
});


test('live incomplete prose before and after a closed fence keeps the installed renderer treatment', async t => {
 const f = await fixture(t, {text: 'Warm up'});
 const variants = [
  '**Unfinished before\n\n```ts\nconst path = "src/keep.ts";\n```\n\nTail.',
  'Before.\n\n```ts\nconst x = 1;\n```\n\n**Current live tail',
  'Before.\n\n```ts\nconst x = 1;\n```\n\n_italic tail',
  'Before.\n\n```ts\nconst x = 1;\n```\n\n[Incomplete link](https://example.invalid',
 ];
 for (const [index, text] of [...variants, ...variants.map(text => text.replace(/const (?:path|x) = [^\n]+;/, rows(220)))].entries()) {
  await f.render({text, id: 'stream-' + index, isStreaming: true, finalReply: false});
  let stock;
  await f.act(async () => { stock = f.w.fixture.stock(text); });
  const prose = node => [...node.querySelectorAll('p')].filter(p => !p.closest('pre')).map(p => p.textContent);
  assert.deepEqual(prose(f.d.querySelector('[data-testid=reply-text]')), prose(stock.host));
  assert.equal(f.d.querySelectorAll('[data-streamdown=strong]').length, stock.host.querySelectorAll('[data-streamdown=strong]').length);
  await f.act(async () => stock.unmount());
 }
});

test('four-backtick streamed examples retain code rows and settle without heuristic suffixes', async t => {
 const body = rows(170) + '\n```\n~~~\n' + rows(20, 'TAIL_ROW') + '\n';
 const open = '````ts\n' + body;
 const f = await fixture(t, {text: open, isStreaming: true, finalReply: true});
 assert.equal(codeRows(f.d), 170);
 const completed = open + '````\n\nDone.';
 await f.render({text: completed, isStreaming: true, finalReply: true});
 assert.equal(codeRows(f.d), 170);
 // Streamdown's live repair may append a suffix; settling must remove it.
 const codeNode = f.d.querySelector('pre');
 await f.render({text: completed, isStreaming: false, finalReply: true});
 assert.equal(f.d.querySelector('pre'), codeNode, 'settling stable content does not remount its code block');
 await f.flush();
 assert.equal(codeRows(f.d), 170);
 assert.ok(f.d.body.textContent.endsWith('Done.'));
 assert.equal(await copyCode(f), body);
});

test('live-to-new-history-row handoff preserves source and finishes safe progressive restoration', async t => {
 const text = manyBlocks();
 const f = await fixture(t, {text, id: 'live-row', isStreaming: true, finalReply: false});
 assert.equal(f.d.querySelectorAll('h2').length, 16);
 await f.render({text, id: 'settled-history-row', finalReply: true});
 assert.ok(f.frames.size > 0, 'a new large settled row starts progressive mounting');
 await f.click('button[aria-label="Copy full reply"]');
 assert.equal(f.writes.at(-1), text);
 await f.flush(); assert.equal(f.d.querySelectorAll('h2').length, 16);
});


test('later reveal frames preserve visible DOM identity, focus and code Copy feedback', async t => {
 const text = '```ts\nconst HELLO = 123;\n```\n\n' + manyBlocks();
 const f = await fixture(t, {text});
 const pre = f.d.querySelector('pre');
 const button = f.d.querySelector('button[data-streamdown="code-block-copy-button"]');
 const heading = f.d.querySelector('h2');
 assert.ok(button);
 await f.act(async () => { button.focus(); button.click(); });
 await f.settle();
 let revealedFrames = 0;
 while (f.frames.size) {
  await f.frame(); revealedFrames++;
  assert.equal(f.d.querySelector('pre'), pre);
  assert.equal(f.d.querySelector('button[data-streamdown="code-block-copy-button"]'), button);
  assert.equal(f.d.querySelector('h2'), heading);
  assert.equal(f.d.activeElement === button, true);
  assert.equal(f.d.querySelector('output[aria-live=polite]')?.textContent, 'Copied');
 }
 assert.ok(revealedFrames > 1);
 assert.equal(f.writes.at(-1), 'const HELLO = 123;\n');
});
