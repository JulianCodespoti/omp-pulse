import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {ModelPicker} from ${JSON.stringify(resolve(root,'web/src/app/sessions/ModelPicker.tsx'))};
 import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
 const calls=[];window.fixture={act,calls,mount:(efforts,owned=false)=>{
 const model={provider:'fixture-provider',id:'project-reasoner',name:'Project Reasoner Extended With A Long Name',contextWindow:200000,reasoning:efforts.length>0,thinking:{efforts,defaultLevel:'high'}};
 DaemonApi.prototype.getAvailableModels=async()=>[model];DaemonApi.prototype.getRecentModels=async()=>[];
 DaemonApi.prototype.getState=async()=>{if(owned)throw {code:'session_owned_by_terminal'};return {}};
 DaemonApi.prototype.setThinkingLevel=async(...args)=>calls.push(args);
 const r=createRoot(document.getElementById('root'));r.render(h(ModelPicker,{open:true,onOpenChange(){},sessionPath:'/synthetic/model',sessionModelHint:{provider:model.provider,model:model.id,thinkingLevel:'high',fastMode:false}}));return r;
 }};
`);
async function fixture(t,efforts=['minimal','low','medium','high','xhigh','max'],owned=false){
 const dom=createDomFixture(code),w=dom.window,{act,calls}=w.fixture;let mounted;await act(async()=>{mounted=w.fixture.mount(efforts,owned)});
 t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 return {w,act,calls,levels:()=>Array.from(w.document.querySelectorAll('[data-testid="model-thinking"] [data-value]'))};
}
test('long model name keeps its full identity in the row',async t=>{
 const f=await fixture(t),name=f.w.document.querySelector('[data-testid="model-name"]'),row=f.w.document.querySelector('[data-testid="model-item"]');
 assert.equal(name.textContent,'Project Reasoner Extended With A Long Name');assert.equal(row.dataset.model,'fixture-provider/project-reasoner');
 assert.ok(row.getAttribute('aria-label').includes('fixture-provider/project-reasoner'));
});
test('the selected level is checked and choosing another sends the exact mutation',async t=>{
 const f=await fixture(t),high=f.levels().find(b=>b.dataset.value==='high');assert.equal(high.getAttribute('aria-checked'),'true');
 const low=f.levels().find(b=>b.dataset.value==='low');await f.act(async()=>low.click());assert.deepEqual(Array.from(f.calls[0]),['/synthetic/model','low']);assert.equal(low.getAttribute('aria-checked'),'true');
});
test('Auto is selectable without inventing unsupported fixed efforts',async t=>{
 const f=await fixture(t,['low','high']);
 assert.equal(f.levels().some(b=>b.dataset.value==='xhigh'),false);
 const automatic=f.levels().find(b=>b.dataset.value==='auto');
 assert.ok(automatic);
 await f.act(async()=>automatic.click());
 assert.equal(automatic.getAttribute('aria-checked'),'true');
 assert.equal(f.levels().find(b=>b.dataset.value==='high').getAttribute('aria-checked'),'false');
 assert.equal(f.calls[0][1],'auto');
});
test('a non-reasoning model does not offer thinking controls',async t=>{
 const f=await fixture(t,[]);assert.equal(f.levels().length,0);
});
test('a session open on the computer keeps every effort control disabled',async t=>{
 const f=await fixture(t,['low','high'],true);assert.ok(f.levels().every(b=>b.disabled));await f.act(async()=>f.levels()[0].click());assert.equal(f.calls.length,0);
});
