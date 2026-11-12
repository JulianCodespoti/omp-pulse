import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import { createElement, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { SearchTool } from ${JSON.stringify(resolve(root,'web/src/app/parts/tools/SearchTool.tsx'))};
window.fixture = {act, mount(part) {const r=createRoot(document.getElementById('root'));r.render(createElement(SearchTool,{part}));return r;}};
`);
// Absence as a boolean: a failing assert.equal on a DOM node would render the
// node's React fiber graph (see test-support/react-dom.mjs).
const none=(node,message)=>assert.equal(node==null,true,message);
async function fixture(t, output, extra={}) {
 const dom=createDomFixture(code), w=dom.window, {act}=w.fixture, copies=[];
 Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>copies.push(text)}});
 let mounted;await act(async()=>{mounted=w.fixture.mount({kind:'tool',name:'grep',callId:'synthetic',args:{pattern:'recovery'},state:'ok',output,...extra});});
 const buttons=()=>[...w.document.querySelectorAll('button')];
 const el=id=>w.document.querySelector(`[data-testid="${id}"]`);
 t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[]);}finally{dom.close();}});
 return {w,act,el,copies,buttons,
  region:()=>w.document.querySelector('[role="region"][aria-label="Output"]'),
  // Search text and copy preserve the recorded output, including blank lines.
  text:()=>[...w.document.querySelectorAll('[data-bash-output]')].map(p=>p.textContent).join(''),
  click:async text=>act(async()=>{const b=buttons().find(b=>b.textContent.startsWith(text)||b.getAttribute('aria-label')===text);assert.ok(b,text);b.click();})};
}
test('long matches keep literal text and wrap on request rather than truncating',async t=>{
 const output='src/'+ 'nested/'.repeat(30)+'controller.ts:123  preserveDraft()';const f=await fixture(t,output),pre=()=>f.w.document.querySelector('[data-bash-output]');
 assert.equal(f.text(),output);assert.equal(pre().classList.contains('truncate'),false);assert.doesNotMatch(f.text(),/…/);
 assert.ok(pre().classList.contains('whitespace-pre'));assert.ok(f.region().classList.contains('overflow-x-auto'),'unwrapped rows scroll sideways');
 const wrap=f.buttons().find(b=>b.getAttribute('aria-label')==='Wrap lines');
 await f.act(async()=>wrap.click());assert.equal(wrap.getAttribute('aria-pressed'),'true');
 assert.ok(pre().classList.contains('whitespace-pre-wrap'));assert.ok(pre().classList.contains('break-all'));assert.equal(f.text(),output);
});
test('results are one keyboard-focusable mono region',async t=>{
 const f=await fixture(t,'src/a.ts:1 match'),region=f.region();
 assert.equal(f.w.document.querySelectorAll('[data-testid="tool-output"]').length,1);
 assert.equal(region.tabIndex,0);for(const cls of ['rounded-lg','bg-surface-1'])assert.ok(region.classList.contains(cls),cls);
 region.focus();assert.equal(f.w.document.activeElement === region, true);
});
test('summary counts matches in the toolbar',async t=>{
 const one=await fixture(t,'src/a.ts:1 match');
 const summary=one.el('search-result-summary');assert.equal(summary.textContent,'1 match');
 assert.equal(summary.closest('[data-testid="tool-output"]').firstElementChild.contains(summary),true,'the count sits in the block toolbar');
 const many=await fixture(t,Array.from({length:1234},(_,i)=>`src/${i}.ts:1 match`).join('\n'));
 assert.equal(many.el('search-result-summary').textContent,'1,234 matches');
});
test('empty results name the query within the 64-character summary budget',async t=>{
 const pattern='long-pattern-'.repeat(5);const f=await fixture(t,'No matches found',{args:{pattern}});
 assert.equal(f.w.document.body.textContent.includes(`No matches for “${pattern.slice(0,64)}…”.`),true);
 none(f.el('tool-output'),'no empty results block');none(f.el('search-result-summary'));
});
test('structured array output stays literal and copies its original representation',async t=>{
 const output=JSON.stringify([{path:'src/one.ts',line:42,text:'  exact match  '},{path:'src/two.ts',line:7,text:'other'}],null,2);
 const f=await fixture(t,output);
 assert.equal(f.text(),output);
 assert.equal(f.el('search-result-summary').textContent,'2 matches');
 await f.click('Copy results');assert.deepEqual(f.copies,[output]);
});
test('markup remains plain text, and Copy preserves every original byte',async t=>{
 const output='src/a.ts:3 <script>doNotRun()</script>\n\n  src/b.ts:4 & value  \n';const f=await fixture(t,output);
 assert.equal(f.region().querySelector('script') === null, true);assert.ok(f.text().includes('<script>doNotRun()</script>'));
 assert.equal(f.text(),output);
 await f.click('Copy results');assert.deepEqual(f.copies,[output]);
});
test('large results retain Show all and Show less with exact Copy',async t=>{
 const output=Array.from({length:501},(_,i)=>`src/${i}.ts:1 match`).join('\n');const f=await fixture(t,output);
 const lines=()=>f.text().split('\n').length;
 assert.equal(lines(),500);assert.equal(f.el('search-result-summary').textContent,'501 matches','the count covers hidden rows');
 await f.click('Show all');assert.equal(lines(),501);
 await f.click('Copy results');assert.deepEqual(f.copies,[output]);await f.click('Show less');assert.equal(lines(),500);
});
test('empty and no-match searches explain themselves',async t=>{
 for(const output of ['No matches found','','no matches']){
  const f=await fixture(t,output);none(f.el('tool-output'));
  assert.match(f.w.document.body.textContent,/No matches for “recovery”\./);
 }
});
test('error output and pruned notice remain readable without a match count',async t=>{
 const f=await fixture(t,'Permission denied\nTry another path',{state:'error',pruned:true});none(f.el('search-result-summary'));
 const [first]=f.w.document.querySelectorAll('[data-bash-output]');
 assert.equal(first.textContent,'Permission denied\n');assert.ok(first.classList.contains('text-danger'));
 assert.equal(f.text(),'Permission denied\nTry another path');
 assert.match(f.w.document.body.textContent,/Output removed from the transcript to save space\./);
 await f.click('Copy error');assert.deepEqual(f.copies,['Permission denied\nTry another path']);
});
for(const output of [
 'src/search.ts:14 if (lower.includes("no matches found")) return [];',
 JSON.stringify([{path:'src/search.ts',line:14,text:'no matches found'}]),
 '  first match\r\n\nsrc/search.ts:14 no matches found  \n',
]) test('actual matches containing empty-result wording remain readable and copyable',async t=>{
 const f=await fixture(t,output);
 assert.equal(f.text(),output);assert.ok(f.el('search-result-summary'));
 assert.doesNotMatch(f.w.document.body.textContent,/No matches for/);
 await f.click('Copy results');assert.deepEqual(f.copies,[output]);
});
test('web source links survive bounded Show all chunks without rewriting text or copy',async t=>{
 const urls=['https://example.com/first','https://example.com/middle','https://example.com/last'];
 const rows=Array.from({length:550},(_,i)=>`answer ${i} ${'x'.repeat(30)}`);
 for(const [index,line] of [1,300,520].entries())rows[line]=`    ${urls[index]}`;
 const output=rows.join('\n');
 const f=await fixture(t,output,{name:'web_search',search:{kind:'web',sourceCount:3,truncated:false}});
 assert.equal(f.w.document.querySelectorAll('[data-bash-output] a').length,2);
 await f.click('Show all');
 assert.ok(f.w.document.querySelectorAll('[data-bash-output]').length>1,'the actual progressive chunk renderer is used');
 assert.equal([...f.w.document.querySelectorAll('[data-bash-output]')].map(pre=>pre.textContent).join('\n'),output,'all chunks preserve the output lines');
 assert.deepEqual([...f.w.document.querySelectorAll('[data-bash-output] a')].map(a=>a.getAttribute('href')),urls);
 await f.click('Copy results');assert.deepEqual(f.copies,[output]);
});
