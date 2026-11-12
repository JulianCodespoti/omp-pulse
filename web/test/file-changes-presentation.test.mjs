import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const require = createRequire(resolve(root, "web/package.json"));
const code = await bundleDomFixture(`
  import { createElement, act } from ${JSON.stringify(require.resolve("react"))};
  import { createRoot } from ${JSON.stringify(require.resolve("react-dom/client"))};
  import { EditSummary } from ${JSON.stringify(resolve(root, "web/src/app/parts/EditSummary.tsx"))};
  window.fixture = { act, notices: [], mount: messages => {
    const r = createRoot(document.getElementById('root'));
    r.render(createElement(EditSummary, {messages})); return r;
  } };
`, [{ name: "notice-sink",
  resolveId: (id, importer) => id === '@/app/Notices' || (importer?.endsWith('/CopyButton.tsx') && id === '../Notices') ? '\0notices' : null,
  load: id => id === '\0notices' ? 'export const showToast = (...args) => window.fixture.notices.push(args)' : null,
}]);

const edit = (id, path, added = 2, removed = 1, extra = {}) => ({ kind: 'tool', name: 'edit', callId: id,
  args: {}, state: 'ok', edits: [{ path, added, removed, diff: '@@ -1 +1 @@\n-old\n+new', ...extra }] });
