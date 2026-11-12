import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
  import { createElement as h, act, useState } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { ModelMentionPicker, useModelMentionEntries } from ${JSON.stringify(resolve(root, "web/src/app/composer/ModelMentionPicker.tsx"))};
  import { modelMentionAtCaret, applyModelMention } from ${JSON.stringify(resolve(root, "web/src/domain/model-mention.ts"))};
  const requests = [], mutations = [];
  const api = {
    getModelMentionChoices(path) {
      return new Promise((resolve, reject) => requests.push({path, resolve, reject}));
    },
    setModel(...args) { mutations.push(args); throw new Error('mention must not switch model'); },
    getAvailableModels() { throw new Error('unscoped model catalogue must not be used'); },
  };
  let update;
  function App() {
    const [config, setConfig] = useState({sessionPath:'/one', text:'^', caret:1, selected:0});
    update = patch => setConfig(current => ({...current, ...patch}));
    const token = modelMentionAtCaret(config.text, config.caret);
    const entries = useModelMentionEntries(api, config.sessionPath, token);
    return h('main', {},
      h('textarea', {'aria-label':'Prompt', value:config.text, readOnly:true}),
      h('output', {'data-testid':'status'}, entries === null ? 'pending' : entries.length ? 'ready' : 'empty'),
      h(ModelMentionPicker, {entries:entries ?? [], selected:config.selected, id:'models',
        onPick:entry => setConfig(current => ({...current, ...applyModelMention(current.text, token, entry)}))}),
      h('output', {'data-testid':'caret'}, String(config.caret)));
  }
  window.fixture = {act, requests, mutations, update:patch => update(patch), mount() {
    const mounted = createRoot(document.getElementById('root'));
    mounted.render(h(App)); return mounted;
  }};
