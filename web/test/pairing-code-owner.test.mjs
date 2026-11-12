import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {PairAnotherDevice} from ${JSON.stringify(resolve(root,'web/src/app/DeviceAccess.tsx'))};
import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
const requests=[];
DaemonApi.prototype.fetchJson=(path,init)=>new Promise((resolve,reject)=>requests.push({body:JSON.parse(init.body),resolve,reject}));
window.fixture={act,requests,mount(){const r=createRoot(document.getElementById('root'));r.render(h(PairAnotherDevice));return r}};
`);
async function fixture(t){
  const dom=createDomFixture(code),w=dom.window,{act,requests}=w.fixture;
  let r;await act(async()=>{r=w.fixture.mount()});
  t.after(async()=>{try{await act(async()=>r.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  const roles=()=>[...w.document.querySelectorAll('[role=radio]')];
  const role=label=>roles().find(node=>node.textContent===label);
  const submit=()=>w.document.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
  return {w,act,requests,role,roles,submit,
    choose:label=>act(async()=>role(label).click()),
    finish:i=>act(async()=>requests[i].resolve({code:'a'.repeat(64),expiresAt:Date.now()+300000})),
    status:()=>w.document.querySelector('[role=status]')?.textContent};
}
test('issued code keeps submitted permissions when role changes race creation',async t=>{
  const f=await fixture(t);
  await f.choose('Admin');
  // Same-turn events exercise the guard before React commits disabled controls.
  await f.act(async()=>{f.submit();f.role('Read only').click();f.submit()});
  assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].body.role,'admin');
  assert.equal(f.role('Admin').getAttribute('aria-checked'),'true');
  assert.equal(f.roles().every(node=>node.disabled),true);
  await f.finish(0);
  assert.equal(f.status().startsWith('Admin ·'),true);
  assert.equal(f.status().includes('Read only'),false);
});
test('failed creation releases access selection and retry issues the newly chosen role',async t=>{
  const f=await fixture(t);
  await f.choose('Admin');await f.act(async()=>f.submit());
  await f.act(async()=>f.requests[0].reject(new Error('Synthetic offline failure')));
  assert.equal(f.roles().some(node=>node.disabled),false);
  await f.choose('Read only');await f.act(async()=>f.submit());
  assert.equal(f.requests[1].body.role,'read');
  await f.finish(1);
  assert.equal(f.status().startsWith('Read only ·'),true);
});
