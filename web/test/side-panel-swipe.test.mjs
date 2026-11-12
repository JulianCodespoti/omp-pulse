import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
  import { createElement as h, act, useState } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { SidePanel } from ${JSON.stringify(resolve(root, "web/src/app/nav/SidePanel.tsx"))};
  const changes = [];
  function Harness() {
    const [open, setOpen] = useState(false);
    const [row, setRow] = useState(0);
    window.fixture.replaceRow = () => setRow((n) => n + 1);
    return h("div", null,
      h("p", { key: row, "data-testid": "row" }, "streaming row " + row),
      h(SidePanel, { open, onOpenChange: (next) => { changes.push(next); setOpen(next); }, label: "Workspace", swipeOpen: true, side: "right", testId: "panel", keepMounted: window.fixture.keepMounted === true }, h("p", null, "panel body")));
  }
  window.fixture = { act, changes, mount: () => { const r = createRoot(document.getElementById('root')); r.render(h(Harness)); return { unmount: () => r.unmount() }; } };
`);

function touchEvent(w, type, x) {
  const event = new w.Event(type, { bubbles: true });
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [{ clientX: x, clientY: 300 }] });
  return event;
}

test("a swipe whose start row is replaced mid-drag still opens the drawer fully", async (t) => {
  const dom = createDomFixture(code), w = dom.window, { act, changes } = w.fixture;
  Object.defineProperty(w, "innerWidth", { configurable: true, value: 400 });
  w.requestAnimationFrame = (fn) => w.setTimeout(() => fn(w.performance.now()), 0);
  let mounted;
  await act(async () => { mounted = w.fixture.mount(); });
  t.after(async () => { await act(async () => mounted.unmount()); dom.close(); });
  const row = w.document.querySelector('[data-testid="row"]');
  await act(async () => { row.dispatchEvent(touchEvent(w, "touchstart", 380)); });
  await act(async () => { row.dispatchEvent(touchEvent(w, "touchmove", 340)); row.dispatchEvent(touchEvent(w, "touchmove", 300)); });
  assert.deepEqual(Array.from(changes), [true], "the claimed swipe opens the drawer");
  // A live turn re-renders the row under the finger: the original node leaves the DOM.
  await act(async () => { w.fixture.replaceRow(); });
  assert.equal(row.isConnected, false);
  await act(async () => { row.dispatchEvent(touchEvent(w, "touchmove", 120)); row.dispatchEvent(touchEvent(w, "touchend", 120)); });
  await act(async () => { await new Promise((r) => w.setTimeout(r, 500)); });
  const panel = w.document.querySelector('[data-testid="panel"]');
  assert.ok(panel, "drawer stays open");
  assert.equal(panel.style.translate, "", "the drawer settled at rest, not frozen part-way");
  assert.deepEqual(Array.from(changes), [true]);
});

test("release springs from the finger's position to the anchor and hands back to the class list", async (t) => {
  const dom = createDomFixture(code), w = dom.window, { act, changes } = w.fixture;
  Object.defineProperty(w, "innerWidth", { configurable: true, value: 400 });
  w.requestAnimationFrame = (fn) => w.setTimeout(() => fn(w.performance.now()), 0);
  const runs = [];
  w.HTMLElement.prototype.animate = function (frames, options) {
    const run = { el: this, frames, options, cancelled: false, cancel() { this.cancelled = true; } };
    runs.push(run);
    return run;
  };
  let mounted;
  await act(async () => { mounted = w.fixture.mount(); });
  t.after(async () => { await act(async () => mounted.unmount()); dom.close(); });
  const row = w.document.querySelector('[data-testid="row"]');
  await act(async () => { row.dispatchEvent(touchEvent(w, "touchstart", 380)); });
  await act(async () => { row.dispatchEvent(touchEvent(w, "touchmove", 340)); row.dispatchEvent(touchEvent(w, "touchmove", 120)); });
  await act(async () => { row.dispatchEvent(touchEvent(w, "touchend", 120)); });
  const panel = w.document.querySelector('[data-testid="panel"]');
  const spring = runs.find((run) => run.el === panel);
  assert.ok(spring, "the panel springs on release");
  const frames = Array.from(spring.frames);
  assert.equal(frames[0].translate, "95px 0", "from where the finger left it");
  assert.equal(frames[frames.length - 1].translate, "0px 0", "to the open anchor");
  assert.equal(frames[frames.length - 1].offset, 1);
  assert.ok(spring.options.duration < 400, "settles fast");
  assert.ok(runs.some((run) => run.el !== panel), "the scrim shares the spring");
  assert.equal(panel.style.translate, "95px 0", "held at the finger's position until the first frame");
  await act(async () => { spring.onfinish(); });
  assert.equal(panel.style.translate, "", "rest position belongs to the class list again");
  assert.ok(spring.cancelled, "the fill-forwards animation is released");
  assert.deepEqual(Array.from(changes), [true]);
});

async function mountKeptDrawer(t) {
  const dom = createDomFixture(code), w = dom.window, { act, changes } = w.fixture;
  Object.defineProperty(w, "innerWidth", { configurable: true, value: 400 });
  w.requestAnimationFrame = (fn) => w.setTimeout(() => fn(w.performance.now()), 0);
  const runs = [];
  w.HTMLElement.prototype.animate = function (frames, options) {
    const run = { el: this, frames, options, cancelled: false, cancel() { this.cancelled = true; } };
    runs.push(run);
    return run;
  };
  let clock = 0;
  w.performance.now = () => clock;
  w.fixture.keepMounted = true;
  let mounted;
  await act(async () => { mounted = w.fixture.mount(); });
  t.after(async () => { await act(async () => mounted.unmount()); dom.close(); });
  const wait = (ms) => act(async () => { await new Promise((r) => w.setTimeout(r, ms)); });
  const touch = (type, x) => act(async () => { w.document.querySelector('[data-testid="row"]').dispatchEvent(touchEvent(w, type, x)); });
  return { w, act, changes, runs, wait, touch, advance: (ms) => { clock += ms; } };
}

test("a swipe-open on a mounted drawer commits nothing to React until release", async (t) => {
  const { w, changes, runs, wait, touch } = await mountKeptDrawer(t);
  const panel = w.document.querySelector('[data-testid="panel"]');
  const scrim = w.document.querySelector('[role="presentation"]');
  assert.equal(panel.hidden, true, "closed and kept mounted: hidden");
  await touch("touchstart", 380);
  await touch("touchmove", 340);
  await touch("touchmove", 120);
  await wait(20);
  assert.deepEqual(Array.from(changes), [], "claiming the swipe does not commit an open");
  assert.equal(panel.hidden, false, "the drag shows the popup itself");
  assert.equal(scrim.hidden, false);
  assert.equal(panel.style.translate, "95px 0", "and moves it with the finger");
  await touch("touchend", 120);
  assert.ok(runs.some((run) => run.el === panel), "release starts the spring");
  assert.deepEqual(Array.from(changes), [], "the open commits a frame after the spring starts, not in the touchend");
  await wait(50);
  assert.deepEqual(Array.from(changes), [true]);
  const spring = runs.find((run) => run.el === panel);
  await w.fixture.act(async () => { spring.onfinish(); });
  assert.equal(panel.style.translate, "", "rest position belongs to the class list again");
  assert.equal(panel.hidden, false);
});

test("a swipe-open that falls back closed never reaches React and hides the popup again", async (t) => {
  const { w, act, changes, runs, wait, touch, advance } = await mountKeptDrawer(t);
  const panel = w.document.querySelector('[data-testid="panel"]');
  const scrim = w.document.querySelector('[role="presentation"]');
  await touch("touchstart", 380);
  await touch("touchmove", 350);
  await touch("touchmove", 340);
  advance(500); // the finger rested: no release velocity, and short of half the width
  await touch("touchend", 340);
  const spring = runs.find((run) => run.el === panel);
  assert.ok(spring, "springs back closed");
  assert.equal(panel.hidden, false, "visible while it springs");
  await act(async () => { spring.onfinish(); });
  assert.equal(panel.hidden, true);
  assert.equal(scrim.hidden, true);
  assert.equal(panel.style.translate, "");
  await wait(50);
  assert.deepEqual(Array.from(changes), []);
});
