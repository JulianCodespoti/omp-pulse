import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const source = path => JSON.stringify(resolve(root, 'web/src', path));
const code = await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {ErrorNotice} from ${source('app/ui/ErrorNotice.tsx')};
import {QueuedMessage} from ${source('app/parts/QueuedMessage.tsx')};
import {QueuedMessagesBar} from ${source('app/chat/QueuedMessagesBar.tsx')};
import {TranscriptActionsContext} from ${source('app/parts/TurnNotices.tsx')};
import {Notices,showErrorToast} from ${source('app/Notices.tsx')};
import {daemonErrorCause,humanizeDaemonError} from ${source('app/ui/OwnedBySession.tsx')};
import {errorRecoveryAction} from ${source('app/ui/error-recovery.ts')};
import {usePanels,closeSettings} from ${source('app/nav/panels.ts')};
import {useDraft,readDraft,flushAllDraftWrites} from ${source('app/composer/use-draft.ts')};
import {createOmpStore} from ${source('runtime/omp-store.ts')};
import * as queue from ${source('runtime/offline-queue.ts')};
import {OmpSessionController} from ${source('runtime/omp-session-controller.ts')};
const path='/synthetic/recovery',namespace=queue.offlineQueueNamespaceForCredential('synthetic-recovery');
queue.setOfflineQueueNamespace(namespace);
const store=createOmpStore();store.setState({sessionPath:path});
const calls={retry:0,cancel:0,edit:0,choose:0,dismiss:0};
const controller={getStore:()=>store};
let entry,draft,setDraft;
const choose=()=>{calls.choose++};
function App({surface,contextual}) {
 const panels=usePanels(),owner=useDraft(path);draft=owner.text;setDraft=owner.setText;
 const child=surface==='bar'?h(QueuedMessagesBar,{controller,pending:[entry],onChooseModel:contextual?choose:undefined})
  :surface==='notice'?h(ErrorNotice,{message:'Setup required',onRetry:()=>calls.retry++,onDismiss:()=>calls.dismiss++,action:errorRecoveryAction(entry.error)})
  :h(QueuedMessage,{entry,onRetry:()=>calls.retry++,onCancel:()=>calls.cancel++,onEdit:()=>calls.edit++});
 return h('div',null,h('textarea',{'aria-label':'Draft',value:owner.text,onChange:()=>{}}),
  h('output',{'data-testid':'destination'},panels.settings?panels.settingsRequest?.page:''),
  h(TranscriptActionsContext.Provider,{value:contextual?{switchModel:choose}:null},child),h(Notices));
}
window.fixture={act,calls,queue,namespace,daemonErrorCause,humanizeDaemonError,errorRecoveryAction,showErrorToast,closeSettings,
 protocolMismatch:()=>OmpSessionController.prototype.checkHeartbeatVersion.call({updateBannerShown:false},'synthetic',undefined,undefined),
 async seed(error,state='failed') {
  await queue.enqueue({commandId:'retained-failure',sessionPath:path,text:'Exact failed prompt\\n  with whitespace',images:[{data:'cGhvdG8=',mimeType:'image/png'}],namespace});
  await queue.update('retained-failure',{state,error},namespace);entry=await queue.getQueued('retained-failure',namespace);
 },
 mount(surface='row',contextual=false){const r=createRoot(document.getElementById('root'));r.render(h(App,{surface,contextual}));return r},
 setDraft:text=>setDraft(text),draft:()=>draft,readDraft:()=>readDraft(path),flushAllDraftWrites,
 entry:()=>queue.getQueued('retained-failure',namespace),images:()=>queue.getImages('retained-failure',namespace)};
