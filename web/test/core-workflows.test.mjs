import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';

const require=createRequire(resolve(root,'web/package.json'));
const src=path=>JSON.stringify(resolve(root,'web/src',path));
const code=await bundleDomFixture(`
import {createElement as h,Fragment,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {ChatScreen} from ${src('app/ChatScreen.tsx')};
import {GlobalPalette} from ${src('app/commands/GlobalPalette.tsx')};
import {closePalette} from ${src('app/commands/palette.ts')};
import {QueuedMessage} from ${src('app/parts/QueuedMessage.tsx')};
import {createOmpStore,selectBackgroundWork} from ${src('runtime/omp-store.ts')};
import {OmpSessionController} from ${src('runtime/omp-session-controller.ts')};
import {DaemonApi} from ${src('runtime/rpc-client.ts')};
import {seedDraft,readDraft,flushAllDraftWrites} from ${src('app/composer/use-draft.ts')};
DaemonApi.prototype.rpc=async()=>({});
DaemonApi.prototype.getPromptConfig=async()=>({magicKeywords:[]});
DaemonApi.prototype.getChangesSummary=async()=>({notRepo:true,files:[],totals:{files:0,additions:0,deletions:0}});
DaemonApi.prototype.sessionRow=async()=>null;
const path='/synthetic/core-workflow',store=createOmpStore();
const controller=new OmpSessionController(store,'synthetic-token');
controller.activeSession=path;
controller.getReceiptScope=()=>'';
controller.loadCommands=async()=>[{name:'usage',source:'builtin',description:'Usage'}];
controller.loadSessions=async()=>{};
controller.startSessionsPolling=()=>{};
controller.stopSessionsPolling=()=>{};
controller.prewarm=()=>{};
store.getState().beginSession(path);store.setState({connection:'open',isOpening:false});
window.fixture={act,path,store,controller,selectBackgroundWork,seedDraft,readDraft,flushAllDraftWrites,closePalette,
 mount(){const r=createRoot(document.getElementById('root'));r.render(h(Fragment,null,h(ChatScreen,{controller,onBack(){}}),h(GlobalPalette,{store,inChat:true,onOpenSession(){}})));return r;},
 status(props){const r=createRoot(document.getElementById('root'));const render=p=>r.render(h(QueuedMessage,p));render(props);return{render,unmount:()=>r.unmount()};}};
`);
async function fixture(t,{draft='',status}={}){
 const dom=createDomFixture(code),w=dom.window,f=w.fixture;
 // The controller asks the link once at boot (runtime/link-state.ts); answer it so the probe is not a blocked network call.
 Object.assign(w,{Headers,Response,Request,TextEncoder,TextDecoder,fetch:async()=>new Response('{}',{status:200,headers:{'content-type':'application/json'}})});
 w.Element.prototype.getAnimations=()=>[];w.HTMLElement.prototype.scrollIntoView=()=>{};
 if(draft)f.seedDraft(f.path,draft);
 let mounted;await f.act(async()=>{mounted=status?f.status(status):f.mount()});
 t.after(async()=>{try{await f.act(async()=>mounted.unmount());f.controller.dispose();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 return{w,f,mounted,act:f.act,q:id=>w.document.querySelector('[data-testid="'+id+'"]'),
 click:el=>f.act(async()=>{assert.equal(!!el,true);el.click()})};
}

test('browsing and dismissing Commands preserves the editor and persisted draft',async t=>{
 const c=await fixture(t,{draft:'Keep my unfinished explanation'});
 const input=()=>c.w.document.querySelector('[data-testid="composer-input"]');
 await c.click(c.q('composer-plus-btn'));
 await c.click(c.q('composer-commands'));
 assert.equal(input().value,'Keep my unfinished explanation');
 assert.equal(c.w.document.querySelector('[role="dialog"]')!==null,true);
 await c.act(async()=>c.f.closePalette());
 await c.act(async()=>c.f.flushAllDraftWrites());
 assert.equal(input().value,'Keep my unfinished explanation');
 assert.equal(c.f.readDraft(c.f.path),'Keep my unfinished explanation');
});

const authority=(revision,backgroundWork)=>({daemonInstanceId:'core-test',revision,bindingEpoch:1,owner:{kind:'child'},turn:'idle',confidence:'confirmed',connection:'connected',observedAt:Date.now(),activity:null,capabilities:{send:true,read:true},...(backgroundWork===undefined?{}:{backgroundWork})});
test('background work stays separate from turn activity and unknown connectivity',async t=>{
 const c=await fixture(t,{draft:'I can still send'});
 const update=record=>c.act(async()=>c.f.store.getState().reconcileSessionState(c.f.path,{sessionState:record},record.revision));
 await update(authority(1,true));
 assert.equal(c.q('background-work')?.dataset.state,'pending');
 assert.equal(c.f.store.getState().agentWorking,false);
 assert.equal(c.q('composer-send-btn').disabled,false);
 await c.act(async()=>c.f.store.setState({connection:'reconnecting'}));
 assert.equal(c.q('background-work')?.dataset.state,'unconfirmed');
 await c.act(async()=>c.f.store.setState({connection:'open'}));
 await update(authority(2,false));
 assert.equal(c.q('background-work')===null,true);
 await update(authority(1,true));
 assert.equal(c.q('background-work')===null,true);
 await update(authority(3,undefined));
 assert.equal(c.f.selectBackgroundWork(c.f.store.getState()),null);
});

const message=(id,parentId,timestamp,text)=>({id,parentId,timestamp,type:'message',message:{role:'user',content:[{type:'text',text}]}});
test('a metadata-only clear boundary repaints and survives rebuilding history without deleting messages',async t=>{
 const c=await fixture(t);
 const first=message('before',null,1000,'Saved older message');
 const boundary={id:'clear',parentId:'before',type:'reset_boundary',timestamp:2000};
 await c.act(async()=>c.f.controller.mergeHistory([first]));
 assert.equal(c.w.document.querySelectorAll('[data-testid="transcript-marker"]').length,0);
 await c.act(async()=>c.f.controller.mergeHistory([boundary]));
 assert.equal(c.w.document.querySelectorAll('[data-testid="transcript-marker"]').length,1);
 assert.deepEqual(Array.from(c.f.store.getState().messages,m=>m.id),['before']);
 await c.act(async()=>c.f.controller.mergeHistory([boundary]));
 assert.equal(c.w.document.querySelectorAll('[data-testid="transcript-marker"]').length,1);
 await c.act(async()=>c.f.controller.mergeHistory([message('after','clear',3000,'New context message')]));
 const rows=[...c.w.document.querySelectorAll('[data-entry-id], [data-testid="transcript-marker"]')];
 assert.deepEqual(rows.map(r=>r.dataset.entryId??r.dataset.testid),['before','transcript-marker','after']);
 assert.deepEqual(Array.from(c.f.store.getState().messages,m=>m.id),['before','after']);
 const reopened=await fixture(t);
 await reopened.act(async()=>reopened.f.controller.mergeHistory([first,boundary,message('after','clear',3000,'New context message')]));
 assert.equal(reopened.w.document.querySelectorAll('[data-testid="transcript-marker"]').length,1);
 assert.deepEqual(Array.from(reopened.f.store.getState().messages,m=>m.id),['before','after']);
});

test('removing an unconfirmed bubble requires consent and stale consent cannot target another message',async t=>{
 let removed=0,checked=0;
 const entry={id:'uncertain',commandId:'uncertain',state:'uncertain',createdAt:1,updatedAt:2};
 const c=await fixture(t,{status:{entry,onCancel:()=>removed++,onRetry:()=>checked++}});
 await c.click(c.w.document.querySelector('[aria-label="Check"]'));
 assert.equal(checked,1);
 await c.click(c.w.document.querySelector('[aria-label="Remove"]'));
 assert.equal(removed,0);
 assert.equal(c.w.document.querySelector('[role="dialog"]')!==null,true);
 await c.act(async()=>c.mounted.render({entry:{...entry,commandId:'new',id:'new',state:'saved',updatedAt:3},onCancel:()=>removed+=10,onRetry:()=>{}}));
 assert.equal(removed,0);
 await c.act(async()=>c.q('confirm-sheet-confirm')?.click());
 assert.equal(removed,0);
});

test('pending abandoned-tail receipts defer to completed active metadata without repinning a later live choice',async t=>{
 const c=await fixture(t),at=Date.now();
 const abandoned={from:'provider/old',to:'provider/abandoned',role:'default',reason:'Abandoned fallback'};
 c.f.controller.request=async()=>({data:{source:'file',sessionModelPending:true,thinkingLevel:'high',modelFallback:abandoned}});
 await c.act(async()=>c.f.controller.seedQueuedMessages(c.f.controller.generation,c.f.path));
 const entries=[
  {id:'abandoned-config',parentId:'unloaded-parent',timestamp:at-2,type:'thinking_level_change',configured:'high',thinkingLevel:'high'},
  {id:'abandoned-fallback',parentId:'abandoned-config',timestamp:at-1,type:'custom',customType:'omp-pulse-model-fallback',data:abandoned},
  message('recent','abandoned-fallback',at,'Abandoned branch reply'),
  {id:'late-usage',parentId:'recent',timestamp:at+1,type:'model_usage',activeLeafId:'active-outside-page'},
 ];
 await c.act(async()=>c.f.controller.applyTailPage({entries,sessionModelPending:true,nextBefore:123}));
 assert.equal(c.f.store.getState().sessionModel?.thinkingLevel,undefined);
 assert.equal(c.f.store.getState().sessionModel?.effectiveThinkingLevel,undefined);
 assert.equal(c.f.store.getState().sessionModel?.modelFallback,undefined);
 await c.act(async()=>c.f.controller.applyTailPage({entries,sessionModelPending:false,sessionModel:{configuredThinkingLevel:'auto',thinkingLevel:'high',thinkingAt:at-10000,modelFallback:null},nextBefore:123}));
 assert.equal(c.f.store.getState().sessionModel.thinkingLevel,'auto');
 assert.equal(c.f.store.getState().sessionModel.effectiveThinkingLevel,'high');
 assert.equal(c.f.store.getState().sessionModel.modelFallback,null);
 await c.act(async()=>c.f.controller.handleEventFrame({type:'event',event:{type:'config_update',thinkingLevel:'low'}},c.f.controller.generation,c.f.path));
 assert.equal(c.f.store.getState().sessionModel.thinkingLevel,'auto');
 assert.equal(c.f.store.getState().sessionModel.effectiveThinkingLevel,'low');
 const liveFallback={from:'provider/current',to:'provider/live',role:'default',entryId:'live-fallback',at:at+10};
 c.f.controller.request=async()=>({});
 await c.act(async()=>{
  c.f.controller.handleEventFrame({type:'event',event:{type:'thinking_level_changed',thinkingLevel:'low'}},c.f.controller.generation,c.f.path);
  c.f.controller.handleEventFrame({type:'event',event:{type:'retry_fallback_applied',...liveFallback}},c.f.controller.generation,c.f.path);
 });
 await c.act(async()=>c.f.controller.adoptSessionConfiguration({configuredThinkingLevel:'auto',thinkingLevel:'high',thinkingAt:at-10000,modelFallback:null}));
 assert.equal(c.f.store.getState().sessionModel.thinkingLevel,'low');
 assert.equal(c.f.store.getState().sessionModel.effectiveThinkingLevel,'low');
 assert.equal(c.f.store.getState().sessionModel.modelFallback.entryId,'live-fallback');
});

test('offline file-only Auto catches up to desktop High and fallback after the owner exits',async t=>{
 const c=await fixture(t),at=Date.now();
 c.f.controller.request=async()=>({data:{source:'file',sessionModelPending:false,configuredThinkingLevel:'auto',thinkingLevel:'low',modelFallback:null}});
 await c.act(async()=>c.f.controller.seedQueuedMessages(c.f.controller.generation,c.f.path));
 assert.equal(c.f.store.getState().sessionModel.thinkingLevel,'auto');
 assert.equal(c.f.store.getState().sessionModel.modelFallback,null);
 const fallback={from:'provider/primary',to:'provider/recovery',role:'default',reason:'Desktop provider failed',entryId:'desktop-fallback',at};
 await c.act(async()=>c.f.store.setState({connection:'reconnecting',endOffset:123}));
 c.f.controller.fetchHistory=async(_path,options)=>{
  assert.equal(options.after,123);
  return {entries:[
   {id:'desktop-high',parentId:null,type:'thinking_level_change',timestamp:at-1,configured:'high',thinkingLevel:'high'},
   {id:fallback.entryId,parentId:'desktop-high',type:'custom',customType:'omp-pulse-model-fallback',timestamp:at,data:fallback},
  ],sessionModelPending:false,sessionModel:{configuredThinkingLevel:'high',thinkingLevel:'high',thinkingAt:at-1,modelFallback:fallback},endOffset:456};
 };
 await c.act(async()=>c.f.controller.catchUp('poll'));
 assert.equal(c.f.store.getState().sessionModel.thinkingLevel,'high');
 assert.equal(c.f.store.getState().sessionModel.effectiveThinkingLevel,'high');
 assert.equal(c.f.store.getState().sessionModel.modelFallback.entryId,'desktop-fallback');
 assert.equal(c.f.store.getState().sessionModel.modelFallback.reason,fallback.reason);
 // File-only peeks use the same provenance contract, including known null.
 c.f.controller.request=async()=>({data:{source:'file',sessionModelPending:false,configuredThinkingLevel:'high',thinkingLevel:'high',modelFallback:null}});
 await c.act(async()=>c.f.controller.seedQueuedMessages(c.f.controller.generation,c.f.path));
 assert.equal(c.f.store.getState().sessionModel.thinkingLevel,'high');
 assert.equal(c.f.store.getState().sessionModel.modelFallback,null);
 assert.equal(c.f.store.getState().sessionModelProvenance.thinkingLevel,'file');
 assert.equal(c.f.store.getState().sessionModelProvenance.modelFallback,'file');
});

for(const releaseViaListing of [false,true]) test(`authoritative owner-scan release retires live Auto ${releaseViaListing?'before':'during'} completed desktop High catchup`,async t=>{
 const c=await fixture(t),at=Date.now();
 const owner=authority(10,false);
 await c.act(async()=>c.f.store.getState().reconcileSessionState(c.f.path,{sessionState:owner},10));
 const oldFallback={from:'provider/old',to:'provider/old-recovery',role:'default',entryId:'old-fallback',at:at-100};
 c.f.controller.request=async()=>({data:{configuredThinkingLevel:'auto',thinkingLevel:'low',modelFallback:oldFallback}});
 await c.act(async()=>c.f.controller.seedQueuedMessages(c.f.controller.generation,c.f.path));
 assert.equal(c.f.store.getState().sessionModelProvenance.thinkingLevel,'live');
 assert.equal(c.f.store.getState().sessionModelProvenance.modelFallback,'live');
 await c.act(async()=>c.f.store.setState({connection:'reconnecting',endOffset:123}));
 const released={...owner,revision:12,bindingEpoch:3,owner:{kind:'none'},confidence:'inferred',connection:'connected',capabilities:{read:true}};
 const fallback={from:'provider/desktop',to:'provider/desktop-recovery',role:'default',entryId:'desktop-receipt',at};
 if(releaseViaListing){
  await c.act(async()=>c.f.controller.reconcileSessionState(c.f.path,{sessionState:released},11));
  assert.equal(c.f.controller.configurationPending,true,'a release without a fold rearms metadata catchup');
 }
 c.f.controller.request=async url=>{
  assert.equal(url.startsWith('/api/history?'),true);
  return {entries:[],sessionState:released,sessionModelPending:false,sessionModel:{configuredThinkingLevel:'high',thinkingLevel:'high',modelFallback:fallback},endOffset:456};
 };
 await c.act(async()=>c.f.controller.catchUp('poll'));
 assert.equal(c.f.store.getState().sessionAuthorities[c.f.path].owner.kind,'none');
 assert.equal(c.f.controller.configurationPending,false);
 assert.equal(c.f.store.getState().sessionModel.thinkingLevel,'high');
 assert.equal(c.f.store.getState().sessionModel.effectiveThinkingLevel,'high');
 assert.equal(c.f.store.getState().sessionModel.modelFallback.entryId,'desktop-receipt');
 assert.equal(c.f.store.getState().sessionModelProvenance.thinkingLevel,'file');
 assert.equal(c.f.store.getState().sessionModelAuthority,null);
});

test('native fallback handoff becomes one durable explanation and survives cold reopen',async t=>{
 const c=await fixture(t),at=Date.now();
 const fallback={from:'provider/original',to:'provider/recovery',role:'default',reason:'Provider refused this request.'};
 c.f.controller.request=async()=>({data:{modelFallback:{...fallback,entryId:'fallback',at}}});
 await c.act(async()=>c.f.controller.handleEventFrame({type:'event',event:{type:'retry_fallback_applied',...fallback}},c.f.controller.generation,c.f.path));
 assert.equal(c.w.document.querySelectorAll('[data-testid="transcript-marker"]').length,1);
 await c.click(c.q('marker-detail-toggle'));
 assert.equal(c.q('marker-detail').textContent.includes(fallback.reason),true);
 const durable={id:'fallback',parentId:null,type:'custom',customType:'omp-pulse-model-fallback',timestamp:at,data:fallback};
 await c.act(async()=>c.f.controller.mergeHistory([durable,message('next','fallback',at+1,'Recovered response')]));
 assert.equal(c.w.document.querySelectorAll('[data-testid="transcript-marker"]').length,1);
 const reopened=await fixture(t);
 await reopened.act(async()=>reopened.f.controller.applyTailPage({entries:[message('later',null,at+60000,'A much later message')],sessionModel:{modelFallback:{...fallback,entryId:'fallback',at}},nextBefore:123}));
 assert.equal(reopened.w.document.querySelectorAll('[data-testid="transcript-marker"]').length,1);
 assert.equal(reopened.f.store.getState().sessionModel.modelFallback.reason,fallback.reason);
});
