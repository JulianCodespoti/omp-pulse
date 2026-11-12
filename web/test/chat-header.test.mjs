import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// Render the actual header on the server: semantics only, not browser geometry.
// The controller is the real class, driven through its history merge, so the
// rename test covers the path a live `title_change` entry takes.
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(resolve(root, "web/package.json"));
const directory = await mkdtemp(resolve(tmpdir(), "pulse-header-unit-"));
after(() => rm(directory, { recursive: true, force: true }));
const source = `
  import { createElement } from ${JSON.stringify(require.resolve("react"))};
  import { renderToStaticMarkup } from ${JSON.stringify(require.resolve("react-dom/server"))};
  import { SessionHeader } from ${JSON.stringify(resolve(root, "web/src/app/chat/SessionHeader.tsx"))};
  export { createOmpStore } from ${JSON.stringify(resolve(root, "web/src/runtime/omp-store.ts"))};
  export { OmpSessionController } from ${JSON.stringify(resolve(root, "web/src/runtime/omp-session-controller.ts"))};
  export const header = (props) => renderToStaticMarkup(createElement(SessionHeader, props));
`;
const bundle = await rolldown({
  input: "header-test-entry", platform: "node",
  resolve: { alias: { "@": resolve(root, "web/src") } },
  transform: { jsx: { runtime: "automatic" }, define: { "import.meta.env": JSON.stringify({ VITE_PROTOCOL_VERSION: 1, VITE_RELEASE_ID: "unit" }) } },
  plugins: [{ name: "header-test-entry", resolveId: (id) => id === "header-test-entry" ? "\0header-test-entry" : null,
    load: (id) => id === "\0header-test-entry" ? source : null }],
});
await bundle.write({ file: resolve(directory, "header.mjs"), format: "esm" });
await bundle.close();
const { header, createOmpStore, OmpSessionController } = await import(pathToFileURL(resolve(directory, "header.mjs")).href);

const PATH = "/tmp/synthetic.jsonl";
function props({ connection = "open", working = false, row = {} } = {}) {
  const store = createOmpStore();
  store.setState({ sessionPath: PATH, agentWorking: working,
    sessions: [{ path: PATH, cwd: "/home/u/Coding/pulse-app", title: "Synthetic header fixture", ...row }] });
  const noop = () => {};
  return { store, connection, sessionPath: PATH, project: "pulse-app",
    onRename: noop, onOpenModelPicker: noop, onOpenSessionSettings: noop, onReload: noop, onNewChat: noop };
}
// The visible heading: the chat's title, with its folder on a second line.
const h1 = (html) => html.match(/data-testid="chat-heading"[^>]*>\s*<span[^>]*>(.*?)<\/span>/s)?.[1] ?? null;
const tracking = (over = {}) => ({ working: false, tasksLeft: 0, tasksDone: 0, tasksTotal: 0, agents: { working: 0, needsYou: 0 }, changes: null, ...over });

test("floating header: round menu pill, then the title with its folder, then workspace, new-chat and more in one pill", () => {
  const html = header({ ...props(), tracking: tracking(), onOpenWorkspace() {} });
  const order = ['data-testid="session-back"', 'data-testid="open-workspace"', 'data-testid="session-new-chat"', 'data-testid="session-actions"'].map((id) => html.indexOf(id));
  assert.ok(order.every((at) => at >= 0), "every control renders");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in reading order");
  assert.ok(html.includes("relative flex h-14 items-center"), "56px row");
  assert.ok(html.includes("pointer-events-none absolute inset-x-0 top-0"), "absolutely over the transcript; only its pills take taps");
  // A page-colour shade masked to fade out, never a bar with blur or a border.
  assert.ok(html.includes("bg-background") && html.includes("mask-image:linear-gradient") && !html.includes("backdrop-blur") && !html.includes("border-b"), "a fading shade, not a bar");
  assert.ok(html.includes("ring-white/10"), "pills carry ChatGPT's lighter ring");
  assert.ok(html.includes('aria-label="Open sessions"'));
  assert.ok(html.includes('aria-label="New chat"'));
  // The title and the folder this chat runs in are on screen: two chats with
  // the same name were indistinguishable once the transcript had messages.
  assert.equal(h1(html), "Synthetic header fixture");
  assert.ok(html.includes('data-testid="chat-heading-project"'), "the folder is named");
  assert.equal(html.match(/data-testid="chat-heading-project"[^>]*>(.*?)<\/span>/)?.[1], "pulse-app");
  assert.ok(!/<h1[^>]*class="sr-only"/.test(html), "no title hidden from sight");
});

test("the actions button's aria label carries usage and spend", () => {
  const html = header({ ...props(), modelLabel: "Opus 5.5 · High", contextPercent: 83.6, cost: "$4.76" });
  assert.match(html, /aria-label="Session actions, context 84% used, \$4.76 spent"/);
});

