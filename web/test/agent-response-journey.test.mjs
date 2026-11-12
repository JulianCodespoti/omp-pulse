import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,act,useState,useEffect,useSyncExternalStore} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {ChatScreen} from ${JSON.stringify(resolve(root,'web/src/app/ChatScreen.tsx'))};
import {SessionSwitcher} from ${JSON.stringify(resolve(root,'web/src/app/nav/SessionSwitcher.tsx'))};
import {setPanelsSession} from ${JSON.stringify(resolve(root,'web/src/app/nav/panels.ts'))};
import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
import * as queue from ${JSON.stringify(resolve(root,'web/src/runtime/offline-queue.ts'))};
const store=createOmpStore(),sent=[],reads=[],receiptReads=[];window.drafts=new Map();
const namespace=queue.offlineQueueNamespaceForCredential('');queue.setOfflineQueueNamespace(namespace);

const agents=[{id:'agent-a',displayName:'Research agent',kind:'sub',status:'running',createdAt:7,hasSessionFile:true}];
const sessions=['a','b'].map(id=>({id,path:'/synthetic/'+id,title:'Session '+id,cwd:'/synthetic/project',activeAt:Date.now(),snippet:{text:'Synthetic parent conversation'}}));
store.setState({sessions,sessionsUpdatedAt:Date.now(),connection:'open',collabAgents:agents,collabAttached:true,sessionModel:{model:'synthetic',contextWindow:1000}});
DaemonApi.prototype.getState=async()=>({model:'synthetic'});
DaemonApi.prototype.getAvailableModels=async()=>[];
DaemonApi.prototype.getDesktopAgentRoster=async session=>{if(window.rpc){const error=Error('No desktop host');error.code='host_unavailable';throw error;}if(window.holdRoster)await new Promise(resolve=>window.finishRoster=resolve);return{ok:true,agents:store.getState().collabAgents,connectionId:window.connectionId??'connection-a'}};
DaemonApi.prototype.getDesktopAgentTranscript=async(session,id,fromByte)=>{reads.push({session,id,fromByte});const text=fromByte?'':JSON.stringify({type:'message',id:'agent-answer',message:{role:'assistant',content:[{type:'text',text:'Actual synthetic agent answer: reviewed the source.'}]}})+'\\n';return{ok:true,agentId:id,connectionId:window.connectionId??'connection-a',fromByte,text,nextByte:fromByte+new TextEncoder().encode(text).length,reset:false}};
for(const name of ['getSubagents','getSubagentMessages','collabAttach','steerSubagent','cancelSubagent','prompt'])DaemonApi.prototype[name]=()=>{throw Error('Unexpected direct agent operation '+name)};
DaemonApi.prototype.getSubagents=async()=>{if(!window.rpc)throw Error('Unexpected RPC roster');return{agents:[{id:'rpc-a',name:'Child researcher',status:'done',createdAt:9}]}};
DaemonApi.prototype.getSubagentMessages=async(session,options)=>{if(!window.rpc)throw Error('Unexpected RPC transcript');reads.push({session,id:options.subagentId});return{entries:[{type:'message',id:'rpc-entry',message:{role:'assistant',content:[{type:'text',text:'Actual child agent answer'}]}}],nextByte:100}};
const controller={queueNamespace:namespace,baseUrl:'http://synthetic.invalid',
canRetainCollabAnswer:()=>false,
getReceiptScope:OmpSessionController.prototype.getReceiptScope,getSavedPrompts:OmpSessionController.prototype.getSavedPrompts,
inspectCommandReceipt:OmpSessionController.prototype.inspectCommandReceipt,getReceipt:OmpSessionController.prototype.getReceipt,
fetchAuthed:async(url,init)=>{receiptReads.push({url,method:init?.method??'GET'});const entry=queue.getSnapshot().find(e=>url.split("?")[0].endsWith(encodeURIComponent(e.commandId)));return{ok:true,status:200,json:async()=>({ok:true,receiptBinding:{version:1,requestedSessionPath:entry.sessionPath,canonicalSessionPath:'/canonical/a'},receipt:{commandId:entry.commandId,sessionPath:'/canonical/a',state:window.receiptState??'forwarded',createdAt:entry.createdAt,updatedAt:Date.now()}})}},
querySwitcherSessions:async()=>store.getState().sessions,
getStore:()=>store,loadSessions:async()=>{},loadCommands:async()=>[],startSessionsPolling(){},stopSessionsPolling(){},setAtBottom(){},prewarm:async()=>{},sendPrompt:async(text,images,path,onSaved)=>{const entry=await queue.enqueue({text,images,sessionPath:path,namespace});sent.push({text,images,path,commandId:entry.commandId});if(window.holdSend)await new Promise(resolve=>window.finishSend=async()=>{await onSaved();resolve()});else await onSaved();}};
// The chat, mounted the way App.tsx mounts it: its workspace pages live in
// the chat's own tab row (SessionPager), keyed by session.
function App(){const [chat,setChat]=useState(false);const openPath=useSyncExternalStore(store.subscribe,()=>store.getState().sessionPath);
useEffect(()=>{setPanelsSession(chat?openPath:null)},[chat,openPath]);
return chat?h(ChatScreen,{key:'chat',controller,onBack:()=>setChat(false)}):h(SessionSwitcher,{controller,active:true,currentPath:null,onSwitch:path=>{store.setState({sessionPath:path});setChat(true)}})}
window.fixture={act,store,sent,reads,receiptReads,mount(){const r=createRoot(document.getElementById('root'));r.render(h(App));return r}};
`,[{name:'synthetic-attachment-persistence',resolveId(id,importer){return importer?.endsWith('/attachment-draft.ts')&&id==='./offline-queue'?'\0attachments':null},load(id){if(id==='\0attachments')return `export * from ${JSON.stringify(resolve(root,'web/src/runtime/offline-queue.ts'))}; export const loadDraftAttachments=async path=>window.drafts.get(path)??[];export const saveDraftAttachments=async(path,images)=>{window.drafts.set(path,images);return true}; export const registerDraftAttachmentFlusher=()=>()=>{};`;return null;}}]);
async function fixture(t){
 const dom=createDomFixture(code),w=dom.window,f=w.fixture;
 w.TextEncoder=TextEncoder;w.Element.prototype.getAnimations=()=>[];w.HTMLElement.prototype.scrollTo=()=>{};w.HTMLElement.prototype.scrollIntoView=()=>{};
 w.fetch=async url=>{assert.match(String(url),/^\/api\/(agents\?|awaiting|changes\?)/);return{ok:true,json:async()=>String(url).startsWith('/api/changes?')?{ok:true,files:[],notRepo:false}:{agents:[],sessions:[]}}};
 w.drafts.set('/synthetic/a',[{data:'c3ludGhldGlj',mimeType:'image/png',previewUrl:'data:image/png;base64,c3ludGhldGlj',name:'kept.png',width:1,height:1}]);
 let mounted;await f.act(async()=>{mounted=f.mount()});
 t.after(async()=>{try{await f.act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const get=s=>w.document.querySelector(s),act=async fn=>{await f.act(async()=>{fn?.()});await f.act(async()=>{await new Promise(r=>w.setTimeout(r,60))})};
 const click=async s=>{const b=get(s);assert.ok(b,s);await act(()=>b.click())};
 const type=async value=>act(()=>{const node=get('[data-testid="composer-input"]');Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(node,value);node.dispatchEvent(new w.Event('input',{bubbles:true}))});
 const session=[...w.document.querySelectorAll('[role="button"],button')].find(n=>n.textContent.includes('Session a'));
 assert.ok(session,'real session row');await act(()=>session.click());
 // The Agents tab of the chat's tab row shows the roster.
 // The workspace is a drawer; the header's workspace button opens it.
 const open=async()=>{if(get('[data-testid="open-workspace"]'))await click('[data-testid="open-workspace"]');await click('[data-testid="workspace-tabs"] [data-value="agents"]');assert.equal(get('[data-testid="workspace-tabs"] [data-value="agents"]').getAttribute('aria-selected'),'true');await click('[data-desktop-agent="agent-a"]');assert.match(get('[data-testid="agent-transcript"]').textContent,/Actual synthetic agent answer/)};
 const reference=async(index=0)=>{const buttons=w.document.querySelectorAll('[data-testid="compact-reference-details"]');assert.ok(buttons[index],'prepared reference Details');await act(()=>buttons[index].click());const block=get('[data-testid="compact-reference-text"]').textContent;await click('[data-testid="sheet-close"]');return block};
 return{w,f,get,act,click,type,open,reference,input:()=>get('[data-testid="composer-input"]')};
}
test('real session → agent transcript → existing parent draft → deliberate Send → return',async t=>{
 const f=await fixture(t);assert.equal(f.get('[data-testid="tab-badge-agents"]')?.textContent,'1','the working desktop agent badges the Agents tab');await f.type('Keep my exact draft  ');const input=f.input();input.setSelectionRange(3,8,'backward');await f.open();
 assert.equal(f.f.sent.length,0);assert.equal(f.f.reads[0].session,'/synthetic/a');
 await f.click('[data-testid="agent-prepare-response"]');
 assert.ok(!f.get('[data-testid="agent-transcript"]'));assert.equal(f.input(),input);
 assert.equal(input.value,'Keep my exact draft  ');const reference=await f.reference();assert.match(reference,/^About agent "Research agent" /);assert.match(reference,/"id":"agent-a"/);assert.match(reference,/"createdAt":7/);assert.match(reference,/"source":"desktop"/);
 assert.equal(input.selectionStart,3);assert.equal(input.selectionEnd,8);assert.equal(input.selectionDirection,'backward');
 assert.equal(f.get('[data-testid="attachment-strip"] img').getAttribute('alt'),'kept.png');assert.equal(f.f.sent.length,0);
 const prepared=input.value;await f.open();await f.click('[data-testid="agent-prepare-response"]');assert.equal(input.value,prepared);assert.equal(await f.reference(),reference);assert.equal(f.f.sent.length,0);
 await f.type(prepared+'\nPlease summarize what this means.');await f.click('[data-testid="composer-send-btn"]');
 assert.equal(f.f.sent.length,1);assert.equal(f.f.sent[0].path,'/synthetic/a');assert.equal(f.f.sent[0].images[0].data,'c3ludGhldGlj');assert.equal(f.f.sent[0].text,prepared+'\nPlease summarize what this means.\n\n'+reference);assert.equal(input.value,'');
 await f.open();await f.click('[aria-label="Back to agents"]');assert.ok(!f.get('[data-testid="agent-transcript"]'));await f.click('[data-testid="workspace-close"]');assert.equal(f.f.sent.length,1);
});
test('command draft is left unchanged with a visible explanation and no send',async t=>{
 const f=await fixture(t);await f.type('/compact keep this');await f.open();await f.click('[data-testid="agent-prepare-response"]');assert.equal(f.input().value,'/compact keep this');assert.match(f.get('[data-testid="workspace-tab-agents"] [role="alert"]').textContent,/draft starts with a command/);assert.equal(f.f.sent.length,0);assert.ok(f.get('[data-testid="agent-transcript"]'));
});
test('double activation before commit appends one reference and sends nothing',async t=>{
 const f=await fixture(t);await f.type('Draft');await f.open();const button=f.get('[data-testid="agent-prepare-response"]');await f.act(()=>{button.click();button.click()});assert.equal(f.input().value,'Draft');assert.equal(f.w.document.querySelectorAll('[data-testid="compact-reference-row"]').length,1);assert.match(await f.reference(),/About agent /);assert.equal(f.f.sent.length,0);
});
for(const kind of ['session','source','roster'])test('uncommitted '+kind+' replacement fences the visible prepare action',async t=>{
 const f=await fixture(t);await f.type('Original draft');await f.open();const button=f.get('[data-testid="agent-prepare-response"]');await f.act(()=>{f.f.store.setState(kind==='session'?{sessionPath:'/synthetic/b'}:kind==='source'?{connection:'offline'}:{collabAgents:[]});button.click()});assert.equal(f.f.sent.length,0);if(kind!=='session')assert.equal(f.input().value,'Original draft');else {await f.act(()=>f.f.store.setState({sessionPath:'/synthetic/a'}));assert.equal(f.input().value,'Original draft')}
});
test('preparing context during an earlier send preserves new text after its acknowledgement',async t=>{
 const f=await fixture(t);await f.type('Earlier message');f.w.holdSend=true;await f.click('[data-testid="composer-send-btn"]');assert.equal(f.f.sent.length,1);await f.type('New draft');await f.open();await f.click('[data-testid="agent-prepare-response"]');const prepared=f.input().value,reference=await f.reference();await f.f.act(async()=>f.w.finishSend());assert.equal(f.input().value,prepared);assert.equal(await f.reference(),reference);assert.equal(f.f.sent.length,1);
});
test('empty draft adds only identity with caret ready for intent; deleting it permits another prepare',async t=>{
 const f=await fixture(t);await f.open();await f.click('[data-testid="agent-prepare-response"]');const first=await f.reference();
 assert.equal(f.input().value,'');assert.match(first,/^About agent "Research agent" \{"id":"agent-a","source":"desktop","createdAt":7,"connectionId":"connection-a"\}:\n$/);
 assert.equal(f.input().selectionStart,0);assert.equal(f.input().selectionEnd,0);assert.equal(f.f.sent.length,0);
 await f.click('[data-testid="compact-reference-remove"]');assert.ok(!f.get('[data-testid="compact-reference-row"]'));await f.open();await f.click('[data-testid="agent-prepare-response"]');assert.equal(f.input().value,'');assert.equal(await f.reference(),first);assert.equal(f.f.sent.length,0);
});
test('renaming the selected agent uses its current name and does not duplicate an existing identity',async t=>{
 const f=await fixture(t);await f.open();await f.act(()=>f.f.store.setState({collabAgents:f.f.store.getState().collabAgents.map(a=>({...a,displayName:'Renamed agent'}))}));
 await f.click('[data-testid="agent-prepare-response"]');assert.equal(f.input().value,'');const first=await f.reference();assert.match(first,/About agent "Renamed agent"/);
 await f.open();await f.act(()=>f.f.store.setState({collabAgents:f.f.store.getState().collabAgents.map(a=>({...a,displayName:'Another name'}))}));await f.click('[data-testid="agent-prepare-response"]');assert.equal(f.input().value,'');assert.equal(await f.reference(),first);
});
test('pending roster cannot prepare an unbound identity before its desktop connection arrives',async t=>{
 const f=await fixture(t);f.w.holdRoster=true;await f.open();assert.equal(f.get('[data-testid="agent-prepare-response"]').disabled,true);await f.click('[data-testid="agent-prepare-response"]');assert.equal(f.input().value,'');
 await f.act(()=>{f.w.holdRoster=false;f.w.finishRoster()});assert.equal(f.get('[data-testid="agent-prepare-response"]').disabled,false);await f.click('[data-testid="agent-prepare-response"]');const prepared=await f.reference();await f.open();await f.click('[data-testid="agent-prepare-response"]');assert.equal(f.input().value,'');assert.equal(await f.reference(),prepared);
});
test('same ID with absent creation time in another desktop connection remains a distinct reference',async t=>{
 const f=await fixture(t);await f.act(()=>f.f.store.setState({collabAgents:f.f.store.getState().collabAgents.map(({createdAt,...a})=>a)}));await f.open();await f.click('[data-testid="agent-prepare-response"]');f.w.connectionId='connection-b';await f.open();await f.click('[data-testid="agent-prepare-response"]');assert.equal(f.input().value,'');assert.equal(f.w.document.querySelectorAll('[data-testid="compact-reference-row"]').length,2);assert.match(await f.reference(0),/connection-a/);assert.match(await f.reference(1),/connection-b/);assert.equal(f.f.sent.length,0);
});
test('confirmed child-owned agent uses the same draft-only route without desktop or control commands',async t=>{
 const f=await fixture(t);f.w.rpc=true;await f.act(()=>f.f.store.setState({collabAgents:[],collabAttached:false,sessionAuthorities:{'/synthetic/a':{owner:{kind:'child'},confidence:'confirmed',connection:'connected',daemonInstanceId:'daemon-a',revision:1,bindingEpoch:1,turn:'idle',observedAt:Date.now(),activity:null,capabilities:{send:true}}}}));
 // No desktop roster means no agents badge; the Agents tab is still the route.
 await f.type('Child draft');assert.equal(f.get('[data-testid="tab-badge-agents"]'),null);await f.click('[data-testid="open-workspace"]');await f.click('[data-testid="workspace-tabs"] [data-value="agents"]');await f.click('[data-rpc-agent="rpc-a"]');assert.match(f.get('[data-testid="agent-transcript"]').textContent,/Actual child agent answer/);assert.equal(f.f.reads.at(-1).id,'rpc-a');assert.equal(f.f.reads.at(-1).session,'/synthetic/a');await f.click('[data-testid="agent-prepare-response"]');assert.equal(f.input().value,'Child draft');const reference=await f.reference();assert.match(reference,/"source":"rpc"/);assert.match(reference,/"id":"rpc-a"/);assert.equal(f.f.sent.length,0);
});
test('preparing a draft cannot override the current parent Send capability',async t=>{
 const f=await fixture(t);await f.act(()=>f.f.store.setState({sessionAuthorities:{'/synthetic/a':{owner:{kind:'collab'},confidence:'confirmed',connection:'connected',daemonInstanceId:'daemon-a',revision:1,bindingEpoch:1,turn:'idle',observedAt:Date.now(),activity:null,capabilities:{send:false}}}}));await f.open();await f.click('[data-testid="agent-prepare-response"]');assert.equal(f.input().value,'');assert.match(await f.reference(),/About agent/);assert.equal(f.get('[data-testid="composer-send-btn"]').disabled,true);await f.click('[data-testid="composer-send-btn"]');assert.equal(f.f.sent.length,0);
});


test('composed read → review draft → Send → one durable row → return',async t=>{
 const f=await fixture(t);await f.type('Please check this');await f.open();
 await f.click('[data-testid="agent-prepare-response"]');assert.equal(f.f.sent.length,0);assert.equal(f.input().value,'Please check this');const reference=await f.reference();assert.match(reference,/Research agent/);
 await f.click('[data-testid="composer-send-btn"]');assert.equal(f.f.sent.length,1);assert.equal(f.f.sent[0].text,'Please check this\n\n'+reference);const id=f.f.sent[0].commandId;
 // The saved send has no transcript echo in this fixture, so the queue stack
 // above the composer is its one surface; no receipt detail is fetched.
 assert.equal(f.w.document.querySelectorAll('[data-testid="queued-message"][data-command-id="'+id+'"]').length,1);assert.equal(f.input().value,'');
 assert.equal(f.get('[aria-label="Last send details"]'),null);assert.equal(f.f.receiptReads.length,0);
 await f.open();assert.match(f.get('[data-testid="agent-transcript"]').textContent,/Actual synthetic agent answer/);assert.equal(f.f.sent.length,1);
});
