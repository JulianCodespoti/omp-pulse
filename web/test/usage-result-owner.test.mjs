import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h, act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {ChatScreen} from ${JSON.stringify(resolve(root, 'web/src/app/ChatScreen.tsx'))};
import {GlobalPalette} from ${JSON.stringify(resolve(root, 'web/src/app/commands/GlobalPalette.tsx'))};
import {createOmpStore} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {DaemonApi} from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
const store = createOmpStore();
store.setState({sessionPath:'/synthetic/usage', connection:'open'});
const calls = [], stats = [];
let owned = false;
DaemonApi.prototype.rpc = async (...args) => {stats.push(args); if (owned && args[1] === "get_session_stats") throw Object.assign(new Error("Synthetic ownership"),{code:"session_owned_by_terminal"}); return {totalTokens:123};};
DaemonApi.prototype.runCommand = (...args) => new Promise((resolve,reject) => calls.push({args,resolve,reject}));
// The track strip reads the working tree; this chat is not in a repository.
DaemonApi.prototype.getChangesSummary = async () => ({cwd:'/synthetic',repoRoot:null,branch:null,notRepo:true,files:[],totals:{files:0,additions:0,deletions:0},truncated:false});
// ChatScreen fetches its own listing row when the controller's list lacks it.
DaemonApi.prototype.sessionRow = async () => null;
const controller = {getReceiptScope:()=>"", getStore:()=>store, loadCommands:async()=>[{name:'usage',source:'builtin'},{name:'context',source:'builtin'}],
canRetainCollabAnswer:()=>false,
setAtBottom(){}, loadSessions:async()=>{}, startSessionsPolling(){}, stopSessionsPolling(){}, prewarm(){}};
// The palette is App's (it runs the chat's commands through the slash source).
window.fixture = {act,calls,stats,store,setOwned:()=>{owned=true},mount(){const r=createRoot(document.getElementById('root'));r.render(h('div',null,h(ChatScreen,{controller,onBack(){}}),h(GlobalPalette,{store,inChat:true,onOpenSession(){}})));return r;}};
`, [{name:'test-import-meta',options(options){return {...options,transform:{...options.transform,define:{...options.transform?.define,'import.meta':'{}'}}}}}]);

async function fixture(t) {
  const dom = createDomFixture(code), w = dom.window, {act,calls,stats} = w.fixture;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.Element.prototype.getAnimations = () => [];
  let mounted;
  await act(async () => {mounted=w.fixture.mount()});
  stats.length = 0;
  t.after(async () => {try {await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])} finally {dom.close()}});
  const click = selector => act(async()=>{const el=w.document.querySelector(selector);assert.ok(el, selector);el.click()});
  const text = () => w.document.body.textContent;
  return {w,act,calls,stats,text,click,
    async open(name="usage"){
      await click('button[aria-label="More actions"]');
      await click('[data-testid="composer-commands"]');
      await act(async()=>{const row=[...w.document.querySelectorAll('[data-testid="command-row"]')].find(e=>e.querySelector('[data-testid="command-name"]')?.textContent.replace(/^\//,'').toLowerCase()===name);assert.equal(!!row,true);row.click()});
    },
    // The palette can still be in its exit transition; close the sheet that is open.
    close:()=>click('[role="dialog"][data-open] button[aria-label="Close"]'),
    finish:(i,output)=>act(async()=>calls[i].resolve({output,agentInvoked:false})),
    fail:(i,message)=>act(async()=>calls[i].reject(new Error(message))),
  };
}

test('old provider limits cannot replace a reopened Usage result',async t=>{
  const f=await fixture(t);await f.open();assert.equal(f.calls.length,1);
  await f.close();await f.open();assert.equal(f.calls.length,2);
  await f.finish(1,'Fresh provider limits');assert.ok(f.text().includes('Fresh provider limits'));
  await f.finish(0,'Old provider limits');assert.ok(f.text().includes('Fresh provider limits'));assert.ok(!f.text().includes('Old provider limits'));
});
test('old provider error cannot replace a reopened Usage result',async t=>{
  const f=await fixture(t);await f.open();await f.close();await f.open();
  await f.finish(1,'Fresh provider limits');await f.fail(0,'Old provider failure');
  assert.ok(f.text().includes('Fresh provider limits'));assert.ok(!f.text().includes('Old provider failure'));
});

test('an older completion leaves the new visit loading until its own result arrives',async t=>{
  const f=await fixture(t);await f.open();await f.close();await f.open();
  await f.finish(0,'Old provider limits');assert.ok(f.text().includes('Checking provider limits'));
  assert.ok(!f.text().includes('Old provider limits'));
  await f.fail(1,'Current provider failure');assert.ok(f.text().includes('Current provider failure'));
  assert.ok(!f.text().includes('Checking provider limits'));assert.equal(f.calls.length,2);
});
test('a current provider report still renders parsed quotas and dispatches once',async t=>{
  const f=await fixture(t);await f.open();
  assert.ok(f.text().includes('Checking provider limits'));
  await f.finish(0,'Synthetic Provider\n- Five hour\n  fixture: 24% used (76% left)\n  [bar] 24%\n  resets in 2h');
  const bar=f.w.document.querySelector('[data-testid="usage-limit"]');assert.equal(bar?.getAttribute('aria-label'),'Synthetic Provider Five hour: 24% used');
  assert.equal(bar?.getAttribute('aria-valuenow'),'24');assert.ok(f.text().includes('Resets in 2h'));
  assert.deepEqual(Array.from(f.calls[0].args),['/synthetic/usage','/usage']);
  assert.equal(f.stats.length,1);assert.equal(f.stats[0][1],'get_session_stats');assert.equal(f.calls.length,1);
});
test('a dismissed Usage sheet stays closed after the provider request completes',async t=>{
  const f=await fixture(t);await f.open();await f.close();await f.finish(0,'Dismissed limits');
  assert.ok(!f.text().includes('Dismissed limits'));
  // Exit-animation DOM can remain after dismissal; a late result must not reopen it.
  assert.equal(f.w.document.querySelector('[role="dialog"][data-open]') === null, true);
});
test('a different command result cannot receive old Usage limits',async t=>{
  const f=await fixture(t);await f.open();await f.close();await f.open('context');
  // /context prints omp's own breakdown (calls[1]); the old /usage reply must not land on it.
  assert.equal(f.calls.length,2);assert.deepEqual(Array.from(f.calls[1].args),['/synthetic/usage','/context']);
  await f.finish(0,'Old usage limits');assert.ok(!f.text().includes('Old usage limits'));
  await f.finish(1,'Context window: 200000 tokens (7% used)\n  Messages         [░░░░] 1%  1473 tokens\n  Free             [███░] 78%  156174 tokens');
  assert.ok(f.text().includes('Context'));assert.ok(f.text().includes('156,174'));assert.ok(!f.text().includes('Old usage limits'));
  assert.equal(f.w.document.querySelector('[aria-label="Context usage 7 percent"]')?.getAttribute('aria-valuenow'),'7');
});

test('derived Usage fallback has the same request ownership after reopen',async t=>{
  const f=await fixture(t);f.w.fixture.setOwned();await f.open();await f.close();await f.open();
  await f.finish(1,'Fresh derived limits');await f.fail(0,'Old derived failure');
  assert.ok(f.text().includes('Fresh derived limits'));assert.ok(!f.text().includes('Old derived failure'));
  assert.equal(f.calls.length,2);
});
