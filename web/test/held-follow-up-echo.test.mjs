import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

// A message sent while the agent works is held by omp as a follow-up. The chat
// painted it twice: the optimistic `local:` echo as a sent bubble AND the
// QueuedMessagesBar chip offering "Send now". The real ChatScreen over a real
// store, with a fake controller (no transport).
const require = createRequire(resolve(root, "web/package.json"));
const chatCode = await bundleDomFixture(`
  import {createElement as h, act} from ${JSON.stringify(require.resolve("react"))};
  import {createRoot} from ${JSON.stringify(require.resolve("react-dom/client"))};
  import {ChatScreen} from ${JSON.stringify(resolve(root, "web/src/app/ChatScreen.tsx"))};
  import {createOmpStore, parseQueuedMessages} from ${JSON.stringify(resolve(root, "web/src/runtime/omp-store.ts"))};
  import {hideHeldEchoes} from ${JSON.stringify(resolve(root, "web/src/runtime/held-echo-presentation.ts"))};
  import {DaemonApi} from ${JSON.stringify(resolve(root, "web/src/runtime/rpc-client.ts"))};
  DaemonApi.prototype.rpc = async () => ({});
  // ChatScreen fetches its own listing row when the controller's list lacks it.
  DaemonApi.prototype.sessionRow = async () => null;
  // The chat header's +a −r count reads the workspace changes summary.
  DaemonApi.prototype.getChangesSummary = async () => ({notRepo:true, totals:{files:0, added:0, removed:0}, files:[]});
  const store = createOmpStore();
  store.setState({sessionPath:'/synthetic/held', connection:'open',sessionAuthorities:{'/synthetic/held':{daemonInstanceId:'held-fixture',revision:1,bindingEpoch:1,observedAt:1,owner:{kind:'child'},turn:'running',confidence:'confirmed',connection:'connected',activity:null,capabilities:{control:true,queue:true}}}});
  const controller = {getReceiptScope:()=>"", getStore:()=>store, loadCommands:async()=>[],
    canRetainCollabAnswer:()=>false,
    setAtBottom(){}, loadSessions:async()=>{}, startSessionsPolling(){}, stopSessionsPolling(){}, prewarm(){}};
  window.fixture = {act, store, parseQueuedMessages, hideHeldEchoes,
    mount(){const r=createRoot(document.getElementById('root'));r.render(h(ChatScreen,{controller,onBack(){}}));return r;}};
`, [{name:"test-import-meta",options(options){return {...options,transform:{...options.transform,define:{...options.transform?.define,"import.meta":"{}"}}}}}]);

const FOLLOW_UP = "FOLLOW-UP-MARKER also run the tests";
const userMessage = (id, text) => ({ id, role: "user", text, parts: [{ kind: "text", text }] });
const assistant = (id, text) => ({ id, role: "assistant", text, parts: [{ kind: "text", text }] });

async function mountChat(t) {
  const dom = createDomFixture(chatCode), w = dom.window, { act, store } = w.fixture;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.Element.prototype.getAnimations = () => [];
  let mounted;
  await act(async () => { mounted = w.fixture.mount(); });
  t.after(async () => { try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const doc = w.document;
  return {
    w,
    change: fn => act(async () => fn(store.getState())),
    queue: lists => w.fixture.parseQueuedMessages(lists),
    // Strings and booleans only: a failing assert on a jsdom node prints the whole window.
    transcriptMentions: () => [...doc.querySelectorAll('[data-testid="queued-messages"]')]
      .reduce((text, bar) => text.replace(bar.textContent, ""), doc.body.textContent).split(FOLLOW_UP).length - 1,
    chips: () => doc.querySelectorAll('[data-testid="queued-message"]').length,
    sendNow: () => doc.querySelector('[aria-label="Send now"]') !== null,
  };
}

test("a follow-up omp holds shows once, as its queued chip, and once as a bubble after delivery", async t => {
  const f = await mountChat(t);
  await f.change(s => { s.setAgentWorking(true); s.setHistory([userMessage("u1", "Fix the build"), assistant("a1", "Looking at it")]); });
  // Composer send while busy: the controller paints the optimistic echo...
  await f.change(s => s.appendMessage(userMessage("local:cmd-1", FOLLOW_UP)));
  assert.equal(f.transcriptMentions(), 1, "before omp reports it, the echo is the message");
  // ...and omp, holding it as a follow-up, reports it in queue_update.
  await f.change(s => s.setQueuedMessages(f.queue({ steering: [], followUp: [FOLLOW_UP], steeringIds: [], followUpIds: ['held-follow-up'] })));
  assert.equal(f.chips(), 1);
  assert.equal(f.sendNow(), true, "the held follow-up keeps its own Send now");
  assert.equal(f.transcriptMentions(), 0, "no sent bubble while omp still holds it");

  // omp delivers it: the queue empties and the transcript entry replaces the echo.
  await f.change(s => s.setQueuedMessages(f.queue({ steering: [], followUp: [] })));
  await f.change(s => s.mergeMessages([userMessage("entry-9", FOLLOW_UP)]));
  assert.equal(f.chips(), 0);
  assert.equal(f.sendNow(), false, "a delivered message offers no send action");
  assert.equal(f.transcriptMentions(), 1, "the delivered message is one bubble");
});

test("held-echo pairing: oldest echo first, delivered twins, live-steered prefix and failed sends keep their bubble", async t => {
  const f = await mountChat(t);
  const hide = (messages, lists, outbox = []) =>
    Array.from(f.w.fixture.hideHeldEchoes(messages, f.queue(lists), outbox), m => m.id).join(",");
  const earlier = userMessage("u0", "yes");
  const echoA = userMessage("local:a", "yes");
  const echoB = userMessage("local:b", " yes ");
  assert.equal(hide([earlier, echoA, echoB], { steering: [], followUp: ["yes"] }), "u0,local:b",
    "one held occurrence hides one echo, the oldest; a transcript twin is never hidden");
  assert.equal(hide([echoA, echoB], { steering: [], followUp: ["yes", "yes"] }), "");
  assert.equal(hide([echoA], { steering: ["yes"], followUp: [], liveSteered: 1 }), "local:a",
    "a live-steered entry is already with the model");
  assert.equal(hide([echoA], { steering: ["yes"], followUp: [] }), "", "a held steer is its chip too");
  assert.equal(hide([echoA], { steering: [], followUp: ["yes"] }, [{ commandId: "a", state: "failed" }]), "local:a",
    "a failed send never reached omp; its Retry stays");
  const messages = [echoA];
  assert.equal(f.w.fixture.hideHeldEchoes(messages, f.queue({ steering: [], followUp: ["other"] }), []) === messages, true,
    "nothing held: same array, so memoized rows do not re-render");
});
