import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { setImmediate as nextTask } from 'node:timers/promises';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
import { memoryIndexedDb } from './support/memory-indexeddb.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const TARGET = '/synthetic/queue preparation α.jsonl';
const TARGET_B = '/synthetic/queue preparation beta.jsonl';
const allowedPaths = new Set([TARGET, TARGET_B]);
const plain = value => JSON.parse(JSON.stringify(value));
const authority = (kind, revision=1, confidence='confirmed') => ({daemonInstanceId:'synthetic-queue-authority',revision,bindingEpoch:revision,observedAt:revision,owner:{kind},turn:'running',confidence,connection:'connected',activity:null,capabilities:{read:true,stream:true,control:true,send:true,stop:true,queue:kind!=='collab'}});
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { createOmpStore, parseQueuedMessages, NO_QUEUED_MESSAGES } from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
import { OmpSessionController } from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
import { QueuedMessagesBar } from ${JSON.stringify(resolve(root,'web/src/app/chat/QueuedMessagesBar.tsx'))};
import { Notices } from ${JSON.stringify(resolve(root,'web/src/app/Notices.tsx'))};
import { readDraft } from ${JSON.stringify(resolve(root,'web/src/app/composer/use-draft.ts'))};
window.fixture={act,createOmpStore,parseQueuedMessages,NO_QUEUED_MESSAGES,OmpSessionController,readDraft,
 mount(controller){const root=createRoot(document.getElementById('root'));root.render(h('div',null,h(QueuedMessagesBar,{controller,pending:[]}),h(Notices)));return root}};
