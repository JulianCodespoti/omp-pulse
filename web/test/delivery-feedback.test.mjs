import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
  import {createElement,act} from ${JSON.stringify(require.resolve("react"))};
  import {createRoot} from ${JSON.stringify(require.resolve("react-dom/client"))};
  import {QueuedMessage} from ${JSON.stringify(resolve(root,"web/src/app/parts/QueuedMessage.tsx"))};
  import {reportLinkError} from ${JSON.stringify(resolve(root,"web/src/runtime/link-state.ts"))};
  const calls={retry:[],cancel:[],edit:[]};
  window.fixture={act,calls,linkDown:()=>reportLinkError(new TypeError('Failed to fetch')),mount:(entry,reason)=>{
    const r=createRoot(document.getElementById('root'));
    const render=(next=entry)=>r.render(createElement(QueuedMessage,{entry:next,reason,onRetry:()=>calls.retry.push(next.commandId),onCancel:()=>calls.cancel.push(next.commandId),onEdit:()=>calls.edit.push(next.commandId)}));
    render();return {render,unmount:()=>r.unmount()};
  }};
`);

async function fixture(t,state,extra={},reason) {
  const dom=createDomFixture(code),w=dom.window,{act,calls}=w.fixture;
  const entry={id:'fixture-command',commandId:'fixture-command',sessionPath:'/synthetic/session',text:'Review',
    state,imageCount:0,imageBytes:0,droppedImages:false,createdAt:Date.now(),updatedAt:Date.now(),...extra};
  let mounted;await act(async()=>{mounted=w.fixture.mount(entry,reason);});
  t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[]);}finally{dom.close();}});
  const button=label=>w.document.querySelector(`button[aria-label="${label}"]`);
  return {w,calls,button,text:()=>w.document.body.textContent,
    status:()=>w.document.querySelector('[data-testid="send-status"]'),
    labels:()=>Array.from(w.document.querySelectorAll('button'),b=>b.getAttribute('aria-label')),
    render:change=>act(async()=>mounted.render({...entry,...change})),
    click:label=>act(async()=>{assert.ok(button(label),label);button(label).click();})};
}

// Failure reasons remain available to assistive technology as well as visibly.
function assertReason(f,reason){
  const status=f.status();
  assert.equal(status?.getAttribute('title'),reason);
  assert.equal(status.getAttribute('aria-description'),`This message wasn’t sent. ${reason}`);
  assert.equal(status.querySelector('p').textContent,`This message wasn’t sent. ${reason}`);
}

test('failed messages carry the full reason, offer Edit and Remove, and Remove can be undone',async t=>{
  const reason='The desktop session is busy. Try again shortly.';
  const f=await fixture(t,'failed',{},reason);
  assert.equal(f.status().getAttribute('data-state'),'failed');
  assertReason(f,reason);
  assert.deepEqual(f.labels(),['Edit','Remove']);
  await f.click('Edit');assert.deepEqual(Array.from(f.calls.edit),['fixture-command']);
  // Remove hides the row at once; the real cancel waits out the undo window.
  await f.click('Remove');assert.equal(f.status(),null);assert.equal(f.calls.cancel.length,0);
  assert.equal(f.calls.retry.length,0);
});

test('delivery failures keep their reason and offer Edit and Remove',async t=>{
  for(const [code,error,expected] of [
    ['session_owned_by_terminal','session_owned_by_terminal: Auto-sharing is temporarily unavailable.','Auto-sharing is temporarily unavailable.'],
    ['agent_rejected','agent_rejected: Agent is already processing.','Agent is already processing.'],
    ['agents_busy','child pool saturated: every child is busy','Your computer is busy with other sessions. Try again in a moment.'],
    ['agent_rejected','agent_rejected: 403 {\n "error": {"message": "Forbidden for this plan"}}','Forbidden for this plan'],
  ]){
    const f=await fixture(t,'failed',{code,error});
    assertReason(f,expected);
    assert.deepEqual(f.labels(),code==='session_owned_by_terminal'?['Edit','Sharing help','Remove']:['Edit','Remove']);
    assert.equal(f.calls.retry.length,0);
  }
});

test('a prompt the agent received never reads as Failed, whatever ended its turn',async t=>{
  for(const state of ['completed','failed'])for(const [code,error] of [
    ['agent_aborted','The turn was stopped.'],
    ['agent_failed','The socket connection was closed unexpectedly'],
    ['agent_refused','Refusal (cyber): This request triggered restrictions.'],
    ['agent_interrupted','Previous OMP process exited before completing the turn.'],
  ]){
    const f=await fixture(t,state,{receipt:{code,error},error});
    assert.equal(f.text(),'',`${state} ${code}`);
  }
  // Native rows keep the bare code as their error when the receipt had no text.
  const f=await fixture(t,'failed',{error:'agent_aborted'});
  assert.equal(f.text(),'');
});

test('terminal failure retires prior delivery actions without dispatch',async t=>{
  for(const state of ['saved','uncertain']){
    const f=await fixture(t,state,{createdAt:Date.now()-7000});
    const oldButton=f.w.document.querySelector('button:not([aria-label="Remove"])');assert.ok(oldButton,state);
    await f.render({state:'failed',error:'Synthetic terminal failure'});
    assert.equal(f.w.document.querySelector('button:not([aria-label="Remove"]):not([aria-label="Edit"])') === null, true);
    await f.w.fixture.act(async()=>{oldButton.click();oldButton.click();oldButton.click();});
    assert.equal(f.calls.retry.length,0);
    // The daemon's raw error is humanized into a sentence, not shown verbatim.
    assertReason(f,'Synthetic terminal failure.');
    assert.deepEqual(f.labels(),['Edit','Remove']);
  }
});


test('fresh saved messages say Sending and only offer Remove',async t=>{
  const f=await fixture(t,'saved');assert.equal(f.text(),'Sending…');
  assert.equal(f.status().getAttribute('data-slow'),null);
  assert.deepEqual(f.labels(),['Remove']);
  await f.click('Remove');assert.equal(f.calls.cancel[0],'fixture-command');assert.equal(f.calls.retry.length,0);
});

test('slow saved messages offer Try again with the same command callback',async t=>{
  const f=await fixture(t,'saved',{createdAt:Date.now()-7000});
  assert.equal(f.status().getAttribute('data-slow'),'true');assert.ok(f.text().startsWith('Not sent'));
  assert.deepEqual(f.labels(),['Try again','Remove']);await f.click('Try again');
  assert.equal(f.calls.retry[0],'fixture-command');
});

test('a saved message turns slow on its own once the grace period passes',async t=>{
  const f=await fixture(t,'saved',{createdAt:Date.now()-5_900});
  assert.equal(f.text(),'Sending…');
  await f.w.fixture.act(()=>new Promise(r=>setTimeout(r,250)));
  assert.equal(f.status().getAttribute('data-slow'),'true');
  assert.deepEqual(f.labels(),['Try again','Remove']);assert.equal(f.calls.retry.length,0);
});

// Each automatic re-dispatch bumps updatedAt; the age must not restart with it.
test('an old message never goes back to Sending…, however recently it was re-dispatched',async t=>{
  const old={createdAt:Date.now()-7000,updatedAt:Date.now()};
  const saved=await fixture(t,'saved',old);
  assert.equal(saved.status().getAttribute('data-slow'),'true');assert.ok(saved.text().startsWith('Not sent'));
  const dispatching=await fixture(t,'dispatching',old);
  assert.equal(dispatching.text(),'Trying again…');
  assert.ok(dispatching.w.document.querySelector('[data-slot="spinner"]'),'still in flight, so still a spinner');
  assert.equal(dispatching.w.document.querySelectorAll('button').length,0);
});

test('with the link down an unsent message says it is waiting for the connection',async t=>{
  for(const [state,extra,labels] of [
    ['saved',{},['Remove']],
    ['saved',{createdAt:Date.now()-7000},['Try again','Remove']],
    ['dispatching',{},[]],
    ['dispatching',{createdAt:Date.now()-7000},[]],
  ]){
    const f=await fixture(t,state,extra);
    await f.w.fixture.act(async()=>f.w.fixture.linkDown());
    assert.equal(f.status().querySelector('span').textContent,'Waiting for connection');
    assert.equal(f.w.document.querySelector('[data-slot="spinner"]'),null,'a clock, not a spinner');
    assert.deepEqual(f.labels(),labels);
  }
});

test('an unconfirmed send has one label, one sentence, and a button that checks',async t=>{
  const f=await fixture(t,'uncertain');
  assert.equal(f.status().querySelector('span').textContent,'Not confirmed');
  assert.equal(f.status().querySelector('p').textContent,'We couldn’t confirm this message arrived. Check the conversation before sending again.');
  assert.deepEqual(f.labels(),['Check','Remove']);await f.click('Check');
  assert.equal(f.calls.retry[0],'fixture-command');
});

test('dispatching never gains cancellation or retry controls',async t=>{
  const f=await fixture(t,'dispatching');assert.equal(f.text(),'Sending…');
  assert.equal(f.w.document.querySelectorAll('button').length,0);
});

test('accepted and finished commands do not add receipt noise',async t=>{
  for(const state of ['accepted','completed','forwarded']){
    const f=await fixture(t,state);assert.equal(f.text(),'');
  }
});

test('a send the daemon holds for a free agent says so, in its own words, with no actions',async t=>{
  const error='Waiting for a free agent. 3 agents are working; this sends when one finishes.';
  const f=await fixture(t,'accepted',{receipt:{code:'agents_busy',error},error});
  assert.equal(f.text(),'Waiting for a free agent');
  // Held, not failed: the line must not claim the message wasn't sent.
  assert.equal(f.status().getAttribute('title'),error);
  assert.equal(f.status().getAttribute('aria-description'),error);
  assert.equal(f.w.document.querySelectorAll('button').length,0);
});

test('the line names no attachment count; the bubble already shows it',async t=>{
  for(const count of [1,2]){
    const f=await fixture(t,'failed',{imageCount:count});assert.match(f.text(),/^Not sent/);assert.doesNotMatch(f.text(),/\d|photo|image|attachment/i);
  }
});


test('Sending shows the shared spinner, hidden from assistive tech beside its text',async t=>{
  const f=await fixture(t,'dispatching'),icon=f.w.document.querySelector('[data-slot="spinner"]');
  assert.ok(icon,'dispatching renders the one Spinner');
  assert.equal(icon.getAttribute('aria-hidden'),'true');
});
