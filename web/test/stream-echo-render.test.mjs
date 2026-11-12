import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,act,useSyncExternalStore} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {MessageParts} from ${JSON.stringify(resolve(root,'web/src/app/parts/MessageParts.tsx'))};
import {visibleStreamingMessage} from ${JSON.stringify(resolve(root,'web/src/domain/stream-visibility.ts'))};
import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
import {entryToUiMessage} from ${JSON.stringify(resolve(root,'web/src/domain/messages.ts'))};
const store=createOmpStore();const controller=Object.create(OmpSessionController.prototype);
Object.assign(controller,{store,activeSession:'/synthetic',clockShift:0,flushHandle:null,pendingDeltas:[],responseChain:null,streamText:''});
function Transcript(){const messages=useSyncExternalStore(store.subscribe,()=>store.getState().messages);return h('section',{'data-history':true},messages.map(m=>h(MessageParts,{key:m.id,message:m})));}
function Live(){const shown=useSyncExternalStore(store.subscribe,()=>visibleStreamingMessage(store.getState().messages,store.getState().streamingMessage));return shown?h('section',{'data-live':true},h(MessageParts,{message:shown,isStreaming:true})):null;}
window.fixture={act,store,controller,persist:message=>store.getState().mergeMessages([entryToUiMessage({type:'message',id:'persisted',message},0)]),mount(){const r=createRoot(document.getElementById('root'));r.render(h('main',{},h(Transcript),h(Live)));return r;}};
`,[{name:'test-import-meta',options(options){return {...options,transform:{...options.transform,define:{...options.transform?.define,'import.meta':'{}'}}}}}]);
const text='This answer should appear once.';
const reply=(id,key='response:r1')=>({id,responseKey:key,role:'assistant',text,parts:[{kind:'text',text}]});
async function fixture(t){const dom=createDomFixture(code),w=dom.window,{act,store}=w.fixture;let r;await act(async()=>{r=w.fixture.mount()});t.after(async()=>{try{await act(async()=>r.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});return{w,act,store,count:()=>w.document.body.textContent.split(text).length-1,set:state=>act(async()=>store.setState(state))};}
test('history plus fresh live tool metadata renders the answer once and keeps the tool',async t=>{
 const f=await fixture(t),history=reply('persisted'),tool={kind:'tool',callId:'t1',name:'bash',args:{command:'synthetic command'},state:'ok',output:'fixture output'};
 const live={...reply('live:r1'),parts:[{kind:'text',text},tool]};
 await f.set({messages:[history],streamingMessage:live});assert.equal(f.count(),1);assert.match(f.w.document.querySelector('[data-live]').textContent,/synthetic command/);
 assert.equal(f.store.getState().streamingMessage.text,text);await f.set({messages:[{...history,parts:live.parts}]});assert.equal(f.count(),1);assert.equal(f.w.document.querySelector('[data-live]') === null, true);
});
test('error-only live projection remains visible without a second answer',async t=>{
 const f=await fixture(t);await f.set({messages:[reply('persisted')],streamingMessage:{...reply('live:r1'),errorMessage:'Provider connection interrupted'}});assert.equal(f.count(),1);
 const notice=f.w.document.querySelector('[data-live] [data-testid="turn-error"]');assert.equal(notice.getAttribute('role'),'alert');assert.match(notice.textContent,/Couldn't get a reply/);assert.match(notice.textContent,/Provider connection interrupted/);
});
test('distinct responses containing identical words remain two genuine messages',async t=>{
 const f=await fixture(t);await f.set({messages:[reply('persisted')],streamingMessage:reply('live:r2','response:r2')});assert.equal(f.count(),2);
});

test('real controller replay keeps prose single through history, tool start/update/end and commit',async t=>{
 const f=await fixture(t),wire={role:'assistant',responseId:'r1',timestamp:1700000000000,content:[{type:'text',text},{type:'toolCall',id:'t1',name:'bash',arguments:{command:'fixture command'}}]};
 await f.act(async()=>f.w.fixture.controller.setStreamingMessage(wire));assert.equal(f.count(),1);
 await f.act(async()=>f.w.fixture.persist(wire));assert.equal(f.count(),1);
 for(const event of [
  {type:'tool_execution_start',toolCallId:'t1',toolName:'bash',args:{command:'fixture command'}},
  {type:'tool_execution_update',toolCallId:'t1',partialResult:'fixture output'},
  {type:'tool_execution_end',toolCallId:'t1',result:'fixture output',isError:false},
 ]){await f.act(async()=>f.w.fixture.controller.reduceToolExecution(event));assert.equal(f.count(),1,event.type);}
 await f.act(async()=>f.w.fixture.controller.commitStreamingMessage(wire));assert.equal(f.count(),1);assert.equal(f.store.getState().messages.length,1);assert.equal(f.store.getState().streamingMessage === null, true);
 const tool=f.store.getState().messages[0].parts.find(p=>p.kind==='tool');assert.equal(tool.state,'ok');assert.equal(tool.output,'fixture output');
});
