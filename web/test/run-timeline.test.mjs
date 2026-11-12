import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const react = `import {createElement as h} from ${JSON.stringify(require.resolve("react"))};`;

// RunSummary alone, with tool rows reduced to their identity.
const runCode = await bundleDomFixture(`
  import { createElement, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { RunSummary } from ${JSON.stringify(resolve(root, "web/src/app/parts/RunSummary.tsx"))};
  import { groupRunSteps } from ${JSON.stringify(resolve(root, "web/src/app/parts/run-summary.ts"))};
  window.fixture = { act, groupRunSteps, mount: (props) => {
    const r = createRoot(document.getElementById('root'));
    const render = (next) => r.render(createElement(RunSummary, { ...next, onOtherQuestion() {} }));
    render(props); return { render, unmount: () => r.unmount() };
  } };
`, [{ name: "presentation-boundaries", resolveId(id, importer) {
  if (importer?.endsWith("/RunSummary.tsx") && ["./ToolPart", "./ImagePart", "./QuickReplies"].includes(id)) return "\0" + id.slice(2);
  return null;
}, load(id) {
  if (id === "\0ToolPart") return react + `export const ToolPart = ({part,live}) => h('div',{'data-tool':part.callId,'data-live':String(live)},part.name);`;
  if (id === "\0ImagePart") return react + `export const ImagePart = () => null;`;
  if (id === "\0QuickReplies") return react + `export const QuickReplies = () => null;`;
  return null;
} }]);

// The whole chat surface over a real store: where the live message is placed.
const chatCode = await bundleDomFixture(`
  import {createElement as h, act} from ${JSON.stringify(require.resolve("react"))};
  import {createRoot} from ${JSON.stringify(require.resolve("react-dom/client"))};
  import {ChatScreen} from ${JSON.stringify(resolve(root, "web/src/app/ChatScreen.tsx"))};
  import {createOmpStore} from ${JSON.stringify(resolve(root, "web/src/runtime/omp-store.ts"))};
  import {DaemonApi} from ${JSON.stringify(resolve(root, "web/src/runtime/rpc-client.ts"))};
  DaemonApi.prototype.rpc = async () => ({});
  // The track strip above the composer asks the daemon for uncommitted changes; this fixture has no daemon.
  DaemonApi.prototype.getChangesSummary = async () => ({ notRepo: true, files: [], totals: { files: 0, additions: 0, deletions: 0 } });
  DaemonApi.prototype.sessionRow = async () => null;
  const store = createOmpStore();
  store.setState({sessionPath:'/synthetic/run', connection:'open'});
  const controller = {getReceiptScope:()=>"", getStore:()=>store, loadCommands:async()=>[],
    canRetainCollabAnswer:()=>false,
    setAtBottom(){}, loadSessions:async()=>{}, startSessionsPolling(){}, stopSessionsPolling(){}, prewarm(){}};
  window.fixture = {act, store, mount(){const r=createRoot(document.getElementById('root'));r.render(h(ChatScreen,{controller,onBack(){}}));return r;}};
`, [{name:"test-import-meta",options(options){return {...options,transform:{...options.transform,define:{...options.transform?.define,"import.meta":"{}"}}}}}]);

let nextCall = 0;
const tool = (name = "read", state = "ok", extras = {}) => ({ kind: "tool", callId: `c${nextCall++}`, name, args: { path: `src/${nextCall}.rs` }, state, ...extras });
const thought = text => ({ kind: "thinking", text });
const hidden = () => ({ kind: "thinking", text: "", redacted: true });
const assistant = (id, parts) => ({ id, role: "assistant", text: "", parts });
const long = n => `Thought ${n}: ${"weighing the next step ".repeat(20)}end ${n}.`;

