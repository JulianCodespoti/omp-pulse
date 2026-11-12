import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {memoryIndexedDb} from './support/memory-indexeddb.mjs';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));

// Sheets render inline (title, leading, subHeader, body, footer) so the
// fixture can drive them without the dialog portal.
const sheetShell=[{name:'sheet-shell',
 resolveId:(id,importer)=>/\/(NewSessionScreen|ModelPicker)\.tsx$/.test(importer??'')&&id==='../ui/Sheet'?'\0sheet':null,
 load:id=>id==='\0sheet'?`import {createElement as h} from ${JSON.stringify(require.resolve('react'))};
 export * from ${JSON.stringify(resolve(root,'web/src/app/ui/Sheet.tsx'))};
 export const BottomSheet=({open,onOpenChange,title,leading,subHeader,children,footer,testId})=>open?h('section',{'data-testid':testId},
  h('h2',{'data-testid':'sheet-title'},title),leading,h('button',{'aria-label':'Close',onClick:()=>onOpenChange(false)}),subHeader,children,footer):null;`:null}];

// ── Project sheet and folder browser ────────────────────────────────────
const browserCode=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {ProjectSheet} from ${JSON.stringify(resolve(root,'web/src/app/sessions/NewSessionScreen.tsx'))};
 import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
 const requests=[],selected=[],closed=[];
 DaemonApi.prototype.browse=path=>new Promise((resolve,reject)=>requests.push({path,resolve,reject}));
 let r,props={projects:[],selected:null};
 const render=(open,next)=>{props={...props,...next};r.render(h(ProjectSheet,{open,...props,onSelect:cwd=>selected.push(cwd),onOpenChange:v=>closed.push(v)}))};
 window.fixture={act,requests,selected,closed,render,mount:(next)=>{r=createRoot(document.getElementById('root'));render(true,next);return r}};
