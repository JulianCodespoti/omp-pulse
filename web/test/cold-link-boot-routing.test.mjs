import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setImmediate as settleTask } from 'node:timers/promises';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
import { memoryIndexedDb } from './support/memory-indexeddb.mjs';
import { pluginHostStub } from './support/plugin-host-stub.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const TARGET = '/synthetic/boot scope/会話 α & # +.jsonl';
const OTHER = '/synthetic/next conversation B.jsonl';
const plain=value=>JSON.parse(JSON.stringify(value));

// Actual App, screens, controller and store. These wrappers only observe original
// method invocations; none changes arguments, receiver, return value or behavior.
const code = await bundleDomFixture(`
import {createElement as h, act, StrictMode} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {App} from ${JSON.stringify(resolve(root, 'web/src/app/App.tsx'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
import * as queue from ${JSON.stringify(resolve(root, 'web/src/runtime/offline-queue.ts'))};
import {recoverDraft} from ${JSON.stringify(resolve(root, 'web/src/app/composer/use-draft.ts'))};
import {handleNativeBack} from ${JSON.stringify(resolve(root, 'web/src/platform/native-back.ts'))};
import {registerServiceWorker} from ${JSON.stringify(resolve(root, 'web/src/platform/service-worker.ts'))};
import {openSettingsPage,closeSettings,openSwitcher,openNewSession} from ${JSON.stringify(resolve(root,'web/src/app/nav/panels.ts'))};
import {clearPairingToken} from ${JSON.stringify(resolve(root,'web/src/platform/browser-storage.ts'))};
const controllers=[], calls=[];
for (const method of ['bindVisibility','loadSessions','startSessionsPolling','stopSessionsPolling','openSession','dispose']) {
  const original=OmpSessionController.prototype[method];
  OmpSessionController.prototype[method]=function(...args) {
    if(!controllers.includes(this))controllers.push(this);
    calls.push({method,controller:controllers.indexOf(this),args,stack:new Error('observe '+method).stack});
    return Reflect.apply(original,this,args);
  };
}
window.fixture={act,controllers,calls,queue,recoverDraft,openSettingsPage,closeSettings,openSwitcher,openNewSession,clearPairingToken,nativeBack:handleNativeBack,registerServiceWorker,namespace:queue.offlineQueueNamespaceForCredential('synthetic-token'),mount(strict){
  const root=createRoot(document.getElementById('root'));
  root.render(strict?h(StrictMode,null,h(App)):h(App));
  return {unmount(){root.unmount()}};
}};
`, [pluginHostStub, {
  name: 'cold-link-import-meta-environment',
  resolveId(id, importer) {
    if(importer?.endsWith('/App.tsx') && id==='./chat-chunk')return '\0controlled-chat-chunk';
  },
  load(id) {
    if(id==='\0controlled-chat-chunk')return `
      import * as actual from ${JSON.stringify(resolve(root,'web/src/app/chat-chunk.ts'))};
      export const preloadChat=actual.preloadChat;
      export function importChatScreen(){
        if(!window.holdChatChunk)return actual.importChatScreen();
        return new Promise((resolve,reject)=>{window.releaseChatChunk=()=>actual.importChatScreen().then(resolve,reject)});
      }`;
  },
  transform(source, id) {
    if (id.endsWith('/omp-session-controller.ts') || id.endsWith('/service-worker.ts') || id.endsWith('/SettingsScreen.tsx')) {
      return source.replaceAll('import.meta', JSON.stringify({env:{VITE_PROTOCOL_VERSION:3,VITE_RELEASE_ID:'synthetic-cold-link'}}));
    }
  },
}]);

