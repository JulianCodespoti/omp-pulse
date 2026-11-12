import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// Capture the actual hook callbacks with React server rendering. Effects and
// storage events do not run: these are equivalent-state cleanup tests, not a
// browser/cross-window journey. A private Map supplies localStorage.
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(resolve(root, "web/package.json"));
const directory = await mkdtemp(resolve(tmpdir(), "pulse-draft-unit-"));
after(() => rm(directory, { recursive: true, force: true }));
const source = `
  import { createElement } from ${JSON.stringify(require.resolve("react"))};
  import { renderToStaticMarkup } from ${JSON.stringify(require.resolve("react-dom/server"))};
  import { useDraft } from ${JSON.stringify(resolve(root, "web/src/app/composer/use-draft.ts"))};
  export { seedDraft, readDraft } from ${JSON.stringify(resolve(root, "web/src/app/composer/use-draft.ts"))};
  export function captureDraft(path) {
    let actions;
    function Harness() { actions = useDraft(path); return null; }
    renderToStaticMarkup(createElement(Harness));
    return actions;
  }
`;
const bundle = await rolldown({ input: "draft-test-entry", platform: "node",
  resolve: { alias: { "@": resolve(root, "web/src") } },
  plugins: [{ name: "draft-test-entry", resolveId: (id) => id === "draft-test-entry" ? "\0draft-test-entry" : null,
    load: (id) => id === "\0draft-test-entry" ? source : null }],
});
await bundle.write({ file: resolve(directory, "draft.mjs"), format: "esm" });
await bundle.close();
const storage = new Map();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key),
} });
const events = new EventTarget();
const { captureDraft, seedDraft, readDraft } = await import(pathToFileURL(resolve(directory, "draft.mjs")).href);
globalThis.window = { setTimeout, clearTimeout, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };


test("acknowledging older text cannot erase a newer draft the view has adopted", () => {
  const path = "/synthetic/adopted";
  seedDraft(path, "newer unsent draft");
  const draft = captureDraft(path);
  assert.equal(draft.clearDraft("older sent text"), "newer unsent draft");
  assert.equal(readDraft(path), "newer unsent draft");
});

test("the pre-autosave hello / hello! boundary still clears the submitted draft", () => {
  const path = "/synthetic/autosave";
  seedDraft(path, "hello");
  const draft = captureDraft(path);
  draft.setText("hello!");
  assert.equal(draft.clearDraft("hello!"), "");
  assert.equal(readDraft(path), "");
});

test("an older acknowledgement must not cancel the newer edit's autosave", async () => {
  const path = "/synthetic/new-edit";
  seedDraft(path, "submitted");
  const draft = captureDraft(path);
  draft.setText("newer edit");
  assert.equal(draft.clearDraft("submitted"), "newer edit");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(readDraft(path), "newer edit");
});

test("a foreign saved value not yet observed survives submitted-text cleanup", () => {
  const path = "/synthetic/foreign";
  seedDraft(path, "submitted");
  const draft = captureDraft(path);
  seedDraft(path, "another view's draft");
  assert.equal(draft.clearDraft("submitted"), "another view's draft");
  assert.equal(readDraft(path), "another view's draft");
});

const { submittedDraftCleanup } = await import("../src/app/composer/draft-cleanup.ts");

test("an observed foreign draft is not treated as this view's old autosave", () => {
  assert.equal(submittedDraftCleanup({ value: "sent", observed: "foreign", foreign: "foreign" }, "sent", "foreign"), "keep-foreign");
});

test("unobserved foreign text and an explicit foreign clear remain foreign", () => {
  for (const stored of ["other", ""]) {
    assert.equal(submittedDraftCleanup({ value: "sent", observed: "old", foreign: stored }, "sent", stored), "keep-foreign");
  }
});

test("the view's own lagging autosave can be removed", () => {
  assert.equal(submittedDraftCleanup({ value: "hello!", observed: "hello", foreign: null }, "hello!", "hello"), "remove-submitted");
});

test("new current text is preserved even if storage still equals the submitted value", () => {
  assert.equal(submittedDraftCleanup({ value: "new", observed: "sent", foreign: null }, "sent", "sent"), "keep-current");
});

test("an exactly submitted saved value can be removed", () => {
  assert.equal(submittedDraftCleanup({ value: "sent", observed: "old", foreign: null }, "sent", "sent"), "remove-submitted");
});