`, [{name:'synthetic-import-meta',transform(source,id){
  if(id.endsWith('/omp-session-controller.ts'))return source.replaceAll('import.meta',JSON.stringify({env:{VITE_PROTOCOL_VERSION:3,VITE_RELEASE_ID:'synthetic-queue-preparation'}}));
}}]);

const queueValue = (liveSteered) => ({steering:['same','same',''],followUp:['later'],liveSteered});
const actionableQueue = marker => ({...queueValue(marker),steeringIds:['held-a','held-b','held-image'],followUpIds:['held-follow-up']});
const accepted = f => value => f.parseQueuedMessages(value);
function callback(button){const key=Object.keys(button).find(key=>key.startsWith('__reactProps$'));assert.ok(key);return button[key].onClick}
function rows(w){return [...w.document.querySelectorAll('[data-testid="queued-message"]')]}

async function withQueue(t,run,options={}){
  const dom=createDomFixture(code),w=dom.window,f=w.fixture,requests=[],pending=[],seeds=[],sockets=[],unexpected=[];let holdSeeds=false;
  const timers=new Map(),intervals=new Map(),frames=new Map();let id=-1,controller,mounted;
  const realTimeout=w.setTimeout.bind(w),realClear=w.clearTimeout.bind(w);
  const zeros=new Set(),memory=memoryIndexedDb();
  const deny=message=>{unexpected.push(message);throw new Error('Unexpected synthetic boundary: '+message)};
  const act=fn=>f.act(async()=>{await fn?.();await nextTask()});
  Object.assign(w,{Headers,Response,Request,TextEncoder,TextDecoder,indexedDB:memory.indexedDB});
  w.setTimeout=(fn,ms=0,...args)=>{if(Number(ms)===0){let key;key=realTimeout(()=>{zeros.delete(key);fn(...args)},0);zeros.add(key);return key}const key=id--;timers.set(key,{fn,ms,args});return key};
  w.clearTimeout=key=>{if(!timers.delete(key)){zeros.delete(key);realClear(key)}};
  w.setInterval=(fn,ms,...args)=>{const key=id--;intervals.set(key,{fn,ms,args});return key};w.clearInterval=key=>intervals.delete(key);
  w.requestAnimationFrame=fn=>{const key=id--;frames.set(key,fn);return key};w.cancelAnimationFrame=key=>frames.delete(key);
  class SyntheticSocket {
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
    constructor(raw){const url=new URL(String(raw));if(url.hostname!=='synthetic.invalid'||url.pathname!=='/ws'||!allowedPaths.has(url.searchParams.get('session')))return deny('socket target');this.readyState=0;this.url=String(raw);sockets.push(this)}
    open(){assert.equal(this.readyState,0);this.readyState=1;this.onopen?.({target:this})}
    message(frame){assert.equal(this.readyState,1);this.onmessage?.({data:JSON.stringify(frame),target:this})}
    send(){return deny('socket send')}
    close(){if(this.readyState>=2)return;this.readyState=2;w.queueMicrotask(()=>{this.readyState=3;this.onclose?.({target:this})})}
  }
  w.WebSocket=SyntheticSocket;
  w.fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:(input.url??String(input)),w.location.origin);
    const row={path:url.pathname,method:init.method??'GET',authorization:new Headers(init.headers).get('authorization')};requests.push(row);
    if(url.origin!==w.location.origin||row.authorization!=='Bearer synthetic-token')return deny('fetch origin/auth');
    if(row.method==='GET'&&url.pathname==='/api/agents/roster')return new Response(JSON.stringify({agents:[]}),{headers:{'Content-Type':'application/json'}});
    if(row.method==='POST'&&url.pathname==='/api/rpc'){
      const payload=JSON.parse(init.body);row.payload=payload;
      if(!allowedPaths.has(payload.sessionPath))return deny('RPC session');
      if(payload.command==='get_queue_recovery'){
        assert.deepEqual(payload,{sessionPath:payload.sessionPath,command:'get_queue_recovery',params:{}});
        return new Response(JSON.stringify({ok:true,data:{recoveries:[]}}),{headers:{'Content-Type':'application/json'}});
      }
      if(payload.command==='get_state'){
        assert.deepEqual(payload,{sessionPath:payload.sessionPath,command:'get_state',params:{},peek:true});
        if(holdSeeds)return new Promise((resolve,reject)=>seeds.push({payload,resolve:value=>{row.result='resolved';resolve(new Response(JSON.stringify({data:value}),{headers:{'Content-Type':'application/json'}}))},reject:error=>{row.result='rejected';reject(error)}}));
        return new Response(JSON.stringify({data:options.seed??{isStreaming:false}}),{headers:{'Content-Type':'application/json'}});
      }
      if(['remove_queued_message','promote_queued_message'].includes(payload.command))return new Promise((resolve,reject)=>pending.push({payload,resolve:value=>resolve(new Response(JSON.stringify({data:value}),{headers:{'Content-Type':'application/json'}})),reject}));
      return deny('RPC '+payload.command);
    }
    if(row.method==='POST'&&url.pathname==='/api/abort'){
      row.body=JSON.parse(init.body);
      return new Response(JSON.stringify(options.abortResult??{ok:true,stopped:true,withdrawn:{messages:[{text:'withdrawn photo',images:[{data:'synthetic-photo',mimeType:'image/png'}]}],imagesDropped:false,truncated:false}}),{headers:{'Content-Type':'application/json'}});
    }
    if(row.method==='GET'&&url.pathname==='/api/history')return new Response(JSON.stringify({entries:[],endOffset:0,nextBefore:null,running:false}));
    if(row.method==='GET'&&url.pathname.startsWith('/api/receipts/'))return new Response(JSON.stringify({error:'not found'}),{status:404});
    return deny(row.method+' '+url.pathname);
  };
  let result;
  try {
    await act(()=>{controller=new f.OmpSessionController(f.createOmpStore(),'synthetic-token');mounted=f.mount(controller)});
    let opening;await act(()=>{opening=controller.openSession(TARGET)});assert.equal(sockets.length,1);
    let socket=sockets[0];await act(()=>{socket.open();socket.message({type:'bundle',history:{entries:[],endOffset:0,nextBefore:null},state:{isStreaming:false},running:false,now:null,at:Date.now()})});
    await act(()=>opening);
    const store=controller.getStore();
    await act(()=>store.setState({sessionAuthorities:{[TARGET]:authority('child')}}));
    const update=async(value)=>act(()=>socket.message({type:'event',event:{type:'queue_update',...value}}));
    const issue=async(generation=controller.generation,path=controller.activeSession)=>{
      holdSeeds=true;const n=seeds.length;let promise;
      await act(()=>{promise=controller.seedQueuedMessages(generation,path)});
      assert.equal(seeds.length,n+1);seeds[n].promise=promise;return seeds[n];
    };
    const settle=async(entry,data,error=false)=>act(async()=>{error?entry.reject(new w.Error('synthetic seed failure')):entry.resolve(data);await entry.promise});
    const open=async(path)=>{
      let opening;const n=sockets.length;await act(()=>{opening=controller.openSession(path)});assert.equal(sockets.length,n+1);socket=sockets.at(-1);
      await act(()=>{socket.open();socket.message({type:'bundle',history:{entries:[],endOffset:0,nextBefore:null},state:{isStreaming:false},running:false,now:null,at:Date.now()})});await act(()=>opening);return socket;
    };
    result=await run({w,f,controller,store,socket,act,requests,pending,seeds,update,issue,settle,open,commands:()=>requests.filter(r=>r.payload&&!['get_state','get_queue_recovery'].includes(r.payload.command))});
    await act();
  } finally {
    if(mounted)await act(()=>mounted.unmount());
    if(controller)await act(()=>controller.dispose());
    const afterController={sockets:sockets.filter(s=>s.readyState<2).length,timers:timers.size,intervals:intervals.size,frames:frames.size};
    t.diagnostic('P1_LEDGER '+JSON.stringify({result,requests,unexpected,blocked:dom.blocked,afterController,promptAttempts:requests.filter(r=>r.path==='/api/prompt').length,realNetworkAdmissions:0}));
    for(const key of zeros)realClear(key);timers.clear();intervals.clear();frames.clear();dom.close();
    assert.deepEqual(unexpected,[]);assert.deepEqual(dom.blocked,[]);assert.equal(afterController.sockets,0);assert.equal(afterController.intervals,0);
  }
}

for(const nested of [false,true])test('P1 selected envelope and exact lists nested='+nested,()=>{
  const dom=createDomFixture(code),f=dom.window.fixture,parse=accepted(f),wrap=value=>nested?{queuedMessages:value,liveSteered:99}:value;
  try{
    for(const marker of [0,1,3]){const input=queueValue(marker),q=parse(wrap(input));assert.deepEqual(plain(q),input);assert.notEqual(q.steering,input.steering);assert.notEqual(q.followUp,input.followUp)}
    assert.deepEqual(plain(parse({queuedMessages:{steering:['inner'],followUp:[]},steering:['outer'],followUp:['outer'],liveSteered:1})),{steering:['inner'],followUp:[],liveSteered:0});
    assert.equal(parse({queuedMessages:{steering:[1],followUp:[]},steering:['outer'],followUp:[]}) === null, true);
    for(const absent of [null,undefined,false,3,'wrong'])assert.equal(parse({queuedMessages:absent,steering:[],followUp:[]}).liveSteered,0);
    for(const nonobject of [null,undefined,false,3,'wrong'])assert.equal(parse(nonobject) === null, true);
    const original={steering:[' exact ','same','same',''],followUp:[' later ',''],liveSteered:1};const q=parse(wrap(original));original.steering[0]='mutated';original.followUp.push('extra');assert.deepEqual(plain(q),{steering:[' exact ','same','same',''],followUp:[' later ',''],liveSteered:1});
  }finally{dom.close()}
});

for(const nested of [false,true])test('P1 marker normalization matrix nested='+nested,()=>{
  const dom=createDomFixture(code),parse=accepted(dom.window.fixture),wrap=value=>nested?{queuedMessages:value}:value;
  try{
    const invalid=[undefined,null,true,false,'0','1',[],{},()=>0,0.1,-1,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER+1,4];
    for(const marker of invalid)assert.equal(parse(wrap(queueValue(marker))).liveSteered === null, true, String(marker));
    for(const marker of [0,-0,1,3]){const q=parse(wrap(queueValue(marker)));assert.equal(q.liveSteered,marker===0?0:marker);assert.equal(Object.is(q.liveSteered,-0),false)}
    const legacy={steering:['one'],followUp:[]};assert.equal(parse(wrap(legacy)).liveSteered,0);
    const inherited=Object.create({liveSteered:1});Object.assign(inherited,legacy);assert.equal(parse(wrap(inherited)).liveSteered,0);
    for(const marker of [0,-0])assert.equal(parse(wrap({steering:[],followUp:[],liveSteered:marker})).liveSteered,0);
    for(const marker of [...invalid,1])assert.equal(parse(wrap({steering:[],followUp:[],liveSteered:marker})).liveSteered === null, true);
  }finally{dom.close()}
});

test('P1 dense string lists reject sparse holes without filtering',()=>{
  const dom=createDomFixture(code),parse=accepted(dom.window.fixture);
  try{
    const allHoles=Array(3),leading=[,'same'],middle=['same',,'same'],trailing=['same'];trailing.length=2;
    const inherited=['same'];inherited.length=2;Object.setPrototypeOf(inherited,Object.assign(Object.create(Array.prototype),{1:'inherited'}));
    const bad=[allHoles,leading,middle,trailing,inherited,['same',1],['same',undefined],null,{},'text'];
    for(const nested of [false,true])for(const list of ['steering','followUp'])for(const value of bad){const source={steering:['same'],followUp:['later'],liveSteered:0,[list]:value};assert.equal(parse(nested?{queuedMessages:source}:source) === null, true, `${nested}/${list}/${String(value)}`)}
  }finally{dom.close()}
});

test('P1 real store identity, notification equality and existing resets',()=>{
  const dom=createDomFixture(code),f=dom.window.fixture,store=f.createOmpStore(),parse=accepted(f);
  try{
    assert.deepEqual(plain(store.getState().queuedMessages),{steering:[],followUp:[],liveSteered:0});
    store.getState().setQueuedMessages(parse(queueValue(0)));let queueNotifications=0,totalNotifications=0;
    store.subscribe((s,p)=>{totalNotifications++;if(s.queuedMessages!==p.queuedMessages)queueNotifications++});
    for(const marker of [1,null,3,0]){const before=store.getState().queuedMessages,n=queueNotifications,total=totalNotifications;store.getState().setQueuedMessages(parse(queueValue(marker)));assert.notEqual(store.getState().queuedMessages,before);assert.equal(queueNotifications,n+1);assert.equal(totalNotifications,total+1)}
    const equal=source=>{const before=store.getState().queuedMessages,q=queueNotifications,n=totalNotifications;store.getState().setQueuedMessages(parse(source));assert.equal(store.getState().queuedMessages,before);assert.equal(queueNotifications,q);assert.equal(totalNotifications,n)};
    equal(queueValue(0));equal({steering:['same','same',''],followUp:['later']});equal(queueValue(-0));
    store.getState().setQueuedMessages(parse(queueValue(undefined)));equal(queueValue('invalid'));equal(queueValue(null));
    for(const source of [{steering:['','same','same'],followUp:['later'],liveSteered:null},{steering:['','same'],followUp:['later'],liveSteered:null},{steering:['','same'],followUp:['later','extra'],liveSteered:null}]){const n=queueNotifications;store.getState().setQueuedMessages(parse(source));assert.equal(queueNotifications,n+1)}
    store.getState().beginSession('/synthetic/reset');assert.equal(store.getState().queuedMessages,f.NO_QUEUED_MESSAGES);store.getState().setQueuedMessages(parse(queueValue(1)));store.getState().clearSession();assert.equal(store.getState().queuedMessages,f.NO_QUEUED_MESSAGES);
  }finally{dom.close()}
});

test('taken steering immediately loses Edit and Remove while identical held rows retain exact actions',async t=>{
  await withQueue(t,async c=>{
    await c.update(actionableQueue(0));assert.equal(rows(c.w)[0].querySelectorAll('button').length,2);
    await c.update(actionableQueue(1));
    assert.equal(rows(c.w)[0].querySelectorAll('button').length,0);
    assert.match(rows(c.w)[0].textContent,/Taken into response/);
    assert.equal(rows(c.w)[1].querySelectorAll('button').length,2);
    await c.update(actionableQueue(null));
    for(const row of rows(c.w).slice(0,3))assert.equal(row.querySelectorAll('button').length,0);
    assert.equal(c.commands().length,0);
  });
});

test('P1 existing get_state seed retains selected nested metadata',async t=>{
  await withQueue(t,async c=>{assert.deepEqual(plain(c.store.getState().queuedMessages),queueValue(1));assert.equal(rows(c.w).length,4);assert.equal(c.commands().length,0)},{seed:{queuedMessages:queueValue(1)}});
});

test('P1 invalid whole queue event preserves the exact current store snapshot',async t=>{
  await withQueue(t,async c=>{await c.update(queueValue(1));const before=c.store.getState().queuedMessages;await c.update({steering:['ok',3],followUp:[],liveSteered:0});assert.equal(c.store.getState().queuedMessages,before);assert.equal(c.commands().length,0)});
});

for(const action of ['remove','promote'])for(const outcome of ['true','false','error'])test(`P1 original pending ${action} survives marker-only updates and ${outcome}`,async t=>{
  await withQueue(t,async c=>{
    await c.update(actionableQueue(0));const row=rows(c.w)[3];const button=row.querySelector(action==='remove'?'button[aria-label="Remove queued message"]':'button[aria-label="Send now"]');const saved=callback(button),beforeDispatch=c.store.getState().queuedMessages;
    await c.act(()=>button.click());assert.equal(c.pending.length,1);assert.equal(button.disabled,true);assert.equal(c.store.getState().queuedMessages,beforeDispatch);assert.equal(rows(c.w).length,4);
    for(const marker of [1,null]){await c.update(actionableQueue(marker));assert.equal(button.disabled,true);assert.equal(rows(c.w)[3]===row,true);await c.act(()=>saved());assert.equal(c.pending.length,1);assert.equal(c.commands().length,1)}
    if(action==='promote')assert.ok([...row.querySelectorAll('button')].every(b=>b.disabled));
    const before=c.store.getState().queuedMessages;
    const payload=c.pending[0].payload;assert.deepEqual(payload,{sessionPath:TARGET,command:action==='remove'?'remove_queued_message':'promote_queued_message',params:action==='remove'?{itemId:'held-follow-up',queue:'followUp'}:{itemId:'held-follow-up'}});
    await c.act(()=>{if(outcome==='error')c.pending[0].reject(new c.w.Error('synthetic action failure'));else c.pending[0].resolve({[action==='remove'?'removed':'promoted']:outcome==='true'})});
    assert.equal(c.store.getState().queuedMessages,before);assert.equal(rows(c.w).length,4);assert.equal(button.disabled,false);assert.equal(c.commands().length,1);
    if(outcome==='false')assert.match(c.w.document.body.textContent,/no longer held/);else if(outcome==='error')assert.match(c.w.document.body.textContent,/synthetic action failure/i);else assert.doesNotMatch(c.w.document.body.textContent,/no longer held|synthetic action failure/i);
    // Remove discards and does not silently put content into the draft.
    assert.equal(c.f.readDraft(TARGET),'');
    return {action,outcome,unchangedQueue:plain(before),wire:payload};
  });
});

test('live duplicate is read-only and held duplicate removal sends its exact owner ID',async t=>{
  await withQueue(t,async c=>{
    await c.update(actionableQueue(1));const before=c.store.getState().queuedMessages;
    assert.equal(rows(c.w)[0].querySelector('button[aria-label="Remove queued message"]')===null,true);
    const held=rows(c.w)[1].querySelector('button[aria-label="Remove queued message"]');
    await c.act(()=>held.click());assert.equal(c.pending.length,1);
    assert.deepEqual(c.pending[0].payload,{sessionPath:TARGET,command:'remove_queued_message',params:{itemId:'held-b',queue:'steering'}});
    await c.act(()=>c.pending[0].resolve({removed:true}));assert.equal(c.store.getState().queuedMessages,before);
  });
});

// P2 drives the actual seed method after the real initial socket-open seed.
// Only HTTP completion is held; no controller parser/setter/adoption is stubbed.
for(const marker of [1,null])test(`P2 equal newer seed fences older marker rollback (${marker})`,async t=>{
  await withQueue(t,async c=>{
    await c.update(queueValue(marker));const before=c.store.getState().queuedMessages;let notices=0;c.store.subscribe((s,p)=>{if(s.queuedMessages!==p.queuedMessages)notices++});
    const a=await c.issue(),b=await c.issue();await c.settle(b,{queuedMessages:queueValue(marker)});assert.equal(c.store.getState().queuedMessages,before);assert.equal(notices,0);
    await c.settle(a,{queuedMessages:queueValue(0)});assert.equal(c.store.getState().queuedMessages,before);assert.equal(notices,0);assert.equal(c.commands().length,0);
    return {schedule:'A then B; equal B then older A',marker,notices,seeds:c.seeds.length};
  });
});
for(const outcome of ['pending','failed','malformed','missing','valid'])test(`P2 older seed stays ineligible when newer is ${outcome}`,async t=>{
  await withQueue(t,async c=>{
    await c.update(queueValue(1));const before=c.store.getState().queuedMessages;const a=await c.issue(),b=await c.issue();
    if(outcome==='failed')await c.settle(b,null,true);
    if(outcome==='malformed')await c.settle(b,{queuedMessages:{steering:[3],followUp:[]}});
    if(outcome==='missing')await c.settle(b,{isStreaming:false});
    if(outcome==='valid')await c.settle(b,{queuedMessages:queueValue(2)});
    const newer=c.store.getState().queuedMessages;
    await c.settle(a,{queuedMessages:queueValue(0)});assert.equal(c.store.getState().queuedMessages,newer);
    if(outcome!=='valid')assert.equal(newer,before);
    if(outcome==='pending'){await c.settle(b,{queuedMessages:queueValue(2)});assert.equal(c.store.getState().queuedMessages.liveSteered,2)}
    const latest=await c.issue();await c.settle(latest,{queuedMessages:queueValue(3)});assert.equal(c.store.getState().queuedMessages.liveSteered,3);assert.equal(c.commands().length,0);
    return {schedule:'A then B; A cannot transiently apply; C recovers',outcome,seeds:c.seeds.length};
  });
});
for(const observation of ['marker','equal','unknown','unknown-equal','away-back','invalid'])test(`P2 accepted event fences seed: ${observation}`,async t=>{
  await withQueue(t,async c=>{
    await c.update(queueValue(observation==='unknown-equal'?null:1));const initial=c.store.getState().queuedMessages,a=await c.issue();
    if(observation==='marker')await c.update(queueValue(2));
    if(observation==='equal')await c.update(queueValue(1));
    if(observation==='unknown'||observation==='unknown-equal')await c.update(queueValue('invalid'));
    if(observation==='away-back'){await c.update(queueValue(2));await c.update(queueValue(1))}
    if(observation==='invalid')await c.update({steering:[3],followUp:[]});
    const observed=c.store.getState().queuedMessages;if(['equal','unknown-equal','invalid'].includes(observation))assert.equal(observed,initial);
    await c.settle(a,{queuedMessages:queueValue(0)});
    if(observation==='invalid')assert.equal(c.store.getState().queuedMessages.liveSteered,0);else assert.equal(c.store.getState().queuedMessages,observed);
    const fresh=await c.issue();await c.settle(fresh,{queuedMessages:queueValue(3)});assert.equal(c.store.getState().queuedMessages.liveSteered,3);assert.equal(c.commands().length,0);
    return {observation,acceptedMarker:observed.liveSteered,freshSeedWorks:true};
  });
});
test('P2 a direct changed queue snapshot fences its older seed',async t=>{
  await withQueue(t,async c=>{await c.update(queueValue(1));const a=await c.issue();await c.act(()=>c.store.getState().setQueuedMessages(c.f.parseQueuedMessages(queueValue(2))));const before=c.store.getState().queuedMessages;await c.settle(a,{queuedMessages:queueValue(0)});assert.equal(c.store.getState().queuedMessages,before)});
});
test('P2 ineligible store-path invocation does not steal an eligible ticket',async t=>{
  await withQueue(t,async c=>{
    await c.update(queueValue(0));const before=c.store.getState().queuedMessages,a=await c.issue();await c.act(()=>c.store.setState({sessionPath:TARGET_B}));const b=await c.issue();await c.act(()=>c.store.setState({sessionPath:TARGET}));
    await c.settle(b,{queuedMessages:queueValue(2)});assert.equal(c.store.getState().queuedMessages,before);await c.settle(a,{queuedMessages:queueValue(1)});assert.equal(c.store.getState().queuedMessages.liveSteered,1);
  });
});
test('P2 matching store path is required at queue response and event acceptance',async t=>{
  await withQueue(t,async c=>{
    await c.update(queueValue(0));const before=c.store.getState().queuedMessages,a=await c.issue();await c.act(()=>c.store.setState({sessionPath:TARGET_B}));await c.update(queueValue(2));assert.equal(c.store.getState().queuedMessages,before);
    await c.settle(a,{queuedMessages:queueValue(1),model:'model-path-control'});assert.equal(c.store.getState().queuedMessages,before);assert.equal(c.store.getState().sessionModel.model,'model-path-control');
    await c.act(()=>c.store.setState({sessionPath:TARGET}));const fresh=await c.issue();await c.settle(fresh,{queuedMessages:queueValue(3)});assert.equal(c.store.getState().queuedMessages.liveSteered,3);
  });
});
test('P2 older queue ticket rejection does not reject an independently current model',async t=>{
  await withQueue(t,async c=>{
    await c.update(queueValue(1));const before=c.store.getState().queuedMessages,a=await c.issue(),b=await c.issue();
    await c.settle(a,{queuedMessages:queueValue(0),model:'model-from-A'});assert.equal(c.store.getState().queuedMessages,before);assert.equal(c.store.getState().sessionModel.model,'model-from-A');
    await c.settle(b,{queuedMessages:queueValue(2),model:'model-from-B'});assert.equal(c.store.getState().queuedMessages.liveSteered,2);assert.equal(c.store.getState().sessionModel.model,'model-from-A');
  });
});
test('P2 valid queue adoption preserves an independently changed model',async t=>{
  await withQueue(t,async c=>{await c.update(queueValue(1));const a=await c.issue();await c.act(()=>c.store.getState().setSessionModel({model:'independently-new'}));const model=c.store.getState().sessionModel;await c.settle(a,{queuedMessages:queueValue(2),model:'stale-model'});assert.equal(c.store.getState().queuedMessages.liveSteered,2);assert.equal(c.store.getState().sessionModel,model)});
});
test('P2 event queue invalidation leaves original model guard independent',async t=>{
  await withQueue(t,async c=>{await c.update(queueValue(1));const a=await c.issue();await c.update(queueValue(2));const before=c.store.getState().queuedMessages;await c.settle(a,{queuedMessages:queueValue(0),model:'eligible-model'});assert.equal(c.store.getState().queuedMessages,before);assert.equal(c.store.getState().sessionModel.model,'eligible-model')});
});
for(const boundary of ['same-path reopen','A-B-A','close','dispose'])test(`P2 ordinary generation fences old seed/event across ${boundary}`,async t=>{
  await withQueue(t,async c=>{
    await c.update(queueValue(1));const a=await c.issue(),retiredCallback=c.socket.onmessage;
    if(boundary==='close'||boundary==='dispose')await c.act(()=>boundary==='close'?c.controller.closeSession():c.controller.dispose());
    if(boundary==='A-B-A'){await c.open(TARGET_B);const middle=c.seeds.at(-1);await c.settle(middle,{queuedMessages:queueValue(2)})}
    await c.open(TARGET);const fresh=c.seeds.at(-1),before=c.store.getState().queuedMessages;assert.equal(c.store.getState().sessionPath,TARGET);assert.equal(before.liveSteered,0);
    await c.act(()=>retiredCallback({data:JSON.stringify({type:'event',event:{type:'queue_update',...queueValue(3)}})}));assert.equal(c.store.getState().queuedMessages,before);
    await c.settle(a,{queuedMessages:queueValue(1),model:'obsolete-model'});assert.equal(c.store.getState().queuedMessages,before);assert.notEqual(c.store.getState().sessionModel?.model,'obsolete-model');
    await c.settle(fresh,{queuedMessages:queueValue(2),model:'new-lifetime'});assert.equal(c.store.getState().queuedMessages.liveSteered,2);assert.equal(c.store.getState().sessionModel.model,'new-lifetime');assert.equal(c.commands().length,0);
    return {boundary,oldWorkRejected:true,newSeedAccepted:true,seeds:c.seeds.length};
  });
});

test('queued promotion follows confirmed owner transitions; bridge preserves Edit/Remove without resending',async t=>{
  await withQueue(t,async c=>{
    await c.update(actionableQueue(0));
    const follow=()=>rows(c.w).at(-1);
    for(const [index,kind] of ['bridge','child','collab','child','ambiguous'].entries()){
      await c.act(()=>c.store.getState().reconcileSessionState(TARGET,{sessionState:authority(kind,index+2)},index+2));
      assert.equal(!!follow().querySelector('button[aria-label="Send now"]'),kind==='child');
      assert.equal(!!follow().querySelector('button[aria-label="Edit"]'),true);
      assert.equal(!!follow().querySelector('button[aria-label="Remove queued message"]'),true);
      if(kind!=='child')await assert.rejects(c.controller.promoteQueuedMessage('later','held-follow-up'),/cannot send queued/);
    }
    assert.equal(c.commands().length,0);
  });
});

for(const [kind,confidence,restore] of [['collab','confirmed',false],['child','confirmed',true],['bridge','confirmed',true],['collab','inferred',true],['ambiguous','confirmed',true]])test(`Stop owner=${kind}/${confidence} uses restoreQueue=${restore}`,async t=>{
  await withQueue(t,async c=>{
    await c.act(()=>c.store.getState().reconcileSessionState(TARGET,{sessionState:authority(kind,2,confidence)},2));
    let recovered;
    await c.act(async()=>{assert.equal(await c.controller.abortTurn(TARGET,withdrawn=>{recovered=plain(withdrawn)}),true)});
    const stop=c.requests.find(row=>row.path==='/api/abort');
    assert.deepEqual(stop.body,{sessionPath:TARGET,restoreQueue:restore});
    if(restore)assert.equal(recovered.messages[0].images[0].data,'synthetic-photo');
    else assert.equal(recovered,undefined);
  },restore?{}:{abortResult:{ok:true}});
});

test('Stop control refusal is surfaced and never retried using a lossy plain abort',async t=>{
  await withQueue(t,async c=>{
    await c.act(()=>c.store.getState().reconcileSessionState(TARGET,{sessionState:authority('bridge',2)},2));
    await assert.rejects(c.controller.abortTurn(TARGET),/queue withdrawal unavailable/);
    assert.match(c.store.getState().error,/queue withdrawal unavailable/);
    assert.equal(c.requests.filter(row=>row.path==='/api/abort').length,1);
    assert.equal(c.requests.find(row=>row.path==='/api/abort').body.restoreQueue,true);
  },{abortResult:{ok:false,error:'queue withdrawal unavailable'}});
});