async function runColdBoot(strict, options={}) {
  const dom=createDomFixture(code), w=dom.window, f=w.fixture;
  const sockets=[], events=[], requests=[], unexpected=[], historyPushes=[], tokenAttempts=[], nativeCalls=[], deferredFetches=[], swHandlers=[];
  const timers=new Map(), intervals=new Map(), frames=new Map(); let nextId=-1;
  const realSetTimeout=w.setTimeout.bind(w), realClearTimeout=w.clearTimeout.bind(w);
  const zeroTimers=new Set();
  const memory=options.memory??memoryIndexedDb();
  let mounted, unmounted=false, cleaned=false;
  const record=(kind,detail={})=>events.push({seq:events.length+1,kind,...detail});
  const deny=(kind)=>{unexpected.push(kind);throw Error('Unexpected synthetic boundary: '+kind)};
  const act=async(fn)=>f.act(async()=>{await fn?.();await settleTask();});
  // Observe only the actual App boot callback at its scheduling boundary.
  // The original microtask queue and callback execution order are unchanged.
  const realQueueMicrotask=w.queueMicrotask.bind(w);
  w.queueMicrotask=callback=>{
    const source=String(callback);
    if(!source.includes('deepLinkHandledRef'))return realQueueMicrotask(callback);
    const queued=record('eligible-boot-callback-queued',{source,stack:new Error('observe boot queue').stack});
    return realQueueMicrotask(()=>{record('eligible-boot-callback-invoked');callback()});
  };

  Object.assign(w,{Headers,Response,Request,TextEncoder,TextDecoder,indexedDB:memory.indexedDB,IDBKeyRange:{bound:(lower,upper,lowerOpen=false,upperOpen=false)=>({lower,upper,lowerOpen,upperOpen})}});
  w.Element.prototype.getAnimations=()=>[];
  w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.HTMLElement.prototype.scrollTo=()=>{};
  if(options.token!==false)w.localStorage.setItem('omp-remote-token',options.credential??'synthetic-token');
  w.holdChatChunk=!!options.holdChatChunk;
  if(options.serviceWorker){
    Object.defineProperty(w,'isSecureContext',{value:true,configurable:true});
    Object.defineProperty(w.navigator,'serviceWorker',{value:{register:async()=>({update:async()=>{}}),addEventListener(type,fn){if(type==='message')swHandlers.push(fn)}},configurable:true});
  }
  w.history.replaceState(null,'',options.hash??('#s='+encodeURIComponent(TARGET)));
  if(options.native){
    w.OmpNative={senderRequired:()=>true};
    w.OmpOutbox={postMessage(raw){
      const msg=JSON.parse(raw);nativeCalls.push({op:msg.op,namespace:msg.namespace});
      if(!['list','get','images'].includes(msg.op))return deny('native '+msg.op);
      w.queueMicrotask(()=>w.OmpOutbox.onmessage?.({data:JSON.stringify({id:msg.id,ok:true,value:msg.op==='get'?null:[]})}));
    },onmessage:null};
    w.Capacitor={Plugins:{OmpNotify:{setToken:({token})=>new Promise((resolve,reject)=>tokenAttempts.push({token,resolve,reject})),clearToken:async()=>{nativeCalls.push({op:'clearToken'});return {ok:true}},clearNotifications:async()=>({ok:true})}}};
  }
  const push=w.history.pushState;
  w.history.pushState=function(...args){historyPushes.push({state:args[0],url:String(args[2])});return Reflect.apply(push,this,args)};

  // Keep React's MessageChannel's zero-delay scheduler usable, but do not tick
  // poll/liveness/history deadlines or layout clocks during the boot observation.
  // This is a synthetic clock boundary, not a changed production deadline.
  w.setTimeout=(callback,delay=0,...args)=>{
    if(Number(delay)===0){let id;id=realSetTimeout(()=>{zeroTimers.delete(id);callback(...args)},0);zeroTimers.add(id);return id}
    const id=nextId--;timers.set(id,{callback,delay:Number(delay),args});return id;
  };
  w.clearTimeout=id=>{if(!timers.delete(id)){zeroTimers.delete(id);realClearTimeout(id)}};
  w.setInterval=(callback,delay,...args)=>{const id=nextId--;intervals.set(id,{callback,delay,args});return id};
  w.clearInterval=id=>intervals.delete(id);
  w.requestAnimationFrame=callback=>{const id=nextId--;frames.set(id,callback);return id};
  w.cancelAnimationFrame=id=>frames.delete(id);

  class SyntheticWebSocket {
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
    constructor(rawUrl){
      if(sockets.length>=8)return deny('socket constructor budget');
      const url=new URL(String(rawUrl));
      if(url.hostname!=='synthetic.invalid'||!['/ws','/ws/sessions'].includes(url.pathname))return deny('socket URL '+url.pathname);
      this.url=String(rawUrl);this.id=sockets.length;this.path=url.pathname;this.session=url.searchParams.get('session');
      this.readyState=0;this.binaryType='blob';this.closeCalls=[];sockets.push(this);
      record('socket-constructed',{id:this.id,path:this.path,session:this.session,readyState:this.readyState,stack:new Error('WebSocket constructor').stack});
    }
    serverOpen(){if(this.readyState!==0)throw Error('Only a connecting socket can open');this.readyState=1;record('server-open',{id:this.id});this.onopen?.({type:'open',target:this})}
    message(frame){record('server-message',{id:this.id,type:frame.type});this.onmessage?.({data:JSON.stringify(frame),target:this})}
    send(data){record('socket-send',{id:this.id,bytes:String(data).length});return deny('unexpected client socket send')}
    close(){
      if(this.readyState===2||this.readyState===3)return;
      const readyState=this.readyState;
      this.closeCalls.push({readyState,stack:new Error('WebSocket close').stack});
      record('socket-close-called',{id:this.id,path:this.path,readyState});
      this.readyState=2;
      // Record native-like asynchronous error/close ordering without pretending
      // this adapter proves Chromium's console or CDP behavior.
      w.queueMicrotask(()=>{
        if(readyState===0){record('synthetic-pre-open-close-error',{id:this.id});this.onerror?.({type:'error',target:this})}
        this.readyState=3;record('socket-close-delivered',{id:this.id});this.onclose?.({type:'close',target:this,code:1006,wasClean:false});
      });
    }
  }
  w.WebSocket=SyntheticWebSocket;
  w.XMLHttpRequest=class{constructor(){deny('XMLHttpRequest')}};
  w.navigator.sendBeacon=()=>deny('sendBeacon');
  w.fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input?.url??String(input),w.location.origin),method=String(init.method??'GET').toUpperCase();
    const row={path:url.pathname,query:url.search,method};requests.push(row);
    if(requests.length>64)return deny('HTTP request budget');
    if(url.origin!==w.location.origin)return deny('fetch origin');
    if(init.signal?.aborted)throw init.signal.reason;
    let body;
    if(method==='GET'&&url.pathname==='/api/sessions')body={sessions:options.listing??[],nextCursor:null,total:0};
    else if(method==='GET'&&url.pathname==='/api/version')body={releaseId:'synthetic-cold-link',protocolVersion:3,minClientProtocolVersion:3};
    else if(method==='GET'&&url.pathname==='/api/awaiting')body={sessions:[]};
    // The new-chat home lists folders for its project picker and reads the model catalogue for its chip.
    else if(method==='GET'&&url.pathname==='/api/browse')body={ok:true,path:'/synthetic',parent:null,dirs:[]};
    else if(method==='GET'&&url.pathname==='/api/model-usage')body={ok:true,usage:[]};
    else if(method==='GET'&&url.pathname==='/api/agents')body={agents:[]};
    else if(method==='GET'&&url.pathname==='/api/agents/roster')body={agents:[]};
    else if(method==='GET'&&url.pathname==='/api/history')body={entries:[],endOffset:0,nextBefore:null,running:false};
    // Settings › Model providers reads this device's role (only an admin may add a
    // provider) and the provider list. Both are read-only; sign-in itself stays denied.
    else if(method==='GET'&&url.pathname==='/api/device')body={device:{id:'synthetic-phone',role:'admin'}};
    else if(method==='GET'&&url.pathname==='/api/providers')body={providers:[]};
    // A sign-in already running on the computer is picked back up; reading it starts nothing.
    else if(method==='GET'&&url.pathname==='/api/providers/login')body={running:false,exitCode:null,output:''};
    // TrackStrip reads change counts for the chat on screen. Allowed only for a
    // known session, with a paired token, while a chat is actually mounted.
    else if(method==='GET'&&url.pathname==='/api/changes'){
      const auth=new w.Headers(init.headers).get('Authorization');
      if(![TARGET,OTHER].includes(url.searchParams.get('session')))return deny('changes for unknown session');
      if(!auth||!/^Bearer \S/.test(auth))return deny('changes without a paired token');
      if(!w.document.querySelector('[data-screen="chat"]'))return deny('changes with no chat on screen');
      body={ok:true,files:[],notRepo:false};
    }
    else if(method==='GET'&&url.pathname.startsWith('/api/receipts/'))return new Response(JSON.stringify({error:'not found'}),{status:404,headers:{'Content-Type':'application/json'}});
    else if(method==='POST'&&url.pathname==='/api/pair'&&(options.token===false||options.allowPair))body={token:options.pairToken??'synthetic-token'};
    else if(method==='POST'&&url.pathname==='/api/rpc'){
      const payload=JSON.parse(init.body);row.command=payload.command;
      if(payload.command==='get_available_models')body={ok:true,data:{models:[]}};
      else if(!['get_available_commands','get_state','get_prompt_config','get_queue_recovery'].includes(payload.command)||![TARGET,OTHER].includes(payload.sessionPath))return deny('RPC '+payload.command);
      else body=payload.command==='get_queue_recovery'?{ok:true,data:{recoveries:[]}}:payload.command==='get_available_commands'?{data:{commands:[]}}:payload.command==='get_prompt_config'?{data:{magicKeywords:[]}}:{data:{isStreaming:false}};
    } else return deny(method+' '+url.pathname);
    if(options.holdPaths?.includes(url.pathname))return new Promise((resolve,reject)=>{const held={path:url.pathname,resolve:(status=200)=>resolve(new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}})),reject};deferredFetches.push(held);init.signal?.addEventListener('abort',()=>reject(init.signal.reason),{once:true})});
    return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
  };

  const cleanup=async()=>{
    if(cleaned)return;
    cleaned=true;
    if(mounted&&!unmounted){await act(()=>mounted.unmount());unmounted=true}
    const afterAppUnmount={activeSockets:sockets.filter(s=>s.readyState<2).length,timers:timers.size,intervals:intervals.size,frames:frames.size};
    // StrictMode may construct an abandoned useMemo value: explicitly dispose
    // every observed real instance during fixture cleanup, recording that sweep.
    const sweep=[];
    await act(()=>{for(const controller of f.controllers){sweep.push(f.controllers.indexOf(controller));controller.dispose()}});
    await settleTask();
    const afterControllerSweep={activeSockets:sockets.filter(s=>s.readyState<2).length,timers:timers.size,intervals:intervals.size,frames:frames.size};
    for(const id of zeroTimers)realClearTimeout(id);
    zeroTimers.clear();timers.clear();intervals.clear();frames.clear();
    const result={unmounted,afterAppUnmount,controllerSweep:sweep,afterControllerSweep,remainingFixtureTimers:0,domBlocked:[...dom.blocked]};
    dom.close();return result;
  };

  const controls={w,f,sockets,events,requests,unexpected,historyPushes,tokenAttempts,nativeCalls,deferredFetches,timers,intervals,memory,act,
    async settle(){for(let i=0;i<4;i++)await act()},
    controller(){return f.controllers.find(c=>!c.disposed)??f.controllers[0]},
    hash(path){w.history.replaceState(null,'','#s='+encodeURIComponent(path));w.dispatchEvent(new w.HashChangeEvent('hashchange'))},
    notify(path){for(const fn of swHandlers)fn({data:{type:'omp-open',sessionPath:path,kind:'message'}})},
    pop(){w.dispatchEvent(new w.PopStateEvent('popstate',{state:null}))},
    unmountSync(){if(!unmounted){mounted.unmount();unmounted=true}},
    counts(){return {list:sockets.filter(s=>s.path==='/ws/sessions').length,chat:sockets.filter(s=>s.path==='/ws').length,opens:f.calls.filter(c=>c.method==='openSession').map(c=>c.args[0]),pushes:historyPushes.length}},
  };
  try {
    await options.prepare?.(controls);
    if(options.beforeBoot){
      f.act(()=>{mounted=f.mount(strict)});
      f.act(()=>options.beforeBoot(controls));
      await act();
    }else await act(()=>{mounted=f.mount(strict)});
    for(let i=0;i<4;i++)await act();
    const scenario=await options.scenario?.(controls);
    await controls.settle();
    const list=sockets.filter(s=>s.path==='/ws/sessions'), chat=sockets.filter(s=>s.path==='/ws');
    const opens=f.calls.filter(c=>c.method==='openSession');
    const current=controls.controller();
    const beforeCleanup={
      strict,target:TARGET,scenario,fixtureConditions:{answerOpen:false,laptopAsk:false,bridge:false},
      listConstructors:list.length,chatConstructors:chat.length,openSessionInvocations:opens.length,
      actualOpenPaths:opens.map(c=>c.args[0]),historyPushes:historyPushes.length,historyState:w.history.state,
      currentSession:current?.getStore().getState().sessionPath??null,
      currentListing:current?.getStore().getState().sessions??[],
      text:w.document.body.textContent,storedToken:w.localStorage.getItem('omp-remote-token'),nativeCalls,
      tokenAttemptCount:tokenAttempts.length,
      chatScreen:!!w.document.querySelector('[data-screen="chat"]'),
      conversationLoading:!!w.document.querySelector('[aria-label="Loading conversation"]'),
      listSocketStates:list.map(s=>({id:s.id,readyState:s.readyState,closeCalls:s.closeCalls})),
      events:[...events],calls:f.calls.map(({method,controller,args,stack})=>({method,controller,args,stack})),requests:[...requests],
      unexpected:[...unexpected],promptAttempts:requests.filter(r=>r.path==='/api/prompt').length,
      realNetworkAdmissions:0,domBlocked:[...dom.blocked],
      claim:'Synthetic App/controller lifecycle observation only; no Chromium close-caller attribution.'
    };
    const cleanedUp=await cleanup();
    return JSON.parse(JSON.stringify({...beforeCleanup,cleanup:cleanedUp,unexpectedAfterCleanup:[...unexpected]}));
  } finally {if(!cleaned)await cleanup()}
}