async function mountRun(t, props) {
  const dom = createDomFixture(runCode), w = dom.window, { act } = w.fixture;
  let mounted;
  await act(async () => { mounted = w.fixture.mount(props); });
  t.after(async () => { try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const all = (sel, scope = w.document) => [...scope.querySelectorAll(sel)];
  const q = id => w.document.querySelector(`[data-testid="${id}"]`);
  return {
    w, act, all, q,
    steps: () => all('div[data-testid="run-step"]', q("run-summary")),
    click: el => act(async () => { el.click(); await Promise.resolve(); }),
    render: next => act(async () => mounted.render(next)),
  };
}

test("groupRunSteps opens a step at each thought and keeps leading calls as their own step", async t => {
  const f = await mountRun(t, { toolsLive: false, messages: [] });
  const a = tool(), b = tool(), c = tool(), d = tool(), first = thought("one"), second = thought("two"), secret = hidden();
  const steps = f.w.fixture.groupRunSteps([
    assistant("m1", [a, first, b]),
    assistant("m2", [c]),
    assistant("m3", [second, { kind: "image", src: "/x", mimeType: "image/png" }, secret, d]),
  ]);
  assert.equal(steps.length, 4);
  // Element-wise: arrays from the fixture window carry another realm's prototype.
  const tools = step => Array.from(step.tools, x => x.part);
  assert.equal(steps[0].thought === null, true);
  assert.equal(tools(steps[0]).length, 1);
  assert.equal(tools(steps[0])[0], a);
  assert.equal(steps[1].thought, first, "parts pass through by identity");
  assert.equal(tools(steps[1]).length, 2);
  assert.equal(tools(steps[1])[0], b);
  assert.equal(tools(steps[1])[1], c);
  assert.deepEqual(Array.from(steps[1].tools, x => x.messageId), ["m1", "m2"]);
  assert.equal(steps[2].thought, second);
  assert.equal(steps[2].tools.length, 0);
  assert.equal(steps[3].thought, secret);
  assert.equal(tools(steps[3]).length, 1);
  assert.equal(tools(steps[3])[0], d);
  assert.equal(f.w.fixture.groupRunSteps([assistant("m1", [])]).length, 0);
});

test("a thought is timed only from the end of the call before it to the start of the call it led to", async t => {
  const f = await mountRun(t, { toolsLive: false, messages: [] });
  const steps = f.w.fixture.groupRunSteps([
    // No call ended before the first thought: there is no honest start for it.
    assistant("m1", [thought("first"), tool("read", "ok", { startedAt: 1_000, endedAt: 2_000 })]),
    assistant("m2", [thought("second"), tool("read", "ok", { startedAt: 14_000, endedAt: 15_000 })]),
    // A call that claims to start before the previous one ended is not a duration.
    assistant("m3", [thought("third"), tool("read", "ok", { startedAt: 15_000 })]),
    // Only the first call after a thought measures it.
    assistant("m4", [thought("fourth"), tool("bash", "ok"), tool("read", "ok", { startedAt: 40_000 })]),
  ]);
  assert.deepEqual(Array.from(steps, step => step.thoughtMs ?? null), [null, 12_000, null, null]);
});

test("while live, the newest thought is the last line, under the calls that thought already issued", async t => {
  // The owner's screenshot: reasoning streaming ABOVE four running reads. omp keeps appending to the
  // same thinking part while the calls it issued run and report, so part order cannot be drawn as-is.
  const messages = [assistant("m1", [thought(long(1)), tool("read", "running"), tool("bash", "running")])];
  const order = (f) => f.all('[data-tool], [data-testid="thought"]', f.steps()[0]).map((el) => el.dataset.tool ? "tool" : "thought");
  const live = await mountRun(t, { toolsLive: true, liveMessageId: "m1", messages });
  assert.deepEqual(order(live), ["tool", "tool", "thought"]);
  const settled = await mountRun(t, { toolsLive: false, messages });
  await settled.click(settled.q("run-summary-toggle"));
  assert.deepEqual(order(settled), ["thought", "tool", "tool"], "a settled run keeps the true order");
});

test("every live step shows, and every settled thought is a collapsed row", async t => {
  const messages = [1, 2, 3, 4].map(n => assistant(`m${n}`, [thought(long(n)), tool()]));
  const f = await mountRun(t, { toolsLive: true, messages });
  // The live window hid all but two steps; the owner watched eight lines vanish mid-turn.
  assert.equal(f.steps().length, 4);
  assert.equal(f.all('[data-testid="thought-text"]').length, 0, "a thought followed by a call has settled");
  await f.click(f.q("run-summary-toggle"));
  assert.equal(f.steps().length, 4);
  await f.click(f.steps()[0].querySelector('[data-testid="thought-toggle"]'));
  assert.deepEqual(f.all('[data-testid="thought-text"]').map(node => node.textContent), [long(1)]);
  await f.render({ toolsLive: true, messages: [...messages, assistant("m5", [thought(long(5))])] });
  assert.deepEqual(f.all('[data-testid="thought-text"]').map(node => node.textContent), [long(1), long(5)], "manual expansion survives; only the block being streamed is open");
});

test("before any words the live step shows only a Thinking shimmer, and hidden reasoning is one quiet label", async t => {
  const f = await mountRun(t, { toolsLive: true, liveMessageId: "m2", messages: [
    assistant("m1", [hidden(), tool()]),
    assistant("m2", [thought("")]),
  ] });
  const [secret, current] = f.steps();
  assert.equal(secret.querySelector('[data-testid="thought-toggle"]').textContent, "Reasoning hidden");
  assert.equal(secret.querySelector('[data-testid="thought-text"]') === null, true);
  assert.equal(current.textContent, "Thinking…");
  assert.equal(current.querySelector('[data-testid="thought"]') === null, true, "no empty window before the first words");
  await f.render({ toolsLive: true, liveMessageId: "m2", messages: [
    assistant("m1", [hidden(), tool()]),
    assistant("m2", [thought("Checking the run grouping")]),
  ] });
  assert.equal(f.steps()[1].querySelector('[data-testid="thought"][data-live="true"]').textContent, "Checking the run grouping");
  // A redacted thought being streamed has no words to show and is never a shimmer.
  await f.render({ toolsLive: true, liveMessageId: "m2", messages: [
    assistant("m1", [hidden(), tool()]),
    assistant("m2", [hidden()]),
  ] });
  assert.equal(f.steps()[1].textContent, "Reasoning hidden");
  assert.equal(f.q("run-summary").textContent.includes("Private reasoning"), false);
});

test("a finished run opens its thoughts in place, each with its measured time", async t => {
  const messages = [
    assistant("m1", [tool("read", "ok", { startedAt: 1_000, endedAt: 2_000 }), thought(long(1)), tool("read", "ok", { startedAt: 14_000, endedAt: 15_000 })]),
    assistant("m2", [hidden(), tool("read", "ok", { startedAt: 16_000 })]),
    assistant("m3", [thought("untimed"), tool()]),
  ];
  const f = await mountRun(t, { toolsLive: false, messages });
  assert.equal(f.steps().length, 0, "folded until tapped");
  await f.click(f.q("run-summary-toggle"));
  const labels = f.steps().map(step => step.querySelector('[data-testid="thought-toggle"]')?.textContent ?? null);
  assert.deepEqual(labels, [null, "Thought for 12s", "Reasoning hidden", "Thought"]);
  await f.click(f.steps()[1].querySelector('[data-testid="thought-toggle"]'));
  assert.equal(f.steps()[1].querySelector('[data-testid="thought-text"]').textContent, long(1));
  assert.equal(f.steps()[2].querySelector('[data-testid="thought-toggle"]').disabled, true, "hidden reasoning has nothing to open");
});


test("a finished run is one line that opens every step in place, with nothing still running", async t => {
  const messages = [1, 2, 3, 4].map(n => assistant(`m${n}`, [thought(long(n)), tool(n === 4 ? "bash" : "read", n === 4 ? "running" : "ok")]));
  const f = await mountRun(t, { toolsLive: true, liveMessageId: "m4", messages });
  assert.equal(f.steps().length, 4, "a live run shows every step");
  await f.render({ toolsLive: false, messages });
  assert.equal(f.q("run-summary").dataset.live === undefined, true);
  assert.equal(f.steps().length, 0);
  const toggle = f.q("run-summary-toggle");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.match(f.q("run-summary-label").textContent, /^Read 3 files, ran 1 command · interrupted$/);
  await f.click(toggle);
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const steps = f.steps();
  assert.equal(steps.length, 4);
  assert.equal(steps.filter(step => step.dataset.current !== undefined).length, 0);
  assert.equal(f.all('[data-testid="thought"]', f.q("run-summary")).length, 4);
  assert.deepEqual(f.all("[data-tool]", f.q("run-summary")).map(el => el.dataset.live), ["false", "false", "false", "false"], "the turn is over: nothing is still running");
  await f.click(toggle);
  assert.equal(f.steps().length, 0, "a second tap folds the run");
});

async function mountChat(t) {
  const dom = createDomFixture(chatCode), w = dom.window, { act, store } = w.fixture;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.getAnimations = () => [];
  let mounted;
  await act(async () => { mounted = w.fixture.mount(); });
  t.after(async () => { try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const count = needle => w.document.body.textContent.split(needle).length - 1;
  return { w, store, count, change: fn => act(async () => fn(store.getState())) };
}

const user = { id: "u1", role: "user", text: "Fix the build", parts: [{ kind: "text", text: "Fix the build" }] };
const LIVE = "LIVE-REASONING-MARKER weighing the grouping";

// Summary mode (the default) draws a run as the work rail (parts/WorkRail).
test("live reasoning streams once, inside the run that follows it", async t => {
  const f = await mountChat(t);
  await f.change(s => { s.setAgentWorking(true); s.setHistory([user, assistant("m1", [thought("Earlier thought"), tool()])]); });
  await f.change(s => s.setStreamingMessage(assistant("live:r2", [thought("LIVE-REASONING-MARKER")])));
  await f.change(s => s.setStreamingMessage(assistant("live:r2", [thought(LIVE)])));
  assert.equal(f.count(LIVE), 1);
  const rails = f.w.document.querySelectorAll('[data-testid="work-rail"]');
  assert.equal(rails.length, 1, "the live step joins the run instead of opening a second one");
  assert.equal(rails[0].dataset.live, "true");
  assert.equal([...rails[0].querySelectorAll('[data-testid="rail-thought"]')].at(-1).textContent, LIVE);
  assert.equal(rails[0].querySelector('[data-testid="rail-live"]'), null, "the footer, not the rail, says the agent is working");
  const thoughts = [...f.w.document.querySelectorAll('[data-testid="rail-thought"]')];
  assert.equal(thoughts.every(node => rails[0].contains(node)), true, "no separate reasoning bubble");
  await f.change(s => s.commitStreamingMessage());
  assert.equal(f.count(LIVE), 1, "the commit hands over without a duplicate");
  assert.equal(f.w.document.querySelectorAll('[data-testid="work-rail"]').length, 1);
});

test("a first live step with no run before it opens the timeline by itself", async t => {
  const f = await mountChat(t);
  await f.change(s => s.setHistory([user]));
  await f.change(s => s.setStreamingMessage(assistant("live:r1", [thought(LIVE)])));
  assert.equal(f.count(LIVE), 1);
  const rail = f.w.document.querySelector('[data-testid="work-rail"]');
  assert.equal(rail.dataset.live, "true");
  assert.equal(rail.querySelector('[data-testid="rail-thought"]').textContent, LIVE);
  assert.equal(f.w.document.querySelectorAll('[data-testid="rail-thought"]').length, 1, "no separate reasoning bubble");
});

test("a streamed thought stays readable in the rail, once, through its calls, the commit and the answer", async t => {
  const f = await mountChat(t);
  const read = tool("read", "running");
  const thoughts = () => Array.from(f.w.document.querySelectorAll('[data-testid="rail-thought"]'), node => node.textContent);
  await f.change(s => { s.setHistory([user]); s.setAgentWorking(true); });
  await f.change(s => s.setStreamingMessage(assistant("live:first", [thought("First words")])));
  assert.deepEqual(thoughts(), ["First words"]);
  await f.change(s => s.setStreamingMessage(assistant("live:first", [thought(long(1))])));
  assert.deepEqual(thoughts(), [long(1)], "the thought grows in place");
  await f.change(s => s.setStreamingMessage(assistant("live:first", [thought(long(1)), read])));
  assert.deepEqual(thoughts(), [long(1)], "a call joins the rail beneath the thought; the thought stays");
  assert.equal(f.w.document.querySelectorAll('[data-testid="rail-chip"]').length, 1);
  await f.change(s => s.commitStreamingMessage());
  assert.deepEqual(thoughts(), [long(1)]);
  await f.change(s => s.setStreamingMessage(assistant("live:next", [thought("New reasoning")])));
  assert.equal(thoughts().at(-1), "New reasoning", "a newer thought joins the same turn's rail");
  assert.equal(f.count("New reasoning"), 1);
});

test("thinking followed by prose is a folded row, and redacted reasoning never shows its words", async t => {
  const f = await mountChat(t);
  await f.change(s => s.setHistory([user]));
  const parts = [thought("Earlier reasoning"), thought("Latest reasoning"), { kind: "text", text: "Answer starts" }];
  await f.change(s => s.setStreamingMessage({ ...assistant("mixed", parts), text: "Answer starts" }));
  const visibleThoughts = () => Array.from(f.w.document.querySelectorAll('[data-testid="thought-text"]'), node => node.textContent);
  assert.deepEqual(visibleThoughts(), []);
  await f.change(s => s.commitStreamingMessage());
  assert.deepEqual(visibleThoughts(), [], "the same policy applies after commit");
  await f.change(s => s.setHistory([user, assistant("redacted", [{ kind: "thinking", text: "MUST NOT DISPLAY", redacted: true }])]));
  assert.deepEqual(visibleThoughts(), []);
  assert.equal(f.count("MUST NOT DISPLAY"), 0);
});

test("a settling turn's footer joins the finished reply without remounting it", async t => {
  const f = await mountChat(t);
  const reply = { ...assistant("a1", [{ kind: "text", text: "All done." }]), text: "All done." };
  await f.change(s => { s.setAgentWorking(true); s.setHistory([user, reply]); });
  const row = () => [...f.w.document.querySelectorAll('[data-testid="chat-message"]')].find(el => el.textContent.includes("All done."));
  const before = row();
  assert.ok(before);
  assert.equal(f.w.document.querySelector('[data-testid="turn-footer"][data-state="done"]'), null, "no settled footer while the turn is live");
  await f.change(s => s.setAgentWorking(false));
  assert.ok(f.w.document.querySelector('[data-testid="turn-footer"][data-state="done"]'), "the settled footer appears");
  assert.equal(row(), before, "the same DOM node: no remount, no reparse, no one-frame height jump");
});

test("a thought that settles into its row shrinks by tween, not in one frame", async t => {
  const f = await mountRun(t, { toolsLive: true, messages: [assistant("m1", [thought(long(1))])] });
  const tweens = [];
  const sizes = [200, 40];
  Object.defineProperty(f.w.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return sizes[0]; } });
  f.w.ResizeObserver = class { constructor(cb) { this.cb = cb; } observe() { this.cb(); } disconnect() {} };
  f.w.HTMLElement.prototype.animate = function (frames) { tweens.push(Array.from(frames, frame => frame.height)); return { cancel() {} }; };
  await f.render({ toolsLive: true, messages: [] });
  await f.render({ toolsLive: true, messages: [assistant("m1", [thought(long(1))])] });
  assert.deepEqual(tweens, []);
  sizes[0] = 40;
  await f.render({ toolsLive: true, messages: [assistant("m1", [thought(long(1)), tool("read", "running")])] });
  // The thought folds into its one-line row (40px to the 2rem row), and the run's own settle tween follows.
  assert.deepEqual(tweens, [["40px", "32px"], ["200px", "40px"]]);
});
