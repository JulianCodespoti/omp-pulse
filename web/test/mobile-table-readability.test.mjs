import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// Real renderer and React lifetime, intercepted clipboard, synthetic DOM only.
// Browser wrapping/scroll geometry, zoom and native accessibility need acceptance.
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { MessageParts } from ${JSON.stringify(resolve(root, 'web/src/app/parts/MessageParts.tsx'))};
import { Markdown, tableToTsv } from ${JSON.stringify(resolve(root, 'web/src/components/markdown.tsx'))};
import { CopyButton } from ${JSON.stringify(resolve(root, 'web/src/app/parts/CopyButton.tsx'))};
import { Message, MessageContent } from ${JSON.stringify(resolve(root, 'web/src/components/ai-elements/message.tsx'))};
const writes = [];
Object.defineProperty(navigator, 'clipboard', {value: {writeText: async text => writes.push(text)}});
function App({text, role = 'assistant', direct = false, readableTables, isStreaming = false, finalReply = true, id = 'reply'}) {
 return h('main', {}, h(CopyButton, {text, label: 'Copy full reply'}),
  direct ? h(Markdown, {readableTables}, text) : h(Message, {from:role}, h(MessageContent, {}, h(MessageParts, {key: id, message: {id, role, text, parts: [{kind: 'text', text}]}, isStreaming, finalReply}))));
}
window.fixture = {act, writes, tableToTsv, mount(props) {
 const r = createRoot(document.getElementById('root')); r.render(h(App, props));
 return {render: props => r.render(h(App, props)), unmount: () => r.unmount()};
}};
`);
const sample = '| Option | Notes | Cost | Confidence |\n| :--- | :--- | ---: | :---: |\n| Local | Keeps data on this device and works without a network connection. | $0 | High |\n| Cloud | Syncs across devices, but needs an internet connection to stay current. | $20 | Medium |\n';
const scroll = '.markdown-table-scroll';
function assertTableScroll(scroller) {
 assert.ok(scroller);
 assert.equal(scroller.getAttribute('role'), 'region'); assert.equal(scroller.getAttribute('aria-label'), 'Table');
 assert.equal(scroller.tabIndex, 0); scroller.focus(); assert.equal(scroller.ownerDocument.activeElement === scroller, true);
 assert.equal(scroller.querySelectorAll('[tabindex],button').length, 0);
 assert.equal(scroller.querySelectorAll('table').length, 1);
 assert.equal(scroller.querySelectorAll(scroll).length, 0, 'no nested scroll owner');
 assert.equal(scroller.classList.contains('overflow-x-auto'), true);
 assert.equal(scroller.classList.contains('touch-auto'), true);
 assert.equal(scroller.classList.contains('touch-pan-x'), false);
 assert.equal(scroller.classList.contains('[overscroll-behavior-x:contain]'), true);
 assert.equal(scroller.classList.contains('focus-visible:outline-ring'), true);
 assert.equal(scroller.querySelector('table').classList.contains('w-max'), true);
 assert.equal(scroller.querySelector('table').classList.contains('min-w-full'), true);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, props) {
 const dom = createDomFixture(code), w = dom.window, api = w.fixture, frames = new Map(); let next = 0, mounted;
 w.HTMLElement.prototype.scrollTo = () => {};
 w.requestAnimationFrame = cb => { const id = ++next; frames.set(id, cb); return id; };
 w.cancelAnimationFrame = id => frames.delete(id);
 const settle = async () => { for (let i = 0; i < 8; i++) await api.act(async () => { await sleep(5); }); };
 await api.act(async () => { mounted = api.mount(props); }); await settle();
 t.after(async () => { try { await api.act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
 return {...api, w, d: w.document, frames,
  render: async props => { await api.act(async () => mounted.render(props)); await settle(); },
  click: async selector => { const target = w.document.querySelector(selector); assert.ok(target, selector); await api.act(async () => target.click()); await settle(); },
  flush: async () => { for (let i = 0; frames.size && i < 100; i++) { const batch = [...frames.values()]; frames.clear(); await api.act(async () => { for (const cb of batch) cb(0); }); } await settle(); assert.equal(frames.size, 0); },
 };
}

test('assistant table keeps native cells, column scopes, exact content and source alignment', async t => {
 const f = await fixture(t, {text: sample});
 assert.equal(f.d.querySelectorAll('table').length, 1);
 assert.equal(f.d.querySelectorAll('thead > tr > th').length, 4);
 assert.equal(f.d.querySelectorAll('tbody > tr').length, 2);
 const cells = [...f.d.querySelectorAll('th,td')];
 assert.deepEqual(cells.map(c => c.textContent), ['Option', 'Notes', 'Cost', 'Confidence', 'Local', 'Keeps data on this device and works without a network connection.', '$0', 'High', 'Cloud', 'Syncs across devices, but needs an internet connection to stay current.', '$20', 'Medium']);
 for (const [i, cell] of cells.entries()) {
  assert.equal(cell.style.textAlign, ['left','left','right','center'][i % 4]);
  assert.equal(cell.firstElementChild.tagName, 'DIV');
  assert.equal(cell.firstElementChild.className, 'assistant-table-cell');
  assert.equal(cell.firstElementChild.style.textAlign, '', 'alignment is inherited, never replaced');
  assert.equal(cell.hasAttribute('node'), false);
  assert.equal(cell.getAttribute('scope'), cell.tagName === 'TH' ? 'col' : null);
 }
});

test('one labelled focusable scroller retains native table structure without extra controls', async t => {
 const f = await fixture(t, {text: sample}), scroller = f.d.querySelector(scroll);
 assert.equal(f.d.querySelectorAll(scroll).length, 1);
 assertTableScroll(scroller);
});

test('table Copy sits in a header outside the scroller, waits for the stream, then writes tab-separated rows', async t => {
 const f = await fixture(t, {text: sample, isStreaming: true}), copy = () => f.d.querySelector('[data-testid="table-copy"]');
 assert.equal(copy().disabled, true);
 assert.equal(f.d.querySelector(scroll).contains(copy()), false);
 assert.equal(copy().className.includes('after:-inset-y-1.5') && copy().className.includes('h-8'), true, '44px hit area');
 await f.render({text: sample, isStreaming: false});
 assert.equal(copy().disabled, false);
 await f.click('[data-testid="table-copy"]');
 assert.equal(f.writes.at(-1), [
  'Option\tNotes\tCost\tConfidence',
  'Local\tKeeps data on this device and works without a network connection.\t$0\tHigh',
  'Cloud\tSyncs across devices, but needs an internet connection to stay current.\t$20\tMedium',
 ].join('\n'));
 assert.equal(copy().getAttribute('aria-label'), 'Copied');
});

test('tableToTsv flattens whitespace inside a cell so it cannot break the grid', async t => {
 const f = await fixture(t, {text: 'x'});
 const host = f.d.createElement('div');
 host.innerHTML = '<table><thead><tr><th>a</th><th> b </th></tr></thead><tbody><tr><td>1\t2</td><td>x\n  y</td></tr><tr><td></td><td>z</td></tr></tbody></table>';
 assert.equal(f.tableToTsv(host.querySelector('table')), 'a\tb\n1 2\tx y\n\tz');
});

test('emitted wrapper utilities compile to automatic touch eligibility without changing overflow or focus', async t => {
 const f = await fixture(t, {text: sample}), scroller = f.d.querySelector(scroll);
 const { compile } = require('tailwindcss'), postcss = require('postcss');
 const compiler = await compile('@tailwind utilities;');
 const css = postcss.parse(compiler.build([...scroller.classList]));
 const declarations = {};
 // Actual emitted utilities only; this is CSS declaration evidence, not a native gesture simulation.
 css.walkRules(rule => {
  const selector = rule.selector.replace(':focus-visible', '');
  if (!selector.startsWith('.')) return;
  if (scroller.matches(selector)) for (const node of rule.nodes) if (node.type === 'decl') declarations[node.prop] = node.value;
 });
 assert.equal(declarations['touch-action'], 'auto');
 assert.equal(declarations['overflow-x'], 'auto');
 assert.equal(declarations['overscroll-behavior-x'], 'contain');
 assert.equal(declarations['outline-width'], '2px');
});

test('full-reply Copy preserves exact Markdown punctuation, whitespace and alignment delimiters', async t => {
 const text = 'Before.\n\n' + sample + '\nAfter with café 🪴.  \n';
 const f = await fixture(t, {text});
 for (let i = 0; i < 3; i++) { await f.click('main > button'); assert.equal(f.writes.at(-1), text); }
 assert.equal(f.writes.length, 3);
});

test('user, tool-role and direct Markdown consumers retain unwrapped cell markup', async t => {
 const f = await fixture(t, {text: sample});
 for (const props of [{role:'user'}, {role:'tool'}, {direct:true}]) {
  await f.render({text:sample, ...props});
  assert.equal(f.d.querySelectorAll('table').length, 1);
  assert.equal(f.d.querySelector('.assistant-table-reader') === null, true);
  assert.equal(f.d.querySelector('.assistant-table-cell') === null, true);
  assert.equal(f.d.querySelector('th').getAttribute('scope') === null, true);
  assert.equal(f.d.querySelectorAll(scroll).length, 1);
  assertTableScroll(f.d.querySelector(scroll));
 }
});

test('readable-table opt-in participates in both renderer memo boundaries', async t => {
 const f = await fixture(t, {text:sample, direct:true, readableTables:false});
 assert.equal(f.d.querySelector('.assistant-table-cell') === null, true);
 await f.render({text:sample, direct:true, readableTables:true});
 assert.equal(f.d.querySelectorAll('.assistant-table-cell').length, 12);
 await f.render({text:sample, direct:true, readableTables:false});
 assert.equal(f.d.querySelector('.assistant-table-cell') === null, true);
});

test('nested list and quote tables keep one nearest scroller and all formatted content', async t => {
 const text = '| Description | Value |\n| :--- | ---: |\n| **Bold** and *emphasis* plus `unbroken_identifier_12345678901234567890` | [Café 🪴](https://example.test/a) |\n';
 const f = await fixture(t, {text: sample});
 for (const [id, nested, parent] of [
  ['quote', text.trimEnd().split('\n').map(line => '> ' + line).join('\n'), 'blockquote'],
  ['list', '- Options\n\n' + text.trimEnd().split('\n').map(line => '  ' + line).join('\n'), 'li'],
 ]) {
  await f.render({id, text:nested});
  assert.equal(f.d.querySelectorAll(`${parent} ${scroll}`).length, 1, id);
  assert.equal(f.d.querySelectorAll(scroll).length, 1, id);
  assertTableScroll(f.d.querySelector(scroll));
  const cell = f.d.querySelector('td .assistant-table-cell');
  assert.equal(cell.textContent, 'Bold and emphasis plus unbroken_identifier_12345678901234567890');
  assert.equal(cell.querySelector('[data-streamdown="strong"]').textContent, 'Bold'); assert.equal(cell.querySelector('[data-streamdown="em"], em').textContent, 'emphasis');
  assert.equal(f.d.querySelector('td a').getAttribute('href'), 'https://example.test/a');
  assert.equal(f.d.querySelector('td span > div') === null, true, 'wrapper is flow-safe');
 }
});

test('appended rows and live-to-settled transition retain the same table, cells and focus', async t => {
 const f = await fixture(t, {text:sample, isStreaming:true});
 const table = f.d.querySelector('table'), scroller = f.d.querySelector(scroll), header = f.d.querySelector('th'), first = f.d.querySelector('td');
 scroller.focus();
 const appended = sample + '| Remote | Another complete description to keep visible. | $10 | Low |\n';
 for (const isStreaming of [true, false]) {
  await f.render({text:appended, isStreaming});
  assert.equal(f.d.querySelector('table'), table); assert.equal(f.d.querySelector(scroll), scroller);
  assert.equal(f.d.querySelector('th'), header); assert.equal(f.d.querySelector('td'), first);
  assert.equal(f.d.activeElement === scroller, true); assert.equal(f.d.querySelectorAll('tbody tr').length, 3);
 }
});

test('240-row table remains indivisible, complete and copyable through settlement and history expansion', async t => {
 const text = '| Row | Long description | Amount |\n| :--- | :--- | ---: |\n' + Array.from({length:240}, (_, i) => `| ROW_${i} | ${'Long prose stays readable without losing any source text. '.repeat(3)} | ${i}.25 |`).join('\n') + '\n';
 assert.ok(text.length > 32000);
 const f = await fixture(t, {text, isStreaming:true});
 const table = f.d.querySelector('table'), scroller = f.d.querySelector(scroll); scroller.focus();
 await f.render({text, isStreaming:false}); await f.flush();
 assert.equal(f.d.querySelector('table'), table); assert.equal(f.d.querySelector(scroll), scroller); assert.equal(f.d.activeElement === scroller, true);
 assert.equal(f.d.querySelectorAll('tbody tr').length, 240);
 assert.deepEqual([...f.d.querySelectorAll('tbody tr > td:first-child')].map(c => c.textContent), Array.from({length:240}, (_, i) => `ROW_${i}`));
 assert.equal(f.d.querySelectorAll('.assistant-table-cell').length, 723);
 await f.click('button[aria-label="Copy full reply"]'); assert.equal(f.writes.at(-1), text);
 await f.render({text, finalReply:false}); await f.click('[data-testid="reply-expand"]'); await f.flush();
 assert.equal(f.d.querySelectorAll('table').length, 1); assert.equal(f.d.querySelectorAll('tbody tr').length, 240);
});

test('mobile rules use intrinsic flow-safe wrappers with root-scaled type and scrollport-aware bounds', () => {
 const postcss = require('postcss'), css = postcss.parse(readFileSync(resolve(root,'web/src/styles.css'),'utf8'));
 const rules = [];
 css.walkRules(rule => { if (!rule.selector.includes('assistant-table')) return; const declarations = {}; rule.walkDecls(d => declarations[d.prop] = d.value); const conditions=[]; for(let p=rule.parent;p;p=p.parent) if(p.type==='atrule') conditions.push('@'+p.name+' '+p.params); rules.push({selector:rule.selector,declarations,conditions}); });
 const desktop = rules.find(r => r.selector === '.assistant-table-cell');
 assert.deepEqual(desktop.declarations, {display:'contents'}); assert.deepEqual(desktop.conditions, []);
 const mobile = rules.filter(r => r !== desktop); assert.ok(mobile.every(r => r.conditions.includes('@media (width < 48rem)')));
 const type = mobile.find(r => r.selector.includes(' table'));
 assert.equal(type.declarations['font-size'],'0.875rem'); assert.equal(type.declarations['line-height'],'1.5'); assert.ok(type.selector.includes(':is(th, td)'));
 const fallback = mobile.find(r => r.declarations.display === 'inline-block');
 assert.equal(fallback.declarations['inline-size'],'auto'); assert.equal(fallback.declarations['max-inline-size'],'24ch');
 assert.equal(fallback.declarations['white-space'],'normal'); assert.equal(fallback.declarations['overflow-wrap'],'anywhere');
 const bound = mobile.find(r => r.declarations['max-inline-size']?.includes('100cqi'));
 assert.equal(bound.declarations['max-inline-size'],'min(24ch, max(0px, calc(100cqi - 1.25rem)))');
 assert.ok(bound.conditions.includes('@supports (container-type: inline-size) and (width: 1cqi) and selector(:has(*))'));
 assert.equal(mobile.find(r => r.selector.includes('markdown-table-scroll')).declarations['container-type'],'inline-size');
 const widthRule = mobile.find(r => r.selector.includes('[data-message-box]'));
 assert.deepEqual(widthRule.declarations, {width:'100%'});
 assert.ok(widthRule.selector.includes('.is-assistant > [data-message-box]:has(.assistant-table-reader table)'));
 assert.deepEqual(widthRule.conditions,bound.conditions);
 for (const {declarations} of rules.filter(r => r !== widthRule)) for (const key of ['text-align','padding','overflow','overflow-x','table-layout','width','position','font-variant-numeric']) assert.equal(key in declarations,false,key);
});
