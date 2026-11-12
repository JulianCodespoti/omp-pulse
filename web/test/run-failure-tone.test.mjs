import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { buildTimeline } from "../src/domain/timeline.ts";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const react = `import {createElement as h} from ${JSON.stringify(require.resolve("react"))};`;

// RunSummary with the real tool rows: the colour of a failed row is the subject.
const code = await bundleDomFixture(`
  import { createElement, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { RunSummary } from ${JSON.stringify(resolve(root, "web/src/app/parts/RunSummary.tsx"))};
  window.fixture = { act, mount: (props) => {
    const r = createRoot(document.getElementById('root'));
    r.render(createElement(RunSummary, props)); return { unmount: () => r.unmount() };
  } };
`, [{ name: "presentation-boundaries", resolveId(id) {
  if (id === "./ImagePart" || id === "./QuickReplies") return "\0" + id.slice(2);
  return null;
}, load(id) {
  if (id === "\0ImagePart") return react + `export const ImagePart = () => null;`;
  if (id === "\0QuickReplies") return react + `export const QuickReplies = () => null;`;
  return null;
} }]);

let nextCall = 0;
const bash = (command, state = "ok") => ({ kind: "tool", callId: `c${nextCall++}`, name: "bash", args: { command }, state, output: state === "error" ? "no match" : "done" });
const assistant = (id, parts, extra = {}) => ({ id, role: "assistant", text: "", parts, ...extra });
const user = id => ({ id, role: "user", text: "go", parts: [{ kind: "text", text: "go" }] });
const reply = (id, extra = {}) => ({ id, role: "assistant", text: "Done.", parts: [{ kind: "text", text: "Done." }], ...extra });

async function mountRun(t, props) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  let mounted;
  await act(async () => { mounted = w.fixture.mount(props); });
  t.after(async () => { try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const q = id => w.document.querySelector(`[data-testid="${id}"]`);
  return {
    q, act,
    toggleDanger: () => q("run-summary-toggle").querySelectorAll(".text-danger").length,
    label: () => q("run-summary-label").textContent,
    expand: () => act(async () => q("run-summary-toggle").click()),
    // Every red element in the opened steps, by the command its row names.
    dangerRows: () => Array.from(q("run-steps-inline").querySelectorAll(".text-danger"), el => el.closest("button")?.textContent ?? "").join("|"),
    failedLabels: () => q("run-steps-inline").querySelectorAll('[data-testid="tool-row"][data-state="error"]').length,
  };
}

const runOf = items => items.filter(item => item.kind === "run");

test("a run is continued only when a healthy assistant message follows it in the turn", () => {
  const steps = () => [assistant(`a${nextCall}`, [bash("grep -q x f", "error")])];
  const cases = [
    [[user("u1"), ...steps(), reply("r1")], true],
    [[user("u1"), ...steps(), user("u2")], false],
    [[user("u1"), ...steps()], false],
    [[user("u1"), ...steps(), reply("r1", { errorMessage: "provider error" })], false],
    [[user("u1"), ...steps(), reply("r1", { stopReason: "aborted" })], false],
  ];
  for (const [messages, continued] of cases) {
    const runs = runOf(buildTimeline(messages));
    assert.equal(runs.length, 1);
    assert.equal(runs[0].continued, continued, messages.map(m => m.id).join(","));
  }
  // A reply arriving after the run re-evaluates the reused run.
  const head = [user("u9"), assistant("a9", [bash("false", "error")])];
  const before = buildTimeline(head);
  assert.equal(runOf(before)[0].continued, false);
  assert.equal(runOf(buildTimeline([...head, reply("r9")], before))[0].continued, true);
});

test("failures the agent went on past are counted quietly", async t => {
  const f = await mountRun(t, {
    toolsLive: false,
    continued: true,
    messages: [
      assistant("m1", [bash("grep -q needle file", "error"), bash("ls src")]),
      assistant("m2", [bash("cargo test", "error")]),
    ],
  });
  assert.equal(f.toggleDanger(), 0, "no danger icon or colour on the folded line");
  assert.match(f.label(), / · 2 errors$/);
  assert.doesNotMatch(f.label(), /failed/);
  await f.expand();
  assert.equal(f.failedLabels(), 2, "each failed row still says so");
  assert.equal(f.dangerRows(), "", "and none of them is red");
});

test("a failure followed by later calls in the run is routine even when the turn ended", async t => {
  const f = await mountRun(t, {
    toolsLive: false,
    continued: false,
    messages: [assistant("m1", [bash("grep -q needle file", "error"), bash("ls src")])],
  });
  assert.equal(f.toggleDanger(), 0);
  assert.match(f.label(), / · 1 error$/);
  await f.expand();
  assert.equal(f.dangerRows(), "");
});

test("a run that ended the turn on a failure stays red, on that row only", async t => {
  const f = await mountRun(t, {
    toolsLive: false,
    continued: false,
    messages: [
      assistant("m1", [bash("grep -q needle file", "error"), bash("ls src")]),
      assistant("m2", [bash("cargo test", "error")]),
    ],
  });
  assert.equal(f.toggleDanger() > 0, true, "danger icon on the folded line");
  assert.match(f.label(), / · 2 failed$/);
  assert.ok(f.dangerRows(), "the run ended on a failure, so it opens by itself");
  assert.equal(f.failedLabels(), 2);
  const red = f.dangerRows();
  assert.match(red, /cargo test/);
  assert.doesNotMatch(red, /grep -q needle file|ls src/);
});

test("a live run has not ended, so its newest failure is not alarming yet", async t => {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  let mounted;
  await act(async () => { mounted = w.fixture.mount({ toolsLive: true, messages: [assistant("m1", [bash("cargo test", "error")])] }); });
  t.after(async () => { try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const details = w.document.querySelector('[data-testid="run-steps-inline"]');
  assert.equal(details.querySelectorAll('[data-testid="tool-row"][data-state="error"] [data-testid="tool-error-line"]').length, 1);
  assert.equal(details.querySelectorAll(".text-danger").length, 0);
});

test("a run that ended on a failure opens itself on the failed row and can be collapsed; a routine failure stays folded", async t => {
  const failed = await mountRun(t, { toolsLive: false, continued: false, messages: [assistant("m1", [bash("ls src"), bash("cargo test", "error")])] });
  const toggle = failed.q("run-summary-toggle");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  const row = failed.q("run-steps-inline").querySelector('[data-testid="tool-row"][data-state="error"]');
  assert.ok(row.querySelector('[data-testid="tool-error-line"]'));
  await failed.act(async () => toggle.click());
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(failed.q("run-steps-inline"), null);
  const routine = await mountRun(t, { toolsLive: false, continued: false, messages: [assistant("m1", [bash("grep -q x f", "error"), bash("ls src")])] });
  assert.equal(routine.q("run-summary-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(routine.q("run-steps-inline"), null);
});
