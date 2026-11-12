import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {CollabConnectSheet} from ${JSON.stringify(resolve(root,'web/src/app/chat/CollabConnectSheet.tsx'))};
import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
const calls=[],closed=[];DaemonApi.prototype.collabAttach=(...args)=>new Promise((resolve,reject)=>calls.push({args,resolve,reject}));
window.fixture={act,calls,closed,mount(){const r=createRoot(document.getElementById('root'));const render=(open=true,sessionPath='/synthetic')=>r.render(h(CollabConnectSheet,{open,sessionPath,onOpenChange:v=>closed.push(v)}));render();return{render,unmount:()=>r.unmount()}}};
`);
const ASK='Ask your computer to share',ASKING='Asking your computer…';
async function fixture(t,previous=''){
 const dom=createDomFixture(code),w=dom.window,{act,calls,closed}=w.fixture;let root,unmounted=false;
 if(previous)w.localStorage.setItem('omp-collab-last-link',previous);
 await act(async()=>{root=w.fixture.mount()});const unmount=async()=>{if(!unmounted){unmounted=true;await act(async()=>root.unmount())}};
 t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 // A Row's accessible text includes its subtitle; match its title too.
 const button=text=>[...w.document.querySelectorAll('button')].find(b=>b.textContent.trim()===text||b.getAttribute('aria-label')===text||b.querySelector('[data-slot="row-body"] > span > span')?.textContent===text);
 return{w,act,calls,closed,button,unmount,render:(open,path)=>act(async()=>root.render(open,path)),click:text=>act(async()=>{assert.ok(button(text),text);button(text).click()}),type:text=>act(async()=>{const input=w.document.getElementById('collab-link');Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(input,text);input.dispatchEvent(new w.Event('input',{bubbles:true}))}),finish:index=>act(async()=>calls[index].resolve())};
}
test('repeated Ask taps issue one request',async t=>{const f=await fixture(t);await f.act(async()=>{f.button(ASK).click();f.button(ASK).click()});assert.equal(f.calls.length,1)});
test('paste success after close/reopen cannot save a link or close the new view',async t=>{const f=await fixture(t);await f.type('synthetic-link');await f.click('Connect');await f.render(false);await f.render(true);await f.finish(0);assert.equal(f.w.localStorage.getItem('omp-collab-last-link') === null, true);assert.equal(f.closed.length,0)});
test('session switch ignores an old failure and releases the new view',async t=>{const f=await fixture(t);await f.click(ASK);await f.render(true,'/other');await f.act(async()=>f.calls[0].reject(new Error('old failure')));assert.equal(f.w.document.body.textContent.includes('old failure'),false);assert.ok(f.button(ASK));assert.equal(f.button(ASK).disabled,false)});
test('old finally cannot enable controls while the newer request is pending',async t=>{const f=await fixture(t);await f.click(ASK);await f.render(false);await f.render(true);await f.click(ASK);assert.equal(f.calls.length,2);await f.finish(0);assert.equal(f.button(ASKING)?.disabled,true)});
test('current failure stays visible and supports retry',async t=>{const f=await fixture(t);await f.click(ASK);await f.act(async()=>f.calls[0].reject(new Error('Current failure')));assert.ok(f.w.document.body.textContent.includes('Current failure'));await f.click(ASK);assert.equal(f.calls.length,2)});
test('current paste success remembers its exact link and closes once',async t=>{const f=await fixture(t);await f.type('synthetic-link');await f.click('Connect');await f.finish(0);assert.equal(f.w.localStorage.getItem('omp-collab-last-link'),'synthetic-link');assert.deepEqual(Array.from(f.closed),[false])});
for(const transition of ['reopen','session'])test(`a stale Ask acknowledgement cannot close the view after ${transition}`,async t=>{const f=await fixture(t);await f.click(ASK);if(transition==='reopen'){await f.render(false);await f.render(true)}else await f.render(true,'/other');await f.finish(0);assert.equal(f.closed.length,0)});
test('Reconnect reuses the remembered link and closes on success',async t=>{const f=await fixture(t,'synthetic-previous');await f.click('Reconnect');assert.deepEqual(Array.from(f.calls[0].args),['/synthetic','synthetic-previous']);await f.finish(0);assert.deepEqual(Array.from(f.closed),[false])});
test('unmount ignores a pending success',async t=>{const f=await fixture(t);await f.click(ASK);await f.unmount();await f.finish(0);assert.equal(f.closed.length,0)});
test('a Close intent invalidates the request before controlled props catch up',async t=>{const f=await fixture(t);await f.type('synthetic-link');await f.click('Connect');await f.click('Close');await f.finish(0);assert.deepEqual(Array.from(f.closed),[false]);assert.equal(f.w.localStorage.getItem('omp-collab-last-link') === null, true)});
