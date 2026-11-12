import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const { compile } = require('@tailwindcss/node');
const code = await bundleDomFixture(`
  import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
  import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
  import { cn } from ${JSON.stringify(resolve(root, 'web/src/lib/utils.ts'))};
  import { BashTool } from ${JSON.stringify(resolve(root, 'web/src/app/parts/tools/BashTool.tsx'))};
  import { FileTool } from ${JSON.stringify(resolve(root, 'web/src/app/parts/tools/FileTool.tsx'))};
  import { ToolPart } from ${JSON.stringify(resolve(root, 'web/src/app/parts/ToolPart.tsx'))};
  import { DiffPart } from ${JSON.stringify(resolve(root, 'web/src/app/parts/DiffPart.tsx'))};
  window.fixture = { act, cn, mount(kind, text, extra, row) {
    const r = createRoot(document.getElementById('root'));
    const part = { kind:'tool', name:kind === 'bash' ? 'bash' : 'edit', callId:'synthetic',
      args:kind === 'bash' ? {command:'git diff -- src/demo.ts'} : {path:'src/demo.ts'},
      state:'ok', output:text, ...extra };
    // row: the transcript row that opens the call's detail in place; otherwise the detail on its own.
    r.render(kind === 'standalone' ? h(DiffPart, {text})
      : row ? h(ToolPart, {part, live:false})
      : kind === 'bash' ? h(BashTool, {part, live:false}) : h(FileTool, {part}));
    return r;
  }};
`, [{
  name: 'notice-sink',
  resolveId: id => id === '@/app/Notices' || id === '../Notices' ? '\0notices' : null,
  load: id => id === '\0notices' ? 'export const showToast = () => {};' : null,
}]);

const raw = 'diff --git a/demo.ts b/demo.ts\n--- a/demo.ts\n+++ b/demo.ts\n@@ -1,2 +1,2 @@\n-old\n+new λ\n context\n\\ No newline at end of file\n';
// Git's preamble is hidden (the header names the file); signs live in the gutter,
// so the content carries only the screen-reader prefix and the line text.
const expected = ['@@ -1,2 +1,2 @@', 'Removed: old', 'Added: new λ', 'context', '\\ No newline at end of file'];

// Absence as a boolean: a failing assert.equal on a DOM node would render the
// node's React fiber graph (see test-support/react-dom.mjs).
const none = (node, message) => assert.equal(node == null, true, message);