`,sheetShell);
const listing=(path,parent='/',dirs=[{name:'alpha',path:'/alpha'},{name:'beta',path:'/beta'}])=>({path,parent,dirs});
async function browser(t,{stored,home,projects,selected}={}){
 const dom=createDomFixture(browserCode),w=dom.window,{act,requests,render}=w.fixture;
 if(stored)w.localStorage.setItem('omp-dirp-last',stored);
 if(home)w.localStorage.setItem('omp-dirp-home',home);
 let mounted;await act(async()=>{mounted=w.fixture.mount({projects:projects??[],selected:selected??null})});
 t.after(async()=>{try{await act(async()=>mounted?.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const q=s=>w.document.querySelector(s),qa=s=>Array.from(w.document.querySelectorAll(s));
 return {w,act,requests,q,qa,render:(open,next)=>act(async()=>render(open,next)),
  settle:(i,path,parent,dirs)=>act(async()=>requests[i].resolve(listing(path,parent,dirs))),
  reject:(i,message='Permission denied')=>act(async()=>requests[i].reject(Error(message))),
  click:name=>act(async()=>qa('[data-testid="dir-row"]').find(b=>b.textContent===name).click()),
  tap:el=>act(async()=>el.click()),
  use:()=>q('[data-testid="folder-use"]'),
  current:()=>q('[data-testid="folder-crumb-current"]')?.textContent,
  crumbs:()=>qa('[data-testid="folder-crumb"],[data-testid="folder-crumb-current"]').map(c=>c.textContent),
  text:()=>w.document.body.textContent,
  selected:()=>Array.from(w.fixture.selected),closed:()=>Array.from(w.fixture.closed),
  unmount:()=>act(async()=>{mounted.unmount();mounted=null})};
}
test('a slower folder cannot replace the latest folder or remembered destination',async t=>{
 const f=await browser(t);await f.settle(0,'/home');await f.click('alpha');await f.click('beta');
 await f.settle(2,'/beta');await f.settle(1,'/alpha');
 assert.equal(f.w.localStorage.getItem('omp-dirp-last'),'/beta');assert.equal(f.current(),'beta');
});
test('an older completion cannot enable Use while a newer folder is loading',async t=>{
 const f=await browser(t);await f.settle(0,'/home');await f.click('alpha');await f.click('beta');
 await f.settle(1,'/alpha');assert.equal(f.use().disabled,true);
 await f.settle(2,'/beta');assert.equal(f.use().disabled,false);
});
test('a stale failed browse cannot replace the latest successful folder with an error',async t=>{
 const f=await browser(t);await f.settle(0,'/home');await f.click('alpha');await f.click('beta');
 await f.settle(2,'/beta');await f.reject(1);
 assert.equal(f.text().includes('Couldn’t open this folder'),false);
});
test('closing the sheet invalidates a late successful remembered-folder write',async t=>{
 const f=await browser(t);await f.render(false);await f.settle(0,'/old');
 assert.equal(f.w.localStorage.getItem('omp-dirp-last'),null);
});
test('a previous open cannot overwrite the current open',async t=>{
 const f=await browser(t);await f.render(false);await f.render(true);
 await f.settle(1,'/new');await f.settle(0,'/old');assert.equal(f.w.localStorage.getItem('omp-dirp-last'),'/new');
});
test('stale remembered-folder failure must not clear storage or start fallback',async t=>{
 const f=await browser(t,{stored:'/remembered'});await f.render(false);await f.render(true);
 await f.settle(1,'/current');await f.reject(0);
 assert.equal(f.requests.length,2);assert.equal(f.w.localStorage.getItem('omp-dirp-last'),'/current');
});
test('unmount invalidates the in-flight home fallback',async t=>{
 const f=await browser(t,{stored:'/missing'});await f.reject(0);assert.equal(f.requests.length,2);
 await f.unmount();await f.settle(1,'/fallback');assert.equal(f.w.localStorage.getItem('omp-dirp-last'),null);
});
test('a remembered folder that is gone falls back to home and learns it',async t=>{
 const f=await browser(t,{stored:'/missing'});await f.reject(0);assert.equal(f.requests[1].path,undefined);
 await f.settle(1,'/home/demo',null);assert.equal(f.w.localStorage.getItem('omp-dirp-last'),'/home/demo');
 assert.equal(f.w.localStorage.getItem('omp-dirp-home'),'/home/demo');assert.equal(f.use().disabled,false);
 assert.deepEqual(f.crumbs(),['Home']);
});
test('breadcrumbs run from home and open the exact ancestor',async t=>{
 const f=await browser(t,{home:'/home/demo',stored:'/home/demo/projects/omp-pulse'});
 await f.settle(0,'/home/demo/projects/omp-pulse','/home/demo/projects',[]);
 assert.deepEqual(f.crumbs(),['Home','projects','omp-pulse']);
 assert.equal(f.text().includes('Up one folder'),false);
 assert.equal(f.qa('.font-mono').length,0,'paths are never monospace');
 await f.tap(f.qa('[data-testid="folder-crumb"]')[1]);assert.equal(f.requests[1].path,'/home/demo/projects');
});
test('without a known home the reported parent is the one step up',async t=>{
 const f=await browser(t);await f.settle(0,'/srv/app','/srv',[]);
 assert.deepEqual(f.crumbs(),['srv','app']);
});
test('an empty folder says so and can still be used',async t=>{
 const f=await browser(t);await f.settle(0,'/home/demo/empty','/home/demo',[]);
 assert.ok(f.text().includes('No folders here'));assert.equal(f.use().disabled,false);
});
test('a no-match filter can be cleared without browsing again',async t=>{
 const f=await browser(t);await f.settle(0,'/home');
 const input=f.q('[data-testid="folder-filter"]');
 await f.act(async()=>{Object.getOwnPropertyDescriptor(f.w.HTMLInputElement.prototype,'value').set.call(input,'zzz');input.dispatchEvent(new f.w.Event('input',{bubbles:true}))});
 assert.equal(f.qa('[data-testid="dir-row"]').length,0);
 await f.tap(f.qa('button').find(b=>b.textContent==='Clear filter'));
 assert.equal(f.qa('[data-testid="dir-row"]').length,2);assert.equal(f.requests.length,1);
});
test('Use this folder selects the directory, remembers it and closes',async t=>{
 const f=await browser(t);await f.settle(0,'/home/demo/app');await f.tap(f.use());
 assert.deepEqual(f.selected(),['/home/demo/app']);assert.deepEqual(f.closed(),[false]);
 assert.equal(f.w.localStorage.getItem('omp-dirp-last'),'/home/demo/app');
});
test('an unreadable folder can be retried',async t=>{
 const f=await browser(t);await f.settle(0,'/home');await f.click('alpha');await f.reject(1);
 assert.ok(f.text().includes('Couldn’t open this folder.'));assert.equal(f.use().disabled,true);
 await f.tap(f.qa('button').find(b=>b.textContent==='Try again'));assert.equal(f.requests[2].path,'/alpha');
 await f.settle(2,'/alpha');assert.equal(f.use().disabled,false);assert.equal(f.current(),'alpha');
});
test('recent projects list first; Other folder opens the browser and Back returns',async t=>{
 const projects=[{cwd:'/home/demo/work/client/app',label:'app',lastActiveAt:Date.now()-3*3600_000,sessionCount:4},{cwd:'/srv/tool',label:'tool',lastActiveAt:0,sessionCount:1}];
 const f=await browser(t,{projects,selected:'/srv/tool'});
 assert.equal(f.requests.length,0,'the browser loads only when opened');
 assert.equal(f.q('[data-testid="sheet-title"]').textContent,'Project');
 const rows=f.qa('[data-testid="project-row"]');
 assert.deepEqual(rows.map(r=>r.dataset.cwd),['/home/demo/work/client/app','/srv/tool']);
 assert.match(rows[0].textContent,/…\/work\/client\/app · 4 sessions/);assert.match(rows[0].textContent,/3h/);
 assert.equal(rows[1].getAttribute('aria-pressed'),'true');
 await f.tap(f.q('[data-testid="project-other-folder"]'));
 assert.equal(f.q('[data-testid="sheet-title"]').textContent,'Choose folder');assert.equal(f.requests.length,1);
 await f.tap(f.q('button[aria-label="Back to projects"]'));
 assert.equal(f.q('[data-testid="sheet-title"]').textContent,'Project');
 await f.tap(f.q('[data-testid="project-row"]'));assert.deepEqual(f.selected(),['/home/demo/work/client/app']);assert.deepEqual(f.closed(),[false]);
});

// ── Start flow ──────────────────────────────────────────────────────────
const screenCode=await bundleDomFixture(`
 import {createElement as h,Fragment,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {NewSessionScreen} from ${JSON.stringify(resolve(root,'web/src/app/sessions/NewSessionScreen.tsx'))};
 import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
 import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
 import {readDraft} from ${JSON.stringify(resolve(root,'web/src/app/composer/use-draft.ts'))};
 import * as queue from ${JSON.stringify(resolve(root,'web/src/runtime/offline-queue.ts'))};
 import {getNewSessionDraft,clearNewSessionDraftMemory,flushNewSessionDraftWrites} from ${JSON.stringify(resolve(root,'web/src/runtime/new-session-draft.ts'))};
 import {clearAttachmentDrafts} from ${JSON.stringify(resolve(root,'web/src/runtime/attachment-draft.ts'))};
 import {clearAllDrafts} from ${JSON.stringify(resolve(root,'web/src/app/composer/use-draft.ts'))};
 import {ScreenActivityContext} from ${JSON.stringify(resolve(root,'web/src/app/nav/screen-activity.ts'))};
 import {PushedScreen} from ${JSON.stringify(resolve(root,'web/src/app/nav/PushedScreen.tsx'))};
 import {usePanels,openSettingsPage,closeSettings,resetPanels} from ${JSON.stringify(resolve(root,'web/src/app/nav/panels.ts'))};
 import {handleNativeBack} from ${JSON.stringify(resolve(root,'web/src/platform/native-back.ts'))};
 const token=localStorage.getItem('omp-remote-token')??'synthetic-start';
 localStorage.setItem('omp-remote-token',token);
 const namespace=queue.offlineQueueNamespaceForCredential(token);
 queue.setOfflineQueueNamespace(namespace);
const calls=[],started=[],opened=[],news=[],transcripts=[];let failCommand=null,failNew=null,failAfterPrompt=false,failCatalogue=null;
 const models=[{provider:'fixture',id:'model-a',name:'Model A',contextWindow:200000,reasoning:true,thinking:{efforts:['low','high'],defaultLevel:'high'}},
  {provider:'fixture',id:'model-b',name:'Model B'}];
 DaemonApi.prototype.getAvailableModels=async path=>{calls.push({path:'catalogue',body:path});if(failCatalogue)throw new Error(failCatalogue);return models};
 DaemonApi.prototype.getRecentModels=async()=>['fixture/model-a'];
 DaemonApi.prototype.fetchJson=async function(path,init){
  const body=init?.body?JSON.parse(init.body):undefined;calls.push({path,body});
  if(path==='/api/version')return {protocolVersion:1,minClientProtocolVersion:1,capabilities:['receipt-session-binding-v1']};
  if(path==='/api/transcribe/warm')return {ok:true,ready:true};
  if(path==='/api/transcribe')return new Promise((resolve,reject)=>{
   transcripts.push({body,resolve:text=>resolve({ok:true,text}),reject});
   init.signal?.addEventListener('abort',()=>reject(init.signal.reason));
  });
  if(path==='/api/new'){if(failNew)throw new Error(failNew);return new Promise(resolve=>news.push(()=>resolve({ok:true,sessionPath:'/s/new.jsonl'})))}
  if(path==='/api/rpc'){if(body.command===failCommand)throw new Error('The session did not apply the requested model.');return {ok:true,data:{}}}
  if(path==='/api/prompt'){
   if(failAfterPrompt)window.idb.control.beforeTransaction=()=>{throw new Error('Storage closed after delivery')};
   const receipt={commandId:body.commandId,sessionPath:body.sessionPath,state:'accepted',createdAt:1,updatedAt:2};
   return {ok:true,receipt,receiptBinding:{version:1,requestedSessionPath:body.sessionPath,canonicalSessionPath:body.sessionPath}}}
  throw new Error('Unexpected synthetic route '+path);
 };
 DaemonApi.prototype.dedupedFetch=DaemonApi.prototype.fetchJson;
 const store=createOmpStore();
 store.getState().setSessions([
  {path:'/s/old-a.jsonl',cwd:'/work/alpha',activeAt:900,mtime:1},
  {path:'/s/old-b.jsonl',cwd:'/work/beta',activeAt:500,mtime:1},
 ]);
 function Host(){const panels=usePanels();return h(Fragment,null,
  h(ScreenActivityContext.Provider,{value:!panels.settings},h(NewSessionScreen,{controller:{getStore:()=>store},onStarted:p=>started.push(p),onOpenSession:p=>opened.push(p)})),
  h(PushedScreen,{open:panels.settings,onClose:closeSettings,title:'Setup',testId:'catalogue-recovery'},
   h('input',{'aria-label':'Setup input','data-page':panels.settingsRequest?.page})))}
window.fixture={act,calls,started,opened,readDraft,transcripts,
  failOn:command=>{failCommand=command},failNew:message=>{failNew=message},
  failAfterPrompt:()=>{failAfterPrompt=true},
  failCatalogue:message=>{failCatalogue=message},back:()=>handleNativeBack('commit'),openSetup:openSettingsPage,
  namespace,draft:()=>getNewSessionDraft(namespace).getSnapshot(),
  editDraft:text=>getNewSessionDraft(namespace).update({text}),
  clearDrafts:async()=>{clearAllDrafts(namespace);clearNewSessionDraftMemory(namespace);await clearAttachmentDrafts(namespace)},
  flushDrafts:async()=>{flushNewSessionDraftWrites();await queue.flushDraftAttachmentWrites()},
  releaseNew:()=>{for(const resolve of news.splice(0))resolve()},
  mount:(catalogueError)=>{if(catalogueError!==undefined)failCatalogue=catalogueError;resetPanels();const r=createRoot(document.getElementById('root'));r.render(h(Host));return r}};
`,sheetShell);
async function screen(t,{microphone=false,saved=null,token='synthetic-start',failHydration=false,catalogueError=null}={}){
 const seed=`window.idb=(${memoryIndexedDb.toString()})();window.indexedDB=window.idb.indexedDB;
  for(const [key,value] of ${JSON.stringify(saved?.storage??[])})localStorage.setItem(key,value);
  localStorage.setItem('omp-remote-token',${JSON.stringify(token)});
  const photos=${JSON.stringify(saved?.photos??[])};
  window.idb.control.beforeGet=(name,key,rows)=>{
   if(name!=='draft-attachments-v3')return;
   for(const row of photos)rows.set(row.storageKey,row);
   window.idb.control.beforeGet=null;
  };
  ${failHydration?"window.idb.control.beforeTransaction=(name)=>{if(name==='draft-attachments-v3')throw Error('Photo storage unavailable')};":''}`;
 const dom=createDomFixture(seed+screenCode);
 const w=dom.window,{act}=w.fixture;
 const imageLoads=[];
 w.URL.createObjectURL=file=>'blob:synthetic/'+file.name;
 w.URL.revokeObjectURL=()=>{};
 w.Image=class{
  naturalWidth=32;naturalHeight=32;
  set src(value){imageLoads.push(this)}
 };
 w.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){}});
 w.HTMLCanvasElement.prototype.toDataURL=()=>'data:image/png;base64,cGhvdG8=';
 if(microphone){
  Object.defineProperty(w,'isSecureContext',{value:true,configurable:true});
  Object.defineProperty(w.navigator,'mediaDevices',{configurable:true,value:{
   getUserMedia:async()=>({getTracks:()=>[{stop(){}}]}),
  }});
  w.MediaRecorder=class{
   state='inactive';mimeType='audio/webm';
   start(){this.state='recording'}
   stop(){this.state='inactive';queueMicrotask(()=>{
    this.ondataavailable?.({data:new w.Blob(['synthetic audio'],{type:'audio/webm'})});
    this.onstop?.(new w.Event('stop'));
   })}
  };
 }
 let mounted;await act(async()=>{mounted=w.fixture.mount(catalogueError)});
 for(let i=0;i<5;i++)await act(async()=>new Promise(r=>w.setTimeout(r,0)));
 t.after(async()=>{try{await act(async()=>mounted?.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const q=s=>w.document.querySelector(s);
 const routes=()=>Array.from(w.fixture.calls,c=>c.path==='/api/rpc'?'rpc:'+c.body.command:c.path).filter(p=>p!=='catalogue');
 return {w,act,q,routes,f:w.fixture,
  attach:()=>act(async()=>{
   const input=q('input[type="file"]');
   Object.defineProperty(input,'files',{configurable:true,value:[new w.File(['photo'],'screenshot.png',{type:'image/png'})]});
   input.dispatchEvent(new w.Event('change',{bubbles:true}));
  }),
  finishImage:()=>act(async()=>imageLoads.shift().onload()),
  type:value=>act(async()=>{const input=q('[data-testid="new-session-input"]');Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new w.Event('input',{bubbles:true}))}),
  // Starting crosses the durable queue (IndexedDB) and timers: let them run.
  tap:async el=>{await act(async()=>el.click());for(let i=0;i<20;i++)await act(async()=>new Promise(r=>w.setTimeout(r,5)))},
  release:async()=>{await act(async()=>w.fixture.releaseNew());for(let i=0;i<20;i++)await act(async()=>new Promise(r=>w.setTimeout(r,5)))},
  reopen:async()=>{await act(async()=>{mounted?.unmount();mounted=null});await act(async()=>{mounted=w.fixture.mount()});for(let i=0;i<5;i++)await act(async()=>new Promise(r=>w.setTimeout(r,0)))},
  save:()=>({storage:Array.from({length:w.localStorage.length},(_,i)=>{const key=w.localStorage.key(i);return [key,w.localStorage.getItem(key)]}),photos:w.idb.rows('draft-attachments-v3')}),
  unmount:()=>act(async()=>{mounted.unmount();mounted=null})};
}
test('defaults to the latest project and the last used model; send starts and opens the session',async t=>{
 const s=await screen(t);
 assert.equal(s.q('[data-testid="new-session-project"]').textContent,'alpha');
 assert.equal(s.q('[data-testid="new-session-model"]').textContent,'Model A · High');
 assert.equal(s.f.calls.find(c=>c.path==='catalogue').body,'/s/old-a.jsonl','the catalogue is asked from a session in the chosen project');
 assert.equal(s.q('[data-testid="new-session-send"]').disabled,true);
 await s.type('Fix the build');await s.tap(s.q('[data-testid="new-session-send"]'));await s.release();
 assert.deepEqual(s.routes(),['/api/new','rpc:set_model','/api/version','/api/prompt']);
 const calls=Array.from(s.f.calls).filter(c=>c.path!=='catalogue');
 assert.equal(calls[0].body.cwd,'/work/alpha');
 assert.equal(JSON.stringify(calls[1].body.params),JSON.stringify({provider:'fixture',modelId:'model-a',thinkingLevel:'high'}));
 assert.equal(calls[3].body.text,'Fix the build');
 assert.deepEqual(Array.from(s.f.started),['/s/new.jsonl']);
 assert.equal(JSON.parse(s.w.localStorage.getItem('omp-new-session-model:'+s.f.namespace)).key,'fixture/model-a');
});
test('Continue opens the most recent chat; a suggestion prefills the composer, and typing hides the starting points',async t=>{
 const s=await screen(t);
 const cont=s.q('[data-testid="new-session-continue"]');
 assert.match(cont.textContent,/^Continue: /);
 assert.equal(s.w.document.querySelectorAll('[data-testid="new-session-suggestion"]').length,3);
 await s.tap(cont);assert.deepEqual(Array.from(s.f.opened),['/s/old-a.jsonl']);assert.equal(s.f.started.length,0);
 await s.tap(s.q('[data-testid="new-session-suggestion"]'));
 assert.equal(s.q('[data-testid="new-session-input"]').value,'Explain this project');
 assert.equal(s.q('[data-testid="new-session-continue"]'),null);
 assert.equal(s.q('[data-testid="new-session-send"]').disabled,false,'a prefilled suggestion is a real draft, sent only by the user');
 assert.equal(s.f.started.length,0);
});
test('missing default model opens the picker without starting again or losing the draft',async t=>{
 const s=await screen(t);s.f.failNew('No default model selected');await s.type('Keep this task');
 await s.tap(s.q('[data-testid="new-session-send"]'));
 const notice=s.q('[data-testid="new-session-error"]');
 assert.equal(notice.querySelector('button').textContent,'Choose model');
 await s.tap(notice.querySelector('button'));
 assert.equal(Boolean(s.q('[data-testid="model-picker"]')),true);
 assert.equal(s.q('[data-testid="new-session-input"]').value,'Keep this task');
 assert.equal(s.routes().filter(route=>route==='/api/new').length,1);
 assert.equal(s.routes().includes('/api/prompt'),false);
 assert.equal(s.f.started.length,0);
});
test('Start without a message only creates and configures the session',async t=>{
 const s=await screen(t);await s.tap(s.q('[data-testid="new-session-start-empty"]'));await s.release();
 assert.deepEqual(s.routes(),['/api/new','rpc:set_model']);assert.deepEqual(Array.from(s.f.started),['/s/new.jsonl']);
});
test('same-turn taps start one session',async t=>{
 const s=await screen(t);await s.type('Once');
 await s.act(async()=>{const b=s.q('[data-testid="new-session-send"]');b.click();b.click()});await s.release();
 assert.equal(s.routes().filter(r=>r==='/api/new').length,1);
});
test('a settings failure keeps the draft on screen and retries the same created session',async t=>{
 const s=await screen(t);s.f.failOn('set_model');await s.type('Keep me');
 await s.tap(s.q('[data-testid="new-session-send"]'));await s.release();
 assert.equal(s.routes().includes('/api/prompt'),false);
 assert.equal(s.f.started.length,0);
 assert.equal(s.q('[data-testid="new-session-input"]').value,'Keep me');
 s.f.failOn(null);
 await s.tap(s.q('[data-testid="new-session-send"]'));
 assert.equal(s.routes().filter(route=>route==='/api/new').length,1);
 assert.equal(s.f.calls.find(call=>call.path==='/api/prompt').body.text,'Keep me');
 assert.deepEqual(Array.from(s.f.started),['/s/new.jsonl']);
});
test('a failed create stays on the screen with a retryable notice',async t=>{
 const s=await screen(t);s.f.failNew('invalid cwd');await s.type('Hello');
 await s.tap(s.q('[data-testid="new-session-send"]'));
 assert.equal(s.q('[data-testid="new-session-error"]')!==null,true);
 const notice=s.q('[data-testid="new-session-error"]');assert.equal(s.f.started.length,0);
 assert.equal(s.q('[data-testid="new-session-input"]').value,'Hello');
 s.f.failNew(null);
 await s.tap(Array.from(notice.querySelectorAll('button')).find(b=>b.textContent==='Try again'));await s.release();
 assert.deepEqual(Array.from(s.f.started),['/s/new.jsonl']);
});
test('leaving the screen suppresses a late start',async t=>{
 const s=await screen(t);await s.type('Late');await s.tap(s.q('[data-testid="new-session-send"]'));
 await s.unmount();await s.release();assert.equal(s.f.started.length,0);
});
test('the model chip opens the picker as an unsaved choice',async t=>{
 const s=await screen(t);await s.tap(s.q('[data-testid="new-session-model"]'));
 await s.tap(s.q('[data-model="fixture/model-b"]'));
 assert.equal(s.q('[data-testid="new-session-model"]').textContent,'Model B');
 assert.equal(s.routes().length,0,'choosing applies nothing until the session starts');
});

for(const [error,page] of [['No API key found for provider fixture','providers'],['Failed to fetch','diagnostics']]){
 test('returning from '+page+' repairs the retained catalogue without changing the prompt or sending',async t=>{
  const s=await screen(t,{catalogueError:error});
  await s.type('Keep the original task');
  await s.tap(s.q('[data-testid="new-session-model"]'));
  assert.equal(s.q('[data-testid="model-item"]')===null,true);
  assert.equal(s.f.calls.filter(call=>call.path==='catalogue').length,1);
  await s.tap(s.q('[data-testid="model-load-failed"] button'));
  assert.equal(s.q('[data-testid="catalogue-recovery"] input').dataset.page,page);
  s.f.failCatalogue(null);
  await s.tap(s.q('[data-testid="catalogue-recovery"] input'));
  assert.equal(s.f.calls.filter(call=>call.path==='catalogue').length,1,'no background refresh while setup owns the screen');
  await s.act(async()=>s.f.back());
  assert.equal(s.q('[data-testid="catalogue-recovery"]')===null,true);
  assert.equal(s.f.calls.filter(call=>call.path==='catalogue').length,2);
  assert.equal(s.q('[data-model="fixture/model-b"]')!==null,true);
  assert.equal(s.q('[data-testid="new-session-input"]').value,'Keep the original task');
  assert.equal(s.routes().length,0,'configuration return only reads; it never starts or sends');
  await s.tap(s.q('[data-model="fixture/model-b"]'));
  await s.tap(s.q('[data-testid="model-picker"] button[aria-label="Close"]'));
  await s.tap(s.q('[data-testid="new-session-model"]'));
  assert.equal(s.f.calls.filter(call=>call.path==='catalogue').length,2,'ordinary picker close/reopen reuses the enabled catalogue');
  assert.equal(s.q('[data-model="fixture/model-b"]').getAttribute('aria-pressed'),'true');
  assert.equal(s.q('[data-testid="new-session-input"]').value,'Keep the original task');
  assert.equal(s.routes().length,0);
 });
}

test('a chosen draft model survives catalogue reactivation without a second default choice or write',async t=>{
 const s=await screen(t);
 await s.type('Keep this draft and model');
 await s.tap(s.q('[data-testid="new-session-model"]'));
 await s.tap(s.q('[data-model="fixture/model-b"]'));
 await s.act(async()=>s.f.openSetup('providers'));
 assert.equal(s.f.calls.filter(call=>call.path==='catalogue').length,1);
 await s.act(async()=>s.f.back());
 assert.equal(s.f.calls.filter(call=>call.path==='catalogue').length,2);
 assert.equal(s.q('[data-model="fixture/model-b"]').getAttribute('aria-pressed'),'true');
 assert.equal(s.q('[data-model="fixture/model-a"]').getAttribute('aria-pressed'),'false');
 assert.equal(s.q('[data-testid="new-session-input"]').value,'Keep this draft and model');
 assert.equal(s.routes().length,0);
 assert.equal(s.f.started.length,0);
});

test('dictation inserts into the latest draft without starting a session',async t=>{
 const s=await screen(t,{microphone:true});
 await s.type('Investigate');
 await s.tap(s.q('[data-testid="voice-button"]'));
 assert.equal(s.q('[data-testid="new-session-start-empty"]').disabled,true);
 await s.type('Investigate carefully');
 await s.tap(s.q('[data-testid="dictation-insert"]'));
 await s.act(async()=>s.f.transcripts[0].resolve('the build failure'));
 assert.equal(s.q('[data-testid="new-session-input"]').value,'Investigate carefully the build failure');
 assert.equal(s.routes().includes('/api/new'),false);
});

test('Insert and send starts one session with the entire transcribed draft',async t=>{
 const s=await screen(t,{microphone:true});
 await s.type('Please');
 await s.tap(s.q('[data-testid="voice-button"]'));
 await s.tap(s.q('[data-testid="dictation-send"]'));
 assert.equal(s.routes().includes('/api/new'),false,'wait for the transcript');
 await s.act(async()=>s.f.transcripts[0].resolve('fix the build'));
 await s.release();
 assert.equal(s.routes().filter(path=>path==='/api/new').length,1);
 assert.equal(s.f.calls.find(call=>call.path==='/api/prompt').body.text,'Please fix the build');
 assert.deepEqual(Array.from(s.f.started),['/s/new.jsonl']);
});

test('cancelling Insert and send forgets send intent; Retry only inserts the kept recording',async t=>{
 const s=await screen(t,{microphone:true});
 await s.tap(s.q('[data-testid="voice-button"]'));
 await s.tap(s.q('[data-testid="dictation-send"]'));
 await s.tap(s.q('[data-testid="dictation-cancel"]'));
 await s.act(async()=>s.f.transcripts[0].resolve('cancelled words'));
 assert.equal(s.q('[data-testid="new-session-input"]').value,'');
 const retry=Array.from(s.q('[data-testid="dictation-error"]').querySelectorAll('button')).find(b=>b.textContent==='Retry');
 await s.tap(retry);
 assert.equal(s.f.transcripts[1].body.audio,s.f.transcripts[0].body.audio);
 await s.act(async()=>s.f.transcripts[1].resolve('recovered words'));
 assert.equal(s.q('[data-testid="new-session-input"]').value,'recovered words');
 assert.equal(s.routes().includes('/api/new'),false);
});

test('leaving during Insert and send never creates a session from a late transcript',async t=>{
 const s=await screen(t,{microphone:true});
 await s.tap(s.q('[data-testid="voice-button"]'));
 await s.tap(s.q('[data-testid="dictation-send"]'));
 await s.unmount();
 await s.act(async()=>s.f.transcripts[0].resolve('too late'));
 assert.equal(s.routes().includes('/api/new'),false);
 assert.deepEqual(Array.from(s.f.started),[]);
});

test('a failed outbox save retains text and image bytes; retry sends once in the same session',async t=>{
 const s=await screen(t);
 await s.type('Explain the screenshot');await s.attach();await s.finishImage();
 s.w.idb.control.abortNextPut=true;
 await s.tap(s.q('[data-testid="new-session-send"]'));await s.release();
 assert.equal(s.f.started.length,0);
 assert.equal(s.routes().includes('/api/prompt'),false);
 assert.equal(s.w.idb.rows().length,0);
 assert.equal(s.q('[data-testid="new-session-input"]').value,'Explain the screenshot');
 assert.equal(s.q('[data-testid="attachment-strip"] img')?.getAttribute('src'),'data:image/png;base64,cGhvdG8=');
 assert.equal(s.q('[data-testid="new-session-project"]').disabled,true);
 const retry=Array.from(s.q('[data-testid="new-session-error"]').querySelectorAll('button')).find(button=>button.textContent==='Try again');
 await s.tap(retry);
 assert.equal(s.routes().filter(route=>route==='/api/new').length,1);
 const sent=Array.from(s.f.calls).filter(call=>call.path==='/api/prompt');
 assert.equal(sent.length,1);
 assert.equal(sent[0].body.text,'Explain the screenshot');
 assert.equal(sent[0].body.images[0].data,'cGhvdG8=');
 assert.deepEqual(Array.from(s.f.started),['/s/new.jsonl']);
});

test('storage failure after durable enqueue offers cleanup-only retry without duplicating the prompt',async t=>{
 const s=await screen(t);s.f.failAfterPrompt();
 await s.type('Already saved');await s.attach();await s.finishImage();
 await s.tap(s.q('[data-testid="new-session-send"]'));await s.release();
 assert.deepEqual(Array.from(s.f.started),[]);
 assert.equal(s.q('[data-testid="new-session-cleanup-error"]')!==null,true);
 assert.equal(s.f.draft().value.transferredSessionPath,'/s/new.jsonl');
 assert.equal(s.w.idb.rows().length,1);
 await s.tap(s.q('[data-testid="new-session-cleanup-error"] button'));
 assert.deepEqual(Array.from(s.f.started),[],'another storage failure must leave cleanup retry available');
 assert.equal(s.q('[data-testid="new-session-cleanup-error"]')!==null,true);
 s.w.idb.control.beforeTransaction=null;
 await s.tap(s.q('[data-testid="new-session-cleanup-error"] button'));
 assert.deepEqual(Array.from(s.f.started),['/s/new.jsonl']);
 assert.equal(s.routes().filter(route=>route==='/api/new').length,1);
 assert.equal(s.routes().filter(route=>route==='/api/prompt').length,1);
 assert.equal(s.f.draft().value.text,'');
});

test('image preparation blocks pointer and keyboard sends until the selected image is included',async t=>{
 const s=await screen(t);await s.type('Explain the screenshot');await s.attach();
 assert.equal(s.q('[data-testid="new-session-send"]').disabled,true);
 assert.equal(s.q('[data-testid="new-session-start-empty"]').disabled,true);
 await s.act(async()=>{
  s.q('[data-testid="new-session-send"]').click();
  s.q('[data-testid="new-session-input"]').dispatchEvent(new s.w.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true}));
 });
 assert.equal(s.routes().includes('/api/new'),false);
 await s.finishImage();
 assert.equal(s.q('[data-testid="new-session-send"]').disabled,false);
 await s.tap(s.q('[data-testid="new-session-send"]'));await s.release();
 const sent=s.f.calls.find(call=>call.path==='/api/prompt');
 assert.equal(sent.body.text,'Explain the screenshot');
 assert.equal(sent.body.images[0].data,'cGhvdG8=');
});

test('Insert and send cannot bypass pending image preparation',async t=>{
 const s=await screen(t,{microphone:true});await s.attach();
 await s.tap(s.q('[data-testid="voice-button"]'));
 assert.equal(s.q('[data-testid="dictation-send"]').disabled,true);
 await s.tap(s.q('[data-testid="dictation-send"]'));
 assert.equal(s.f.transcripts.length,0);
 assert.equal(s.routes().includes('/api/new'),false);
 await s.finishImage();
 assert.equal(s.q('[data-testid="dictation-send"]').disabled,false);
 await s.tap(s.q('[data-testid="dictation-send"]'));
 await s.act(async()=>s.f.transcripts[0].resolve('Describe this image'));
 await s.release();
 const sent=s.f.calls.find(call=>call.path==='/api/prompt');
 assert.equal(sent.body.text,'Describe this image');
 assert.equal(sent.body.images[0].data,'cGhvdG8=');
});

test('Back and reopen preserve the task, exact photo payload, project, model and thinking choice',async t=>{
 const s=await screen(t);await s.type('Keep the original screenshot');
 await s.tap(s.q('[data-testid="new-session-project"]'));
 await s.tap(s.q('[data-cwd="/work/beta"]'));
 await s.tap(s.q('[data-testid="new-session-model"]'));
 await s.tap(s.q('[data-model="fixture/model-b"]'));
 await s.attach();await s.finishImage();
 await s.reopen();
 assert.equal(s.q('[data-testid="new-session-input"]').value,'Keep the original screenshot');
 assert.equal(s.q('[data-testid="new-session-project"]').textContent,'beta');
 assert.equal(s.q('[data-testid="new-session-model"]').textContent,'Model B');
 assert.equal(s.q('[data-testid="attachment-strip"] img')?.getAttribute('src'),'data:image/png;base64,cGhvdG8=');
 await s.tap(s.q('[data-testid="new-session-send"]'));await s.release();
 const prompt=s.f.calls.find(call=>call.path==='/api/prompt').body;
 assert.equal(prompt.images[0].data,'cGhvdG8=');
 assert.equal(s.f.draft().value.text,'');
 assert.equal(s.w.idb.rows('draft-attachments-v3').length,0);
});

test('reload restores configuration and photo bytes without decoding the image again',async t=>{
 const s=await screen(t);await s.type('Survive a reload');await s.attach();await s.finishImage();
 const reloaded=await screen(t,{saved:s.save()});
 assert.equal(reloaded.q('[data-testid="new-session-input"]').value,'Survive a reload');
 assert.equal(reloaded.q('[data-testid="new-session-model"]').textContent,'Model A · High');
 assert.equal(reloaded.q('[data-testid="new-session-project"]').textContent,'alpha');
 assert.equal(reloaded.q('[data-testid="attachment-strip"] img')?.getAttribute('src'),'data:image/png;base64,cGhvdG8=');
 assert.equal(reloaded.save().storage.some(([,value])=>value.includes('cGhvdG8=')),false);
 await reloaded.tap(reloaded.q('[data-testid="new-session-send"]'));await reloaded.release();
 const prompt=reloaded.f.calls.find(call=>call.path==='/api/prompt').body;
 assert.equal(prompt.text,'Survive a reload');assert.equal(prompt.images[0].data,'cGhvdG8=');
});

test('a different pairing cannot read the prior pairing draft or photos',async t=>{
 const s=await screen(t);await s.type('Private task');await s.attach();await s.finishImage();
 await s.tap(s.q('[data-testid="new-session-project"]'));await s.tap(s.q('[data-cwd="/work/beta"]'));
 const other=await screen(t,{saved:s.save(),token:'another-pairing'});
 assert.equal(other.q('[data-testid="new-session-input"]').value,'');
 assert.equal(other.q('[data-testid="attachment-strip"]')===null,true);
 assert.equal(other.q('[data-testid="new-session-project"]').textContent,'alpha');
});

test('Back while an image is preparing preserves the pending intake and includes it on send',async t=>{
 const s=await screen(t);await s.type('Include the pending photo');await s.attach();await s.reopen();
 assert.equal(s.q('[data-testid="new-session-send"]').disabled,true);
 await s.finishImage();
 assert.equal(s.q('[data-testid="attachment-strip"] img')!==null,true);
 await s.tap(s.q('[data-testid="new-session-send"]'));await s.release();
 assert.equal(s.f.calls.find(call=>call.path==='/api/prompt').body.images[0].data,'cGhvdG8=');
});

test('a settings failure remains retryable against the already created session after reload',async t=>{
 const s=await screen(t);s.f.failOn('set_model');await s.type('Retry this task');
 await s.tap(s.q('[data-testid="new-session-send"]'));await s.release();
 const reloaded=await screen(t,{saved:s.save()});
 assert.equal(reloaded.q('[data-testid="new-session-input"]').value,'Retry this task');
 assert.equal(reloaded.q('[data-testid="new-session-project"]').disabled,true);
 await reloaded.tap(reloaded.q('[data-testid="new-session-send"]'));
 assert.equal(reloaded.routes().includes('/api/new'),false);
 assert.equal(reloaded.f.calls.find(call=>call.path==='/api/prompt').body.sessionPath,'/s/new.jsonl');
});

test('late successful submission clears only its exact consumed text revision',async t=>{
 const s=await screen(t);await s.type('The consumed task');await s.tap(s.q('[data-testid="new-session-send"]'));
 await s.unmount();
 // Another editor lifetime has newer input before the old request settles.
 await s.act(async()=>s.f.editDraft('The newer task'));
 await s.release();await s.reopen();
 assert.equal(s.q('[data-testid="new-session-input"]').value,'The newer task');
 assert.equal(s.f.started.length,0,'offscreen completion must not navigate');
});

test('a local draft write failure stays visible and preserves text across navigation until retry',async t=>{
 const s=await screen(t),original=s.w.Storage.prototype.setItem;
 s.w.Storage.prototype.setItem=function(key,value){if(key.startsWith('omp-draft:'))throw Error('Storage full');return original.call(this,key,value)};
 await s.type('Do not lose this task');
 assert.equal(s.q('[data-testid="new-session-storage-error"]')!==null,true);
 await s.reopen();
 assert.equal(s.q('[data-testid="new-session-input"]').value,'Do not lose this task');
 s.w.Storage.prototype.setItem=original;
 await s.tap(s.q('[data-testid="new-session-storage-error"] button'));
 assert.equal(s.q('[data-testid="new-session-storage-error"]')===null,true);
 const reloaded=await screen(t,{saved:s.save()});
 assert.equal(reloaded.q('[data-testid="new-session-input"]').value,'Do not lose this task');
});

test('failed photo hydration blocks send until an explicit retry restores the saved tray',async t=>{
 const s=await screen(t);await s.type('Need the photo');await s.attach();await s.finishImage();
 const reloaded=await screen(t,{saved:s.save(),failHydration:true});
 assert.equal(reloaded.q('[data-testid="new-session-send"]').disabled,true);
 assert.equal(reloaded.q('[data-testid="new-session-attachment-error"]')!==null,true);
 reloaded.w.idb.control.beforeTransaction=null;
 await reloaded.tap(reloaded.q('[data-testid="new-session-attachment-error"] button'));
 assert.equal(reloaded.q('[data-testid="new-session-send"]').disabled,false);
 assert.equal(reloaded.q('[data-testid="attachment-strip"] img')!==null,true);
});

test('clearing offline drafts invalidates an old pending intake instead of resurrecting it',async t=>{
 const s=await screen(t);await s.type('Clear me');await s.attach();
 await s.act(async()=>s.f.clearDrafts());await s.finishImage();await s.reopen();
 assert.equal(s.q('[data-testid="new-session-input"]').value,'');
 assert.equal(s.q('[data-testid="attachment-strip"]')===null,true);
 assert.equal(s.w.idb.rows('draft-attachments-v3').length,0);
});

test('starting without a message does not discard a prompt that was not consumed',async t=>{
 const s=await screen(t);await s.type('Keep for later');
 await s.tap(s.q('[data-testid="new-session-start-empty"]'));await s.release();await s.reopen();
 assert.equal(s.q('[data-testid="new-session-input"]').value,'Keep for later');
 assert.equal(s.routes().includes('/api/prompt'),false);
});

test('reload after ownership transfer retries only draft cleanup, not session creation or delivery',async t=>{
 const s=await screen(t);s.f.failAfterPrompt();await s.type('Transferred once');await s.attach();await s.finishImage();
 await s.tap(s.q('[data-testid="new-session-send"]'));await s.release();
 const reloaded=await screen(t,{saved:s.save()});
 assert.equal(reloaded.q('[data-testid="new-session-cleanup-error"]')!==null,true);
 await reloaded.tap(reloaded.q('[data-testid="new-session-cleanup-error"] button'));
 assert.deepEqual(reloaded.routes(),[]);
 assert.deepEqual(Array.from(reloaded.f.started),['/s/new.jsonl']);
 assert.equal(reloaded.f.draft().value.text,'');
});

test('a deliberately chosen thinking level survives Back and reload',async t=>{
 const s=await screen(t);await s.type('Think at low effort');
 await s.tap(s.q('[data-testid="new-session-model"]'));
 const low=Array.from(s.q('[data-testid="model-thinking"]').querySelectorAll('button')).find(button=>button.textContent==='Low');
 await s.tap(low);await s.reopen();
 assert.equal(s.q('[data-testid="new-session-model"]').textContent,'Model A · Low');
 const reloaded=await screen(t,{saved:s.save()});
 assert.equal(reloaded.q('[data-testid="new-session-model"]').textContent,'Model A · Low');
 await reloaded.tap(reloaded.q('[data-testid="new-session-send"]'));await reloaded.release();
 assert.equal(reloaded.f.calls.find(call=>call.path==='/api/rpc').body.params.thinkingLevel,'low');
});

test('late completion cannot remove a newer draft saved by another window',async t=>{
 const s=await screen(t);await s.type('Consumed in this window');
 await s.tap(s.q('[data-testid="new-session-send"]'));
 const key='omp-draft:'+s.f.namespace+':new-session';
 const newer={...s.f.draft().value,revision:'newer-window',text:'Saved in the other window'};
 s.w.localStorage.setItem(key,JSON.stringify(newer));
 await s.release();await s.reopen();
 assert.equal(s.q('[data-testid="new-session-input"]').value,'Saved in the other window');
 assert.equal(JSON.parse(s.w.localStorage.getItem(key)).text,'Saved in the other window');
});
