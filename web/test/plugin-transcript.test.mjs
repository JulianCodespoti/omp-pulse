import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
import { pluginHostStub } from './support/plugin-host-stub.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {ToolPart} from ${JSON.stringify(resolve(root, 'web/src/app/parts/ToolPart.tsx'))};
import {MessageParts} from ${JSON.stringify(resolve(root, 'web/src/app/parts/MessageParts.tsx'))};
import {TurnWorkChip} from ${JSON.stringify(resolve(root, 'web/src/app/chat/TurnWorkChip.tsx'))};
import {WorkRun} from ${JSON.stringify(resolve(root, 'web/src/app/parts/WorkRail.tsx'))};
import {entriesToTranscript} from ${JSON.stringify(resolve(root, 'web/src/domain/messages.ts'))};
const text=value=>({k:'text',p:{text:value},c:[]});
const entry=(pluginName,value)=>[{pluginId:'cron',pluginName,view:text(value)}];
const plugin={id:'cron',name:'Cron',version:'1',description:'',status:'enabled',hash:'h',slots:['transcript.tool','transcript.message'],
  tools:['schedule_*'],messages:['my-ext:card'],permissions:[],options:[],optionValues:{},actions:[],sources:[],linked:false,changed:false};
const hooks=window.pluginHostTest={
  state:{catalog:[plugin],catalogError:null,runtimes:{},haltedAfterCrash:false,
    views:{'composer.status':[],'composer.actions':[],drawer:[],page:[],'session.row':[],'session.menu':[],'transcript.tool':[],'transcript.message':[]},
    keyed:{'session.row':{},'session.menu':{},
      'transcript.tool':{claimed:entry('Cron','Next run at 10:00')},
      'transcript.message':{note:entry('Cron','Card for the note')}}},
  retains:[],releases:[],dispatches:[],keyRetains:[]};
const tool=(callId,name)=>({kind:'tool',callId,name,args:{},state:'ok',output:'raw output'});
const note={id:'note',role:'assistant',customType:'my-ext:card',text:'Raw note text',parts:[{kind:'text',text:'Raw note text'}]};
const other={id:'other',role:'assistant',customType:'other:type',text:'Unclaimed text',parts:[{kind:'text',text:'Unclaimed text'}]};
const turn=(id,...parts)=>({id,role:'assistant',text:'',parts});
const withClaimed=turn('turn-claimed',tool('claimed','schedule_list'),tool('plain','bash'));
const onlyPlain=turn('turn-plain',tool('plain','bash'));
const root=()=>createRoot(document.getElementById('root'));
// A settled turn in Summary mode: the chip folds the work; its body draws the run as the transcript does.
const settled=message=>{const r=root();
  const item={kind:'run',key:'run-'+message.id,messages:[message],continued:false,reply:''};
  r.render(h(TurnWorkChip,{work:{items:[item],summary:undefined,failed:false},
    render:work=>h(WorkRun,{messages:work.messages,toolsLive:false,defaultExpanded:true})}));return r;};
const live=message=>{const r=root();
  r.render(h(WorkRun,{messages:[message],toolsLive:true,latestThought:true,group:'live',liveMessageId:message.id}));return r;};
// A turn that landed edits settles as two groups: its run's, then the edit summary after the
// reply, whose items span the whole turn and so repeat the run's messages (claimed call included).
const settledWithEdits=message=>{const r=root();
  const reply={id:'reply',role:'assistant',text:'Done.',parts:[{kind:'text',text:'Done.'}]};
  const run={kind:'run',key:'run-'+message.id,messages:[message],continued:true,reply:'Done.'};
  const edits={kind:'edits',key:'edits:reply',messages:[message,reply]};
  const group=item=>({items:[item],summary:undefined,failed:false});
  const body=work=>work.kind==='edits'?h('div',null,'Edited 1 file'):h(WorkRun,{messages:work.messages,toolsLive:false,defaultExpanded:true});
  r.render(h('div',null,h(TurnWorkChip,{work:group(run),render:body}),h(TurnWorkChip,{work:group(edits),render:body})));return r;};
window.fixture={act,
  retained:()=>JSON.stringify(hooks.keyRetains.map(String)),
  details:()=>JSON.stringify(entriesToTranscript([
    {type:'custom_message',id:'with',customType:'my-ext:card',display:true,content:'Body',details:{items:[1,2]}},
    {type:'custom_message',id:'without',customType:'my-ext:card',display:true,content:'Body'}]).messages
    .map(message=>({id:message.id,has:'customDetails' in message,details:message.customDetails??null}))),
  mountTools(){const r=root();
    r.render(h('div',null,
      h(ToolPart,{part:tool('claimed','schedule_list'),live:false}),
      h(ToolPart,{part:tool('plain','bash'),live:false})));return r;},
  mountMessages(){const r=root();
    r.render(h('div',null,h(MessageParts,{message:note}),h(MessageParts,{message:other})));return r;},
  mountSettledClaimed:()=>settled(withClaimed),
  mountSettledWithEdits:()=>settledWithEdits(withClaimed),
  mountSettledPlain:()=>settled(onlyPlain),
  mountLiveClaimed:()=>live(withClaimed),
  mountLivePlain:()=>live(onlyPlain)};