test("the menu button shows an accent dot only while ANOTHER chat needs you", () => {
  const { store, ...rest } = props();
  const render = () => header({ ...rest, store, controller: { getStore: () => store } });
  assert.ok(!render().includes('data-testid="needs-you-dot"'));
  store.setState({ sessions: [...store.getState().sessions, { path: "/tmp/other.jsonl", cwd: "/home/u/x", status: "waiting" }] });
  assert.ok(render().includes('data-testid="needs-you-dot"'));
  store.setState({ sessions: store.getState().sessions.map((row) => ({ ...row, status: "waiting" })).filter((row) => row.path === PATH) });
  assert.ok(!render().includes('data-testid="needs-you-dot"'), "the open chat waiting on you is not elsewhere");
});

test("the workspace badge shows what needs you first, then what is working, then what is left", () => {
  const badge = (t) => header({ ...props(), tracking: tracking(t), onOpenWorkspace() {} }).match(/data-testid="workspace-badge" data-tone="(\w+)"[^>]*>(\d+)</)?.slice(1) ?? null;
  assert.equal(badge({}), null);
  assert.deepEqual(badge({ tasksLeft: 2, tasksDone: 1, tasksTotal: 3 }), ["neutral", "2"]);
  assert.deepEqual(badge({ tasksLeft: 2, agents: { working: 3, needsYou: 0 } }), ["running", "3"]);
  assert.deepEqual(badge({ tasksLeft: 2, agents: { working: 3, needsYou: 1 } }), ["warning", "1"]);
});

test("the header never states turn or connection state", () => {
  for (const connection of ["open", "offline", "connecting", "reconnecting", "closed", "error"]) {
    for (const working of [false, true]) {
      const html = header(props({ connection, working }));
      for (const word of ["Idle", "Working", "reconnecting", "offline", "connecting", "connected"]) {
        assert.ok(!html.includes(`>${word}<`), `${connection}/${working}: ${word}`);
      }
      assert.ok(!html.includes("bg-dot-success") && !html.includes("animate-pulse"), `${connection}/${working}: no status dot`);
    }
  }
});

test("no session: the heading shows no placeholder word, only an accessible name", () => {
  const p = props(); p.sessionPath = null; p.project = null;
  const html = header(p);
  const heading = html.match(/data-testid="chat-heading"[^>]*>(.*?)<\/h1>/s)?.[1] ?? "";
  assert.ok(!heading.includes(">Chat<"), "no generic word posing as a name");
  assert.ok(heading.includes('class="sr-only">Conversation</span>'));
  assert.ok(!html.includes('data-testid="chat-heading-project"'), "no folder to name");
  assert.ok(html.includes('aria-label="Session actions"'));
});

function controller(store) {
  const c = Object.create(OmpSessionController.prototype);
  Object.assign(c, { store, generation: 0, activeSession: PATH, disposed: false, modelEntryAt: 0, thinkingEntryAt: 0, titleEntryAt: 0,
    enforceWindow() {} });
  return c;
}
const titleChange = (title, at, id = `t-${at}`) => ({ type: "title_change", id, parentId: null, timestamp: new Date(at).toISOString(), title });

test("a title_change entry renames the header at once, before any listing refresh", () => {
  const p = props();
  assert.equal(h1(header(p)), "Synthetic header fixture");
  controller(p.store).mergeHistory([titleChange("Renamed from the transcript", 2_000)]);
  assert.equal(p.store.getState().sessions[0].title, "Renamed from the transcript");
  const html = header(p);
  assert.equal(h1(html), "Renamed from the transcript");
});

test("the newest rename wins; an older page or an older entry never rolls it back", () => {
  const p = props();
  const c = controller(p.store);
  c.mergeHistory([titleChange("First name", 1_000), titleChange("Second name", 3_000)]);
  assert.equal(p.store.getState().sessions[0].title, "Second name");
  c.mergeHistory([titleChange("Stale echo", 2_000)]);
  assert.equal(p.store.getState().sessions[0].title, "Second name", "older tail entry");
  // Backward pages (loadEarlier) hold older names than the listing already has.
  c.adoptSessionModelEntries([titleChange("From an older page", 5_000)], true);
  assert.equal(p.store.getState().sessions[0].title, "Second name", "backward page");
});

test("a rename confirmed by /rename patches only its own row", () => {
  const store = createOmpStore();
  store.setState({ sessions: [{ path: PATH, title: "Old" }, { path: "/tmp/other.jsonl", title: "Other" }] });
  const before = store.getState().sessions;
  store.getState().setSessionTitle(PATH, "New");
  assert.deepEqual(store.getState().sessions.map((row) => row.title), ["New", "Other"]);
  assert.equal(store.getState().sessions[1], before[1], "untouched row keeps its identity");
  const same = store.getState().sessions;
  store.getState().setSessionTitle(PATH, "New");
  assert.equal(store.getState().sessions, same, "an unchanged title publishes nothing");
});
