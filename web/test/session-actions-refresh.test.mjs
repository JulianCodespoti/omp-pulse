import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
  import { createElement, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { SessionActionsSheet } from ${JSON.stringify(resolve(root, "web/src/app/sessions/SessionActionsSheet.tsx"))};
  window.fixture = {
    act,
    mount: (initial) => {
      let current = initial;
      const r = createRoot(document.getElementById("root"));
      const render = () => r.render(createElement(SessionActionsSheet, {
        session: current,
        onOpenChange() {},
        onChanged() {},
        onOpenSession() {},
      }));
      render();
      return {
        update(next) { current = next; render(); },
        unmount() { r.unmount(); },
      };
    },
  };
`);

const row = (title, extra = {}) => ({
  path: "/synthetic/" + title + ".jsonl",
  title,
  cwd: "/synthetic/project",
  activeAt: Date.now(),
  running: false,
  ...extra,
});

async function fixture(t, initial) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  w.localStorage.setItem("omp-remote-token", "synthetic-fixture");
  let mounted;
  await act(async () => { mounted = w.fixture.mount(initial); });
  t.after(async () => {
    try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  const el = (id) => w.document.querySelector(`[data-testid="${id}"]`);
  return {
    w, el, act,
    update: (next) => act(async () => mounted.update(next)),
    typeRename: (value) => act(async () => {
      const input = el("rename-input");
      Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new w.Event("input", { bubbles: true }));
    }),
    click: (id) => act(async () => { assert.ok(el(id), id); el(id).click(); }),
  };
}

test("an open running-session menu enables the computer handoff after the reply finishes", async (t) => {
  const f = await fixture(t, row("Running", { running: true }));
  assert.equal(f.el("action-open-on-computer").disabled, true);
  await f.update(row("Running", { running: false }));
  assert.equal(f.el("action-open-on-computer").disabled, false);
});

test("an open idle menu disables handoff when the same session starts working", async (t) => {
  const f = await fixture(t, row("Idle"));
  assert.equal(f.el("action-open-on-computer").disabled, false);
  await f.update(row("Idle", { running: true }));
  assert.equal(f.el("action-open-on-computer").disabled, true);
});

test("fresh metadata never erases an in-progress rename draft", async (t) => {
  const f = await fixture(t, row("Idle"));
  await f.click("action-rename");
  await f.typeRename("My unfinished name");
  await f.update(row("Idle", { preview: "new preview", revision: 2 }));
  assert.equal(f.el("rename-input")?.value, "My unfinished name");
});

test("a newly reported computer owner replaces Open with the protected Close action", async (t) => {
  const f = await fixture(t, row("Idle"));
  await f.update(row("Idle", { live: true }));
  assert.equal(Boolean(f.el("action-open-on-computer")), false);
  assert.ok(f.el("action-close-on-computer"));
});

test("starting a rename after a title update uses the fresh title", async (t) => {
  const f = await fixture(t, row("Idle"));
  await f.update({ ...row("Idle"), title: "Renamed elsewhere" });
  await f.click("action-rename");
  assert.equal(f.el("rename-input").value, "Renamed elsewhere");
});