`, [pluginHostStub]);

async function fixture(t, mountName) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  let mounted;
  const act = callback => f.act(async () => { await callback(); });
  await act(() => { mounted = f[mountName](); });
  t.after(async () => {
    try { await act(() => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); }
  });
  return { w, act, retained: () => JSON.parse(f.retained()), q: selector => [...w.document.querySelectorAll(selector)] };
}

test('a claimed tool call shows its plugin card, and Show original toggles both ways', async t => {
  const { act, q, retained } = await fixture(t, 'mountTools');
  const cards = q("[data-testid='plugin-tool-card']");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].getAttribute('data-plugin'), 'cron');
  assert.equal(cards[0].getAttribute('data-call'), 'claimed');
  assert.match(cards[0].textContent, /Cron/);
  assert.match(cards[0].textContent, /Next run at 10:00/);
  // The claimed call keeps its stock row above the card: a card can add to what a call says
  // it did, never replace it. Only the claimed one asked the host for a view.
  assert.equal(q("[data-testid='tool-row']").length, 2);
  const claimedPart = cards[0].closest("[data-testid='tool-part']");
  assert.ok(claimedPart.querySelector("[data-testid='tool-row']"), "the row sits with its card");
  assert.equal(retained().length, 1);
  assert.match(retained()[0], /claimed/);

  await act(() => q("[data-testid='plugin-show-original']")[0].click());
  assert.equal(q("[data-testid='plugin-tool-card']").length, 0);
  assert.equal(q("[data-testid='tool-row']").length, 2);
  const back = q("[data-testid='plugin-show-original']");
  assert.equal(back.length, 1);
  assert.equal(back[0].getAttribute('aria-pressed'), 'true');

  await act(() => back[0].click());
  assert.equal(q("[data-testid='plugin-tool-card']").length, 1);
  assert.equal(q("[data-testid='tool-row']").length, 2);
  assert.equal(q("[data-testid='plugin-show-original']")[0].getAttribute('aria-pressed'), 'false');
});

test('a claimed custom message shows its card and Show original brings back the stock text', async t => {
  const { act, q, retained } = await fixture(t, 'mountMessages');
  const cards = q("[data-testid='plugin-message-card']");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].getAttribute('data-plugin'), 'cron');
  assert.match(cards[0].textContent, /Card for the note/);
  assert.doesNotMatch(cards[0].textContent, /Raw note text/);
  // The unclaimed custom type renders as before and retains nothing.
  assert.match(q('body')[0].textContent, /Unclaimed text/);
  assert.equal(retained().length, 1);
  assert.match(retained()[0], /note/);

  await act(() => q("[data-testid='plugin-show-original']")[0].click());
  assert.equal(q("[data-testid='plugin-message-card']").length, 0);
  assert.match(q('body')[0].textContent, /Raw note text/);
  assert.equal(q("[data-testid='plugin-show-original']")[0].getAttribute('aria-pressed'), 'true');

  await act(() => q("[data-testid='plugin-show-original']")[0].click());
  assert.equal(q("[data-testid='plugin-message-card']").length, 1);
});

test('a settled Summary-mode turn shows one plugin card in the flow, under its chip, even once the chip is open', async t => {
  const { act, q, retained } = await fixture(t, 'mountSettledClaimed');
  const cards = q("[data-testid='plugin-tool-card']");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].getAttribute('data-call'), 'claimed');
  assert.equal(cards[0].closest("[data-testid='turn-work']"), null);
  assert.equal(retained().length, 1);

  await act(() => q("[data-testid='turn-work-title']")[0].click());
  assert.equal(q("[data-testid='plugin-tool-card']").length, 1);
  assert.equal(q("[data-testid='tool-part'] [data-testid='plugin-tool-card']").length, 0);
});

test("a turn's edit summary repeating a claimed call does not draw its card a second time", async t => {
  const { q, retained } = await fixture(t, 'mountSettledWithEdits');
  assert.equal(q("[data-testid='turn-work']").length, 2);
  const cards = q("[data-testid='plugin-tool-card']");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].getAttribute('data-call'), 'claimed');
  assert.equal(retained().length, 1);
});

test('a live Summary-mode run shows the plugin card in the flow, beside the rail rather than inside it', async t => {
  const { q, retained } = await fixture(t, 'mountLiveClaimed');
  assert.equal(q("[data-testid='work-rail']").length, 1);
  const cards = q("[data-testid='plugin-tool-card']");
  assert.equal(cards.length, 1);
  assert.equal(cards[0].getAttribute('data-call'), 'claimed');
  assert.equal(cards[0].closest("[data-testid='turn-work']"), null);
  assert.equal(retained().length, 1);
});

for (const mountName of ['mountSettledPlain', 'mountLivePlain']) {
  test(`${mountName}: an unclaimed call adds no card and retains nothing`, async t => {
    const { q, retained } = await fixture(t, mountName);
    assert.equal(q("[data-testid='plugin-tool-card']").length, 0);
    assert.equal(q("[data-testid='plugin-show-original']").length, 0);
    assert.deepEqual(retained(), []);
  });
}

test('an extension message keeps its details for plugins and leaves the field out when there are none', async t => {
  const { w } = await fixture(t, 'mountTools');
  assert.deepEqual(JSON.parse(w.fixture.details()), [
    { id: 'with', has: true, details: { items: [1, 2] } },
    { id: 'without', has: false, details: null },
  ]);
});
