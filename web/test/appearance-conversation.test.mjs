import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const STUBS = {
  "./ToolPart": `export const ToolPart = ({part}) => h('div',{'data-tool':part.callId},part.name);`,
  "./ImagePart": `export const ImagePart = () => null;`,
  "./QuickReplies": `export const QuickReplies = () => null;`,
  "@/components/ai-elements/message": `export const MessageResponse = ({children}) => h('div',{'data-testid':'md'},children);`,
};
const code = await bundleDomFixture(`
  import { createElement, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { RunSummary } from ${JSON.stringify(resolve(root, "web/src/app/parts/RunSummary.tsx"))};
  import { MessageParts } from ${JSON.stringify(resolve(root, "web/src/app/parts/MessageParts.tsx"))};
  import { setAppearance } from ${JSON.stringify(resolve(root, "web/src/platform/appearance.ts"))};
  window.fixture = { act, setAppearance, mount: (Component, props) => {
    const r = createRoot(document.getElementById('root'));
    r.render(createElement(Component, props)); return r;
  }, RunSummary, MessageParts };
`, [{ name: "stubs", resolveId: (id) => id in STUBS ? "\0" + id : null,
  load(id) {
    const stub = STUBS[id.slice(1)];
    return id[0] === "\0" && stub ? `import {createElement as h} from ${JSON.stringify(require.resolve("react"))};` + stub : null;
  } }]);

let nextCall = 0;
const tool = () => ({ kind: "tool", callId: `c${nextCall++}`, name: "read", args: { path: "a" }, state: "ok" });
const thinking = (text = "weighing options") => ({ kind: "thinking", text });
const assistant = (parts, text = "") => ({ id: "m1", role: "assistant", text, parts });
// One step per thought, each with one call.
const steps = (n) => [assistant(Array.from({ length: n }, () => [thinking(), tool()]).flat())];

async function mount(t, kind, props, prefs = {}, setup) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  setup?.(w);
  w.fixture.setAppearance(prefs);
  let r;
  await act(async () => { r = w.fixture.mount(w.fixture[kind], props); });
  t.after(async () => { try { await act(async () => r.unmount()); } finally { dom.close(); } });
  const count = (id) => w.document.querySelectorAll(`[data-testid="${id}"]`).length;
  // A message's work is a group, collapsed unless it is the one working: open it to read its rows.
  const open = async () => { for (const b of w.document.querySelectorAll('[data-testid="turn-work-title"][aria-expanded="false"]')) await act(async () => b.click()); };
  return { w, count, open, q: (id) => w.document.querySelector(`[data-testid="${id}"]`) };
}

// Thought rows are the Grouped/Expanded modes; the rail's settings are in work-rail.test.mjs.
test("thinking 'latest' opens only the newest thought, not every thought in the turn", async (t) => {
  const two = assistant([thinking("FIRST_THOUGHT"), tool(), thinking("SECOND_THOUGHT")]);
  const msg = await mount(t, "MessageParts", { message: two, latestThought: true }, { thinking: "latest", toolCalls: "grouped" });
  assert.equal(msg.count("thought"), 0, "a settled message's work starts collapsed");
  await msg.open();
  const shown = [...msg.w.document.querySelectorAll('[data-testid="thought-text"]')].map((e) => e.textContent);
  assert.deepEqual(shown, ["SECOND_THOUGHT"]);
  const run = await mount(t, "RunSummary", { messages: steps(3), toolsLive: false, latestThought: true }, { thinking: "latest", toolCalls: "expanded" });
  assert.equal(run.count("thought"), 3);
  assert.equal(run.count("thought-text"), 1);
  const toggles = run.w.document.querySelectorAll('[data-testid="thought-toggle"]');
  assert.equal(toggles[2].getAttribute("aria-expanded"), "true");
  assert.equal(toggles[0].getAttribute("aria-expanded"), "false");
});

test("thinking 'latest' opens only the newest turn's settled thought", async (t) => {
  const message = assistant([thinking()]);
  const opened = async (props, prefs) => { const m = await mount(t, "MessageParts", props, prefs); await m.open(); return m.count("thought-text"); };
  assert.equal(await opened({ message, latestThought: true }, { thinking: "latest", toolCalls: "grouped" }), 1);
  assert.equal(await opened({ message, latestThought: false }, { thinking: "latest", toolCalls: "grouped" }), 0);
  assert.equal(await opened({ message, latestThought: true }, { thinking: "collapsed", toolCalls: "grouped" }), 0);
  const run = await mount(t, "RunSummary", { messages: steps(1), toolsLive: false, latestThought: true }, { thinking: "latest", toolCalls: "expanded" });
  assert.equal(run.count("thought-text"), 1);
  const toggle = run.q("thought-toggle");
  await run.w.fixture.act(async () => toggle.click());
  assert.equal(run.count("thought-text"), 0, "tapping still toggles");
});

test("thinking 'hidden' renders no settled thought and only the shimmer while live", async (t) => {
  const message = assistant([thinking()]);
  const settled = await mount(t, "MessageParts", { message }, { thinking: "hidden", toolCalls: "grouped" });
  assert.equal(settled.count("thought"), 0);
  assert.equal(settled.w.document.querySelectorAll(".my-1").length, 0, "no empty wrapper gap");
  const live = await mount(t, "MessageParts", { message, isStreaming: true }, { thinking: "hidden", toolCalls: "grouped" });
  assert.equal(live.count("thought-text"), 0);
  assert.match(live.w.document.body.textContent, /Thinking…/);
  const run = await mount(t, "RunSummary", { messages: steps(1), toolsLive: false }, { thinking: "hidden", toolCalls: "expanded" });
  assert.equal(run.count("thought"), 0);
  assert.equal(run.w.document.querySelectorAll("[data-tool]").length, 1, "the calls still show");
});