for(const strict of [false,true])test(`cold deep-link boot avoids transient sessions transport (StrictMode=${strict})`,{timeout:10_000},async t=>{
  const result=await runColdBoot(strict);
  t.diagnostic('COLD_LINK_FOUNDATION '+JSON.stringify(result));
  // Validate every fixture/safety prerequisite before the intentional baseline
  // RED. An infrastructure failure cannot masquerade as a reproduced defect.
  assert.deepEqual(result.unexpectedAfterCleanup,[],'no unapproved synthetic request');
  assert.deepEqual(result.domBlocked,[],'no real network boundary escaped');
  assert.deepEqual(result.cleanup.domBlocked,[],'cleanup had no network escape');
  assert.equal(result.promptAttempts,0,'zero prompt attempts');
  assert.equal(result.cleanup.afterControllerSweep.activeSockets,0,'no fixture socket survives cleanup');
  assert.equal(result.openSessionInvocations,1,'one actual boot open');
  assert.deepEqual(result.actualOpenPaths,[TARGET],'exact boot path');
  assert.equal(result.chatConstructors,1,'one actual chat socket');
  assert.equal(result.historyPushes,1,'one boot history push');
  assert.equal(result.currentSession,TARGET,'actual controller owns boot target');
  assert.deepEqual(result.currentListing,[],'no laptop/bridge listing enables legitimate chat polling');
  assert.ok(result.chatScreen||result.conversationLoading,'chat route or existing loading surface is rendered');
  assert.ok(result.listSocketStates.every(s=>s.closeCalls.some(c=>c.readyState===0)),'every observed boot list socket closed while CONNECTING');
  if(!strict&&result.listConstructors>0)assert.equal(result.listConstructors,1,'ordinary baseline has exactly one transient list socket');
  assert.equal(result.listConstructors,0,'known ordinary boot route must construct zero transient sessions-list sockets');
});

// QA D-B2: StrictMode runs App's controller.dispose() cleanup between its two
// effect setups. A chat booted from a link never starts list polling, so the
// listing must still be fetched over HTTP (no list socket) and installed, or
// the switcher, header title and palette have nothing to show.
for(const strict of [false,true])test(`cold deep-link boot loads the session listing (StrictMode=${strict})`,{timeout:10_000},async()=>{
  const row={path:TARGET,id:'boot-target',title:'Boot target',cwd:'/synthetic/boot scope',activeAt:Date.now()};
  const result=await runColdBoot(strict,{listing:[row]});
  assert.deepEqual(result.unexpectedAfterCleanup,[]);
  assert.ok(result.requests.some(r=>r.method==='GET'&&r.path==='/api/sessions'),'the listing was requested');
  assert.deepEqual(result.currentListing.map(s=>s.path),[TARGET],'the listing reached the store');
  assert.equal(result.listConstructors,0,'still no transient sessions-list socket');
});

function safety(result){
  assert.deepEqual(result.unexpectedAfterCleanup,[]);
  assert.deepEqual(result.domBlocked,[]);
  assert.equal(result.promptAttempts,0);
  assert.equal(result.cleanup.afterControllerSweep.activeSockets,0);
}
function onlyBoot(result){
  safety(result);assert.equal(result.listConstructors,0);assert.equal(result.chatConstructors,1);
  assert.deepEqual(result.actualOpenPaths,[TARGET]);assert.equal(result.historyPushes,1);
}

for(const strict of [false,true])test(`unmount before the boot microtask never opens (StrictMode=${strict})`,{timeout:10_000},async()=>{
  const result=await runColdBoot(strict,{beforeBoot:c=>c.unmountSync()});safety(result);
  assert.equal(result.listConstructors,0);assert.equal(result.chatConstructors,0);assert.equal(result.openSessionInvocations,0);assert.equal(result.historyPushes,0);
});

