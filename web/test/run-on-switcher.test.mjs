import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {RunOnSwitcher} from ${JSON.stringify(resolve(root,'web/src/app/RunOnSwitcher.tsx'))};
window.fixture={act,mount(){const r=createRoot(document.getElementById('root'));r.render(h(RunOnSwitcher));return{unmount:()=>r.unmount()}}};
`);
const STUDIO='https://studio.example-tailnet.ts.net/app/',DESK='https://desk.example-tailnet.ts.net/app/';
async function fixture(t,state){
  const dom=createDomFixture(code),w=dom.window,{act}=w.fixture,calls=[];
  if(state)w.OmpLocal={state:()=>JSON.stringify({phase:'ready',progress:-1,downloadBytes:0,...state}),setMode:m=>calls.push(['setMode',m]),
    useComputer:u=>{calls.push(['useComputer',u]);return '{"ok":true}'}};
  let mounted;await act(async()=>{mounted=w.fixture.mount()});
  t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  const q=s=>w.document.querySelector(s),all=s=>[...w.document.querySelectorAll(s)];
  return{act,calls,q,all};
}

test('hidden in a browser and with only one place to run',async t=>{
  assert.equal((await fixture(t,null)).q('[data-testid="run-on-switcher"]'),null);
  const one=await fixture(t,{mode:'laptop',supported:true,installed:false,laptopUrl:STUDIO,computers:[STUDIO]});
  assert.equal(one.q('[data-testid="run-on-switcher"]'),null);
});

test('names where it runs and switches to the phone or another computer',async t=>{
  const f=await fixture(t,{mode:'laptop',supported:true,installed:true,laptopUrl:STUDIO,computers:[STUDIO,DESK]});
  assert.equal(f.q('[data-testid="run-on-switcher"]').textContent,'studio');
  await f.act(async()=>f.q('[data-testid="run-on-switcher"]').click());
  const options=()=>f.all('[data-testid="run-on-switcher-option"]');
  assert.equal(options().length,3);
  await f.act(async()=>options().find(o=>o.textContent.includes('studio')).click());
  assert.deepEqual(f.calls,[],'the one in use does nothing');
  await f.act(async()=>options().find(o=>o.textContent.includes('desk')).click());
  assert.deepEqual(f.calls,[['useComputer',DESK]]);
});

test('from the phone, a computer is one tap away',async t=>{
  const f=await fixture(t,{mode:'phone',supported:true,installed:true,laptopUrl:STUDIO,computers:[STUDIO]});
  assert.equal(f.q('[data-testid="run-on-switcher"]').textContent,'This phone');
  await f.act(async()=>f.q('[data-testid="run-on-switcher"]').click());
  await f.act(async()=>f.all('[data-testid="run-on-switcher-option"]').find(o=>o.textContent.includes('studio')).click());
  assert.deepEqual(f.calls,[['useComputer',STUDIO]]);
});
