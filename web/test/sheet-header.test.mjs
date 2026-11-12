import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {BottomSheet} from ${JSON.stringify(resolve(root,'web/src/app/ui/Sheet.tsx'))};
 const calls={close:[],action:0,back:0};window.fixture={act,calls,mount:(title,description,slots)=>{
  const r=createRoot(document.getElementById('root'));r.render(h(BottomSheet,{open:true,title,description,onOpenChange:v=>calls.close.push(v),testId:'fixture-sheet',
   leading:slots?h('button',{'data-testid':'fixture-back',onClick:()=>calls.back++},'Back'):undefined,
   headerActions:slots?h('button',{'data-testid':'fixture-action',onClick:()=>calls.action++},'Copy'):undefined,
   subHeader:slots?h('div',{'data-testid':'fixture-subheader'},'Search'):undefined,
   footer:slots?h('div',{'data-testid':'fixture-footer'},'Footer'):undefined},h('p',{'data-testid':'fixture-body'},'Body stays here')));return r;
 }};
`);
async function fixture(t,{title='Commands',description,slots=false}={}){
 const dom=createDomFixture(code),w=dom.window,{act,calls}=w.fixture;let mounted;
 await act(async()=>{mounted=w.fixture.mount(title,description,slots);await new Promise(r=>w.setTimeout(r,30))});
 t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 return {w,act,calls,get:id=>w.document.querySelector(`[data-testid="${id}"]`)};
}
test('real dialog keeps its title identity with a two-line contract',async t=>{
 const title='Improve message delivery and offline recovery';const f=await fixture(t,{title});const el=f.get('sheet-title-text');assert.ok(el);assert.equal(el.textContent,title);assert.equal(el.title,title);assert.ok(el.classList.contains('line-clamp-2'));assert.equal(el.classList.contains('truncate'),false);
 const dialog=f.w.document.querySelector('[role="dialog"]');assert.ok(dialog);const heading=f.w.document.getElementById(dialog.getAttribute('aria-labelledby'));assert.ok(heading?.contains(el));
});
test('subtitle wraps below the title without the old negative offset',async t=>{
 const description='A long project description that should remain available';const f=await fixture(t,{description});const el=f.get('sheet-description');assert.equal(el.textContent,description);assert.ok(el.classList.contains('line-clamp-2'));assert.ok(el.classList.contains('mt-0.5'));assert.equal(el.classList.contains('-mt-1.5'),false);assert.equal(el.title,description);
});
test('short title has no empty subtitle placeholder',async t=>{
 const f=await fixture(t);assert.equal(f.get('sheet-description') === null, true);assert.equal(f.get('sheet-title-text').textContent,'Commands');
});
// Focus entering the sheet on open is covered by sheet-focus-restoration; here
// the sheet mounts already open, so only the close button's state is checked.
test('close is named, closes, and is never the initially focused control',async t=>{
 const f=await fixture(t);const close=f.get('sheet-close');assert.equal(close.getAttribute('aria-label'),'Close');
 assert.notEqual(f.w.document.activeElement,close);
 await f.act(async()=>close.click());assert.deepEqual(Array.from(f.calls.close),[false]);
});
test('header actions and leading slot retain independent callbacks',async t=>{
 const f=await fixture(t,{slots:true});await f.act(async()=>f.get('fixture-action').click());await f.act(async()=>f.get('fixture-back').click());assert.equal(f.calls.action,1);assert.equal(f.calls.back,1);assert.equal(f.calls.close.length,0);
});
test('subheader body and footer remain present in the actual sheet',async t=>{
 const f=await fixture(t,{slots:true});for(const id of ['fixture-subheader','fixture-body','fixture-footer'])assert.ok(f.get(id));
});