for(const event of ['hash','back','native-back','notification'])test(`newer ${event} before boot consumption retires the captured target`,{timeout:10_000},async()=>{
  const newTarget=event==='hash'||event==='notification';
  const result=await runColdBoot(false,{serviceWorker:event==='notification',prepare:event==='notification'?c=>c.f.registerServiceWorker():undefined,beforeBoot:c=>{
    if(event==='hash')c.hash(OTHER);else if(event==='notification')c.notify(OTHER);else if(event==='native-back')c.f.nativeBack('commit');else c.pop();
  }});safety(result);
  assert.deepEqual(result.actualOpenPaths,newTarget?[OTHER]:[]);
  assert.equal(result.historyPushes,newTarget?1:0);
  assert.equal(result.currentSession,newTarget?OTHER:null);
});

// Pushing a second chat entry left a dead one behind: after Back to the list,
// the next Back popped it and visibly did nothing.
test('warm notification tap on an open chat replaces its history entry',{timeout:10_000},async()=>{
  const result=await runColdBoot(false,{serviceWorker:true,prepare:c=>c.f.registerServiceWorker(),scenario:async c=>{
    assert.equal(c.historyPushes.length,1);assert.equal(c.w.history.state?.ompChat,true);
    await c.act(()=>c.notify(OTHER));await c.settle();
  }});safety(result);
  assert.deepEqual(result.actualOpenPaths,[TARGET,OTHER]);
  assert.equal(result.historyPushes,1,'boot push only; the tap replaced the chat entry');
  assert.equal(result.historyState.path,OTHER);assert.equal(result.historyState.ompChat,true);
  assert.equal(result.currentSession,OTHER);
});

// Home is the new-chat screen, not a list: the listing arrives over HTTP and
// nothing subscribes to the list socket until the drawer or All chats needs it.
for(const hash of ['', '#s='])test(`ordinary boot lands on home, not a list or a chat, for ${hash||'no fragment'}`,{timeout:10_000},async()=>{
  const result=await runColdBoot(false,{hash});safety(result);
  assert.equal(result.listConstructors,0);assert.equal(result.chatConstructors,0);assert.equal(result.openSessionInvocations,0);
  assert.match(result.text,/What should we work on\?/);assert.equal(result.chatScreen,false);
  assert.equal(result.requests.some(r=>r.path==='/api/sessions'),true,'the launch decision reads the listing over HTTP');
});

test('StrictMode ordinary boot keeps no list subscription', {timeout:10_000},async()=>{
  const result=await runColdBoot(true,{hash:'',scenario:c=>({liveLists:c.sockets.filter(s=>s.path==='/ws/sessions'&&s.readyState<2).length})});safety(result);
  assert.equal(result.scenario.liveLists,0);assert.equal(result.chatConstructors,0);
});

// Launch rule (domain/launch-target.ts): the most recent chat opens when it is
// fresh, running or waiting; otherwise home.
test('cold start reopens a fresh most recent chat',{timeout:10_000},async()=>{
  const result=await runColdBoot(false,{hash:'',listing:[{path:OTHER,title:'Recent',activeAt:Date.now()-60_000}]});safety(result);
  assert.deepEqual(result.actualOpenPaths,[OTHER]);assert.equal(result.currentSession,OTHER);assert.equal(result.chatScreen,true);
});

test('cold start with only a stale chat shows home',{timeout:10_000},async()=>{
  const result=await runColdBoot(false,{hash:'',listing:[{path:OTHER,title:'Old',activeAt:Date.now()-3*60*60_000}]});safety(result);
  assert.deepEqual(result.actualOpenPaths,[]);assert.equal(result.chatScreen,false);assert.match(result.text,/What should we work on\?/);
});

test('a notification target beats the launch rule',{timeout:10_000},async()=>{
  const result=await runColdBoot(false,{listing:[{path:OTHER,title:'Recent',activeAt:Date.now()-60_000}]});safety(result);
  assert.deepEqual(result.actualOpenPaths,[TARGET]);assert.equal(result.currentSession,TARGET);
});

const STALE_ROW={path:OTHER,title:'Older chat',cwd:'/synthetic/p',activeAt:Date.now()-3*60*60_000};
const drawer=c=>c.w.document.querySelector('[data-testid="session-switcher"]');

test('the session drawer is the sole list over home: search focuses inline, picking a chat opens it and closes the drawer',{timeout:10_000},async()=>{
  const result=await runColdBoot(false,{hash:'',listing:[STALE_ROW],scenario:async c=>{
    await c.act(()=>c.f.openSwitcher());await c.settle();
    assert.ok(drawer(c),'the drawer opens');
    await c.act(()=>c.w.document.querySelector('[data-testid="switcher-search-toggle"]').click());await c.settle();
    assert.ok(c.w.document.querySelector('[data-testid="session-search"]'),'inline search opens');
    await c.act(()=>c.w.document.querySelector('[data-testid="session-row"]').click());await c.settle();
    return {chat:Boolean(c.w.document.querySelector('[data-screen="chat"]'))};
  }});safety(result);
  assert.deepEqual(result.scenario,{chat:true});assert.equal(result.currentSession,OTHER);
});


test('Back in a chat opens the drawer once; the Back after it closes the drawer, then leaves the app',{timeout:10_000},async()=>{
  const result=await runColdBoot(false,{scenario:async c=>{
    const handled=[];let drawerAfterFirst=false;
    for(let i=0;i<3;i++){
      await c.act(()=>{handled.push(c.f.nativeBack('commit'))});await c.settle();
      if(i===0)drawerAfterFirst=Boolean(c.w.document.querySelector('[data-testid="session-switcher"]'));
    }
    return {handled,drawerAfterFirst};
  }});safety(result);
  // The first Back opens the drawer, the second closes it, the third finds nothing to close: the shell leaves.
  assert.deepEqual(result.scenario,{handled:[true,true,false],drawerAfterFirst:true});assert.equal(result.currentSession,TARGET);
});

test('New chat leaves an open chat for home; from Settings over home it uncovers home',{timeout:10_000},async()=>{
  const result=await runColdBoot(false,{scenario:async c=>{
    await c.act(()=>c.f.openNewSession());await c.settle();
    const home=()=>/What should we work on\?/.test(c.w.document.body.textContent);
    const onHome=home()&&!c.w.document.querySelector('[data-screen="chat"]');
    await c.act(()=>c.f.openSettingsPage('providers'));await c.settle();
    const covered=Boolean(c.w.document.querySelector('[data-testid="settings-layer"]'));
    await c.act(()=>c.f.openNewSession());await c.settle();
    return {onHome,covered,settingsGone:!c.w.document.querySelector('[data-testid="settings-layer"]'),homeInert:c.w.document.querySelector('[data-screen="home"]')?.hasAttribute('inert')};
  }});safety(result);
  assert.deepEqual(result.scenario,{onHome:true,covered:true,settingsGone:true,homeInert:false});assert.equal(result.currentSession,null);
});

test('native readiness waits, failure preserves credential, retry opens once', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{native:true,scenario:async c=>{
    assert.deepEqual(plain(c.counts()),{list:0,chat:0,opens:[],pushes:0});
    assert.ok(c.w.document.querySelector('[data-testid="native-handoff"]'),'native hand-off screen is shown while waiting');
    await c.act(()=>c.tokenAttempts[0].reject(new Error('Synthetic native handoff failure')));await c.settle();
    assert.match(c.w.document.body.textContent,/Finishing setup/);assert.equal(c.w.localStorage.getItem('omp-remote-token'),'synthetic-token');
    await c.act(()=>[...c.w.document.querySelectorAll('button')].find(b=>b.textContent.includes('Try again')).click());
    assert.equal(c.tokenAttempts.length,2);await c.act(()=>c.tokenAttempts[1].resolve({ok:true}));
  }});onlyBoot(result);assert.equal(result.tokenAttemptCount,2);
});