async function fixture(t, kind, output = raw, extra = {}, { row = false } = {}) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture, copies = [];
  w.Element.prototype.getAnimations = () => [];
  Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: async text => copies.push(text) } });
  let mounted;
  await act(async () => { mounted = w.fixture.mount(kind, output, extra, row); });
  t.after(async () => {
    try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  const card = () => w.document.querySelector('[data-testid="diff-part"]');
  const buttons = () => [...(card() ?? w.document).querySelectorAll('button')];
  return {
    w, act, copies, buttons, card,
    region: () => w.document.querySelector('[role="region"][aria-label="Code diff"]'),
    lines: () => [...w.document.querySelectorAll('[data-testid="diff-line"]')],
    contents: () => [...w.document.querySelectorAll('[data-testid="diff-line-content"]')].map(el => el.textContent),
    button: label => buttons().find(el => el.textContent === label || el.getAttribute('aria-label') === label),
    click: async label => act(async () => {
      const button = buttons().find(el => el.textContent === label || el.getAttribute('aria-label') === label);
      assert.ok(button, label); button.click();
    }),
  };
}

function assertCard(f, title) {
  assert.equal(f.w.document.querySelectorAll('[data-testid="diff-part"]').length, 1, 'one diff card');
  const card = f.card(), header = card.firstElementChild;
  for (const cls of ['rounded-lg', 'bg-surface-1', 'overflow-hidden']) assert.ok(card.classList.contains(cls), cls);
  for (const cls of ['border', 'shadow-sm']) assert.equal(card.classList.contains(cls), false, cls);
  assert.equal(header.firstElementChild.textContent, title);
  assert.match(header.textContent, /\+1 −1/);
  assert.equal(f.region().parentElement === card, true, 'lines sit directly in the card');
}

for (const kind of ['bash', 'file']) {
  test(`${kind} diff renders as one DiffPart card with code-sized lines and no left rails`, async t => {
    const f = await fixture(t, kind);
    assertCard(f, kind === 'file' ? 'src/demo.ts' : 'Changes');
    none(f.w.document.querySelector('[data-bash-output]'), 'diff replaces the mono reader');
    const lines = f.region().firstElementChild;
    for (const cls of ['font-mono', 'text-code']) assert.ok(lines.classList.contains(cls), cls);
    assert.deepEqual(f.lines().map(el => el.dataset.kind), ['hunk', 'del', 'add', 'context', 'context']);
    assert.ok(f.lines()[1].classList.contains('bg-danger/10'));
    assert.ok(f.lines()[2].classList.contains('bg-success/15'));
    for (const line of f.lines()) {
      assert.equal([...line.classList].some(cls => cls.startsWith('border-')), false, 'no left rail');
    }
    for (const index of [0, 3, 4]) {
      assert.equal([...f.lines()[index].classList].some(cls => cls.startsWith('bg-')), false, `line ${index} has no tint`);
    }
  });

  test(`${kind} diff hides git metadata and keeps sign gutters and the no-final-newline marker`, async t => {
    const f = await fixture(t, kind);
    assert.deepEqual(f.contents(), expected);
    assert.doesNotMatch(f.region().textContent, /diff --git|\+\+\+ b\/demo\.ts|--- a\/demo\.ts/);
    const gutters = f.lines().map(el => el.firstElementChild);
    assert.deepEqual(gutters.map(el => el.textContent), ['', '−', '+', '', '']);
    assert.ok(gutters.every(el => el.getAttribute('aria-hidden') === 'true'), 'signs are visual only');
    assert.equal(f.region().tabIndex, 0);
    f.region().focus(); assert.equal(f.w.document.activeElement === f.region(), true);
    assert.ok(f.region().classList.contains('overflow-x-auto'));
  });

  test(`${kind} diff wrap toggles preserve complete long lines`, async t => {
    const long = 'value'.repeat(800), f = await fixture(t, kind, raw + '+' + long);
    const before = f.contents(), wrap = f.button('Wrap lines'), copy = f.button('Copy diff');
    assert.equal(before.at(-1), `Added: ${long}`);
    for (const control of [wrap, copy]) assert.equal(control.getAttribute('data-size'), 'icon-sm', '32px header icon (44px hit area)');
    assert.equal(wrap.getAttribute('aria-pressed'), 'false');
    assert.ok(f.region().firstElementChild.classList.contains('min-w-max'));
    await f.click('Wrap lines');
    assert.equal(wrap.getAttribute('aria-pressed'), 'true'); assert.deepEqual(f.contents(), before);
    assert.ok(f.region().firstElementChild.classList.contains('min-w-0'));
    assert.equal(f.region().classList.contains('overflow-x-auto'), false, 'wrapped lines do not scroll sideways');
    assert.ok(f.lines().every(line => line.classList.contains('whitespace-pre-wrap')));
    await f.click('Wrap lines');
    assert.equal(wrap.getAttribute('aria-pressed'), 'false'); assert.deepEqual(f.contents(), before);
    assert.ok(f.region().classList.contains('overflow-x-auto'));
  });

  test(`${kind} diff copies full original bytes through the 200-line clamp and wrap changes`, async t => {
    const text = raw + Array.from({length: 250}, (_, i) => `+line ${i}`).join('\n') + '\n';
    const output = text;
    const f = await fixture(t, kind, output);
    // Copy relabels itself "Copied" for 1.2s, so hold the control, not its label.
    const copy = f.button('Copy diff'), copyDiff = () => f.act(async () => copy.click());
    assert.equal(f.contents().length, 200);
    await copyDiff();
    await f.click('Wrap lines'); await f.click('Show all (55 more lines)');
    assert.equal(f.contents().length, 255);
    assert.equal(f.contents().at(-1), 'Added: line 249');
    none(f.button('Show less'), 'a diff expands once; the sheet scrolls');
    await copyDiff();
    await f.click('Wrap lines'); assert.equal(f.contents().length, 255);
    await copyDiff();
    assert.deepEqual(f.copies, [text, text, text]);
  });

  test(`${kind} diff opens in the tool sheet from its row`, async t => {
    const f = await fixture(t, kind, raw, {}, { row: true });
    const row = f.w.document.querySelector('[data-testid="tool-row"]');
    none(f.card(), 'nothing renders until tapped');
    assert.equal(row.textContent, kind === 'file' ? 'Edited src/demo.ts' : 'Ran git diff -- src/demo.ts · 8 lines');
    await f.act(async () => row.click());
    const sheet = f.w.document.querySelector('[data-testid="tool-sheet"]');
    assert.ok(sheet, 'the sheet opened');
    assert.equal(sheet.contains(f.card()), true, 'the diff lives in the sheet');
    assert.deepEqual(f.contents(), expected);
    assert.equal(f.w.document.querySelectorAll('[data-testid="diff-part"]').length, 1);
  });

  test(`${kind} long diff in the sheet clamps at 200 lines and Show all expands in place`, async t => {
    const text = raw + Array.from({length: 250}, (_, i) => `+line ${i}`).join('\n') + '\n';
    const f = await fixture(t, kind, text, {}, { row: true });
    await f.act(async () => f.w.document.querySelector('[data-testid="tool-row"]').click());
    const sheet = f.w.document.querySelector('[data-testid="tool-sheet"]');
    assert.equal(sheet.querySelectorAll('[data-testid="diff-line"]').length, 200);
    await f.act(async () => { sheet.querySelector('[data-testid="show-all"]').click(); await Promise.resolve(); });
    assert.equal(sheet.querySelectorAll('[data-testid="diff-line"]').length, 255);
  });

  test(`${kind} failed diff-shaped output keeps the error presentation`, async t => {
    const f = await fixture(t, kind, raw, {state:'error', pruned:true});
    none(f.region());
    none(f.card());
    const pres = [...f.w.document.querySelectorAll('[data-bash-output]')];
    assert.equal(pres[0].textContent, 'diff --git a/demo.ts b/demo.ts\n');
    assert.ok(pres[0].classList.contains('text-danger'), 'the first line is the error');
    assert.equal(pres.map(pre => pre.textContent).join(''), raw);
    assert.ok(f.w.document.body.textContent.includes('Output removed from the transcript to save space.'));
    await f.click(kind === 'bash' ? 'Copy output' : 'Copy error');
    assert.deepEqual(f.copies, [raw]);
  });
}

test('file edit record renders its own diff with exact counts, truncation and empty-diff notes', async t => {
  const diff = '@@ -1 +1 @@\n-old\n+new\n';
  const f = await fixture(t, 'file', 'Edited.', { edits: [{ path: 'src/exact.ts', added: 12, removed: 3, diff, truncated: true }] });
  const header = f.card().firstElementChild;
  assert.equal(header.firstElementChild.textContent, 'src/exact.ts');
  assert.match(header.textContent, /\+12 −3/, 'counts cover the whole change, not the shortened diff');
  assert.match(f.card().textContent, /Diff shortened; the counts cover the whole change\./);
  none(f.w.document.querySelector('[data-bash-output]'), 'the edit replaces the tool text');
  await f.click('Copy diff'); assert.deepEqual(f.copies, [diff]);
  const empty = await fixture(t, 'file', 'Edited.', { edits: [{ path: 'src/exact.ts', added: 0, removed: 0, diff: '', truncated: false }] });
  none(empty.card());
  assert.match(empty.w.document.body.textContent, /No diff was recorded for this change\./);
});

test('standalone DiffPart is the same single card', async t => {
  const f = await fixture(t, 'standalone');
  assertCard(f, 'Changes');
  assert.deepEqual(f.contents(), expected);
  assert.ok(f.lines()[1].classList.contains('bg-danger/10'));
  assert.ok(f.lines()[2].classList.contains('bg-success/15'));
});

// Check compiled units and real cn behavior, not synthetic-DOM layout or zoom.
test('tool typography preserves rem font sizes through class merging', async t => {
  const dom = createDomFixture(code);
  t.after(() => { try { assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  for (const color of ['text-foreground', 'text-muted-foreground', 'text-danger', 'text-tertiary']) {
    for (const size of ['text-meta', 'text-code']) {
      for (const classes of [`${size} ${color}`, `${color} ${size}`]) {
        const merged = dom.window.fixture.cn(classes).split(/\s+/);
        for (const token of [size, color]) assert.ok(merged.includes(token), `${token} survives cn(${classes})`);
      }
    }
  }
  const compiler = await compile(readFileSync(resolve(root, 'web/src/styles.css'), 'utf8'), {
    base: resolve(root, 'web/src'), onDependency() {},
  });
  const css = compiler.build(['text-meta', 'text-code']);
  const meta = css.match(/\.text-meta\s*\{([^}]+)\}/)?.[1];
  const mono = css.match(/\.text-code\s*\{([^}]+)\}/)?.[1];
  assert.ok(meta && mono, 'both utilities are generated from the actual app stylesheet');
  assert.match(meta, /font-size:\s*0\.8125rem;/);
  assert.match(meta, /line-height:\s*var\(--tw-leading,\s*1\.125rem\);/);
  // Code size (Appearance) scales the rem base; it never becomes px.
  assert.match(mono, /font-size:\s*calc\(0\.75rem \* var\(--code-scale, 1\)\);/);
  assert.match(mono, /line-height:\s*var\(--tw-leading,\s*calc\(1\.125rem \* var\(--code-scale, 1\)\)\);/);
});
