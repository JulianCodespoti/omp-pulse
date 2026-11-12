import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {CloseOnLaptopDialog} from ${JSON.stringify(resolve(root,'web/src/app/CloseOnLaptopDialog.tsx'))};
import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
const calls=[],closed=[],dismissed=[];
DaemonApi.prototype.closeOnLaptop=(...args)=>new Promise((resolve,reject)=>calls.push({args,resolve,reject}));
window.fixture={act,calls,closed,dismissed,mount(){const r=createRoot(document.getElementById('root'));const render=(open=true,sessionPath='/synthetic/a',title='Synthetic session')=>r.render(h(CloseOnLaptopDialog,{open,sessionPath,title,project:'Synthetic',onOpenChange:v=>dismissed.push(v),onClosed:()=>closed.push(true)}));render();return{render,unmount:()=>r.unmount()}}};
`);
async function fixture(t){const dom=createDomFixture(code),w=dom.window,{act,calls,closed,dismissed}=w.fixture;let r,unmounted=false;await act(async()=>{r=w.fixture.mount()});const unmount=async()=>{if(!unmounted){unmounted=true;await act(async()=>r.unmount())}};t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});const confirm=()=>[...w.document.querySelectorAll('button')].find(b=>['Close on computer','Closing…'].includes(b.textContent));return{w,act,calls,closed,dismissed,confirm,unmount,render:(...a)=>act(async()=>r.render(...a)),click:()=>act(async()=>confirm().click()),finish:(i,result={ok:true})=>act(async()=>calls[i].resolve(result))};}
test('same-turn confirmation taps issue one close request',async t=>{const f=await fixture(t);await f.act(async()=>{f.confirm().click();f.confirm().click()});assert.equal(f.calls.length,1)});
test('a late close acknowledgement cannot dismiss another session',async t=>{const f=await fixture(t);await f.click();await f.render(true,'/synthetic/b');await f.finish(0);assert.equal(f.closed.length,0);assert.equal(f.dismissed.length,0)});
test('parent close and reopen ignores old completion for same path',async t=>{const f=await fixture(t);await f.click();await f.render(false);await f.render(true);await f.finish(0);assert.equal(f.closed.length,0);assert.equal(f.dismissed.length,0)});
test('unmounted close cannot invoke parent callbacks',async t=>{const f=await fixture(t);await f.click();await f.unmount();await f.finish(0);assert.equal(f.closed.length,0);assert.equal(f.dismissed.length,0)});
test('a newer visit owns its pending state after an old result',async t=>{const f=await fixture(t);await f.click();await f.render(true,'/synthetic/b');assert.equal(f.confirm().disabled,false);await f.click();await f.finish(0);assert.equal(f.confirm().disabled,true);assert.equal(f.closed.length,0);await f.finish(1);assert.equal(f.closed.length,1)});
test('an old close failure cannot appear in another dialog',async t=>{const f=await fixture(t);await f.click();await f.render(true,'/synthetic/b');await f.act(async()=>f.calls[0].reject(new Error('Old close failure')));assert.equal(f.w.document.body.textContent.includes('Old close failure'),false)});
test('current daemon refusal remains visible and retryable',async t=>{const f=await fixture(t);await f.click();await f.finish(0,{ok:false,error:'Session is running'});assert.ok(f.w.document.body.textContent.includes('Session is running'));assert.equal(f.closed.length,0);await f.click();assert.equal(f.calls.length,2);await f.finish(1);assert.equal(f.closed.length,1);assert.deepEqual(Array.from(f.dismissed),[false])});
test('harmless title refresh preserves the confirmed request',async t=>{const f=await fixture(t);await f.click();await f.render(true,'/synthetic/a','Updated title');await f.finish(0);assert.equal(f.closed.length,1)});
test('Escape cannot dismiss an already-confirmed pending close',async t=>{const f=await fixture(t);await f.click();await f.act(async()=>f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(f.dismissed.length,0);await f.finish(0);assert.equal(f.closed.length,1)});
test('current transport failure remains visible and requires explicit retry',async t=>{const f=await fixture(t);await f.click();await f.act(async()=>f.calls[0].reject(new Error('Transport failed')));assert.ok(f.w.document.body.textContent.includes('Transport failed'));assert.equal(f.calls.length,1);assert.equal(f.closed.length,0);assert.equal(f.confirm().disabled,false);await f.click();assert.equal(f.calls.length,2)});
test('same-turn Cancel cannot withdraw an already-confirmed request',async t=>{const f=await fixture(t);await f.act(async()=>{f.confirm().click();[...f.w.document.querySelectorAll('button')].find(b=>b.textContent==='Cancel').click()});assert.equal(f.dismissed.length,0);await f.finish(0);assert.equal(f.closed.length,1)});