test('StrictMode ignores the cancelled native acknowledgement and consumes the surviving one once', {timeout:10_000},async()=>{
  const result=await runColdBoot(true,{native:true,scenario:async c=>{
    assert.deepEqual(plain(c.counts()),{list:0,chat:0,opens:[],pushes:0});
    await c.act(()=>c.tokenAttempts[0].resolve({ok:true}));assert.equal(c.sockets.length,0);
    await c.act(()=>c.tokenAttempts[1].resolve({ok:true}));
  }});onlyBoot(result);
});

test('pairing preserves a captured enrollment-plus-session target', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{token:false,hash:'#pair=SYNTHETIC&s='+encodeURIComponent(TARGET)+'&k=message',scenario:async c=>{
    assert.equal(c.sockets.length,0);assert.match(c.w.document.body.textContent,/Connect to your computer/);
    assert.equal(new URLSearchParams(c.w.location.hash.slice(1)).has('pair'),false);
    assert.equal(new URLSearchParams(c.w.location.hash.slice(1)).get('s'),TARGET);
    await c.act(()=>c.w.document.querySelector('form').dispatchEvent(new c.w.Event('submit',{bubbles:true,cancelable:true})));
  }});onlyBoot(result);assert.equal(result.storedToken,'synthetic-token');assert.equal(result.historyState.notificationKind,'message');
});

test('native acknowledgement after unmount cannot open the captured route', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{native:true,scenario:async c=>{
    await c.act(()=>c.unmountSync());await c.act(()=>c.tokenAttempts[0].resolve({ok:true}));
  }});safety(result);assert.equal(result.chatConstructors,0);assert.equal(result.openSessionInvocations,0);
});

for (const strict of [false, true]) for (const event of ['hash', 'notification']) for (const hash of ['', '#s='+encodeURIComponent(TARGET)]) {
  test(`new ${event} during native hand-off wins over ${hash ? 'boot chat' : 'list'} (StrictMode=${strict})`, {timeout:10_000}, async()=>{
    const result=await runColdBoot(strict,{native:true,hash,serviceWorker:event==='notification',
      prepare:event==='notification'?c=>c.f.registerServiceWorker():undefined,
      scenario:async c=>{
        await c.act(()=>event==='hash'?c.hash(OTHER):c.notify(OTHER));
        assert.deepEqual(plain(c.counts()),{list:0,chat:0,opens:[],pushes:0});
        await c.act(()=>c.tokenAttempts[0].resolve({ok:true}));
        if(strict)await c.act(()=>c.tokenAttempts[1].resolve({ok:true}));
      }});
    safety(result);
    assert.deepEqual(result.actualOpenPaths,[OTHER]);
    assert.equal(result.currentSession,OTHER);
    assert.equal(result.listConstructors,0);
    assert.equal(result.historyPushes,1);
  });
}

test('handoff failure and retry retain only the latest notification', {timeout:10_000}, async()=>{
  const result=await runColdBoot(false,{native:true,scenario:async c=>{
    await c.act(()=>c.hash(OTHER));
    await c.act(()=>c.tokenAttempts[0].reject(new Error('Synthetic handoff failure')));
    await c.act(()=>c.hash(TARGET));
    await c.act(()=>[...c.w.document.querySelectorAll('button')].find(b=>b.textContent.includes('Try again')).click());
    await c.act(()=>c.tokenAttempts[1].resolve({ok:true}));
  }});
  safety(result);assert.deepEqual(result.actualOpenPaths,[TARGET]);assert.equal(result.listConstructors,0);
});

test('Back while handoff waits cancels a newly received notification', {timeout:10_000}, async()=>{
  const result=await runColdBoot(false,{native:true,scenario:async c=>{
    await c.act(()=>c.hash(OTHER));await c.act(()=>c.pop());
    await c.act(()=>c.tokenAttempts[0].resolve({ok:true}));
  }});
  safety(result);assert.deepEqual(result.actualOpenPaths,[]);assert.equal(result.listConstructors,0);
});

test('readiness withdrawal and rejected credential cannot let the old token open', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{native:true,holdPaths:['/api/sessions'],scenario:async c=>{
    await c.act(()=>{void c.controller().request('/api/sessions').catch(()=>undefined)});
    await c.act(()=>c.deferredFetches.find(row=>row.path==='/api/sessions').resolve(401));
    await c.act(()=>c.tokenAttempts[0].resolve({ok:true}));
  }});safety(result);assert.equal(result.storedToken === null, true);assert.match(result.text,/Connect to your computer/);assert.equal(result.chatConstructors,0);assert.equal(result.openSessionInvocations,0);
});

test('Back opens the drawer once; another link and repeated Back never replay the boot target', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{scenario:async c=>{
    await c.act(()=>c.pop());await c.settle();
    assert.equal(c.controller().getStore().getState().sessionPath,TARGET,'Back in a chat keeps the chat under the drawer');
    assert.ok(c.w.document.querySelector('[data-testid="session-switcher"]'),'Back in a chat opens the drawer');
    await c.act(()=>c.hash(OTHER));await c.settle();assert.equal(c.controller().getStore().getState().sessionPath,OTHER);
    await c.act(()=>{c.pop();c.pop()});
  }});safety(result);assert.deepEqual(result.actualOpenPaths,[TARGET,OTHER]);assert.equal(result.currentSession,OTHER);
});

test('warm A to B keeps B current after retired A callbacks', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{scenario:async c=>{
    const old=c.sockets.find(s=>s.path==='/ws'),lateMessage=old.onmessage,lateOpen=old.onopen,lateClose=old.onclose;
    await c.act(()=>c.hash(OTHER));
    await c.act(()=>{lateOpen?.({});lateMessage?.({data:JSON.stringify({type:'error',message:'obsolete A'})});lateClose?.({})});
    return {error:c.controller().getStore().getState().error};
  }});safety(result);assert.deepEqual(result.actualOpenPaths,[TARGET,OTHER]);assert.equal(result.currentSession,OTHER);assert.equal(result.scenario.error === null, true);
});

test('genuine list interruption still closes CONNECTING and fences retired callbacks', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{hash:'',scenario:async c=>{
    await c.act(()=>c.f.openSwitcher());await c.settle();
    const old=c.sockets[0],lateOpen=old.onopen,lateMessage=old.onmessage,lateClose=old.onclose;
    await c.act(()=>c.hash(TARGET));assert.equal(old.closeCalls[0].readyState,0);
    const before=c.sockets.length;await c.act(()=>{lateOpen?.({});lateMessage?.({data:JSON.stringify({type:'sessions'})});lateClose?.({})});
    assert.equal(c.sockets.length,before);return {syntheticWireErrorRecorded:c.events.some(e=>e.kind==='synthetic-pre-open-close-error'&&e.id===old.id)};
  }});safety(result);assert.equal(result.listConstructors,1);assert.equal(result.chatConstructors,1);assert.equal(result.scenario.syntheticWireErrorRecorded,true);
});

test('current list handshake failure remains recorded and schedules existing recovery', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{hash:'',scenario:async c=>{
    await c.act(()=>c.f.openSwitcher());await c.settle();
    const socket=c.sockets[0];await c.act(()=>{c.events.push({kind:'injected-current-wire-error',id:socket.id});socket.onerror?.({type:'error'})});
    return {recorded:c.events.some(e=>e.kind==='injected-current-wire-error'),reconnectScheduled:[...c.timers.values()].some(t=>t.delay===1000)};
  }});safety(result);assert.deepEqual(result.scenario,{recorded:true,reconnectScheduled:true});
});