// What a sighted reader sees: counts and line prefixes also carry sr-only words.
const visible = el => { const c = el.cloneNode(true); for (const s of c.querySelectorAll('.sr-only')) s.remove(); return c.textContent; };
async function fixture(t, parts = [edit('a', 'src/send.ts', 18, 4), edit('b', 'src/use-draft.ts', 6, 2)]) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture, copies = [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => copies.push(text) } });
  let mounted; await act(async () => { mounted = w.fixture.mount([{id:'m1',role:'assistant',text:'',parts}]); });
  t.after(async () => { try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  // Opening shows the diffs in place; "Show all" opens the reader sheet (a Base UI portal on body).
  const el = id => w.document.querySelector(`[data-testid="${id}"]`);
  const all = sel => [...w.document.querySelectorAll(sel)];
  const click = async target => { const node = typeof target === 'string' ? el(target) : target; assert.ok(node, String(target)); await act(async () => { node.click(); await Promise.resolve(); }); };
  const open = () => click('edit-summary-toggle');
  return { w, el, all, act, copies, click, open };
}

const long = n => '@@ -1,' + n + ' +1,' + n + ' @@\n' + Array.from({ length: n }, (_, i) => `-old ${i}\n+new ${i}`).join('\n');

test('empty and failed edits do not invent a successful change summary', async t => {
  const failed = {...edit('failed','src/failed.ts',0,0,{error:'Write refused',diff:''}),state:'error'};
  const f = await fixture(t, [failed]); assert.equal(Boolean(f.el('edit-summary')), false);
  const unmarked = {...edit('failed','src/failed.ts'),state:'error'};
  const g = await fixture(t, [unmarked]); assert.equal(Boolean(g.el('edit-summary')), false);
});

test('a failed batch still summarises the files that landed', async t => {
  const batch = { ...edit('batch', 'src/landed.ts', 3, 1), state: 'error', edits: [edit('x', 'src/landed.ts', 3, 1).edits[0], { path: 'src/refused.ts', added: 0, removed: 0, diff: '', truncated: false, error: 'Write refused' }] };
  const f = await fixture(t, [batch]);
  assert.match(visible(f.el('edit-summary-toggle')), /Edited 1 file\+3 −1/);
});

test('summary is one row with exact totals that discloses its diffs', async t => {
  const f = await fixture(t), button = f.el('edit-summary-toggle');
  assert.equal(button.type, 'button');
  assert.equal(visible(button), 'Edited 2 files+24 −6');
  assert.match(button.getAttribute('aria-label'), /^Show edits: 2 files, 24 added, 6 removed/);
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(Boolean(f.el('edit-summary-files')), false, 'nothing renders until the first tap');
  await f.open();
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.match(button.getAttribute('aria-label'), /^Hide edits/);
  assert.equal(Boolean(f.el('edit-summary-sheet')), false, 'the diffs open in place, not in a sheet');
  await f.open();
  assert.equal(Boolean(f.el('edit-summary-files')), false, 'a second tap folds them');
});

test('tapping the row shows every file diff in place, one toolbar and a total', async t => {
  const f = await fixture(t); await f.open();
  const body = f.el('edit-summary-files'); assert.ok(body);
  const files = f.all('[data-testid="edited-file"]');
  assert.deepEqual(files.map(s => s.getAttribute('aria-label')), ['src/send.ts', 'src/use-draft.ts']);
  assert.match(visible(files[0]), /^src\/send\.ts\+18 −4/); assert.match(visible(files[1]), /^src\/use-draft\.ts\+6 −2/);
  for (const file of files) {
    const diff = file.querySelector('[data-testid="edited-file-diff"]');
    assert.deepEqual([...diff.querySelectorAll('[data-testid="diff-line-content"]')].map(visible), ['@@ -1 +1 @@', 'old', 'new']);
  }
  // One toolbar for every file, not one per file.
  assert.equal(body.querySelectorAll('button[aria-label="Wrap lines"]').length, 1);
  assert.equal(body.querySelectorAll('button[aria-label="Copy all diffs"]').length, 1);
  assert.equal(body.querySelectorAll('button[aria-label="Copy diff"]').length, 0);
  assert.equal(Boolean(f.el('path-chip')), false); assert.equal(Boolean(f.el('edited-file-toggle')), false);
  assert.equal(visible(f.el('edit-summary-total')), '2 files · +24 −6');
  assert.match(f.el('edit-summary-total').textContent, /24 added, 6 removed/);
  assert.equal(Boolean(f.el('show-all')), false, 'short diffs need no reader');
});

test('the wrap toggle is one switch for every diff and copy takes every recorded diff', async t => {
  const f = await fixture(t, [edit('a','src/a.ts',1,1,{diff:'@@ -1 +1 @@\n-a\n+A'}), edit('b','src/b.ts',1,1,{diff:'@@ -2 +2 @@\n-b\n+B'}), edit('c','src/c.ts',1,0,{diff:''})]);
  await f.open();
  const wrap = f.el('edit-summary-files').querySelector('button[aria-label="Wrap lines"]');
  assert.equal(wrap.getAttribute('aria-pressed'), 'false');
  await f.click(wrap);
  assert.equal(wrap.getAttribute('aria-pressed'), 'true');
  assert.equal(f.all('[data-testid="diff-lines"]').length, 2);
  await f.click(f.el('edit-summary-files').querySelector('button[aria-label="Copy all diffs"]'));
  // Empty diffs contribute nothing; the copied text is the exact recorded patches.
  assert.deepEqual(f.copies, ['@@ -1 +1 @@\n-a\n+A\n@@ -2 +2 @@\n-b\n+B']);
});

test('a long diff is cut in the transcript and Show all reads it whole in a sheet', async t => {
  const diff = long(30);
  const f = await fixture(t, [edit('a','src/long.ts',30,30,{diff})]);
  await f.open();
  await f.click('show-all');
  const sheet = f.el('edit-summary-sheet'); assert.ok(sheet, 'the reader sheet opened');
  assert.equal(sheet.querySelectorAll('[data-testid="diff-line"]').length, 61, 'the reader holds every line');
  assert.equal(Boolean(sheet.querySelector('[data-testid="show-all"]')), false, 'the reader is not cut');
  await f.click(sheet.querySelector('button[aria-label="Copy all diffs"]'));
  assert.deepEqual(f.copies, [diff]);
});

test('repeated edits stay grouped and duplicate call identities do not inflate counts', async t => {
  const first = edit('a','src/same.ts',2,1), second = edit('b','src/same.ts',4,3);
  const f = await fixture(t,[first,second,first]);
  assert.match(f.el('edit-summary-toggle').getAttribute('aria-label'), /1 file, 6 added, 4 removed/);
  await f.open();
  const files = f.all('[data-testid="edited-file"]'); assert.equal(files.length, 1);
  assert.equal(files[0].querySelectorAll('[role="region"][aria-label="Code diff"]').length, 2);
  assert.equal(visible(f.el('edit-summary-total')), '1 file · +6 −4');
});

test('missing and truncated diffs retain their explanations while counts stay exact', async t => {
  const f = await fixture(t,[edit('a','src/same.ts',2,1,{diff:''}),edit('b','src/same.ts',40,9,{truncated:true})]);
  await f.open();
  const diff = f.el('edited-file-diff');
  assert.match(diff.textContent,/No diff was recorded for this change\./);
  assert.match(diff.textContent,/Diff shortened; the counts cover the whole change\./);
  // The shortened diff shows one added line, but the header and total keep the recorded counts.
  assert.match(visible(f.el('edited-file')), /^src\/same\.ts\+42 −10/);
  assert.equal(visible(f.el('edit-summary-total')), '1 file · +42 −10');
});

test('long paths keep the full identity in the file header', async t => {
  const path = 'src/nested/' + 'long-name-'.repeat(20) + '.ts';
  const f = await fixture(t,[edit('a',path)]); await f.open();
  const file = f.el('edited-file'); assert.equal(file.getAttribute('aria-label'), path);
  const header = file.querySelector(`[title="${path}"]`); assert.ok(header, 'full path title');
  assert.equal(header.textContent, path);
});
