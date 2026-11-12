import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h, act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {Row, RowGroup} from ${JSON.stringify(resolve(root, 'web/src/app/ui/Row.tsx'))};
import {SheetSearch} from ${JSON.stringify(resolve(root, 'web/src/app/ui/Sheet.tsx'))};
import {DesktopAgentList} from ${JSON.stringify(resolve(root, 'web/src/app/tools/DesktopAgentList.tsx'))};
let node; const clicks = [];
window.fixture = {act, clicks, mount() {
 node = createRoot(document.getElementById('root'));
 node.render(h('main', {},
  h(RowGroup, {title:'Devices'}, h(Row, {title:'Device', onClick:()=>clicks.push('device')}), h(Row, {title:'File', subtitle:'a.txt', onClick:()=>clicks.push('file')})),
  h(SheetSearch, {value:'', onChange:()=>{}, placeholder:'Search files'}),
  h(DesktopAgentList, {agents:[{id:'long-agent', displayName:'Long agent name '.repeat(12), status:'aborted', kind:'sub'}], selectedId:null, onOpen:()=>clicks.push('agent')})
 ));
}, unmount(){node.unmount()}};
`);

test('shared lists are flat with native button semantics without replacement explanatory controls', async t => {
 const dom = createDomFixture(code), w = dom.window, f = w.fixture;
 await f.act(async()=>f.mount());
 t.after(async()=>{await f.act(async()=>f.unmount());assert.deepEqual(dom.blocked,[]);dom.close()});
 const buttons = Array.from(w.document.querySelectorAll('button'));
 for(const button of buttons){
  assert.equal(button.type, 'button', 'Rows never submit an enclosing form');
  await f.act(async()=>button.click());
 }
 assert.deepEqual(Array.from(f.clicks), ['device','file','agent']);
 assert.equal(w.document.querySelector('details, summary') === null, true);
 assert.doesNotMatch(w.document.body.textContent, /Last received|Status may have changed/);
 const agent = w.document.querySelector('[data-desktop-agent]');
 // An aborted desktop agent reads as the shared status word "Stopped".
 assert.match(agent.getAttribute('aria-label'), /^Open Long agent name .* conversation, Stopped$/);
assert.match(agent.querySelector('[data-slot="row-body"]').textContent, /Stopped/);
 assert.ok(agent.querySelector('[title]').getAttribute('title').length > 100);
 const input = w.document.querySelector('input');
 assert.equal(input.getAttribute('aria-label'), 'Search files');
 assert.ok(input.classList.contains('text-body'), 'Inputs retain 16px text');
 const group = w.document.querySelector('[data-slot="row-group"]');
 assert.equal(group.querySelector('h2').textContent, 'Devices');
 assert.equal(group.querySelectorAll('button').length, 2);
});

test('body/input text compiles to 16px', async () => {
 const css = readFileSync(resolve(root,'web/src/styles.css'),'utf8');
 const { compile } = require('@tailwindcss/node');
 const compiler = await compile(css, { base: resolve(root, 'web/src'), onDependency() {} });
 // 16px input text is what stops iOS zooming a focused field.
 assert.match(compiler.build(['text-body']), /\.text-body\s*\{[^}]*font-size:\s*1rem;/);
});


test('inset focus offset overrides the global important fallback for edge-aligned rows', () => {
 const css = readFileSync(resolve(root,'web/src/styles.css'),'utf8');
 const fallback = css.indexOf('outline-offset: 2px !important');
 const inset = css.indexOf('[class~="focus-visible:-outline-offset-2"]:focus-visible');
 assert.ok(inset > fallback);
 assert.match(css.slice(inset, css.indexOf('}', inset)), /outline-offset: -2px !important/);
 for (const file of ['input.tsx', 'textarea.tsx']) {
   const source = readFileSync(resolve(root,'web/src/components/ui',file),'utf8');
   assert.equal(/md:text-(xs|sm|meta|ui)\b/.test(source), false, `${file} keeps 16px text at md`);
 }
});
