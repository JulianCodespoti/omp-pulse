import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { buildTimeline } from "../src/domain/timeline.ts";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
  import { createElement, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { RunSummary } from ${JSON.stringify(resolve(root, "web/src/app/parts/RunSummary.tsx"))};
  window.fixture = { act, mount: (props) => {
    const r = createRoot(document.getElementById('root'));
    r.render(createElement(RunSummary, props)); return r;
  } };
`, [{ name: "presentation-boundaries", resolveId(id, importer) {
  if (importer?.endsWith("/RunSummary.tsx") && ["./ToolPart", "./ImagePart", "./QuickReplies"].includes(id)) return "\0" + id.slice(2);
  return null;
}, load(id) {
  const react = `import {createElement as h} from ${JSON.stringify(require.resolve("react"))};`;
  if (id === "\0ToolPart") return react + `export const ToolPart = ({part,showImages}) => h('div',{'data-tool':part.callId,'data-show-images':String(showImages)},part.name);`;
  if (id === "\0ImagePart") return react + `export const ImagePart = ({src}) => h('span',{'data-image':src});`;
  if (id === "\0QuickReplies") return react + `export const QuickReplies = () => null;`;
  return null;
} }]);

const shot = (n) => ({
  kind: "tool", callId: `read${n}`, name: "read", state: "ok",
  args: { path: `/sdcard/Pictures/omp/shot-${n}.png` },
  images: [{ src: `blob:sha256:${String(n).repeat(8)}`, mimeType: "image/png" }],
});
const run = (parts, id = "m1") => ({ id, role: "assistant", text: "", parts });

async function fixture(t, props) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  let mounted;
  await act(async () => { mounted = w.fixture.mount({ toolsLive: false, ...props }); });
  t.after(async () => { try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const all = (selector) => [...w.document.querySelectorAll(selector)];
  return {
    inline: () => all('[data-testid="run-photo"] [data-image]').map((el) => el.dataset.image),
    stepImages: () => Object.fromEntries(all("[data-tool]").map((el) => [el.dataset.tool, el.dataset.showImages])),
    toggle: () => act(async () => w.document.querySelector('[data-testid="run-summary-toggle"]').click()),
  };
}

test("a run shows only its newest screenshot; the others wait in the expanded steps", async (t) => {
  const f = await fixture(t, { messages: [run([shot(1), shot(2), shot(3)]), run([shot(4), shot(5)], "m2")] });
  assert.deepEqual(f.inline(), ["blob:sha256:55555555"]);
  await f.toggle();
  assert.deepEqual(f.stepImages(), { read1: "true", read2: "true", read3: "true", read4: "true", read5: "false" });
  assert.deepEqual(f.inline(), ["blob:sha256:55555555"], "expanding does not duplicate the inline one");
});

test("a screenshot the reply names stays in view with the newest", async (t) => {
  const f = await fixture(t, {
    messages: [run([shot(1), shot(2), shot(3)])],
    continued: true,
    reply: "The settings page is in shot-1.png; the last one shows the result.",
  });
  assert.deepEqual(f.inline(), ["blob:sha256:11111111", "blob:sha256:33333333"]);
  await f.toggle();
  assert.deepEqual(f.stepImages(), { read1: "false", read2: "true", read3: "false" });
});

test("an image the agent posted itself is never hidden in the steps", async (t) => {
  const posted = { kind: "image", src: "blob:sha256:abcdabcd", mimeType: "image/png" };
  const f = await fixture(t, { messages: [run([posted, shot(1), shot(2)])] });
  assert.deepEqual(f.inline(), ["blob:sha256:abcdabcd", "blob:sha256:22222222"]);
});

test("a tool without images asks for none in its step", async (t) => {
  const f = await fixture(t, { messages: [run([{ kind: "tool", callId: "bash1", name: "bash", state: "ok", args: { command: "ls" } }, shot(1)])] });
  await f.toggle();
  assert.deepEqual(f.stepImages(), { bash1: "false", read1: "false" });
});

test("a run item carries the text of the reply that continued it", () => {
  const user = { id: "u1", role: "user", text: "Look at the screen", parts: [{ kind: "text", text: "Look at the screen" }] };
  const reply = { id: "r1", role: "assistant", text: "See shot-1.png", parts: [{ kind: "text", text: "See shot-1.png" }] };
  const steps = run([shot(1)]);
  const before = buildTimeline([user, steps]);
  assert.equal(before.find((item) => item.kind === "run").reply, "");
  const after = buildTimeline([user, steps, reply], before);
  assert.equal(after.find((item) => item.kind === "run").reply, "See shot-1.png");
});
