import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,Fragment,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {TasksTab} from ${JSON.stringify(resolve(root,'web/src/app/tools/TasksTab.tsx'))};
import {useProvideWorkspaceHost} from ${JSON.stringify(resolve(root,'web/src/app/tools/workspace-host.ts'))};
import {openWorkspace,usePanels} from ${JSON.stringify(resolve(root,'web/src/app/nav/panels.ts'))};
import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
import {readDraft,seedDraft} from ${JSON.stringify(resolve(root,'web/src/app/composer/use-draft.ts'))};
import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
import {handleNativeBack} from ${JSON.stringify(resolve(root,'web/src/platform/native-back.ts'))};
const jumped=[],branched=[],moved=[],panel={workspace:null};const store=createOmpStore();store.setState({sessionPath:'/synthetic/a'});
// One stable host, published the way ChatScreen does.
const host={controller:{getStore:()=>store},jumpTo:id=>jumped.push(id),onBranched:path=>branched.push(path),onMovedHere:(path,text,ask=false)=>moved.push([path,text??null,ask])};
function Harness(props){useProvideWorkspaceHost(host);return h(TasksTab,{focused:props.active,...props})}
function PanelProbe(){panel.workspace=usePanels().workspace;return null}
const mountTasks=()=>{openWorkspace('tasks');const r=createRoot(document.getElementById('root'));const render=(active=true,sessionPath='/synthetic/a')=>{store.setState({sessionPath});r.render(h(Fragment,null,h(PanelProbe),h(Harness,{active,sessionPath})))};render();return{render,unmount:()=>r.unmount()}};
const calls=[];DaemonApi.prototype.getBranchMessages=async()=>[{entryId:'u1',text:'continue'},{entryId:'u2',text:'continue'}];for(const method of ['branch','treeGoto','treeLabel','runCommand'])DaemonApi.prototype[method]=(...args)=>{const pending=Promise.withResolvers();calls.push({method,args,...pending});return pending.promise};
window.fixture={act,calls,jumped,branched,moved,panel,readDraft,store,back:()=>handleNativeBack('commit'),mount(){seedDraft('/synthetic/a','Unsent original');return mountTasks()}};
`);
const ROWS=[{id:'u1',text:'continue',active:true},{id:'u2',text:'continue',active:true},{id:'u9',text:'continue',active:false}];
async function fixture(t,rows=ROWS){const dom=createDomFixture(code),w=dom.window,{act,calls,branched,moved,panel,readDraft}=w.fixture;w.Element.prototype.getAnimations=()=>[];w.fetch=async url=>{assert.ok(url.startsWith('/api/tree?'));return{ok:true,status:200,json:async()=>({ok:true,rows,nextBefore:null})}};let r,unmounted=false;await act(async()=>{r=w.fixture.mount()});const unmount=async()=>{if(!unmounted){unmounted=true;await act(async()=>r.unmount())}};t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  // The row's actions menu, then one of its items (rendered in a portal).
  const button=id=>w.document.querySelector(`[data-timeline-row-id="${id}"] [data-testid="timeline-row-menu"]`);
  const item=testId=>w.document.querySelector(`[data-testid="${testId}"]`);
  const has=testId=>item(testId)!==null;
  const click=id=>act(async()=>button(id).click());
  const choose=async(id,testId)=>{await click(id);await act(async()=>item(testId)?.click())};
  const move=async(id,summarize=false,reanswer=false)=>{await choose(id,reanswer?'timeline-reanswer':'timeline-go-here');await act(async()=>item(summarize?'timeline-move-summarize':'timeline-move-no-summary')?.click())};
  // Rewind asks once in a ConfirmSheet; its confirm button is the only branch trigger.
  const confirmButton=()=>item('confirm-sheet-confirm');
  // The workspace panel is open until the tab closes it through closePanels().
  const panelOpen=()=>panel.workspace==='tasks';
  const note=id=>w.document.querySelector(`[data-timeline-row-id="${id}"] [role="status"]`);
  const text=()=>w.document.body.textContent;
  const labels=()=>[...w.document.querySelectorAll('[data-testid="timeline-row-label"]')].map(node=>node.textContent.replace(/^·/,''));
  const rowIds=()=>[...w.document.querySelectorAll('[data-timeline-row-id]')].map(row=>row.dataset.timelineRowId);
  return{w,act,calls,branched,moved,readDraft,button,item,has,click,choose,move,confirmButton,panelOpen,note,text,labels,rowIds,unmount,render:(...a)=>act(async()=>r.render(...a)),
   confirm:async id=>{await choose(id,'timeline-rewind-new');await act(async()=>confirmButton()?.click())},
   finish:(i,result={sessionPath:'/synthetic/new-branch',text:'Restored prompt',cancelled:false})=>act(async()=>calls[i].resolve(result))};}
test('rewind uses the selected raw entry id even when all prompt text matches',async t=>{const f=await fixture(t);await f.confirm('u2');assert.equal(f.calls[0].method,'branch');assert.deepEqual(Array.from(f.calls[0].args),['/synthetic/a','u2'])});
test('a nonactive tree row retains its exact target identity',async t=>{const f=await fixture(t);await f.confirm('u9');assert.equal(f.calls[0].method,'branch');assert.deepEqual(Array.from(f.calls[0].args),['/synthetic/a','u9'])});
test('opening the row menu alone starts nothing',async t=>{const f=await fixture(t);await f.click('u2');assert.equal(f.calls.length,0);assert.equal(f.has('timeline-go-here'),true);assert.equal(f.has('timeline-rewind-new'),true)});
test('repeated confirmation cannot create two branches',async t=>{const f=await fixture(t);await f.choose('u2','timeline-rewind-new');await f.act(async()=>{f.confirmButton().click();f.confirmButton().click()});assert.equal(f.calls.length,1)});
test('cancelled rewind cannot erase an existing draft or navigate',async t=>{const f=await fixture(t);await f.confirm('u2');await f.finish(0,{sessionPath:'/synthetic/a',text:'',cancelled:true});assert.equal(f.readDraft('/synthetic/a'),'Unsent original');assert.equal(f.branched.length,0);assert.equal(f.panelOpen(),true);assert.equal(f.note('u2').textContent,'Rewind cancelled.');assert.equal(f.w.document.querySelector('[data-slot="notice"]'),null)});
test('close/reopen ignores old branch draft and navigation effects',async t=>{const f=await fixture(t);await f.confirm('u2');await f.render(false);await f.render(true);await f.finish(0);assert.equal(f.readDraft('/synthetic/new-branch'),'');assert.equal(f.branched.length,0);assert.equal(f.panelOpen(),true)});
test('changed session ignores old branch result',async t=>{const f=await fixture(t);await f.confirm('u2');await f.render(true,'/synthetic/b');await f.finish(0);assert.equal(f.branched.length,0);assert.equal(f.panelOpen(),true)});
test('unmounted branch cannot seed a draft or call navigation',async t=>{const f=await fixture(t);await f.confirm('u2');await f.unmount();await f.finish(0);assert.equal(f.readDraft('/synthetic/new-branch'),'');assert.equal(f.branched.length,0)});
test('current success seeds returned text and opens its exact branch',async t=>{const f=await fixture(t);await f.confirm('u2');await f.finish(0);assert.equal(f.readDraft('/synthetic/new-branch'),'Restored prompt');assert.deepEqual(Array.from(f.branched),['/synthetic/new-branch']);assert.equal(f.panelOpen(),false)});
test('old failure cannot appear in a new session',async t=>{const f=await fixture(t);await f.confirm('u2');await f.render(true,'/synthetic/b');await f.act(async()=>f.calls[0].reject(new Error('Old branch failure')));assert.equal(f.w.document.body.textContent.includes('Old branch failure'),false)});
test('pending branch blocks competing rewind rows',async t=>{const f=await fixture(t);await f.confirm('u2');assert.equal(f.button('u9').disabled,true);await f.confirm('u9');assert.equal(f.calls.length,1)});
test('old finally cannot unlock a newer branch request',async t=>{const f=await fixture(t);await f.confirm('u2');await f.render(true,'/synthetic/b');await f.confirm('u9');await f.finish(0);assert.equal(f.button('u1').disabled,true);assert.equal(f.branched.length,0);await f.finish(1,{sessionPath:'/synthetic/newer',text:'Newer branch',cancelled:false});assert.deepEqual(Array.from(f.branched),['/synthetic/newer'])});
test('current failure can be explicitly reconfirmed',async t=>{const f=await fixture(t);await f.confirm('u2');await f.act(async()=>f.calls[0].reject(new Error('Current branch failure')));assert.ok(f.note('u2').textContent.includes('Current branch failure'));await f.confirm('u2');assert.equal(f.calls.length,2)});
test('same-visit rerender preserves its pending branch',async t=>{const f=await fixture(t);await f.confirm('u2');await f.render(true);await f.finish(0);assert.deepEqual(Array.from(f.branched),['/synthetic/new-branch'])});

test('Go here waits for a summary choice and transports no-summary explicitly',async t=>{const f=await fixture(t);await f.choose('u2','timeline-go-here');assert.equal(f.calls.length,0);await f.act(async()=>f.item('timeline-move-no-summary').click());assert.equal(f.calls[0].method,'treeGoto');assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].args)),['/synthetic/a','u2',{summarize:false}]);await f.finish(0,{cancelled:false,editorText:'Amend me'});assert.deepEqual(JSON.parse(JSON.stringify(f.moved)),[['/synthetic/a','Amend me',false]]);assert.equal(f.readDraft('/synthetic/a'),'Unsent original');assert.equal(f.branched.length,0,'no new chat');assert.equal(f.panelOpen(),false)});
test('a cancelled Go here says nothing changed and keeps the panel',async t=>{const f=await fixture(t);await f.move('u2');await f.finish(0,{cancelled:true});assert.ok(f.text().includes('Nothing changed.'));assert.equal(f.moved.length,0);assert.equal(f.panelOpen(),true)});
test('a refused Go here shows the reason and moves nothing',async t=>{const f=await fixture(t);await f.move('u2');await f.act(async()=>f.calls[0].reject(new Error('Stop the agent first')));assert.ok(f.text().includes('Stop the agent first'));assert.equal(f.moved.length,0)});
test('a Go here from a previous session cannot move the new one',async t=>{const f=await fixture(t);await f.move('u2');await f.render(true,'/synthetic/b');await f.finish(0,{cancelled:false,editorText:'Old'});assert.equal(f.moved.length,0);assert.equal(f.panelOpen(),true)});

test('no Labeled chip while no row has a label',async t=>{const f=await fixture(t);assert.equal(f.has('timeline-labeled-filter'),false)});
test('the Labeled chip narrows the list to labelled rows',async t=>{const f=await fixture(t,[{id:'u1',text:'first',active:true},{id:'u2',text:'second',active:true,label:'Before refactor'}]);assert.deepEqual(f.labels(),['Before refactor']);assert.deepEqual(f.rowIds(),['u1','u2']);await f.act(async()=>f.item('timeline-labeled-filter').click());assert.deepEqual(f.rowIds(),['u2']);assert.equal(f.item('timeline-labeled-filter').getAttribute('aria-pressed'),'true')});
test('adding a label saves the typed text and shows what the daemon kept',async t=>{const f=await fixture(t);await f.choose('u1','timeline-label');assert.equal(f.has('timeline-label-input'),true);const input=f.item('timeline-label-input');await f.act(async()=>{const setter=Object.getOwnPropertyDescriptor(f.w.HTMLInputElement.prototype,'value').set;setter.call(input,'  Checkpoint ');input.dispatchEvent(new f.w.Event('input',{bubbles:true}))});await f.act(async()=>[...f.w.document.querySelectorAll('button[type="submit"]')].find(b=>b.textContent==='Save').click());assert.equal(f.calls[0].method,'treeLabel');assert.deepEqual(Array.from(f.calls[0].args),['/synthetic/a','u1','  Checkpoint ']);await f.act(async()=>f.calls[0].resolve('Checkpoint'));assert.deepEqual(f.labels(),['Checkpoint']);assert.equal(f.has('timeline-label-input'),false);assert.equal(f.has('timeline-labeled-filter'),true)});
test('Remove label clears it and the chip goes with the last one',async t=>{const f=await fixture(t,[{id:'u1',text:'first',active:true,label:'Keep'}]);await f.click('u1');assert.equal(f.text().includes('Edit label'),true);await f.act(async()=>f.item('timeline-label-remove').click());assert.deepEqual(Array.from(f.calls[0].args),['/synthetic/a','u1',null]);await f.act(async()=>f.calls[0].resolve(null));assert.deepEqual(f.labels(),[]);assert.equal(f.has('timeline-labeled-filter'),false)});

test('summarize choice keeps the selected off-branch target and prevents duplicate requests',async t=>{
  const f=await fixture(t);await f.choose('u9','timeline-go-here');
  await f.act(async()=>{const choice=f.item('timeline-move-summarize');choice.click();choice.click()});
  assert.equal(f.calls.length,1);assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].args)),['/synthetic/a','u9',{summarize:true}]);
  assert.equal(f.button('u2').disabled,true);
});
test('cancelling summary selection leaves path, draft and branches untouched',async t=>{
  const f=await fixture(t);await f.choose('u2','timeline-go-here');await f.act(async()=>f.item('timeline-move-cancel').click());
  assert.equal(f.calls.length,0);assert.equal(f.moved.length,0);assert.equal(f.branched.length,0);assert.equal(f.readDraft('/synthetic/a'),'Unsent original');assert.equal(f.panelOpen(),true);assert.deepEqual(f.rowIds(),['u1','u2','u9']);
});
for(const method of ['Escape','back'])test(method+' cancels summary selection without navigating',async t=>{
  const f=await fixture(t);await f.choose('u2','timeline-go-here');
  await f.act(async()=>method==='back'?f.w.fixture.back():f.w.document.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true})));
  await f.act(async()=>new Promise(resolve=>f.w.setTimeout(resolve,350)));
  assert.equal(f.w.document.querySelector('[role="dialog"]')===null,true);assert.equal(f.calls.length,0);assert.equal(f.moved.length,0);assert.equal(f.panelOpen(),true);
});
test('an aborted summary or question transaction never claims a committed move',async t=>{
  const f=await fixture(t);await f.move('u2',true);await f.finish(0,{cancelled:false,aborted:true});
  assert.equal(f.moved.length,0);assert.equal(f.panelOpen(),true);assert.equal(f.readDraft('/synthetic/a'),'Unsent original');assert.match(f.note('u2').textContent,/Nothing changed/);
});
const DECISIONS=[
  {id:'u1',kind:'user',text:'Choose a storage engine',active:true},
  {id:'ask-original',kind:'ask',text:'Which database should we use?\nHow should migrations run?',answer:'PostgreSQL\nManually',active:false,label:'Original choice'},
  {id:'ask-alternate',kind:'ask',text:'Which database should we use?\nHow should migrations run?',answer:'SQLite\nAutomatically',active:true},
];
test('historical decisions show question and answer, with Re-answer instead of user-message rewind',async t=>{
  const f=await fixture(t,DECISIONS);
  assert.match(f.w.document.querySelector('[data-timeline-row-id="ask-original"]').textContent,/PostgreSQL/);
  await f.click('ask-original');assert.match(f.item('timeline-row-actions').textContent,/How should migrations run/);assert.match(f.item('timeline-row-actions').textContent,/Manually/);
  assert.equal(f.has('timeline-reanswer'),true);assert.equal(f.has('timeline-rewind-new'),false);assert.equal(f.has('timeline-go-here'),false);
});
test('re-answer uses original result identity, preserves comparison rows, and reports native auto-resume',async t=>{
  const f=await fixture(t,DECISIONS);await f.move('ask-original',false,true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0].args)),['/synthetic/a','ask-original',{summarize:false}]);
  await f.finish(0,{cancelled:false,askReanswerCommitted:true});
  assert.deepEqual(JSON.parse(JSON.stringify(f.moved)),[['/synthetic/a',null,true]]);assert.equal(f.branched.length,0);
  assert.deepEqual(f.rowIds(),['u1','ask-original','ask-alternate']);assert.match(f.text(),/PostgreSQL/);assert.match(f.text(),/SQLite/);assert.equal(f.readDraft('/synthetic/a'),'Unsent original');
});
test('cancelling a historical question preserves both decision branches and can be retried',async t=>{
  const f=await fixture(t,DECISIONS);await f.move('ask-original',false,true);await f.finish(0,{cancelled:true});
  assert.equal(f.moved.length,0);assert.deepEqual(f.rowIds(),['u1','ask-original','ask-alternate']);assert.equal(f.panelOpen(),true);
  await f.move('ask-original',true,true);assert.equal(f.calls.length,2);
});
test('a controller session switch rejects old completion even before workspace props update',async t=>{
  const f=await fixture(t);await f.move('u2');await f.act(async()=>f.w.fixture.store.setState({sessionPath:'/synthetic/b'}));
  await f.finish(0,{cancelled:false,editorText:'Old prepared text'});assert.equal(f.moved.length,0);assert.equal(f.panelOpen(),true);
});
test('running state disables a previously opened move choice without dispatching',async t=>{
  const f=await fixture(t);await f.choose('u2','timeline-go-here');await f.act(async()=>f.w.fixture.store.setState({agentWorking:true}));
  assert.equal(f.item('timeline-move-summarize').disabled,true);assert.equal(f.item('timeline-move-no-summary').disabled,true);
  await f.act(async()=>f.item('timeline-move-no-summary').click());assert.equal(f.calls.length,0);assert.match(f.text(),/Stop the agent/);
});
test('a confirmed control refusal prevents tree navigation',async t=>{
  const f=await fixture(t);await f.act(async()=>f.w.fixture.store.setState({sessions:[{path:'/synthetic/a',capabilities:{control:false}}]}));
  await f.click('u2');assert.equal(f.item('timeline-go-here').disabled,true);assert.match(f.text(),/cannot be changed from this device/);assert.equal(f.calls.length,0);
});

test('a refused historical answer explains native cancellation without changing paths',async t=>{
  const f=await fixture(t,DECISIONS);await f.move('ask-original',false,true);
  await f.finish(0,{cancelled:true,error:'A chat redirect cannot re-answer an earlier question.'});
  assert.match(f.note('ask-original').textContent,/chat redirect cannot re-answer/);
  assert.equal(f.moved.length,0);assert.equal(f.panelOpen(),true);assert.equal(f.readDraft('/synthetic/a'),'Unsent original');
});

const ANSWERS=[{id:'u1',kind:'user',text:'Same prompt',active:true,resumeTargets:[
  {id:'answer-one',text:'First completed approach'},
  {id:'answer-two',text:'Second completed approach'},
]}];
test('resuming a completed sibling answer targets that answer without replaying the prompt or replacing the draft',async t=>{
  const f=await fixture(t,ANSWERS);await f.click('u1');
  const choices=f.w.document.querySelectorAll('[data-testid="timeline-resume-answer"]');
  assert.equal(choices[1].textContent.includes('Second completed approach'),true);
  await f.act(async()=>choices[1].click());
  assert.equal(f.calls.length,0);
  await f.act(async()=>f.item('timeline-move-no-summary').click());
  assert.equal(f.calls[0].method,'treeGoto');
  assert.equal(f.calls[0].args[1],'answer-two');
  await f.finish(0,{cancelled:false});
  assert.equal(f.moved[0][1],null);
  assert.equal(f.readDraft('/synthetic/a'),'Unsent original');
  assert.equal(f.branched.length,0);
});
test('a resumed-answer failure is shown on its prompt row and a stale completion cannot switch the newer view',async t=>{
  const f=await fixture(t,ANSWERS);await f.choose('u1','timeline-resume-answer');
  await f.act(async()=>f.item('timeline-move-no-summary').click());
  await f.act(async()=>f.calls[0].reject(new Error('Answer is unavailable')));
  assert.equal(f.note('u1').textContent.includes('Answer is unavailable'),true);
  await f.choose('u1','timeline-resume-answer');
  await f.act(async()=>f.item('timeline-move-no-summary').click());
  await f.render(true,'/synthetic/b');
  await f.finish(1,{cancelled:false});
  assert.equal(f.moved.length,0);
  assert.equal(f.panelOpen(),true);
});
for(const action of ['done','drop','rm'])test('duplicate task '+action+' refuses the ambiguous native selector before any mutation',async t=>{
  const f=await fixture(t);
  const phases=[{name:'First',tasks:[{content:'Repeat',status:'pending'}]},{name:'Second',tasks:[{content:'Repeat',status:'pending'}]}];
  await f.act(async()=>f.w.fixture.store.setState({messages:[{id:'board',role:'assistant',text:'',parts:[{kind:'tool',name:'todo',callId:'todo',state:'ok',todo:phases}]}]}));
  const rows=f.w.document.querySelectorAll('[data-testid="todo-task"]');
  await f.act(async()=>rows[1].querySelector('button').click());
  await f.act(async()=>f.item('todo-action-'+action).click());
  assert.equal(f.calls.length,0);
  assert.equal(f.text().includes('Several tasks have this name'),true);
  assert.deepEqual([...f.w.document.querySelectorAll('[data-testid="todo-task"]')].map(row=>row.dataset.status),['pending','pending']);
});