test('bridged chat retains its intentional listing subscription', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{listing:[{path:TARGET,title:'Synthetic bridged session',bridge:true,status:'idle'}]});safety(result);
  assert.equal(result.chatConstructors,1);assert.equal(result.listConstructors,1);assert.deepEqual(result.actualOpenPaths,[TARGET]);
});

test('unresolved HTTP and history do not delay the chat route or change its fallback deadline', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{holdPaths:['/api/sessions','/api/history'],scenario:async c=>{
    assert.ok(c.w.document.querySelector('[data-screen="chat"]'));assert.equal(c.counts().list,0);
    // App also idles a 1500 ms screen-prefetch timer; pick the controller's history fallback.
    const historyTimer=[...c.timers.entries()].find(([,t])=>t.delay===1500&&String(t.callback).includes('startInitialHistoryFallback'));
    assert.ok(historyTimer,'existing 1500 ms bundle fallback timer');
    c.timers.delete(historyTimer[0]);await c.act(()=>historyTimer[1].callback(...historyTimer[1].args));
    assert.ok(c.requests.some(r=>r.path==='/api/history'));assert.equal(c.counts().opens.length,1);
  }});onlyBoot(result);
});

test('held lazy chunk shows the existing loading surface without a list subscription', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{holdChatChunk:true,scenario:async c=>{
    assert.ok(c.w.document.querySelector('[aria-label="Loading conversation"]'));assert.equal(c.counts().list,0);assert.equal(c.counts().opens.length,1);
    await c.act(()=>c.w.releaseChatChunk());
  }});onlyBoot(result);assert.equal(result.chatScreen,true);
});

test('saved draft and retained two-image intent remain byte-exact across boot and Back', {timeout:10_000},async()=>{
  const text='Exact retained α\n  two spaces 🔒',draft='Newer unsent draft 🙂';
  const images=[{data:'eA==',mimeType:'image/png'},{data:'eQ==',mimeType:'image/jpeg'}];let before;
  const result=await runColdBoot(false,{prepare:async c=>{
    await c.f.queue.enqueue({commandId:'boot-pending',sessionPath:TARGET,text,images,namespace:c.f.namespace});
    await c.f.queue.update('boot-pending',{state:'uncertain',error:'Already uncertain'},c.f.namespace);
    c.f.recoverDraft(TARGET,draft,c.f.namespace);
    before=plain(await c.f.queue.getQueued('boot-pending',c.f.namespace));
  },scenario:async c=>{
    const afterBoot=plain(await c.f.queue.getQueued('boot-pending',c.f.namespace));
    const savedImages=plain(await c.f.queue.getImages('boot-pending',c.f.namespace));
    await c.act(()=>c.pop());await c.settle();
    return {before,afterBoot,afterBack:plain(await c.f.queue.getQueued('boot-pending',c.f.namespace)),savedImages,draft:c.w.localStorage.getItem('omp-draft:'+c.f.namespace+':'+TARGET)};
  }});safety(result);assert.deepEqual(result.scenario.afterBoot,result.scenario.before);assert.deepEqual(result.scenario.afterBack,result.scenario.before);assert.deepEqual(result.scenario.savedImages,images);assert.equal(result.scenario.draft,draft);
});

for(const token of [false,true])test(`native Back does not activate chat while pairing/readiness waits (token=${token})`,{timeout:10_000},async()=>{
  const result=await runColdBoot(false,{native:true,token,scenario:async c=>{
    const handled=c.f.nativeBack('commit');
    assert.equal(handled,false,'waiting UI has no active chat base Back layer');
    if(token){await c.act(()=>c.tokenAttempts[0].resolve({ok:true}));await c.settle();assert.equal(c.f.nativeBack('start'),true);c.f.nativeBack('cancel');}
  }});safety(result);assert.equal(result.openSessionInvocations,token?1:0);
});

for(const strict of [false,true])test(`authoritative bundle settles the selected boot conversation (StrictMode=${strict})`,{timeout:10_000},async()=>{
 const result=await runColdBoot(strict,{scenario:async c=>{
  const chat=c.sockets.find(s=>s.path==='/ws');
  await c.act(()=>{chat.serverOpen();chat.message({type:'bundle',history:{entries:[{type:'message',id:'boot-answer',timestamp:'2026-10-11T00:00:00.000Z',message:{role:'assistant',content:[{type:'text',text:'Authoritative boot answer'}]}}],endOffset:1,nextBefore:null},state:{isStreaming:false},running:false,now:null,at:Date.now()})});
  await c.settle();return {opening:c.controller().getStore().getState().isOpening,messages:c.controller().getStore().getState().messages.map(m=>m.text)};
 }});onlyBoot(result);assert.equal(result.scenario.opening,false);assert.ok(result.scenario.messages.includes('Authoritative boot answer'));assert.match(result.text,/Authoritative boot answer/);
});


// This supplement exercises the missing eligible-callback cancellation window
// without changing any frozen source or replacing any controller implementation.
for(const strict of [false,true])test(`eligible queued boot is retired by explicit credential removal/controller replacement (StrictMode=${strict})`,{timeout:10_000},async t=>{
  let retired,retiredIndex,queuedBeforeRejection,disposeCount;
  const result=await runColdBoot(strict,{beforeBoot:c=>{
    queuedBeforeRejection=c.events.filter(e=>e.kind==='eligible-boot-callback-queued').length;
    assert.equal(queuedBeforeRejection,strict?2:1,'actual eligible boot effect queued before rejection');
    assert.equal(c.events.filter(e=>e.kind==='eligible-boot-callback-invoked').length,0,'no boot callback has run');
    assert.deepEqual(plain(c.counts()),{list:0,chat:0,opens:[],pushes:0},'eligible callback remains pending');
    retiredIndex=c.f.calls.filter(x=>x.method==='loadSessions').at(-1).controller;
    retired=c.f.controllers[retiredIndex];disposeCount=c.f.calls.filter(x=>x.method==='dispose'&&x.controller===retiredIndex).length;
    c.events.push({kind:'explicit-credential-removal',controller:retiredIndex});
    c.f.clearPairingToken();
    retired.getStore().getState().setAuthRejected(true);
  },scenario:c=>{
    assert.equal(retired.disposed,true,'real replacement effect disposed old controller');
    assert.ok(c.f.calls.filter(x=>x.method==='dispose'&&x.controller===retiredIndex).length>disposeCount,'replacement cleanup ran after injection');
    assert.ok(c.f.controllers.some(x=>x!==retired&&x.token===''),'real tokenless replacement constructed');
    return {queuedBeforeRejection,retiredIndex,retiredDisposed:retired.disposed,replacementTokenlessControllers:c.f.controllers.filter(x=>x!==retired&&x.token==='').length,invokedAfterRejection:c.events.filter(e=>e.kind==='eligible-boot-callback-invoked').length};
  }});
  t.diagnostic('COLD_LINK_QUEUED_RETIREMENT '+JSON.stringify(result));
  assert.deepEqual(result.unexpectedAfterCleanup,[]);
  assert.deepEqual(result.domBlocked,[]);assert.deepEqual(result.cleanup.domBlocked,[]);
  assert.equal(result.promptAttempts,0);assert.equal(result.realNetworkAdmissions,0);
  assert.equal(result.cleanup.afterControllerSweep.activeSockets,0);
  assert.equal(result.storedToken === null, true);assert.match(result.text,/Connect to your computer/);
  assert.equal(result.scenario.invokedAfterRejection,queuedBeforeRejection,'queued callbacks ran after retirement');
  assert.equal(result.listConstructors,0,'no list socket before or after replacement');
  assert.equal(result.chatConstructors,0,'no old chat socket from cancelled callback');
  assert.equal(result.openSessionInvocations,0,'no late old or new controller open');
  assert.equal(result.historyPushes,0,'no late history effect');
  assert.equal(result.currentSession === null, true);
});