`);

async function fixture(t, { error = 'agent process exited: No default model selected', surface = 'row', phone = false, contextual = false, state = 'failed' } = {}) {
 const dom = createDomFixture(code), w = dom.window, f = w.fixture;
 w.Element.prototype.getAnimations = () => [];
 const nativeCalls=[];
 if (phone) w.OmpLocal={state:()=>JSON.stringify({mode:'phone'}),loginStart:()=>nativeCalls.push('login'),prepare:()=>nativeCalls.push('prepare'),grant:()=>nativeCalls.push('grant')};
 await f.seed(error,state);
 let mounted;
 w.localStorage.setItem('omp-remote-token','unchanged-credential');
 await f.act(async()=>{mounted=f.mount(surface,contextual)});
 await f.act(async()=>{f.setDraft('Different unsent draft');f.flushAllDraftWrites()});
 t.after(async()=>{try{await f.act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const button=label=>[...w.document.querySelectorAll('button')].find(b=>b.textContent.trim()===label||b.getAttribute('aria-label')===label);
 return {w,f,nativeCalls,button,destination:()=>w.document.querySelector('[data-testid="destination"]').textContent,
  click:label=>f.act(async()=>{assert.equal(Boolean(button(label)),true,label);button(label).click()})};
}
const plain=value=>JSON.parse(JSON.stringify(value));

for (const surface of ['row','bar','notice']) for (const phone of [false,true]) test(`${surface}: provider recovery only navigates and retains failed intent, images, draft and credentials (${phone?'phone':'remote'})`,async t=>{
 const f=await fixture(t,{surface,phone});
 const before=plain(await f.f.entry()),images=plain(await f.f.images());
 assert.equal(Boolean(f.button('Try again')),false,'terminal failures never retry an old command ID');
 if(surface!=='notice') assert.equal(f.w.document.querySelector(surface==='row'?'[data-testid="send-status"] p':'[data-testid="queued-message"] p')?.textContent,`This message wasn’t sent. ${f.f.humanizeDaemonError(before.error)}`,'the failure cause is visible, not tooltip-only');
 await f.click('Model providers');
 assert.equal(f.destination(),'providers');
 assert.deepEqual(plain(await f.f.entry()),before);assert.deepEqual(plain(await f.f.images()),images);
 assert.equal(f.f.draft(),'Different unsent draft');assert.equal(f.f.readDraft(),'Different unsent draft');
 assert.equal(f.w.localStorage.getItem('omp-remote-token'),'unchanged-credential');
 assert.equal(f.f.calls.retry,0);assert.equal(f.f.calls.cancel,0);assert.deepEqual(f.nativeCalls,[]);
 await f.f.act(async()=>f.f.closeSettings());assert.equal(f.destination(),'');
 assert.deepEqual(plain(await f.f.entry()),before);assert.equal(f.f.draft(),'Different unsent draft');
});

for(const surface of ['row','bar']) test(`${surface}: a known model-picker callback takes precedence without resending`,async t=>{
 const f=await fixture(t,{surface,contextual:true});const before=plain(await f.f.entry());
 await f.click('Choose model');assert.equal(f.f.calls.choose,1);assert.equal(f.destination(),'');
 assert.deepEqual(plain(await f.f.entry()),before);assert.equal(f.f.calls.retry,0);assert.equal(f.f.draft(),'Different unsent draft');
});

test('specific model and provider causes outrank child-exit noise and generic status',async t=>{
 const {f}=await fixture(t);
 for(const error of ['agent process exited: No default model selected', {message:'agent process terminated: No default model selected',status:500}, {error:{message:'No default model selected'}}]) {
  assert.equal(f.daemonErrorCause(error),'model');
  assert.notEqual(f.humanizeDaemonError(error),f.humanizeDaemonError('agent process exited'));
 }
 for(const error of ['agent process exited: No API key found for provider anthropic', {message:'401 {"error":{"type":"authentication_error","message":"Invalid credentials"}}',status:401}, {error:{type:'authentication_error',message:'Invalid credentials'}}, {code:'invalid_api_key',message:'Credentials unavailable'}]) {
  assert.equal(f.daemonErrorCause(error),'provider-auth');
  assert.equal(f.errorRecoveryAction(error).label,'Model providers');
 }
 assert.equal(f.errorRecoveryAction('Synthetic unexplained error'),undefined);
});

for(const [error,page] of [[{name:'AuthError',message:'Authentication failed'},'repair-pairing'],[{name:'ForbiddenError',message:'Forbidden'},'computer'],['Failed to fetch','diagnostics'],['failed to spawn omp rpc child','diagnostics']]) test(`global recovery uses exact safe destination: ${page}`,async t=>{
 const f=await fixture(t);await f.f.act(async()=>f.f.errorRecoveryAction(error).onClick());assert.equal(f.destination(),page);
 assert.equal(f.f.calls.retry,0);assert.equal(f.f.calls.cancel,0);
});

test('an uncertain send with a stale setup error still only checks delivery; it is never replayed by recovery',async t=>{
 const f=await fixture(t,{state:'uncertain'});const before=plain(await f.f.entry());
 assert.equal(Boolean(f.button('Model providers')),false);assert.equal(Boolean(f.button('Choose model')),false);
 assert.equal(Boolean(f.button('Check')),true);assert.deepEqual(plain(await f.f.entry()),before);assert.equal(f.f.calls.retry,0);
});

test('actionable transient errors retain raw provider classification and their action until used',async t=>{
 const f=await fixture(t);await f.f.act(async()=>f.f.showErrorToast({message:'agent process exited: No API key found for provider anthropic',status:500}));
 const toast=f.w.document.querySelector('[data-slot="toast"]');
 assert.equal(Boolean(toast),true);assert.equal(Boolean([...toast.querySelectorAll('button')].find(b=>b.textContent==='Model providers')),true);
 await f.f.act(async()=>[...toast.querySelectorAll('button')].find(b=>b.textContent==='Model providers').click());
 assert.equal(f.destination(),'providers');assert.equal(f.f.calls.retry,0);assert.equal(f.f.calls.cancel,0);
});

test('ownership recovery opens real sharing help without adopting or replaying the retained send',async t=>{
 const f=await fixture(t,{error:'session_owned_by_terminal: session file is held open by another omp process'});
 await f.click('Sharing help');assert.equal(Boolean(f.w.document.querySelector('[data-testid="sharing-recovery"]')),true);
 assert.equal(Boolean(f.button('Copy sharing command')),true);assert.equal(f.f.calls.retry,0);assert.equal(f.f.calls.cancel,0);
 assert.equal(f.f.draft(),'Different unsent draft');
});

for(const phone of [false,true]) test(`protocol mismatch opens the host-correct update guide without reloading or sending (${phone?'phone':'remote'})`,async t=>{
 const f=await fixture(t,{phone}),opened=[];f.w.open=(...args)=>opened.push(args);
 await f.f.act(async()=>f.f.protocolMismatch());
 const banner=f.w.document.querySelector('[data-testid="app-banner"]');
 assert.equal(Boolean(banner),true);
 await f.f.act(async()=>[...banner.querySelectorAll('button')].find(b=>b.textContent.trim()==='Update guide').click());
 assert.equal(opened.length,1);
 assert.match(opened[0][0],/#on-your-computer$/);
 assert.equal(f.f.calls.retry,0);assert.equal(f.f.calls.cancel,0);assert.equal(f.f.draft(),'Different unsent draft');
});

test('a received turn failure in the retained queue is not presented as an unsent message',async t=>{
 const f=await fixture(t,{surface:'bar',error:'agent_failed'});
 const status=f.w.document.querySelector('[data-testid="queued-message"] [role="status"]');
 assert.equal(status?.textContent,'Turn failed');assert.equal(f.f.calls.retry,0);
});
