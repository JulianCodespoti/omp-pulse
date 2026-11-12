import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const postcss = require('postcss');
const css = postcss.parse(readFileSync(resolve(root, 'web/src/styles.css'), 'utf8'));
const rules = [];
css.walkRules(rule => {
  if (!rule.selector.startsWith('.assistant-code-reader')) return;
  const declarations = {};
  rule.walkDecls(d => { declarations[d.prop] = d.value; });
  rules.push({selector: rule.selector, declarations, rule});
});
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { MessageParts } from ${JSON.stringify(resolve(root, 'web/src/app/parts/MessageParts.tsx'))};
import { Markdown } from ${JSON.stringify(resolve(root, 'web/src/components/markdown.tsx'))};
const writes = [];
Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => writes.push(text)}});
function App({text, role = 'assistant', direct = false, finalReply = true, isStreaming = false, id = 'reply'}) {
 return direct ? h(Markdown, {}, text) : h(MessageParts, {key: id, message: {id, role, text, parts: [{kind: 'text', text}]}, finalReply, isStreaming});
}
window.fixture = {act, writes, mount(props) {
 const r = createRoot(document.getElementById('root'));
 r.render(h(App, props));
 return {render: props => r.render(h(App, props)), unmount: () => r.unmount()};
}};
`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const block = '[data-streamdown="code-block"]';
const copy = '[data-streamdown="code-block-copy-button"]';
// Code blocks offer Copy only; the Download control must never render.
const download = '[data-streamdown="code-block-download-button"]';
const source = '\tconst path = "src/features/conversations/markdown/renderers/assistant-code.ts";  \n\n  // café 🪴 <literal> &\n';
const fence = (value = source, info = 'typescript') => `\`\`\`${info}\n${value}\`\`\`\n`;
async function fixture(t, props) {
 const dom = createDomFixture(code), w = dom.window, api = w.fixture;
 w.HTMLElement.prototype.scrollTo = () => {}; // no synthetic geometry claim
 const frames = new Map(), feedback = []; let id = 0;
 const nativeTimeout = w.setTimeout.bind(w);
 w.setTimeout = (fn, ms, ...args) => ms === 2000 ? (feedback.push(() => fn(...args)), -feedback.length) : nativeTimeout(fn, ms, ...args);
 w.requestAnimationFrame = callback => { const key = ++id; frames.set(key, callback); return key; };
 w.cancelAnimationFrame = key => frames.delete(key);
 let mounted;
 const settle = async () => { for (let i = 0; i < 8; i++) await api.act(async () => { await sleep(5); }); };
 await api.act(async () => { mounted = api.mount(props); }); await settle();
 t.after(async () => { try { await api.act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
 return {...api, w, d: w.document, settle,
  render: async props => { await api.act(async () => mounted.render(props)); await settle(); },
  click: async selector => { const el = w.document.querySelector(selector); assert.ok(el, selector); await api.act(async () => el.click()); await settle(); },
  finishFeedback: async () => { await api.act(async () => { for (const fn of feedback.splice(0)) fn(); }); },
  flush: async () => { for (let i = 0; frames.size && i < 100; i++) { const batch = [...frames.values()]; frames.clear(); await api.act(async () => { for (const fn of batch) fn(0); }); } await settle(); assert.equal(frames.size, 0); },
 };
}

test('actual assistant renderer keeps one native code surface, language and highlighted numbered rows', async t => {
 const f = await fixture(t, {text: fence()});
 assert.equal(f.d.querySelectorAll('.assistant-code-reader').length, 1);
 assert.equal(f.d.querySelectorAll(block).length, 1);
 assert.equal(f.d.querySelectorAll(`${block} pre`).length, 1);
 assert.equal(f.d.querySelector('[data-streamdown="code-block-header"]')?.textContent, 'typescript');
 assert.ok(f.d.querySelector('pre span[style*="--sdm-c"]'));
 const rows = f.d.querySelectorAll('pre code > span');
 assert.equal(rows.length, 3);
 assert.equal(rows[0].textContent, source.split('\n')[0]);
 assert.equal(rows[1].textContent, '\n');
 assert.ok(rows[0].className.includes('counter(line)'));
 assert.equal(f.d.querySelector('[data-streamdown="code-block-body"]').style.maxHeight, '400px');
 assert.equal(f.d.querySelectorAll('pre [data-testid="path-chip"]').length, 0);
});

test('native Copy is the only code action and retains exact raw whitespace, repeating safely', async t => {
 const f = await fixture(t, {text: fence()});
 assert.equal(f.d.querySelector(download), null);
 assert.equal(f.d.querySelectorAll(`${block} button`).length, 1, 'one action: Copy');
 for (let i = 0; i < 3; i++) {
  await f.click(copy); assert.equal(f.writes.at(-1), source);
  assert.equal(f.d.querySelector('output[aria-live="polite"]')?.textContent, 'Copied');
  await f.finishFeedback(); assert.equal(f.d.querySelector('output') === null, true);
 }
 assert.equal(f.writes.length, 3);
});

test('same native block keeps focus and Copy feedback while following prose updates', async t => {
 const text = fence() + '\nBefore.';
 const f = await fixture(t, {text});
 const original = f.d.querySelector(block), button = f.d.querySelector(copy);
 await f.click(copy); button.focus();
 await f.render({text: fence() + '\nAfter.'});
 assert.equal(f.d.querySelector(block), original);
 assert.equal(f.d.querySelector(copy), button);
 assert.equal(f.d.activeElement === button, true);
 assert.equal(f.d.querySelector('output')?.textContent, 'Copied');
 await f.click(copy); assert.equal(f.writes.length, 1, 'native feedback suppresses duplicate Copy');
});

test('streaming buttons stay disabled and the native body survives same-block settling', async t => {
 const f = await fixture(t, {text: fence(), isStreaming: true});
 const original = f.d.querySelector(block);
 assert.equal(f.d.querySelector(copy).disabled, true); assert.equal(f.d.querySelector(download), null);
 await f.click(copy); assert.equal(f.writes.length, 0);
 await f.render({text: fence(), isStreaming: false});
 assert.equal(f.d.querySelector(block), original);
 assert.equal(f.d.querySelector(copy).disabled, false); assert.equal(f.d.querySelector(download), null);
 await f.click(copy); assert.equal(f.writes.at(-1), source);
});

test('nested, unlabelled and unknown-language code keep native payload and metadata semantics', async t => {
 const f = await fixture(t, {text: 'Warm up'});
 for (const [id, text, language, payload] of [
  ['plain', fence(source, ''), '', source],
  ['unknown', fence(source, 'arbitrary-fixture-language'), 'arbitrary-fixture-language', source],
  ['quote', '> ' + fence('const n = 1;\n', 'ts startLine=42').split('\n').join('\n> '), 'ts', 'const n = 1;\n'],
  ['list', '- Example\n\n  ~~~~ts noLineNumbers\n  const n = 1;\n  ~~~~\n', 'ts', 'const n = 1;\n'],
 ]) {
  await f.render({id, text});
  assert.equal(f.d.querySelector(block)?.getAttribute('data-language'), language, id);
  await f.click(copy); assert.equal(f.writes.at(-1), payload, id);
  if (id === 'quote') assert.equal(f.d.querySelector('pre code').style.counterReset, 'line 41');
  if (id === 'list') assert.equal(f.d.querySelector('pre code > span').className.includes('counter(line)'), false);
 }
});

test('styles match assistant code only, excluding Mermaid, user and direct Markdown consumers', async t => {
 const text = 'Inline `src/inline.ts`.\n\n' + fence() + '\n| Name | Value |\n| --- | --- |\n| A | B |\n\n' + fence('graph TD; A-->B\n', 'mermaid');
 const f = await fixture(t, {text});
 // Diff-fence rules style a block this fixture deliberately does not contain.
 for (const {selector} of rules.filter(r => !r.selector.includes('[data-language="diff"]'))) {
  const base = selector.replace(/::(before|after)$/, '').replace(':focus-visible', '');
  assert.ok(f.d.querySelector(base), selector);
  for (const match of f.d.querySelectorAll(base)) {
   assert.equal(match.closest(block)?.getAttribute('data-language'), 'typescript');
   assert.equal(match.tagName === 'TABLE', false);
  }
 }
 assert.equal(f.d.querySelectorAll('[data-streamdown="inline-code"]').length, 1);
 assert.equal(f.d.querySelectorAll('table').length, 1);
 for (const props of [{text, role: 'user'}, {text, direct: true}]) {
  await f.render(props); assert.equal(f.d.querySelector('.assistant-code-reader') === null, true);
  for (const {selector} of rules) assert.equal(f.d.querySelector(selector.replace(/::(before|after)$/, '').replace(':focus-visible', '')) === null, true);
 }
});

test('Copy carries an accessible name and no Download control appears for any fence', async t => {
 const f = await fixture(t, {text: fence() + '\n' + fence('const n = 1;\n', '') + '\n' + fence('graph TD; A-->B\n', 'mermaid')});
 assert.equal(f.d.querySelectorAll(download).length, 0);
 for (const button of f.d.querySelectorAll(copy)) {
  // The DOM patch mirrors streamdown's title onto aria-label (A11Y-03).
  const label = button.getAttribute('aria-label');
  assert.ok(label, 'copy button is named');
  if (button.title) assert.equal(label, button.title);
 }
});

test('progressive reveal and repeated history expansion retain complete source and native actions', async t => {
 const text = fence(source) + '\n' + ('Prose between blocks. '.repeat(200) + '\n\n').repeat(9) + fence('const tail = 2;\n');
 const f = await fixture(t, {text, finalReply: false});
 for (let i = 0; i < 2; i++) {
  await f.click('[data-testid="reply-expand"]'); await f.flush();
  assert.equal(f.d.querySelectorAll(block).length, 2);
  assert.equal(f.d.querySelector(download), null);
  const button = f.d.querySelector(copy); await f.click(copy); button.focus();
  await f.flush(); assert.equal(f.d.activeElement === button, true); assert.equal(f.writes.at(-1), source);
  await f.click('[data-testid="reply-expand"]');
 }
});

test('surface rules declare one frame/scroll owner and one root-relative code size without token colour resets', () => {
 const find = suffix => rules.find(r => r.selector.endsWith(suffix)).declarations;
 assert.match(find(':not([data-language="mermaid"])')['background'], /^var\(--surface-[123]\)$/);
 assert.equal(find('[data-streamdown="code-block-body"]')['overflow'], 'auto');
 assert.equal(find('[data-streamdown="code-block-body"]')['border'], '0');
 assert.equal(find(' pre')['overflow'], 'visible'); assert.equal(find(' pre')['border'], '0');
 assert.equal(find(' pre')['background'], 'transparent'); assert.equal(find(' pre')['white-space'], 'pre');
 // One size before and after highlighting lands: pre, code and the line gutter agree.
 const size = find(' pre')['font-size'];
 assert.match(size, /rem|var\(--text-/);
 assert.equal(find(' pre > code')['font-size'].replace(/\s*!important$/, ''), size);
 assert.equal(find('span::before')['font-size'], size);
 const codeRule = rules.find(r => r.selector.endsWith(' pre > code')).rule;
 assert.equal(codeRule.parent.name, 'layer'); assert.equal(codeRule.parent.params, 'utilities');
 assert.ok(codeRule.nodes.every(d => d.important));
 for (const {selector, declarations} of rules) {
  assert.ok(selector.includes('[data-streamdown="code-block"]:not([data-language="mermaid"])'));
  if (!selector.endsWith('::before')) assert.equal('color' in declarations, false);
  assert.equal('max-height' in declarations, false, 'native bounded height remains authoritative');
 }
});