for(const strict of [false,true])test(`re-pair after queued boot retirement has no transient list (StrictMode=${strict})`,{timeout:10_000},async t=>{
  let beforePair;
  const result=await runColdBoot(strict,{allowPair:true,hash:'#pair=SYNTHETIC&s='+encodeURIComponent(TARGET),beforeBoot:c=>{
    assert.equal(c.events.filter(e=>e.kind==='eligible-boot-callback-queued').length,strict?2:1);
    assert.equal(c.events.filter(e=>e.kind==='eligible-boot-callback-invoked').length,0);
    const actualIndex=c.f.calls.filter(x=>x.method==='loadSessions').at(-1).controller;
    c.events.push({kind:'explicit-credential-removal',controller:actualIndex});
    c.f.clearPairingToken();
    c.f.controllers[actualIndex].getStore().getState().setAuthRejected(true);
  },scenario:async c=>{
    beforePair=plain(c.counts());assert.deepEqual(beforePair,{list:0,chat:0,opens:[],pushes:0});
    assert.equal(c.w.localStorage.getItem('omp-remote-token') === null, true);assert.match(c.w.document.body.textContent,/Connect to your computer/);
    await c.act(()=>c.w.document.querySelector('form').dispatchEvent(new c.w.Event('submit',{bubbles:true,cancelable:true})));
    await c.settle();return {beforePair,afterPair:plain(c.counts())};
  }});
  t.diagnostic('COLD_LINK_REPAIR_CONTINUATION '+JSON.stringify(result));
  assert.deepEqual(result.unexpectedAfterCleanup,[]);assert.deepEqual(result.domBlocked,[]);assert.deepEqual(result.cleanup.domBlocked,[]);
  assert.equal(result.promptAttempts,0);assert.equal(result.cleanup.afterControllerSweep.activeSockets,0);
  assert.equal(result.storedToken,'synthetic-token');
  assert.deepEqual(result.actualOpenPaths,[TARGET]);assert.equal(result.chatConstructors,1);assert.equal(result.historyPushes,1);
  assert.equal(result.currentSession,TARGET);assert.equal(result.listConstructors,0,'still-pending boot route must not mount transient list after re-pair');
});

for(const strict of [false,true])for(const handled of ['consumed','Back-cancelled'])test(`re-pair never revives a ${handled} boot target (StrictMode=${strict})`,{timeout:10_000},async t=>{
  const reject=c=>{
    const actualIndex=c.f.calls.filter(x=>x.method==='loadSessions').at(-1).controller;
    c.f.clearPairingToken();
    c.f.controllers[actualIndex].getStore().getState().setAuthRejected(true);
  };
  const result=await runColdBoot(strict,{allowPair:true,hash:'#pair=SYNTHETIC&s='+encodeURIComponent(TARGET),beforeBoot:handled==='Back-cancelled'?c=>{c.pop();reject(c)}:undefined,scenario:async c=>{
    if(handled==='consumed'){assert.deepEqual(plain(c.counts()),{list:0,chat:1,opens:[TARGET],pushes:1});await c.act(()=>reject(c));await c.settle()}
    assert.equal(c.w.localStorage.getItem('omp-remote-token') === null, true);assert.match(c.w.document.body.textContent,/Connect to your computer/);
    const beforePair=plain(c.counts());
    await c.act(()=>c.w.document.querySelector('form').dispatchEvent(new c.w.Event('submit',{bubbles:true,cancelable:true})));
    await c.settle();return {handled,beforePair,afterPair:plain(c.counts()),liveLists:c.sockets.filter(s=>s.path==='/ws/sessions'&&s.readyState<2).length};
  }});
  t.diagnostic('COLD_LINK_NO_REVIVAL '+JSON.stringify(result));safety(result);
  assert.equal(result.storedToken,'synthetic-token');
  assert.deepEqual(result.actualOpenPaths,handled==='consumed'?[TARGET]:[]);
  assert.equal(result.historyPushes,handled==='consumed'?1:0);
  assert.equal(result.scenario.afterPair.chat,result.scenario.beforePair.chat,'re-pair constructs no boot chat socket');
  assert.deepEqual(result.scenario.afterPair.opens,result.scenario.beforePair.opens,'re-pair does not reopen handled target');
  assert.equal(result.scenario.afterPair.pushes,result.scenario.beforePair.pushes,'re-pair does not push handled history');
  assert.equal(result.scenario.liveLists,0,'re-pair lands on home: no list subscription, no revived chat');
  assert.equal(result.currentSession === null, true);assert.equal(result.chatScreen,false);
});

async function enterRepair(c) {
  await c.act(()=>c.f.openSettingsPage('repair-pairing'));
  await c.settle();
  const button=[...c.w.document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Enter code');
  assert.equal(Boolean(button),true);
  await c.act(()=>button.click());
  await c.act(()=>{
    const input=c.w.document.querySelector('#pairing-code');
    Object.getOwnPropertyDescriptor(c.w.HTMLInputElement.prototype,'value').set.call(input,'SYNTHETIC-REPAIR');
    input.dispatchEvent(new c.w.Event('input',{bubbles:true}));
  });
}

test('in-place repair restores the intended chat and keeps previous drafts read-only', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{allowPair:true,pairToken:'replacement-synthetic-token',prepare:async c=>{
    c.w.localStorage.setItem(`omp-draft:${c.f.namespace}:${TARGET}`,'original chat draft');
    c.w.localStorage.setItem(`omp-draft:${c.f.namespace}:new-session`,JSON.stringify({revision:'draft-revision',text:'new-session text',project:null,choice:null,createdSessionPath:null,transferredSessionPath:null}));
  },scenario:async c=>{
    assert.equal(c.controller().getStore().getState().sessionPath,TARGET);
    await enterRepair(c);
    await c.act(()=>c.w.document.querySelector('[data-settings-page="repair-pairing"] form').dispatchEvent(new c.w.Event('submit',{bubbles:true,cancelable:true})));
    await c.settle();
    const current=c.controller();
    assert.equal(current.getStore().getState().sessionPath,TARGET);
    assert.equal(c.w.document.querySelector('[data-testid="composer-input"]')?.value,'',
      'old credential draft is not put in the replacement composer automatically');
    const archive=await c.f.queue.readPairingRecoveryEntries('replacement-synthetic-token');
    assert.equal(archive.items.some(item=>item.preview==='original chat draft'),true);
    assert.equal(archive.items.some(item=>item.preview==='new-session text'),true);
    assert.equal(c.f.queue.pendingAll().length,0);
    await c.act(()=>c.f.openSettingsPage('repair-pairing'));await c.settle();
    const savedWork=c.w.document.querySelector('[aria-label="Saved work from pairing repair"]');
    assert.ok(savedWork);
    for(const row of savedWork.querySelectorAll('button[aria-expanded]')){
      await c.act(()=>row.click());await c.settle();
      if(savedWork.textContent.includes('original chat draft'))break;
    }
    assert.equal(savedWork.textContent.includes('original chat draft'),true);
    return {};
  }});
  safety(result);
  assert.equal(result.storedToken,'replacement-synthetic-token');
  assert.equal(result.currentSession,TARGET);
  assert.deepEqual(result.actualOpenPaths,[TARGET,TARGET]);
});

