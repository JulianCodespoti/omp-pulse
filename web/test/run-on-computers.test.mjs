import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {RunOnSettings,useLocalMode} from ${JSON.stringify(resolve(root,'web/src/app/LocalModeSettings.tsx'))};
function Page(){const local=useLocalMode(()=>{window.fixture.connects++});return local?h(RunOnSettings,{local}):null}
window.fixture={act,connects:0,mount(){const r=createRoot(document.getElementById('root'));r.render(h(Page));return{unmount:()=>r.unmount()}}};
`);
const STUDIO='https://studio.example-tailnet.ts.net/app/',DESK='https://desk.example-tailnet.ts.net/app/';
async function fixture(t,{mode='laptop',computers=[STUDIO,DESK]}={}){
  const dom=createDomFixture(code),w=dom.window,{act}=w.fixture,calls=[];
  const state={mode,supported:true,phase:'ready',laptopUrl:computers[0]??null,computers,downloadBytes:0,progress:-1};
  w.OmpLocal={state:()=>JSON.stringify(state),setMode:m=>calls.push(['setMode',m]),prepare(){},
    useComputer:u=>{calls.push(['useComputer',u]);return '{"ok":true}'},forgetComputer:u=>calls.push(['forgetComputer',u])};
  let mounted;await act(async()=>{mounted=w.fixture.mount()});
  t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  const rows=()=>[...w.document.querySelectorAll('[data-testid="computer-row"]')];
  return{w,act,calls,rows};
}

test('every saved computer is listed by name; the one in use is ticked',async t=>{
  const f=await fixture(t);
  assert.deepEqual(f.rows().map(r=>r.querySelector('[data-slot="row-body"] span span').textContent),['studio','desk']);
  assert.equal(f.rows()[0].getAttribute('aria-current'),'true');
  assert.equal(f.rows()[1].getAttribute('aria-current'),null);
});

test('tapping another computer switches to it; tapping the one in use does nothing',async t=>{
  const f=await fixture(t);
  await f.act(async()=>f.rows()[0].click());
  assert.deepEqual(f.calls,[]);
  await f.act(async()=>f.rows()[1].click());
  assert.deepEqual(f.calls,[['useComputer',DESK]]);
});

test('on the phone, the active computer is not ticked and tapping it switches to it',async t=>{
  const f=await fixture(t,{mode:'phone'});
  assert.equal(f.rows()[0].getAttribute('aria-current'),null);
  await f.act(async()=>f.rows()[0].click());
  assert.deepEqual(f.calls,[['useComputer',STUDIO]]);
});

test('a visible button asks before forgetting a computer',async t=>{
  const f=await fixture(t);
  const button=f.w.document.querySelectorAll('[data-testid="forget-computer-button"]')[1];
  assert.equal(button.getAttribute('aria-label'),'Forget desk');
  await f.act(async()=>button.click());
  assert.ok(f.w.document.body.textContent.includes('Forget desk?'));
  assert.deepEqual(f.calls,[]);
  const forget=[...f.w.document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Forget');
  await f.act(async()=>forget.click());
  assert.deepEqual(f.calls,[['forgetComputer',DESK]]);
});

test('the computer in use is ticked without the pressed fill, and the page has no expanders',async t=>{
  const f=await fixture(t);
  assert.equal(f.rows()[0].className.includes('bg-surface-3'),false);
  assert.equal(f.w.document.querySelector('details'),null);
  assert.ok(f.w.document.body.textContent.includes('omp runs on the computer ticked above.'));
});

test('adding a computer opens the connect page instead of a sheet',async t=>{
  const f=await fixture(t);
  await f.act(async()=>f.w.document.querySelector('[data-testid="add-computer"]').click());
  assert.equal(f.w.fixture.connects,1);
  assert.equal(f.w.document.querySelector('[role="dialog"]'),null);
});
