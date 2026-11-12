import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
  import { createElement as h, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { WorkRail, WorkRun } from ${JSON.stringify(resolve(root, "web/src/app/parts/WorkRail.tsx"))};
  import { TranscriptActionsContext } from ${JSON.stringify(resolve(root, "web/src/app/parts/TurnNotices.tsx"))};
  const actions = { switchModel() {}, editPrompt() {}, stopTurn: async () => {} };
  window.fixture = { act, mount(Component, props) {
    const r = createRoot(document.getElementById("root"));
    r.render(h(TranscriptActionsContext.Provider, { value: actions }, h(Component === "run" ? WorkRun : WorkRail, props)));
    return r;
  } };
`);

let next = 0;
const call = (name, args, extras = {}) => ({ kind: "tool", callId: `c${next++}`, name, args, state: "ok", output: "done", ...extras });
const thought = (text) => ({ kind: "thinking", text });
const turn = (parts) => [{ id: "m1", role: "assistant", text: "", parts }];

async function mount(t, props, appearance = {}, component = "rail") {
  const dom = createDomFixture(code), w = dom.window;
  w.Element.prototype.getAnimations = () => [];
  w.localStorage.setItem("omp-appearance", JSON.stringify(appearance));
  let r;
  await w.fixture.act(async () => { r = w.fixture.mount(component, props); });
  t.after(async () => { try { await w.fixture.act(async () => r.unmount()); } finally { dom.close(); } });
  const all = (id) => [...w.document.querySelectorAll(`[data-testid="${id}"]`)];
  const click = (el) => w.fixture.act(async () => el.click());
  return { w, all, click, q: (id) => w.document.querySelector(`[data-testid="${id}"]`) };
}

test("consecutive calls of one kind are one verb with a chip each: files by name, other calls by intent or command", async (t) => {
  const f = await mount(t, { messages: turn([
    call("read", { path: "/repo/src/a.ts" }), call("read", { path: "/repo/src/b.ts" }),
    call("bash", { command: "npm test" }, { intent: "Running the web tests" }), call("bash", { command: "echo hi" }),
    call("grep", { pattern: "bg-[a-z]+" }, { intent: "Finding backgrounds" }),
  ]), toolsLive: false });
  const acts = f.all("rail-act").map((row) => [row.dataset.category, [...row.querySelectorAll('[data-testid="rail-chip"]')].map((chip) => chip.textContent)]);
  assert.deepEqual(acts, [
    ["read", ["a.ts", "b.ts"]],
    ["bash", ["Running the web tests", "echo hi"]],
    ["search", ["Finding backgrounds"]],
  ]);
  assert.match(f.all("rail-act")[0].textContent, /^Read · 2/);
  assert.doesNotMatch(f.w.document.body.textContent, /bg-\[a-z\]/, "a raw pattern is not a chip");
});

test("a started agents chip names the agents, not the first line of their prompt", async (t) => {
  const f = await mount(t, { messages: turn([call("task", { tasks: [{ name: "Drawer", task: "# Target\nx" }, { name: "Streaming", task: "# Target\ny" }] })]), toolsLive: false });
  assert.equal(f.q("rail-chip").textContent, "Drawer, Streaming");
});

test("a failed call is a red chip whose tap opens its error in the detail sheet", async (t) => {
  const f = await mount(t, { messages: turn([call("bash", { command: "cargo test" }, { state: "error", output: "error[E0425]: cannot find value" })]), toolsLive: false });
  const chip = f.q("rail-chip");
  assert.equal(chip.dataset.state, "error");
  assert.ok(chip.className.includes("text-danger"));
  await f.click(chip);
  assert.match(f.q("tool-sheet").textContent, /cannot find value/);
});

test("live: the rail has no shimmer of its own (the turn footer is the one), and a running call's Stop is a chip tap away", async (t) => {
  const running = call("bash", { command: "npm test" }, { intent: "Running the web tests", state: "running", output: undefined, startedAt: Date.now() - 5_000 });
  const f = await mount(t, { messages: turn([thought("Checking the suite."), running]), toolsLive: true, liveMessageId: "m1", sessionPath: "/synthetic/s" });
  assert.equal(f.q("rail-live"), null);
  assert.equal(f.w.document.querySelector('[data-testid="work-rail"] [data-shimmer], [data-testid="work-rail"] [class*="shimmer"]'), null);
  assert.match(f.all("rail-act")[0].textContent, /^Running/);
  await f.click(f.q("rail-chip"));
  assert.ok(f.w.document.querySelector('[data-testid="tool-sheet"] [data-testid="stop-command"]'), "a live command keeps its Stop");
});

test("a group's icon follows its category, not its first call", async (t) => {
  const f = await mount(t, { messages: turn([call("grep", { pattern: "x" }), call("bash", { command: "ls" }), call("write", { path: "xd://ast_grep" })]), toolsLive: false });
  const icons = f.all("rail-act").map((row) => row.querySelector("svg").getAttribute("class").match(/lucide-([\w-]+)/)?.[1]);
  assert.deepEqual(icons, ["search", "terminal", "wrench"]);
});

test("Thinking setting: hidden leaves settled thoughts out, latest opens only the newest", async (t) => {
  const messages = turn([thought("First."), call("read", { path: "/a.ts" }), thought("Second.")]);
  const hidden = await mount(t, { messages, toolsLive: false }, { thinking: "hidden" });
  assert.equal(hidden.all("rail-thought").length, 0);
  assert.equal(hidden.all("rail-chip").length, 1, "the calls still show");
  const latest = await mount(t, { messages, toolsLive: false }, { thinking: "latest" });
  assert.deepEqual(latest.all("rail-thought").map((row) => row.querySelector("button").getAttribute("aria-expanded")), ["false", "true"]);
});

test("past three chips the rest wait behind 'N more'", async (t) => {
  const f = await mount(t, { messages: turn([1, 2, 3, 4, 5].map((n) => call("read", { path: `/f${n}.ts` }))), toolsLive: false });
  assert.equal(f.all("rail-chip").length, 3);
  assert.equal(f.q("rail-more").textContent, "2 more");
  await f.click(f.q("rail-more"));
  assert.equal(f.all("rail-chip").length, 5);
});

test("generic calls group by the server or tool device they belong to, each named for it", async (t) => {
  const f = await mount(t, { messages: turn([
    call("mcp__workiq_search", {}), call("mcp__workiq_call", {}), call("write", { path: "xd://mcp__workiq_describe", content: "{}" }),
    call("write", { path: "xd://lsp", content: "{}" }),
    call("browser", { action: "goto" }),
  ]), toolsLive: false });
  assert.deepEqual(f.all("rail-act").map((row) => row.querySelector("p").textContent), ["Used WorkIQ · 3", "Used LSP", "Used browser"]);
});

test("Summary mode draws the rail; Grouped keeps the rows", async (t) => {
  const messages = turn([thought("Look."), call("read", { path: "/a.ts" })]);
  const summary = await mount(t, { messages, toolsLive: false }, {}, "run");
  assert.ok(summary.q("work-rail"));
  assert.equal(summary.q("run-summary"), null);
  const grouped = await mount(t, { messages, toolsLive: false }, { toolCalls: "grouped" }, "run");
  assert.ok(grouped.q("run-summary"));
  assert.equal(grouped.q("work-rail"), null);
});

// A thought before each call: the shape of a real long turn, where the agent thinks between nearly every call.
const alternating = (n) => Array.from({ length: n }, (_, i) => [thought(`Thinking ${i}.`), call("bash", { command: `echo ${i}` })]).flat();

test("past 12 calls a settled rail is collapsed sections; one opens to a single merged group with its thoughts behind a toggle", async (t) => {
  const f = await mount(t, { messages: turn(alternating(30)), toolsLive: false });
  const sections = f.all("rail-section");
  assert.equal(sections.length, 3);
  assert.equal(f.q("rail-earlier"), null, "settled rails have no Earlier line");
  assert.equal(sections.reduce((sum, s) => sum + Number(s.dataset.calls), 0), 30);
  assert.deepEqual(sections.map((s) => s.dataset.open), ["false", "false", "false"]);
  assert.deepEqual(f.all("rail-section-summary").map((s) => s.textContent), ["Ran 12 commands", "Ran 12 commands", "Ran 6 commands"]);
  assert.equal(f.q("rail-act"), null);
  await f.click(f.all("rail-section-summary")[0]);
  assert.equal(f.all("rail-act").length, 1, "one merged group");
  assert.equal(f.q("rail-act").querySelector("p").textContent, "Ran · 12");
  assert.equal(f.q("rail-more").textContent, "9 more");
  await f.click(f.q("rail-more"));
  assert.equal(f.all("rail-chip").length, 12);
  assert.equal(f.q("rail-less").textContent, "Show less");
  assert.equal(f.q("rail-thoughts").textContent, "11 thoughts");
  assert.equal(f.all("rail-thought").length, 1, "only the section's opening thought shows until the toggle");
  await f.click(f.q("rail-thoughts"));
  assert.equal(f.all("rail-thought").length, 12);
  await f.click(f.all("rail-section-summary")[0]);
  assert.equal(f.q("rail-act"), null, "tapping again collapses");
});

test("a settled run drawn inline (an older run of a running turn) folds its sections behind one line", async (t) => {
  const f = await mount(t, { messages: turn(alternating(30)), toolsLive: false, nest: true });
  assert.match(f.q("rail-earlier").textContent, /^Earlier · 30 steps/);
  assert.equal(f.q("rail-section"), null, "its rows wait behind the line, not flat in the chat");
  await f.click(f.q("rail-earlier"));
  assert.equal(f.all("rail-section").length, 3);
});

test("live: older sections hide behind one Earlier line, and the newest section shows every step", async (t) => {
  const tail = [thought("Now."), call("read", { path: "/a.ts" }), thought("Then."), call("grep", { pattern: "x" }), thought("Next."), call("bash", { command: "boom" }, { state: "error" })];
  const f = await mount(t, { messages: turn([...alternating(30), ...tail]), toolsLive: true, liveMessageId: "m1" });
  assert.match(f.q("rail-earlier").textContent, /^Earlier · 24 steps/);
  assert.equal(f.q("rail-earlier").dataset.open, "false");
  assert.equal(f.all("rail-section").length, 1, "only the newest section is drawn");
  // The owner's report: steps vanished mid-turn. Nothing in the newest section is windowed now, so the
  // earliest step of that section ("Now.", which the old three-step window hid) is still on screen.
  assert.equal(f.q("rail-hidden"), null, "no hidden-steps line: every step of the live section is shown");
  assert.ok(f.all("rail-thought").some((t) => t.textContent.startsWith("Now.")), "the section's first step never disappears");
  await f.click(f.q("rail-earlier"));
  assert.equal(f.q("rail-earlier").dataset.open, "true");
  // Two older section rows, plus the newest section's own header.
  assert.equal(f.all("rail-section-summary").length, 3);
  await f.click(f.all("rail-section-summary")[0]);
  assert.equal(f.all("rail-section-summary")[0].dataset.open, "true");
  await f.click(f.q("rail-earlier"));
  // The newest steps fold too: with Earlier shut and the newest closed, the whole turn is two lines.
  const newest = f.all("rail-section-summary").at(-1);
  assert.equal(newest.dataset.open, "true");
  await f.click(newest);
  assert.equal(f.all("rail-act").length + f.all("rail-thought").length, 0);
  assert.equal(f.all("rail-section-summary").at(-1).dataset.open, "false");
});

test("a rail of 12 calls is not sectioned", async (t) => {
  const f = await mount(t, { messages: turn(alternating(12)), toolsLive: true, liveMessageId: "m1" });
  assert.equal(f.q("rail-section"), null);
  assert.equal(f.q("rail-earlier"), null);
  assert.equal(f.all("rail-act").length, 12);
});

test("sectioned: a short stretch of a long turn is one collapsed row, with natural count wording", async (t) => {
  const messages = turn([
    call("read", { path: "/a.ts" }), call("bash", { command: "ls" }), call("grep", { pattern: "x" }), call("grep", { pattern: "y" }),
    call("mcp__workiq_search", {}), call("mcp__workiq_call", {}),
  ]);
  const f = await mount(t, { messages, toolsLive: false, sectioned: true });
  assert.equal(f.all("rail-section").length, 1);
  assert.equal(f.q("rail-act"), null);
  assert.equal(f.q("rail-section-summary").textContent, "2 searches · Used 2 tools · Read 1 file · 1 more");
  const plain = await mount(t, { messages, toolsLive: false });
  assert.equal(plain.q("rail-section"), null, "without the flag a short rail is unchanged");
});

test("a read of an agent:// or xd:// path is grouped under what the path names, not 'read'", async (t) => {
  const f = await mount(t, { messages: turn([call("read", { path: "agent://Scout" }), call("read", { path: "xd://lsp" })]), toolsLive: false });
  assert.deepEqual(f.all("rail-act").map((row) => row.querySelector("p").textContent), ["Used agents", "Used LSP"]);
});
