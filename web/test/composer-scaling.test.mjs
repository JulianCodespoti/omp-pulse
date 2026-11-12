import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// Static actual-component rendering only. No browser geometry, effects, input
// gestures, microphone or daemon. Storage and origin are synthetic.
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(resolve(root, "web/package.json"));
const directory = await mkdtemp(resolve(tmpdir(), "pulse-composer-scale-"));
after(() => rm(directory, { recursive: true, force: true }));
const source = `
  import { createElement } from ${JSON.stringify(require.resolve("react"))};
  import { renderToStaticMarkup } from ${JSON.stringify(require.resolve("react-dom/server"))};
  import { Composer } from ${JSON.stringify(resolve(root, "web/src/app/composer/Composer.tsx"))};
  export { seedDraft } from ${JSON.stringify(resolve(root, "web/src/app/composer/use-draft.ts"))};
  export const render = (props) => renderToStaticMarkup(createElement(Composer, props));
`;
const bundle = await rolldown({ input: "composer-test-entry", platform: "node",
  resolve: { alias: { "@": resolve(root, "web/src") } },
  transform: { jsx: { runtime: "automatic" }, define: { "import.meta.env": JSON.stringify({ VITE_PROTOCOL_VERSION: 1, VITE_RELEASE_ID: "unit" }) } },
  plugins: [{ name: "composer-test-entry", resolveId: (id) => id === "composer-test-entry" ? "\0composer-test-entry" : null,
    load: (id) => id === "\0composer-test-entry" ? source : null }],
});
await bundle.write({ file: resolve(directory, "composer.mjs"), format: "esm" });
await bundle.close();
const { render, seedDraft } = await import(pathToFileURL(resolve(directory, "composer.mjs")).href);
const storage = new Map();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: (key) => storage.delete(key),
} });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: () => assert.fail("SSR must not request a microphone") } } });
globalThis.MediaRecorder = class { constructor() { assert.fail("SSR must not record"); } };
globalThis.window = { location: { origin: "http://synthetic.invalid" }, isSecureContext: true };
let seq = 0;
function html(text = "", options = {}) {
  const path = `/synthetic/composer-${++seq}`;
  if (text) seedDraft(path, text);
  return render({ sessionPath: path, busy: false, onSend() { assert.fail("SSR must not send"); }, onStop() { assert.fail("SSR must not stop"); }, ...options });
}
const button = (markup, id) => [...markup.matchAll(/<button\b[^>]*>/g)].map((m) => m[0]).find((tag) => tag.includes(`data-testid="${id}"`));

test("typed draft stays in the editor while initial Send waits for attachment restoration", () => {
  const markup = html("newer unsent text");
  assert.match(markup, /<textarea[^>]*>newer unsent text<\/textarea>/);
  const send = button(markup, "composer-send-btn");
  assert.ok(send?.includes('type="submit"'));
  // SSR cannot restore a durable tray. The first client render must also
  // stay blocked until restoration, avoiding a text-only send window.
  assert.ok(send?.includes('disabled=""'));
});

test("busy typed composer offers Send and a compact Stop together, with the send-mode choice above the card", () => {
  const markup = html("follow-up", { busy: true });
  assert.ok(button(markup, "composer-send-btn"));
  assert.ok(button(markup, "composer-stop-btn"), "a draft must not hide Stop: the only way out was clearing it");
  assert.ok(markup.includes('data-testid="send-mode"'));
});

test("busy empty composer retains Stop without inventing a sendable draft", () => {
  const markup = html("", { busy: true });
  assert.ok(button(markup, "composer-stop-btn"));
  assert.equal(button(markup, "composer-send-btn"), undefined);
});

test("send and stop permission states still constrain their own controls", () => {
  const markup = html("kept draft", { busy: true, sendAllowed: false, stopAllowed: false });
  assert.ok(button(markup, "composer-send-btn")?.includes('disabled=""'));
  assert.equal(button(markup, "composer-stop-btn"), undefined);
  assert.ok(markup.includes("kept draft"));
});