`);

async function fixture(t) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  let mounted;
  await act(async () => { mounted = w.fixture.mount(); });
  t.after(async () => {
    try {
      await act(async () => mounted.unmount());
      assert.deepEqual(dom.blocked, []);
      assert.equal(w.fixture.mutations.length, 0);
    } finally { dom.close(); }
  });
  return {
    w, act, requests: w.fixture.requests,
    update: (patch) => act(async () => w.fixture.update(patch)),
    resolve: (index, entries) => act(async () => w.fixture.requests[index].resolve(entries)),
    reject: (index) => act(async () => w.fixture.requests[index].reject(new Error("unavailable"))),
    rows: () => Array.from(w.document.querySelectorAll('[role="option"]')),
    status: () => w.document.querySelector('[data-testid="status"]').textContent,
    text: () => w.document.querySelector("textarea").value,
  };
}
const model = (selector, name = selector) => ({ selector, name, provider: selector.split("/")[0] });

// Real React hook/effects/filter/replacement and DOM events over deferred owner
// queries. No browser layout or live model execution is claimed by this fixture.
test("available choices are accessible and selection changes only the prompt", async t => {
  const f = await fixture(t);
  await f.resolve(0, [model("Provider/Claude@EU:high", "Claude"), model("Other/Gemini", "Gemini")]);
  const list = f.w.document.querySelector('[role="listbox"]');
  assert.equal(list.getAttribute("aria-label"), "Models");
  assert.deepEqual(f.rows().map(row => row.getAttribute("aria-selected")), ["true", "false"]);
  await f.update({ selected: 1 });
  assert.deepEqual(f.rows().map(row => row.getAttribute("aria-selected")), ["false", "true"]);
  assert.equal(f.rows()[1].id, "models-1");
  const input = f.w.document.querySelector("textarea");
  input.focus();
  const pointer = new f.w.Event("pointerdown", { bubbles: true, cancelable: true });
  f.rows()[0].dispatchEvent(pointer);
  assert.equal(pointer.defaultPrevented, true);
  assert.equal(f.w.document.activeElement === input, true);
  assert.equal(f.rows()[0].type, "button");
  await f.act(async () => f.rows()[0].click());
  assert.equal(f.text(), "^Provider/Claude@EU:high ");
  assert.equal(f.w.document.querySelector('[data-testid="caret"]').textContent, String(f.text().length));
  assert.equal(f.rows().length, 0);
});

test("a middle-token pick keeps suffix text and exact quoted routed identifier", async t => {
  const f = await fixture(t);
  await f.update({ text: "compare ^olddraft and explain", caret: 11 });
  await f.resolve(1, [model('Local/old"Quoted"@route', "Old quoted")]);
  await f.act(async () => f.rows()[0].click());
  assert.equal(f.text(), 'compare ^Local/old"Quoted"@route and explain');
  const caret = Number(f.w.document.querySelector('[data-testid="caret"]').textContent);
  assert.equal(f.text().slice(caret), "and explain");
});

test("typing filters case-insensitively without inventing aliases or invalid selectors", async t => {
  const f = await fixture(t);
  await f.update({ text: "^cLaU", caret: 5 });
  await f.resolve(1, [model("P/Claude"), model("Q/Gemini"), model("P/Claude Bad"), model("P/Claude^Bad")]);
  assert.deepEqual(f.rows().map(row => row.textContent), ["P/ClaudeP/Claude"]);
  await f.update({ text: "^missing", caret: 8 });
  assert.equal(f.rows().length, 0);
  await f.resolve(2, [model("P/Claude")]);
  assert.equal(f.status(), "empty");
  assert.equal(f.rows().length, 0);
});

test("session changes hide old choices immediately and reject late completions", async t => {
  const f = await fixture(t);
  await f.resolve(0, [model("Old/Visible")]);
  assert.equal(f.rows().length, 1);
  await f.update({ sessionPath: "/two" });
  assert.equal(f.rows().length, 0);
  assert.equal(f.status(), "pending");
  await f.update({ sessionPath: "/three" });
  await f.resolve(2, [model("New/Scoped")]);
  await f.resolve(1, [model("Wrong/Scope")]);
  assert.deepEqual(f.rows().map(row => row.textContent), ["New/ScopedNew/Scoped"]);
  assert.deepEqual(Array.from(f.requests, request => request.path), ["/one", "/two", "/three"]);
});

test("query and token-position changes fence late successes and failures", async t => {
  const f = await fixture(t);
  await f.update({ text: "^cla", caret: 4 });
  await f.update({ text: "now ^gem", caret: 8 });
  await f.resolve(2, [model("P/Gemini"), model("P/Claude")]);
  await f.resolve(0, [model("Wrong/Old")]);
  await f.reject(1);
  assert.deepEqual(f.rows().map(row => row.textContent), ["P/GeminiP/Gemini"]);
});

test("closed picker ignores pending results and reopening re-queries live availability", async t => {
  const f = await fixture(t);
  await f.update({ text: "plain", caret: 5 });
  await f.resolve(0, [model("Stale/Model")]);
  assert.equal(f.rows().length, 0);
  await f.update({ text: "^", caret: 1 });
  assert.equal(f.status(), "pending");
  await f.resolve(1, []);
  assert.equal(f.status(), "empty");
  assert.equal(f.rows().length, 0);
});

test("unavailable authoritative scope stays empty, never uses switcher defaults", async t => {
  const f = await fixture(t);
  await f.reject(0);
  assert.equal(f.status(), "empty");
  assert.equal(f.rows().length, 0);
  await f.update({ sessionPath: null });
  assert.equal(f.requests.length, 1);
  assert.equal(f.rows().length, 0);
});

test("unmounted picker abandons its unresolved owner query", async () => {
  const dom = createDomFixture(code), { act, requests } = dom.window.fixture;
  try {
    let mounted;
    await act(async () => { mounted = dom.window.fixture.mount(); });
    await act(async () => mounted.unmount());
    await act(async () => requests[0].resolve([model("Late/Model")]));
    assert.equal(dom.window.document.querySelectorAll('[role="option"]').length, 0);
    assert.deepEqual(dom.blocked, []);
  } finally { dom.close(); }
});
