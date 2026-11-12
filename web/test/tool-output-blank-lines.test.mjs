import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
// Bash and file results share one reader (OutputBlock); both are mounted so a
// renderer split between them cannot regress unnoticed.
const code = await bundleDomFixture(`
  import { createElement as h, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { BashTool } from ${JSON.stringify(resolve(root, "web/src/app/parts/tools/BashTool.tsx"))};
  import { FileTool } from ${JSON.stringify(resolve(root, "web/src/app/parts/tools/FileTool.tsx"))};
  window.fixture = { act, mount(kind, part) {
    const r = createRoot(document.getElementById('root'));
    r.render(kind === 'bash' ? h(BashTool, { part, live: false }) : h(FileTool, { part }));
    return r;
  } };
`, [{
  name: "notice-sink",
  resolveId: (id, importer) =>
    (importer?.endsWith("/CopyButton.tsx") && id === "../Notices") ||
    (importer?.endsWith("/BashTool.tsx") && id === "@/app/Notices") ? "\0notices" : null,
  load: id => id === "\0notices" ? "export const showToast = () => {};" : null,
}]);

async function fixture(t, kind, output, { state = "ok" } = {}) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  const writes = [], frames = new Map();
  let frameId = 0, mounted;
  w.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  w.cancelAnimationFrame = id => frames.delete(id);
  Object.defineProperty(w.navigator, "clipboard", {
    configurable: true, value: { writeText: async text => { writes.push(text); } },
  });
  t.after(async () => {
    try {
      if (mounted) await act(async () => mounted.unmount());
      assert.deepEqual(dom.blocked, [], "no network attempts");
    } finally { dom.close(); }
  });
  await act(async () => {
    mounted = w.fixture.mount(kind, {
      kind: "tool", name: kind === "bash" ? "bash" : "read", callId: "synthetic-only", state,
      args: kind === "bash" ? { command: "never executed" } : { path: "synthetic.txt" }, output,
    });
  });
  const click = async button => {
    assert.ok(button, "requested control exists");
    await act(async () => button.click());
  };
  const button = prefix => [...w.document.querySelectorAll("button")].find(b => b.textContent.startsWith(prefix));
  // Hold the control: Copy relabels itself "Copied" after a click.
  const copyButton = () => w.document.querySelector('button[aria-label="Copy output"], button[aria-label="Copy error"]');
  const chunks = () => [...w.document.querySelectorAll('[style*="content-visibility"]')]
    .filter(el => el.style.containIntrinsicSize === "auto 400px");
  const lines = () => {
    const pres = [...w.document.querySelectorAll("pre[data-bash-output]")];
    if (!pres.length) return [];
    const text = pre => {
      const code = pre.querySelector("code");
      assert.ok(code, "each reader range has exact text content");
      return code.textContent;
    };
    // Each progressive chunk omits its joining newline, so empty ranges keep
    // trailing/boundary blank lines observable. Unchunked ranges (a failure's
    // danger-coloured first line, then the rest) are contiguous slices.
    const rendered = chunks();
    const joined = rendered.length
      ? rendered.map(chunk => text(chunk.querySelector("pre[data-bash-output]"))).join("\n")
      : pres.map(text).join("");
    return joined.split("\n");
  };
  const tick = async () => {
    const callbacks = [...frames.values()];
    frames.clear();
    await act(async () => callbacks.forEach(callback => callback(frameId * 16)));
  };
  return {
    w, act, writes, frames, click, button, chunks, lines, tick,
    expand: () => click(button("Show all")),
    less: () => click(button("Show less")),
    copy: () => click(copyButton()),
    async settle() {
      let ticks = 0;
      while (frames.size) { assert.ok(++ticks < 100, "progressive expansion finishes"); await tick(); }
      await act(async () => { await new Promise(resolve => w.setTimeout(resolve, 0)); });
    },
    async unmount() { await act(async () => mounted.unmount()); mounted = null; },
  };
}

function assertLines(actual, output) {
  const expected = output.split("\n");
  assert.equal(actual.length, expected.length, "all logical lines survive expansion");
  const mismatch = actual.findIndex((line, index) => line !== expected[index]);
  assert.equal(mismatch, -1, `line content/order mismatch at line ${mismatch + 1}`);
}