test('cancelled repair keeps the credential, draft and originating conversation', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{prepare:c=>c.w.localStorage.setItem(`omp-draft:${c.f.namespace}:${TARGET}`,'cancelled repair draft'),scenario:async c=>{
    const old=c.controller();await enterRepair(c);
    await c.act(()=>c.f.closeSettings());await c.settle();
    assert.equal(c.controller()===old,true);
    assert.equal(old.getStore().getState().sessionPath,TARGET);
    assert.equal(c.w.localStorage.getItem(`omp-draft:${c.f.namespace}:${TARGET}`),'cancelled repair draft');
    assert.equal(c.requests.filter(row=>row.path==='/api/pair').length,0);
    return {};
  }});
  safety(result);assert.equal(result.storedToken,'synthetic-token');assert.equal(result.currentSession,TARGET);
});

test('a late old 401 during native repair cannot clear the redeemed pairing; Back wins over restoration', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{native:true,allowPair:true,pairToken:'replacement-synthetic-token',holdPaths:['/api/sessions'],scenario:async c=>{
    await c.act(()=>c.tokenAttempts[0].resolve({ok:true}));await c.settle();
    const old=c.controller();await enterRepair(c);
    await c.act(()=>c.w.document.querySelector('[data-settings-page="repair-pairing"] form').dispatchEvent(new c.w.Event('submit',{bubbles:true,cancelable:true})));await c.settle();
    assert.equal(c.w.localStorage.getItem('omp-remote-token'),'replacement-synthetic-token');
    assert.equal(c.tokenAttempts.length,2);
    const unrenderable=new c.w.CustomEvent('app:open-settings',{detail:{page:'computer'},cancelable:true});
    await c.act(()=>c.w.dispatchEvent(unrenderable));
    assert.equal(unrenderable.defaultPrevented,false,'unacknowledged replacement cannot promise a Settings destination');
    await c.act(()=>c.deferredFetches.find(row=>row.path==='/api/sessions').resolve(401));await c.settle();
    assert.equal(old.getStore().getState().authRejected,false);
    assert.equal(c.w.localStorage.getItem('omp-remote-token'),'replacement-synthetic-token');
    assert.equal(c.nativeCalls.some(call=>call.op==='clearToken'),false);
    await c.act(()=>c.tokenAttempts[1].reject(Error('synthetic native failure')));await c.settle();
    assert.equal(c.requests.filter(row=>row.path==='/api/pair').length,1);
    await c.act(()=>c.w.document.querySelector('[data-settings-page="repair-pairing"] form').dispatchEvent(new c.w.Event('submit',{bubbles:true,cancelable:true})));await c.settle();
    assert.equal(c.tokenAttempts.length,3);
    await c.act(()=>c.f.closeSettings());await c.act(()=>c.pop());await c.settle();
    await c.act(()=>c.tokenAttempts[2].resolve({ok:true}));await c.settle();
    assert.equal(c.controller().getStore().getState().sessionPath,null,'Back cannot be overridden by repair completion');
    assert.equal(c.requests.filter(row=>row.path==='/api/pair').length,1);
    assert.equal((await c.f.queue.readPairingRecovery('replacement-synthetic-token'))!==null,true);
    return {};
  }});
  safety(result);assert.equal(result.storedToken,'replacement-synthetic-token');assert.equal(result.currentSession,null);
});

test('native settings acknowledges only a destination available on the current screen', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{token:false,hash:'',scenario:async c=>{
    const send=page=>{const event=new c.w.CustomEvent('app:open-settings',{detail:{page},cancelable:true});c.w.dispatchEvent(event);return event.defaultPrevented};
    assert.equal(send('computer'),false);assert.equal(send('diagnostics'),false);
    assert.equal(send('repair-pairing'),true,'an already rendered tokenless PairScreen is a valid destination');
    return {};
  }});safety(result);
  const pending=await runColdBoot(false,{native:true,scenario:async c=>{
    for(const page of ['computer','diagnostics','repair-pairing']){
      const event=new c.w.CustomEvent('app:open-settings',{detail:{page},cancelable:true});c.w.dispatchEvent(event);
      assert.equal(event.defaultPrevented,false,'unacknowledged credential cannot render Settings');
    }
    await c.act(()=>c.tokenAttempts[0].resolve({ok:true}));await c.settle();
    const event=new c.w.CustomEvent('app:open-settings',{detail:{page:'repair-pairing'},cancelable:true});
    await c.act(()=>c.w.dispatchEvent(event));await c.settle();
    assert.equal(event.defaultPrevented,true);
    assert.equal(c.w.document.querySelector('[data-settings-page=\"repair-pairing\"]')!==null,true);
    return {};
  }});safety(pending);
});

test('native acknowledgement failure survives a cold reload with durable read-only work and no second redemption', {timeout:10_000},async()=>{
  const memory=memoryIndexedDb();
  const first=await runColdBoot(false,{memory,native:true,allowPair:true,pairToken:'replacement-synthetic-token',
    prepare:c=>c.w.localStorage.setItem(`omp-draft:${c.f.namespace}:${TARGET}`,'durable across reload'),
    scenario:async c=>{
      await c.act(()=>c.tokenAttempts[0].resolve({ok:true}));await c.settle();
      await enterRepair(c);
      await c.act(()=>c.w.document.querySelector('[data-settings-page="repair-pairing"] form').dispatchEvent(new c.w.Event('submit',{bubbles:true,cancelable:true})));await c.settle();
      await c.act(()=>c.tokenAttempts[1].reject(Error('synthetic native failure')));await c.settle();
      assert.equal(c.requests.filter(row=>row.path==='/api/pair').length,1);
      return {};
    }});
  safety(first);assert.equal(first.storedToken,'replacement-synthetic-token');
  const second=await runColdBoot(false,{memory,native:true,credential:first.storedToken,scenario:async c=>{
    assert.equal(c.tokenAttempts[0].token,'replacement-synthetic-token');
    await c.act(()=>c.tokenAttempts[0].resolve({ok:true}));await c.settle();
    const page=await c.f.queue.readPairingRecoveryEntries('replacement-synthetic-token');
    assert.equal(page.items.some(item=>item.preview==='durable across reload'),true);
    assert.equal(c.requests.filter(row=>row.path==='/api/pair').length,0);
    assert.equal(c.f.queue.pendingAll().length,0);
    return {};
  }});
  safety(second);assert.equal(second.storedToken,'replacement-synthetic-token');
});

test('a newer notification during native repair wins over the originating conversation', {timeout:10_000},async()=>{
  const result=await runColdBoot(false,{native:true,allowPair:true,pairToken:'replacement-synthetic-token',scenario:async c=>{
    await c.act(()=>c.tokenAttempts[0].resolve({ok:true}));await c.settle();
    await enterRepair(c);
    await c.act(()=>c.w.document.querySelector('[data-settings-page="repair-pairing"] form').dispatchEvent(new c.w.Event('submit',{bubbles:true,cancelable:true})));await c.settle();
    await c.act(()=>c.hash(OTHER));await c.settle();
    await c.act(()=>c.tokenAttempts[1].resolve({ok:true}));await c.settle();
    assert.equal(c.controller().getStore().getState().sessionPath,OTHER);
    return {};
  }});
  safety(result);assert.equal(result.currentSession,OTHER);
  assert.deepEqual(result.actualOpenPaths,[TARGET,OTHER,OTHER]);
});
