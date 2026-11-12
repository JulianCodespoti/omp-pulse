import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// Actual CopyButton callback; presentational Button/Toast are stubbed. This is
// not a DOM, OS-clipboard or React-effect test. Clipboard writes are fake.
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(resolve(root, "web/package.json"));
const directory = await mkdtemp(resolve(tmpdir(), "pulse-reply-copy-"));
after(() => rm(directory, { recursive: true, force: true }));
const buttonPath = resolve(directory, "button.mjs"), noticePath = resolve(directory, "notice.mjs");
await writeFile(buttonPath, "export let latestProps; export function Button(props) { latestProps = props; return null; }");
await writeFile(noticePath, "export const notices = []; export function showToast(...args) { notices.push(args); }");
const source = `
  import { createElement } from ${JSON.stringify(require.resolve("react"))};
  import { renderToStaticMarkup } from ${JSON.stringify(require.resolve("react-dom/server"))};
  import { CopyButton } from ${JSON.stringify(resolve(root, "web/src/app/parts/CopyButton.tsx"))};
  import { latestProps } from ${JSON.stringify(buttonPath)};
  export { notices } from ${JSON.stringify(noticePath)};
  export function capture(text, props = {}) { renderToStaticMarkup(createElement(CopyButton, { text, ...props })); return latestProps; }
`;
const bundle = await rolldown({ input: "copy-test-entry", platform: "node",
  resolve: { alias: { "@": resolve(root, "web/src") } },
  transform: { jsx: { runtime: "automatic" } },
  plugins: [{ name: "copy-test-entry", resolveId: (id, importer) => {
    if (id === "copy-test-entry") return "\0copy-test-entry";
    if (importer?.endsWith("/CopyButton.tsx")) {
      if (id.includes("components/ui/button")) return buttonPath;
      if (id.endsWith("Notices")) return noticePath;
    }
    return null;
  },
    load: (id) => id === "\0copy-test-entry" ? source : null }],
});
await bundle.write({ file: resolve(directory, "copy.mjs"), format: "esm" });
await bundle.close();
const { capture, notices } = await import(pathToFileURL(resolve(directory, "copy.mjs")).href);
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function fixture(writeText, legacyResult = false) {
  notices.length = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText } } });
  globalThis.window = { setTimeout: (...args) => setTimeout(...args).unref(), clearTimeout };
  globalThis.document = { activeElement: null, body: { appendChild() {} },
    createElement: () => ({ value: "", readOnly: false, style: {}, select() {}, remove() {} }),
    execCommand: () => legacyResult };
  return capture(" exact fixture reply ");
}

test("failed modern and legacy writes produce one actionable warning", async () => {
  const button = fixture(async () => { throw new Error("fixture denial"); });
  await button.onClick();
  assert.deepEqual(notices, [["Couldn't copy. Try again or select the text.", "warn"]]);
});

test("size picks the toolbar variant and the label names the copy target", () => {
  fixture(async () => {});
  assert.equal(capture("x").size, "icon");
  assert.equal(capture("x").variant, "ghost");
  const small = capture("x", { size: "icon-sm", label: "Copy output" });
  assert.equal(small.size, "icon-sm");
  assert.equal(small["aria-label"], "Copy output");
});

test("repeated clicks while a write is pending issue only one clipboard request", async () => {
  let calls = 0; const pending = deferred();
  const button = fixture(() => { calls++; return pending.promise; });
  const first = button.onClick(), second = button.onClick();
  pending.resolve();
  await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(notices, []);
});

test("successful writes preserve exact text without a failure warning", async () => {
  let received;
  const button = fixture(async (value) => { received = value; });
  await button.onClick();
  assert.equal(received, " exact fixture reply ");
  assert.deepEqual(notices, []);
});

test("an acknowledged legacy fallback remains a successful copy", async () => {
  const button = fixture(async () => { throw new Error("fixture rejection"); }, true);
  await button.onClick();
  assert.deepEqual(notices, []);
});

test("a failure releases the guard so the same button can be retried", async () => {
  let calls = 0;
  const button = fixture(async () => { if (!calls++) throw new Error("first failed"); });
  await button.onClick(); await button.onClick();
  assert.equal(calls, 2);
  assert.equal(notices.length, 1);
});