const rows = Array.from({ length: 600 }, (_, i) => `row_${String(i).padStart(4, "0")}_${"x".repeat(110)}`).join("\n");
const fullChunks = Array.from({ length: 8 }, (_, i) => String(i).repeat(8000)).join("\n");
const cases = [
  ["leading blanks", "\n\n\n" + rows],
  ["consecutive middle blanks", "start\n\n\nend\n" + rows],
  ["blank start of chunk", "A".repeat(8000) + "\n\n\nNEXT\n" + rows],
  ["trailing blanks within chunk", rows + "\n\n\n"],
  ["trailing empty chunk", fullChunks + "\n"],
  ["trailing boundary blanks", fullChunks + "\n\n\n"],
  ["all blank output", "\n".repeat(65001)],
  ["long single line", "L".repeat(65001)],
  ["long lines and adjacent blanks", "\n\n" + "X".repeat(33000) + "\n\n" + "Y".repeat(33000) + "\n"],
  ["spaces and tabs", " \n\t\n \t\n" + rows + "\n\t\n "],
  ["ordinary many chunks", rows],
  ["Unicode around blank boundaries", ("🙂é漢".repeat(2000) + "\n\n").repeat(8) + "e\u0301\n"],
];

for (const kind of ["bash", "file"]) {
  for (const state of ["ok", "error"]) {
    for (const [name, output] of cases) {
      test(`${kind} ${state}: ${name}`, async t => {
        assert.ok(output.length > 60000, "fixture enters expanded chunk path");
        const f = await fixture(t, kind, output, { state });
        const clamped = f.lines();
        await f.expand();
        await f.settle();
        // Copy must remain exact even for a display regression.
        await f.copy();
        assert.deepEqual(f.writes, [output]);
        const expanded = f.lines();
        assert.equal(f.w.document.querySelector("[data-language]") === null, true, "no highlighter path");
        // Uncoloured fixtures render as plain runs: no invented colour.
        assert.equal(f.w.document.querySelector("[data-bash-color]") === null, true, "plain text runs");
        assertLines(expanded, output);
        await f.less();
        assert.deepEqual(f.lines(), clamped, "Show less restores the original clamp");
        assert.ok(f.button("Show all"));
      });
    }
  }
}

for (const kind of ["bash", "file"]) {
  test(`${kind}: progressive frames, Show less cancellation, and re-expansion preserve blanks`, async t => {
    const output = "\n\n" + rows + "\n\n";
    const f = await fixture(t, kind, output);
    await f.expand();
    assert.equal(f.chunks().length, 1);
    assert.ok(f.frames.size > 0);
    await f.tick();
    assert.equal(f.chunks().length, 3, "two more chunks per frame");
    await f.less();
    assert.equal(f.frames.size, 0, "Show less cancels outstanding progressive work");
    assert.equal(f.chunks().length, 0);
    await f.expand();
    assert.equal(f.chunks().length, 1);
    await f.settle();
    assertLines(f.lines(), output);
    await f.less();
    await f.expand();
    assert.ok(f.frames.size > 0);
    await f.unmount();
    assert.equal(f.frames.size, 0, "unmount cancels outstanding progressive work");
  });

  const lineOnly = Array.from({ length: 600 }, (_, i) => `line_${i}_${"x".repeat(25)}`).join("\n");
  for (const [name, output, expectedClamp, chunked] of [
    ["character clamp", "L".repeat(65001), "L".repeat(60000), true],
    ["line-only clamp", lineOnly, lineOnly.split("\n").slice(0, 500).join("\n"), true],
    ["short blank line-only clamp", "\n".repeat(501), "\n".repeat(499), false],
  ]) {
    test(`${kind}: ${name} and clamped Copy remain unchanged`, async t => {
      const f = await fixture(t, kind, output);
      assertLines(f.lines(), expectedClamp);
      await f.copy();
      assert.deepEqual(f.writes, [output]);
      await f.expand();
      assert.equal(f.chunks().length > 0, chunked);
      if (name === "line-only clamp") assert.equal(f.frames.size, 0, "under 32000 chars expands immediately");
      await f.settle();
      assertLines(f.lines(), output);
    });
  }

  for (const [name, output] of [["empty", ""], ["missing", undefined]]) {
    for (const state of ["ok", "error"]) {
      test(`${kind} ${state}: ${name} output has no invented lines or copy action`, async t => {
        const f = await fixture(t, kind, output, { state });
        assert.deepEqual(f.lines(), []);
        assert.equal(f.button("Show all") === undefined, true);
        assert.equal(f.w.document.querySelector('button[aria-label="Copy output"], button[aria-label="Copy error"]') === null, true);
        // A command keeps its own head and Copy; a file read with nothing returned shows no block.
        assert.equal(f.w.document.querySelector('button[aria-label="Copy command"]') !== null, kind === "bash");
        assert.equal(f.frames.size, 0);
      });
    }
  }
}