test("toolCalls 'expanded' opens a settled run and shows every live step", async (t) => {
  const grouped = await mount(t, "RunSummary", { messages: steps(1), toolsLive: false });
  assert.equal(grouped.q("run-steps-inline"), null);
  const settled = await mount(t, "RunSummary", { messages: steps(1), toolsLive: false }, { toolCalls: "expanded" });
  assert.equal(settled.q("run-summary-toggle").getAttribute("aria-expanded"), "true");
  assert.ok(settled.q("run-steps-inline"));
  await settled.w.fixture.act(async () => settled.q("run-summary-toggle").click());
  assert.equal(settled.q("run-steps-inline"), null, "the header still toggles");
  // Both modes show every step of a live run; the mode only picks the body.
  assert.equal((await mount(t, "RunSummary", { messages: steps(4), toolsLive: true })).count("run-step"), 4);
  assert.equal((await mount(t, "RunSummary", { messages: steps(4), toolsLive: true }, { toolCalls: "expanded" })).count("run-step"), 4);
});

test("longReplies 'full' never offers a preview on a long assistant reply", async (t) => {
  const message = assistant([], "word ".repeat(600));
  assert.equal((await mount(t, "MessageParts", { message })).count("reply-expand"), 1);
  assert.equal((await mount(t, "MessageParts", { message }, { longReplies: "full" })).count("reply-expand"), 0);
});

const user = (text) => ({ id: "u1", role: "user", text, parts: [{ kind: "text", text }] });
// jsdom has no layout: report the folded body as taller than its eight-line box.
const tallWhenFolded = (w) => Object.defineProperty(w.HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get() { return this.className.includes("max-h-[8lh]") ? 400 : 0; },
});

test("a user message that fits in eight lines has no fold", async (t) => {
  const view = await mount(t, "MessageParts", { message: user("short") });
  assert.equal(view.count("reply-expand"), 0);
  assert.equal(view.q("reply-text").firstElementChild.className.includes("mask-image"), false);
});

test("a long user message folds to eight lines behind a chevron, whatever Long replies says", async (t) => {
  const view = await mount(t, "MessageParts", { message: user("line\n".repeat(30)) }, { longReplies: "full" }, tallWhenFolded);
  const body = () => view.q("reply-text").firstElementChild, toggle = () => view.q("reply-expand");
  assert.equal(toggle().getAttribute("aria-expanded"), "false");
  assert.equal(toggle().getAttribute("aria-label"), "Show full message");
  assert.equal(body().className.includes("max-h-[8lh]") && body().className.includes("mask-image"), true);
  assert.equal(toggle().className.includes("after:-inset-y-2.5") && toggle().className.includes("w-11"), true, "44px target");
  await view.w.fixture.act(async () => toggle().click());
  assert.equal(toggle().getAttribute("aria-expanded"), "true");
  assert.equal(toggle().getAttribute("aria-label"), "Show less");
  assert.equal(body().className.includes("max-h-") || body().className.includes("mask-image"), false);
  await view.w.fixture.act(async () => toggle().click());
  assert.equal(toggle().getAttribute("aria-expanded"), "false");
  assert.equal(body().className.includes("max-h-[8lh]"), true);
});

test("message style 'bubbles' puts agent text in a bubble and threads its work beneath", async (t) => {
  const message = assistant([{ kind: "text", text: "Looking at the retry test first." }, tool()], "Looking at the retry test first.");
  const plain = await mount(t, "MessageParts", { message }, { messageStyle: "plain", toolCalls: "grouped" });
  assert.equal(plain.w.document.querySelectorAll(".bg-surface-2").length, 0);
  const chat = await mount(t, "MessageParts", { message }, { messageStyle: "bubbles", toolCalls: "grouped" });
  await chat.open();
  const bubble = chat.q("md").closest(".bg-surface-2");
  assert.ok(bubble, "the text sits in a bubble");
  const call = chat.w.document.querySelector("[data-tool]");
  assert.ok(call.closest(".border-l"), "the call is threaded, not bubbled");
  assert.equal(call.closest(".bg-surface-2"), null);
});

test("bubbles: tapping an agent bubble reveals its time and model; a second tap hides it", async (t) => {
  const message = { ...assistant([{ kind: "text", text: "Done." }], "Done."), model: "claude-opus-4-5", createdAt: new Date(Date.now() - 60_000) };
  const chat = await mount(t, "MessageParts", { message }, { messageStyle: "bubbles" });
  assert.ok(chat.q("agent-avatar"), "the agent's avatar sits beside its bubble");
  const info = () => chat.q("bubble-info");
  assert.equal(info().dataset.open, undefined, "hidden until tapped (still read to screen readers)");
  assert.match(info().textContent, /Opus/);
  const tap = () => chat.w.fixture.act(async () => { chat.q("agent-bubble").click(); await new Promise((r) => chat.w.setTimeout(r, 5)); });
  await tap();
  assert.equal(info().dataset.open, "true");
  await tap();
  assert.equal(info().dataset.open, undefined);
});
