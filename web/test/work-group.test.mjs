import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve("react"))};
import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
import { RunGroup } from ${JSON.stringify(resolve(root, "web/src/app/chat/TurnWorkChip.tsx"))};
window.fixture = { act, mount(messages, live) {
  const r = createRoot(document.getElementById("root"));
  const render = (m, l) => r.render(h(RunGroup, { messages: m, live: l }, h("p", { "data-testid": "body" }, "steps")));
  render(messages, live);
  return { update: render, unmount: () => r.unmount() };
}, mountMany(groups) {
  const r = createRoot(document.getElementById("root"));
  const render = (list) => r.render(h("div", null, ...list.map(([m, l], i) => h(RunGroup, { key: i, messages: m, live: l }, h("p", { "data-testid": "body" }, "steps " + i)))));
  render(groups);
  return { update: render, unmount: () => r.unmount() };
} };
`);

const read = (state, start, end) => ({ kind: "tool", callId: "r", name: "read", args: { path: "src/retry.test.ts" }, state, output: "", startedAt: start, endedAt: end });
const message = (parts) => ({ id: "m", role: "assistant", text: "", parts, createdAt: new Date(1_000_000) });

async function fixture(t, messages, live) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  let mounted;
  await act(async () => { mounted = w.fixture.mount(messages, live); });
  t.after(async () => { try { await act(async () => mounted.unmount()); } finally { dom.close(); } });
  const q = (s) => w.document.querySelector(s);
  return { act, q, update: (m, l) => act(async () => mounted.update(m, l)) };
}

test("the newest group is fully open, shimmers the running step, and folds into its time once the answer starts", async (t) => {
  const f = await fixture(t, [message([{ kind: "thinking", text: "look" }, read("running", 1_001_000)])], true);
  assert.equal(f.q('[data-testid="turn-work"]').dataset.mode, "preview");
  assert.equal(f.q('[data-testid="turn-work-title"]').textContent, "Reading retry.test.ts…", "the rail's verb and target, as DeepSeek's live title");
  assert.ok(f.q('[data-testid="turn-work"] [data-testid="body"]'), "the steps are in the group itself, not a window");
  assert.equal(f.q('[data-testid="work-preview"]'), null, "no capped inner scroll pane: the group grows downward");
  await f.update([message([{ kind: "thinking", text: "look" }, read("ok", 1_001_000, 1_013_000)])], false);
  assert.equal(f.q('[data-testid="turn-work"]').dataset.mode, "collapsed");
  assert.equal(f.q('[data-testid="turn-work-title"]').textContent, "Worked for 12s");
  assert.equal(f.q('[data-testid="body"]'), null, "collapsed shows only the title");
  await f.act(async () => f.q('[data-testid="turn-work-title"]').click());
  assert.equal(f.q('[data-testid="turn-work"]').dataset.mode, "expanded");
  assert.equal(f.q('[data-testid="turn-work-title"]').getAttribute("aria-expanded"), "true");
  assert.ok(f.q('[data-testid="body"]'), "expanded is the whole timeline in place");
});

test("a live group with nothing in flight reads its elapsed time, never \"Working…\"", async (t) => {
  // The owner's report: after the last step finished the title still claimed work.
  const done = await fixture(t, [message([read("ok", 1_001_000, 1_013_000)])], true);
  assert.equal(done.q('[data-testid="turn-work-title"]').textContent, "Worked for 12s");
  assert.equal(done.q('[data-testid="turn-work-title"] [data-shimmer]'), null, "nothing is running, so nothing shimmers");
  assert.equal(done.q('[data-testid="turn-work"]').dataset.mode, "preview", "and it stays open until its stretch ends");
  const thinking = await fixture(t, [message([read("ok", 1_001_000, 1_002_000), { kind: "thinking", text: "look" }])], true);
  assert.equal(thinking.q('[data-testid="turn-work-title"]').textContent, "Thinking…", "words still streaming are work in flight");
});

test("a group that only thought says so, and a run with nothing done yet draws no title", async (t) => {
  const thought = await fixture(t, [message([{ kind: "thinking", text: "hmm" }])], false);
  assert.equal(thought.q('[data-testid="turn-work-title"]').textContent, "Thought");
  const empty = await fixture(t, [message([{ kind: "thinking", text: "  " }])], false);
  assert.equal(empty.q('[data-testid="turn-work"]'), null);
  assert.equal(empty.q('[data-testid="body"]'), null, "nothing settled to show draws nothing at all");
});

test("when a new group starts, only it previews: every earlier group compacts to its title", async (t) => {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  let mounted;
  const first = [message([read("ok", 1_001_000, 1_005_000)])];
  const second = [{ ...message([read("running", 1_010_000)]), id: "m2" }];
  // Both stretches claim to be live, as the chat's separate paths can while a new step starts streaming.
  await act(async () => { mounted = w.fixture.mountMany([[first, true]]); });
  t.after(async () => { try { await act(async () => mounted.unmount()); } finally { dom.close(); } });
  const modes = () => [...w.document.querySelectorAll('[data-testid="turn-work"]')].map((g) => g.dataset.mode);
  const titles = () => [...w.document.querySelectorAll('[data-testid="turn-work-title"]')].map((b) => b.textContent);
  assert.deepEqual(modes(), ["preview"]);
  await act(async () => mounted.update([[first, true], [second, true]]));
  assert.deepEqual(modes(), ["collapsed", "preview"], "the earlier group folded when the newer one appeared");
  assert.deepEqual(titles(), ["Worked for 4s", "Reading retry.test.ts…"], "and reads as settled, without a shimmer");
  await act(async () => mounted.update([[first, true]]));
  assert.deepEqual(modes(), ["preview"], "with the newer one gone it is the newest again");
});
