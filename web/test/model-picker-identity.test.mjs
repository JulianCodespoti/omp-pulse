import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
  import {createElement,act} from ${JSON.stringify(require.resolve('react'))};
  import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
  import {ModelPicker} from ${JSON.stringify(resolve(root,'web/src/app/sessions/ModelPicker.tsx'))};
  import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
  const models=[
    {provider:'provider-a',id:'claude-sonnet-20260101',name:'Sonnet'},
    {provider:'provider-a',id:'claude-sonnet-20260601',name:'Sonnet'},
    {provider:'provider-b',id:'claude-sonnet-other',name:'Sonnet',reasoning:true,thinking:{efforts:['low','high'],defaultLevel:'high'}},
    {provider:'opencode-go',id:'muse-spark-1.3-contributor',name:'Muse Spark 1.3'}
  ];
  const calls={catalogue:0,selected:[],changed:[],draft:[],levels:[]};
  let state={};
  DaemonApi.prototype.getAvailableModels=async()=>{calls.catalogue++;return models};
  DaemonApi.prototype.getState=async()=>state;
  DaemonApi.prototype.getRecentModels=async()=>['provider-a/claude-sonnet-20260101'];
  DaemonApi.prototype.setModel=async(...args)=>{calls.selected.push(args)};
  DaemonApi.prototype.setThinkingLevel=async(...args)=>{calls.levels.push(args)};
  window.fixture={act,calls,models,
    mount:()=>{
      const r=createRoot(document.getElementById('root'));
      r.render(createElement(ModelPicker,{open:true,onOpenChange(){},sessionPath:'/synthetic/session',
        sessionModelHint:{provider:'opencode-go',model:'muse-spark-1.3-contributor',fastMode:false},
        onChanged:key=>calls.changed.push(key)}));return r;
    },
    mountAuto:()=>{
      state={model:models[2],thinkingLevel:'high'};
      const r=createRoot(document.getElementById('root'));
      r.render(createElement(ModelPicker,{open:true,onOpenChange(){},sessionPath:'/synthetic/session',
        sessionModelHint:{provider:'provider-b',model:'claude-sonnet-other',thinkingLevel:'auto',effectiveThinkingLevel:'low',
          modelFallback:{from:'provider-a/original',to:'provider-b/claude-sonnet-other',role:'default',reason:'Request failed: 529 overloaded'}}}));
      return r;
    },
    mountDraft:()=>{
      const r=createRoot(document.getElementById('root'));
      const render=value=>r.render(createElement(ModelPicker,{open:true,onOpenChange(){},draft:{
        catalogue:{models,recent:['provider-a/claude-sonnet-20260101'],loading:false,error:null},
        value,onChange:choice=>{calls.draft.push(choice);render(choice)}}}));
      render(null);return r;
    },
  };
