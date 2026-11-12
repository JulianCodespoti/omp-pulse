import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { firstErrorLine } from "../src/app/parts/tool-summary.ts";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
  import { createElement, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { RunSummary } from ${JSON.stringify(resolve(root, "web/src/app/parts/RunSummary.tsx"))};
  window.fixture = { act, mount: (props) => {
    const r = createRoot(document.getElementById('root'));
    r.render(createElement(RunSummary, { ...props, onOtherQuestion() {} })); return r;
  } };
`, [{ name: "presentation-boundaries", resolveId(id, importer) {
  if (importer?.endsWith("/RunSummary.tsx") && ["./ToolPart", "./ImagePart", "./QuickReplies"].includes(id)) return "\0" + id.slice(2);
  return null;
}, load(id) {
  const react = `import {createElement as h} from ${JSON.stringify(require.resolve("react"))};`;
  if (id === "\0ToolPart") return react + `export const ToolPart = ({part}) => h('div',{'data-tool':part.callId},part.name);`;
  if (id === "\0ImagePart") return react + `export const ImagePart = () => null;`;
  if (id === "\0QuickReplies") return react + `export const QuickReplies = () => null;`;
  return null;
} }]);

const NOW = 1_800_000_000_000;
let nextCall = 0;
const tool = (name, args, state = "ok", extras = {}) => ({ kind: "tool", callId: `c${nextCall++}`, name, args, state, ...extras });
const message = (parts, id = "m1") => ({ id, role: "assistant", text: "", parts });

async function mount(t, props) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  let root;
  await act(async () => { root = w.fixture.mount(props); });
  t.after(async () => { try { await act(async () => root.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const q = id => w.document.querySelector(`[data-testid="${id}"]`);
  const click = el => act(async () => { el.click(); await Promise.resolve(); });
  return {
    w, q, click,
    label: () => q("run-summary-label")?.textContent,
    remount: async next => {
      await act(async () => root.unmount());
      await act(async () => { root = w.fixture.mount(next); });
    },
  };
}

const read = (path, state = "ok", extras) => tool("read", { path }, state, extras);
const bash = (command, state = "ok", extras) => tool("bash", { command }, state, extras);

test("MCP tools and xd:// device writes read as actions, never as file edits", async t => {
  const f = await mount(t, {
    toolsLive: false,
    messages: [message([tool("write", { path: "xd://mcp__phone_act", content: "{}" }), tool("mcp__phone_observe", {}), tool("edit", { path: "src/a.rs" })])],
  });
  assert.equal(f.label(), "Edited 1 file, used 2 tools");
});

test("a finished run counts what it touched, by kind", async t => {
  const f = await mount(t, {
    toolsLive: false,
    messages: [message([
      read("/repo/src/http.rs"), read("/repo/src/ws.rs"), read("/repo/src/types.rs"), read("/repo/src/http.rs:1-40"),
      bash("cargo test"),
      tool("grep", { pattern: "fooBar" }), tool("edit", { path: "src/a.rs" }), tool("edit", { path: "src/b.rs" }), tool("edit", { path: "src/c.rs" }),
    ])],
  });
  assert.equal(f.label(), 'Read 4 files, ran 1 command, edited 3 files, searched 1 time');
  const toggle = f.q("run-summary-toggle");
  assert.equal(toggle.getAttribute("aria-label"), `Show steps: ${f.label()}`);
  // The first kind named leads the row; no success check, no alert on a clean run.
  assert.ok(toggle.querySelector(".lucide-file-text"));
  assert.equal(toggle.querySelector(".lucide-triangle-alert") === null, true);
  assert.equal(toggle.querySelector(".lucide-check") === null, true);
});

test("a plan edit and unnamed tools are counted, never spelled out", async t => {
  const long = "cargo test --release --all-features --workspace -- --nocapture --test-threads=1";
  const f = await mount(t, { toolsLive: false, messages: [message([
    tool("read", {}), tool("read", {}), bash(long), tool("todo", {}), tool("todo", {}), tool("lsp", {}), tool("lsp", {}),
  ])] });
  // A plan edit without a recorded plan is one "updated tasks", never a count of edits.
  assert.equal(f.label(), "Read 2 files, ran 1 command, updated tasks, 2 steps");
});

test("a finished run is one line that opens in place, and a stale running call reads interrupted", async t => {
  const finished = [message([read("src/a.rs", "ok", { startedAt: NOW - 9_000, endedAt: NOW - 8_000 }), bash("ls", "ok", { startedAt: NOW - 5_000, endedAt: NOW - 4_000 })])];
  const f = await mount(t, { toolsLive: false, messages: finished });
  assert.equal(f.label(), "Read 1 file, ran 1 command");
  assert.equal(f.q("run-steps-inline"), null, "folded until tapped");
  assert.equal(f.q("run-summary-toggle").getAttribute("aria-expanded"), "false");
  await f.click(f.q("run-summary-toggle"));
  assert.equal(f.q("run-summary-toggle").getAttribute("aria-expanded"), "true");
  assert.deepEqual([...f.q("run-steps-inline").querySelectorAll("[data-tool]")].map(el => el.textContent), ["read", "bash"]);
  assert.equal(f.w.document.querySelector('[data-testid="tool-sheet"]'), null, "the run opens in the transcript, not a sheet");
  await f.click(f.q("run-summary-toggle"));
  assert.equal(f.q("run-steps-inline"), null, "a second tap folds it again");
  // An interrupted call the daemon never closed: still `running` in the data, but the turn is over.
  await f.remount({ toolsLive: false, messages: [message([bash("sleep 999", "running", { startedAt: NOW - 600_000 })])] });
  assert.equal(f.label(), "Ran sleep 999 · interrupted");
  assert.equal(f.q("run-summary-toggle").getAttribute("aria-label"), "Show steps: Ran sleep 999 · interrupted");
  // While the turn is live the same call is running, not interrupted.
  await f.remount({ toolsLive: true, messages: [message([bash("sleep 999", "running", { startedAt: NOW - 600_000 })])] });
  assert.equal(f.label(), "Ran sleep 999", "a live run keeps its header row, not marked interrupted");
  assert.ok(f.q("run-steps-inline").querySelector("[data-tool]"));
});

test("the run label is count-based, and a lone named call is spelled out", async t => {
  const f = await mount(t, { toolsLive: false, messages: [message([
    read("a.rs"), read("b.rs"), read("c.rs"), bash("a"), bash("b"), bash("c"), bash("d"), bash("e"),
  ])] });
  assert.equal(f.label(), "Read 3 files, ran 5 commands");
  await f.remount({ toolsLive: false, messages: [message([bash("git status")])] });
  assert.equal(f.label(), "Ran git status");
});

test("firstErrorLine picks the error over a banner, strips colour, clips, and falls back", () => {
  assert.equal(firstErrorLine("Compiling foo v0.1\nerror[E0425]: cannot find value `x`\nnote: more"), "error[E0425]: cannot find value `x`");
  assert.equal(firstErrorLine("\u001b[31merror:\u001b[0m boom"), "error: boom");
  const clipped = firstErrorLine(`error: ${"x".repeat(50)}`, 20);
  assert.equal(clipped.length, 20);
  assert.ok(clipped.endsWith("…"));
  assert.equal(firstErrorLine("\n  \nhello world\nsecond"), "hello world");
  assert.equal(firstErrorLine("  \n\n"), "");
});
