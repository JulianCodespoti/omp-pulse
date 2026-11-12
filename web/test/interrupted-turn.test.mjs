import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';

const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {InterruptedBanner} from ${JSON.stringify(resolve(root,'web/src/app/chat/InterruptedBanner.tsx'))};
 import {sessionInterruption,markInterruptionHandled} from ${JSON.stringify(resolve(root,'web/src/app/session-format.ts'))};
 const calls={continue:0,dismiss:0};
 window.fixture={act,calls,fmt:{sessionInterruption,markInterruptionHandled},mount:(interruption,canSend)=>{
  const r=createRoot(document.getElementById('root'));
  r.render(h(InterruptedBanner,{interruption,canSend,onContinue:()=>{calls.continue++},onDismiss:()=>{calls.dismiss++}}));return r;
 }};
`);

const cut=(cause='restart')=>({startedAt:1000,detectedAt:2000,cause});
async function fixture(t,interruption=cut(),canSend=true){
 const dom=createDomFixture(code),w=dom.window,{act,calls}=w.fixture;let mounted;
 await act(async()=>{mounted=w.fixture.mount(interruption,canSend)});
 t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const el=id=>w.document.querySelector(`[data-testid="${id}"]`);
 return {w,act,calls,el};
}

test('the banner says what happened, calmly, and sends nothing on its own',async t=>{
 const f=await fixture(t);
 assert.equal(f.el('interrupted-banner').textContent.includes('The app closed while the agent was working.'),true);
 assert.equal(f.el('interrupted-continue').textContent,'Continue');
 assert.equal(f.calls.continue,0);assert.equal(f.calls.dismiss,0);
});

test('Continue and dismiss act only on tap',async t=>{
 const f=await fixture(t);
 await f.act(async()=>f.el('interrupted-continue').click());
 assert.equal(f.calls.continue,1);assert.equal(f.calls.dismiss,0);
 await f.act(async()=>f.el('interrupted-dismiss').click());
 assert.equal(f.calls.dismiss,1);
 assert.equal(f.el('interrupted-dismiss').getAttribute('aria-label'),'Dismiss');
});

test('a dead agent reads differently, and a device that cannot send gets no Continue',async t=>{
 const f=await fixture(t,cut('exited'),false);
 assert.equal(f.el('interrupted-banner').textContent.includes('The agent stopped while it was working.'),true);
 assert.equal(f.el('interrupted-continue')===null,true);
 assert.equal(f.el('interrupted-dismiss')===null,false);
});

test('the notice hides while a turn runs and once the user acted on it',async t=>{
 const f=await fixture(t);const {sessionInterruption,markInterruptionHandled}=f.w.fixture.fmt;
 const row={path:'/synthetic/a.jsonl',interrupted:cut(),running:false};
 assert.equal(sessionInterruption(row)?.detectedAt,2000);
 assert.equal(sessionInterruption({...row,running:true}),null);
 assert.equal(sessionInterruption({path:'/synthetic/b.jsonl'}),null);
 assert.equal(sessionInterruption({...row,interrupted:{cause:'restart'}}),null);
 markInterruptionHandled(row.path,cut());
 assert.equal(sessionInterruption(row),null);
 // A later cut-off of the same chat shows again.
 assert.equal(sessionInterruption({...row,interrupted:{...cut(),detectedAt:3000}})?.detectedAt,3000);
});

// The real chat, with a fake controller: the banner comes from the listing
// row, Continue sends exactly "Continue" to that chat, dismiss posts nothing
// to the agent.
const chatCode=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {ChatScreen} from ${JSON.stringify(resolve(root,'web/src/app/ChatScreen.tsx'))};
 import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
 import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
 DaemonApi.prototype.rpc=async()=>({});
 // The chat header's +a −r count reads the workspace changes summary.
 DaemonApi.prototype.getChangesSummary=async()=>({notRepo:true,totals:{files:0,added:0,removed:0},files:[]});
 const store=createOmpStore();
 const path='/synthetic/cut.jsonl';
 const calls={sent:[],dismissed:[]};
 const controller={getReceiptScope:()=>'',getStore:()=>store,loadCommands:async()=>[],setAtBottom(){},loadSessions:async()=>{},
  canRetainCollabAnswer:()=>false,
  startSessionsPolling(){},stopSessionsPolling(){},prewarm(){},
  sendPrompt:async(text,images,target)=>{calls.sent.push([text,target]);return {state:'forwarded'}},
  dismissInterruption:async(target)=>{calls.dismissed.push(target)}};
 window.fixture={act,calls,mount:(running)=>{
  store.setState({sessionPath:path,connection:'open',sessions:[{path,title:'Cut',cwd:'/synthetic',running,
   interrupted:{startedAt:1000,detectedAt:Date.now(),cause:'restart'}}]});
  const r=createRoot(document.getElementById('root'));r.render(h(ChatScreen,{controller,onBack(){}}));return r;
 }};
`,[{name:'test-import-meta',options(options){return {...options,transform:{...options.transform,define:{...options.transform?.define,'import.meta':'{}'}}}}}]);

async function chat(t,running=false){
 const dom=createDomFixture(chatCode),w=dom.window,{act,calls}=w.fixture;
 w.HTMLElement.prototype.scrollIntoView=()=>{};w.Element.prototype.getAnimations=()=>[];
 let mounted;await act(async()=>{mounted=w.fixture.mount(running)});
 t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const el=id=>w.document.querySelector(`[data-testid="${id}"]`);
 return {act,calls,el};
}

test('the chat offers Continue for a cut-off turn and sends it only on tap',async t=>{
 const f=await chat(t);
 assert.equal(f.el('interrupted-banner')===null,false);
 assert.equal(f.calls.sent.length,0);
 await f.act(async()=>f.el('interrupted-continue').click());
 assert.equal(JSON.stringify(f.calls.sent),JSON.stringify([['Continue','/synthetic/cut.jsonl']]));
 assert.equal(f.el('interrupted-banner')===null,true);
});

test('dismissing forgets the notice without sending anything',async t=>{
 const f=await chat(t);
 await f.act(async()=>f.el('interrupted-dismiss').click());
 assert.deepEqual(Array.from(f.calls.dismissed),['/synthetic/cut.jsonl']);
 assert.equal(f.calls.sent.length,0);
 assert.equal(f.el('interrupted-banner')===null,true);
});

test('no banner while a turn is running',async t=>{
 const f=await chat(t,true);
 assert.equal(f.el('interrupted-banner')===null,true);
});