`,[{name:'sheet-shell',resolveId:(id,importer)=>importer?.endsWith('/ModelPicker.tsx')&&id==='../ui/Sheet'?'\0sheet':null,
load:id=>id==='\0sheet'?`import {createElement as h} from ${JSON.stringify(require.resolve('react'))};
export * from ${JSON.stringify(resolve(root,'web/src/app/ui/Sheet.tsx'))};
export const BottomSheet=({open,subHeader,children,footer})=>open?h('section',{},subHeader,children,footer):null;`:null}]);

async function fixture(t,mode='mount'){
  const dom=createDomFixture(code),w=dom.window,{act,calls}=w.fixture;
  w.localStorage.setItem('omp-remote-token','synthetic-fixture');
  let mounted;await act(async()=>{mounted=w.fixture[mode]()});
  t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  const rows=()=>Array.from(w.document.querySelectorAll('[data-testid="model-item"]'));
  const input=()=>w.document.querySelector('[data-testid="model-search"]');
  return {w,act,calls,rows,input,row:key=>rows().find(r=>r.dataset.model===key),
    clear:()=>w.document.querySelector('button[aria-label="Clear search"]'),
    groups:()=>Array.from(w.document.querySelectorAll('[data-slot="row-group"] > h2'),h=>h.textContent),
    type:value=>act(async()=>{Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(input(),value);input().dispatchEvent(new w.Event('input',{bubbles:true}))})};
}

test('mixed groups name the provider; provider groups say it once in the title',async t=>{
  const f=await fixture(t);
  const label={'opencode-go':'OpenCode Go','provider-a':'Provider A','provider-b':'Provider B'};
  for(const row of f.rows()){
    const grouped=row.closest('[data-testid^="model-group-provider:"]')!==null;
    assert.equal(row.querySelector('[data-testid="model-provider"]')?.textContent,grouped?undefined:label[row.dataset.model.split('/')[0]]);
  }
  assert.equal(f.w.document.body.textContent.includes('Fast and capable'),false);
});

test('ambiguous versions show exact ids while unique provider rows stay compact',async t=>{
  const f=await fixture(t);
  for(const id of ['claude-sonnet-20260101','claude-sonnet-20260601']){
    assert.equal(f.row('provider-a/'+id).querySelector('[data-testid="model-exact-id"]')?.textContent,id);
  }
  assert.equal(Boolean(f.row('provider-b/claude-sonnet-other').querySelector('[data-testid="model-exact-id"]')),false);
  assert.equal(Boolean(f.row('opencode-go/muse-spark-1.3-contributor').querySelector('[data-testid="model-exact-id"]')),false);
});

test('current, then recent, then providers alphabetically; each model once',async t=>{
  const f=await fixture(t);
  assert.deepEqual(f.groups(),['Current','Recent','Provider A','Provider B']);
  assert.equal(f.rows()[0].dataset.model,'opencode-go/muse-spark-1.3-contributor');
  assert.equal(f.rows()[1].dataset.model,'provider-a/claude-sonnet-20260101');
  assert.equal(f.rows().length,4);
  assert.equal(f.w.document.querySelectorAll('[data-current="true"]').length,1);
  assert.equal(f.rows()[0].getAttribute('aria-pressed'),'true');
});

test('searching one version keeps its identity label rather than collapsing it away',async t=>{
  const f=await fixture(t);await f.type('20260601');assert.equal(f.rows().length,1);
  assert.equal(f.rows()[0].querySelector('[data-testid="model-exact-id"]')?.textContent,'claude-sonnet-20260601');
  assert.deepEqual(f.groups(),['Provider A']);
});

test('clear search restores the catalogue and focus without selecting or refetching',async t=>{
  const f=await fixture(t);await f.type('provider-b');assert.equal(f.rows().length,1);
  const clear=f.clear();assert.ok(clear);
  assert.equal(clear.classList.contains('size-11'),true);
  await f.act(async()=>clear.click());assert.equal(f.rows().length,4);assert.equal(f.input().value,'');
  assert.equal(f.w.document.activeElement === f.input(), true);assert.equal(f.calls.selected.length,0);assert.equal(f.calls.catalogue,1);
});

test('empty search results stay recoverable through the same clear action',async t=>{
  const f=await fixture(t);await f.type('no-such-fixture');assert.equal(f.rows().length,0);
  assert.ok(f.w.document.body.textContent.includes('No matching models'));
  await f.act(async()=>f.clear().click());assert.equal(f.rows().length,4);
});

test('choosing a duplicate name sends the exact provider and id',async t=>{
  const f=await fixture(t);await f.act(async()=>f.row('provider-b/claude-sonnet-other').click());
  assert.deepEqual(Array.from(f.calls.selected[0]),['/synthetic/session','provider-b','claude-sonnet-other']);
  assert.equal(f.calls.changed[0],'provider-b/claude-sonnet-other');
  assert.equal(f.row('provider-b/claude-sonnet-other').getAttribute('aria-pressed'),'true');
});

test('accessible row names retain the full model identity',async t=>{
  const f=await fixture(t);
  for(const row of f.rows()) assert.ok(row.getAttribute('aria-label')?.includes(row.dataset.model));
  assert.equal(Boolean(f.clear()),false);
});

test('an unsaved selection returns the choice and applies nothing',async t=>{
  const f=await fixture(t,'mountDraft');
  assert.equal(f.w.document.querySelectorAll('[data-current="true"]').length,0);
  await f.act(async()=>f.row('provider-b/claude-sonnet-other').click());
  const choice=f.calls.draft.at(-1);
  assert.equal(choice.model.id,'claude-sonnet-other');assert.equal(choice.thinkingLevel,'high');
  assert.equal(f.calls.selected.length,0);assert.equal(f.calls.catalogue,0);
  assert.equal(f.row('provider-b/claude-sonnet-other').dataset.current,'true');
  await f.act(async()=>f.w.document.querySelector('[data-testid="model-thinking"] [data-value="low"]').click());
  assert.equal(f.calls.draft.at(-1).thinkingLevel,'low');assert.equal(f.calls.draft.at(-1).model.id,'claude-sonnet-other');
});

test('reopening a model picker keeps Auto selected while showing the latest concrete effort',async t=>{
  const f=await fixture(t,'mountAuto');
  const auto=f.w.document.querySelector('[data-testid="model-thinking"] [data-value="auto"]');
  assert.ok(auto);
  assert.equal(auto.getAttribute('aria-checked'),'true');
  assert.ok(f.w.document.querySelector('[data-testid="model-auto-effort"]')?.textContent.includes('current effort: High'));
  assert.equal(f.calls.levels.length,0,'opening never writes an effort');
  const fallback=f.w.document.querySelector('[data-testid="model-fallback"]')?.textContent;
  assert.ok(fallback.includes('provider-a/original'));
  assert.ok(fallback.includes('provider-b/claude-sonnet-other'));
  assert.ok(fallback.includes('Request failed: 529 overloaded'));
});

test('an unsaved Auto choice survives switching models with a fixed default',async t=>{
  const f=await fixture(t,'mountDraft');
  await f.act(async()=>f.row('provider-b/claude-sonnet-other').click());
  await f.act(async()=>f.w.document.querySelector('[data-testid="model-thinking"] [data-value="auto"]').click());
  assert.equal(f.calls.draft.at(-1).thinkingLevel,'auto');
  await f.act(async()=>f.row('provider-a/claude-sonnet-20260101').click());
  await f.act(async()=>f.row('provider-b/claude-sonnet-other').click());
  assert.equal(f.calls.draft.at(-1).thinkingLevel,'auto');
  assert.equal(f.w.document.querySelector('[data-testid="model-thinking"] [data-value="auto"]')?.getAttribute('aria-checked'),'true');
});
