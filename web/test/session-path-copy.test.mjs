import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// Actual SessionHeader callback, stub menu/toast presentation and fake
// clipboard. No browser, effect scheduling, real clipboard or daemon calls.
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(resolve(root, "web/package.json"));
const directory = await mkdtemp(resolve(tmpdir(), "pulse-session-copy-"));
after(() => rm(directory, { recursive: true, force: true }));
const menuPath = resolve(directory, "menu.mjs"), noticePath = resolve(directory, "notice.mjs");
// The closed menu renders nothing on the server, so its parts render their children and the items record their props.
await writeFile(menuPath, `export const items = [];
  const pass = ({ children }) => children ?? null;
  export const DropdownMenu = pass, DropdownMenuContent = pass, DropdownMenuTrigger = () => null, DropdownMenuSeparator = () => null;
  export function DropdownMenuChoice(props) { items.push(props); return null; }
`);
await writeFile(noticePath, "export const notices = []; export function showToast(...args) { notices.push(args); }");
const source = `
  import { createElement } from ${JSON.stringify(require.resolve("react"))};
  import { renderToStaticMarkup } from ${JSON.stringify(require.resolve("react-dom/server"))};
  import { SessionHeader } from ${JSON.stringify(resolve(root, "web/src/app/chat/SessionHeader.tsx"))};
  import { createOmpStore } from ${JSON.stringify(resolve(root, "web/src/runtime/omp-store.ts"))};
  import { items } from ${JSON.stringify(menuPath)};
  export { notices } from ${JSON.stringify(noticePath)};
  export function capture(path) {
    items.length = 0;
    const store = createOmpStore(); store.setState({ sessionPath: path });
    const noop = () => {};
    renderToStaticMarkup(createElement(SessionHeader, { sessionPath: path, store, summary: null, connection: 'open',
      onBack: noop, onRename: noop, onOpenModelPicker: noop, onOpenSessionSettings: noop, onReload: noop }));
    const item = items.find((p) => p["data-testid"] === 'session-copy-path');
    return { item, store };
  }
`;
const bundle = await rolldown({ input: "session-copy-test", platform: "node",
  resolve: { alias: { "@": resolve(root, "web/src") } },
  transform: { jsx: { runtime: "automatic" }, define: { "import.meta.env": JSON.stringify({ VITE_PROTOCOL_VERSION: 1, VITE_RELEASE_ID: "unit" }) } },
  plugins: [{ name: "session-copy-test", resolveId: (id, importer) => {
    if (id === "session-copy-test") return "\0session-copy-test";
    if (importer?.endsWith("/SessionHeader.tsx")) {
      if (id.endsWith("ui/dropdown-menu")) return menuPath;
      if (id.endsWith("Notices")) return noticePath;
    }
    return null;
  }, load: (id) => id === "\0session-copy-test" ? source : null }],
});
await bundle.write({ file: resolve(directory, "copy.mjs"), format: "esm" });
await bundle.close();
const { capture, notices } = await import(pathToFileURL(resolve(directory, "copy.mjs")).href);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const PATH = "/synthetic/with spaces/α.jsonl";
function fixture(writeText, legacyResult = false, path = PATH) {
  notices.length = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: writeText ? { writeText } : undefined } });
  globalThis.document = { activeElement: null, body: { appendChild() {} },
    createElement: () => ({ value: "", readOnly: false, style: {}, select() {}, remove() {} }), execCommand: () => legacyResult };
  globalThis.window = { location: { origin: "http://synthetic.invalid" } };
  return capture(path);
}

test("session path is copied exactly and acknowledged without revealing it in the toast", async () => {
  let received; const { item } = fixture(async (text) => { received = text; });
  await item.onClick();
  assert.equal(received, PATH);
  assert.deepEqual(notices, [["Copied path", "success"]]);
});

test("unavailable modern clipboard can use the acknowledged legacy fallback", async () => {
  const { item } = fixture(undefined, true);
  await item.onClick();
  assert.deepEqual(notices, [["Copied path", "success"]]);
});

test("unavailable clipboard methods give a retry warning instead of silence", async () => {
  const { item } = fixture(undefined, false);
  await item.onClick();
  assert.deepEqual(notices, [["Couldn’t copy the path.", "warn"]]);
});

test("repeated pending path copies issue one write", async () => {
  let calls = 0; const pending = deferred();
  const { item } = fixture(() => { calls++; return pending.promise; });
  const first = item.onClick(), second = item.onClick(); pending.resolve();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test("a changed active session suppresses old path-copy feedback", async () => {
  const pending = deferred(); const { item, store } = fixture(() => pending.promise);
  const copy = item.onClick(); store.setState({ sessionPath: "/synthetic/new.jsonl" }); pending.resolve();
  await copy;
  assert.deepEqual(notices, []);
});

test("a missing session disables copying and does not attempt a write", async () => {
  const { item } = fixture(() => assert.fail("no session should not copy"), false, null);
  assert.equal(item.disabled, true);
  await item.onClick();
  assert.deepEqual(notices, []);
});

test("a rejected modern write is caught and remains retryable", async () => {
  let attempts = 0;
  const { item } = fixture(async () => { if (!attempts++) throw new Error("fixture denial"); });
  await item.onClick(); await item.onClick();
  assert.deepEqual(notices, [["Couldn’t copy the path.", "warn"], ["Copied path", "success"]]);
});
