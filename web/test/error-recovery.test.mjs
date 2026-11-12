import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {Notice} from ${JSON.stringify(resolve(root,'web/src/app/ui/Notice.tsx'))};
 const calls={retry:0,dismiss:0};window.fixture={act,calls,mount:(retry,dismiss,message,tone)=>{
  const r=createRoot(document.getElementById('root'));r.render(h('form',{onSubmit:e=>{e.preventDefault();calls.submit=(calls.submit??0)+1}},h(Notice,{tone,
   action:retry?{label:'Retry',onClick:()=>calls.retry++}:undefined,onDismiss:dismiss?()=>calls.dismiss++:undefined,
   className:'fixture-extra',testId:'fixture-error'},message)));return r;
 }};
`);
async function fixture(t,retry=false,dismiss=false,message='Couldn’t reach your computer.',tone='danger'){
 const dom=createDomFixture(code),w=dom.window,{act,calls}=w.fixture;let mounted;
 await act(async()=>{mounted=w.fixture.mount(retry,dismiss,message,tone)});
 t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const notice=w.document.querySelector('[data-testid="fixture-error"]');
 return {w,act,calls,notice,button:label=>[...w.document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent.trim()===label)};
}
for(const [retry,dismiss] of [[false,false],[true,false],[false,true],[true,true]]){
 test(`only supplied actions appear: retry=${retry} dismiss=${dismiss}`,async t=>{
  const f=await fixture(t,retry,dismiss);assert.equal(Boolean(f.button('Retry')),retry);assert.equal(Boolean(f.button('Dismiss')),dismiss);
  assert.equal(f.w.document.querySelectorAll('button').length,Number(retry)+Number(dismiss));
 });
}
test('the action is a visible text label and dismiss is named',async t=>{
 const f=await fixture(t,true,true);assert.equal(f.button('Retry').textContent.trim(),'Retry');
 assert.equal(f.button('Dismiss').getAttribute('aria-label'),'Dismiss');
});
test('action and dismiss callbacks remain separate and do not submit an enclosing form',async t=>{
 const f=await fixture(t,true,true);assert.equal(f.button('Retry').type,'button');assert.equal(f.button('Dismiss').type,'button');
 await f.act(async()=>f.button('Retry').click());assert.equal(f.calls.retry,1);assert.equal(f.calls.dismiss,0);
 await f.act(async()=>f.button('Dismiss').click());assert.equal(f.calls.retry,1);assert.equal(f.calls.dismiss,1);
 assert.equal(f.calls.submit,undefined);
});
test('long unbroken messages remain intact',async t=>{
 const text='Long/path/'.repeat(100);const f=await fixture(t,true,true,text);
 assert.ok(f.notice.textContent.includes(text));
});
test('urgent tones are alerts, calm tones are status; caller identity is kept',async t=>{
 for(const [tone,role] of [['danger','alert'],['warning','alert'],['info','status'],['success','status']]){
  const f=await fixture(t,false,false,'Message',tone);assert.equal(f.notice.getAttribute('role'),role,tone);
  assert.ok(f.notice.classList.contains('fixture-extra'));assert.equal(f.notice.querySelector('svg').getAttribute('aria-hidden'),'true');
 }
});
