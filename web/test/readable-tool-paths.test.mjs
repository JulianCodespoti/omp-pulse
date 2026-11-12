import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// The real ToolPart: its 32px row carries "<verb> <dir>/<file>:<range>" and a
// tap opens the call's detail in place, whose path line is the exact original path.
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
  import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
  import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
  import { ToolPart } from ${JSON.stringify(resolve(root, 'web/src/app/parts/ToolPart.tsx'))};
  let r;
  const render = (part, live = false) => r.render(h(ToolPart, { part, live }));
  window.fixture = { act, render, mount: (...args) => { r = createRoot(document.getElementById('root')); render(...args); return r; } };
`);

const file = (overrides = {}) => ({ kind: 'tool', callId: 'synthetic-call', name: 'read', state: 'ok', args: { path: '/workspace/src/demo.ts' }, output: 'first\nsecond\n', ...overrides });
const diff = '@@ -1,2 +1,2 @@\n-old\n+new\n context\n';
async function fixture(t, part, live = false) {
  const dom = createDomFixture(code), w = dom.window, { act, render } = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  w.HTMLElement.prototype.scrollTo = () => {};
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const writes = [];
  Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async text => { writes.push(text); } } });
  let mounted;
  await act(async () => { mounted = w.fixture.mount(part, live); });
  t.after(async () => { try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const d = w.document;
  const row = () => d.querySelector('[data-testid="tool-part"] > button[data-testid="tool-row"]');
  // The detail opens in a portalled sheet.
  const sheet = () => d.querySelector('[data-testid="tool-sheet"]');
  const settle = () => act(async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); });
  return {
    w, d, act, writes, row, sheet,
    render: (next, nextLive = live) => act(async () => render(next, nextLive)),
    description: () => sheet()?.querySelector('[data-testid="tool-path"]') ?? null,
    open: async () => {
      await act(async () => row().click()); await settle();
      assert.ok(sheet(), 'detail opened in the sheet');
    },
    close: async () => {
      await act(async () => { d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }); await settle();
      await act(async () => { await new Promise(r => setTimeout(r, 400)); });
      assert.equal(sheet(), null, 'detail closed');
    },
    button: label => sheet() && [...sheet().querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label),
  };
}

const longName = `${'long-name-'.repeat(12)}👩🏽‍💻e\u0301.tsx`;
// [case, raw path, visible "dir/file" target]: only the immediate parent is
// shown; roots keep their spelling; the sheet always holds the full path.
for (const [name, path, target] of [
  ['POSIX', '/workspace/omp-pulse/web/src/app/composer/Composer.tsx', 'composer/Composer.tsx'],
  ['Windows', String.raw`C:\workspace\web\src\Composer.tsx`, 'src/Composer.tsx'],
  ['UNC', String.raw`\\server\share\components\Composer.tsx`, 'components/Composer.tsx'],
  ['mixed separators', String.raw`C:\workspace/web\src/Composer.tsx`, 'src/Composer.tsx'],
  ['bare filename', 'Composer.tsx', 'Composer.tsx'],
  ['dotfile', '/workspace/.env.local', 'workspace/.env.local'],
  ['bare dot', '.', '.'],
  ['bare dot-dot', '..', '..'],
  ['dot-relative', './Composer.tsx', './Composer.tsx'],
  ['dot-dot-relative', '../Composer.tsx', '../Composer.tsx'],
  ['unresolved segments', '/a/../src/Composer.tsx', 'src/Composer.tsx'],
  ['Unicode', '/工作区/组件/👩🏽‍💻-re\u0301sume\u0301.tsx', '组件/👩🏽‍💻-re\u0301sume\u0301.tsx'],
  ['long filename', `/workspace/components/${longName}`, `components/${longName}`],
  ['long parent', `/workspace/${'directory'.repeat(20)}/file.ts`, `${'directory'.repeat(20)}/file.ts`],
  ['whitespace', ' /parent name/ file name.ts ', 'parent name/ file name.ts '],
  ['root child', '/file.ts', 'file.ts'],
  ['drive-root child', String.raw`C:\file.ts`, 'C:/file.ts'],
  ['UNC share child', String.raw`\\server\share\file.ts`, 'share/file.ts'],
  ['repeated separators', '/workspace//file.ts', 'file.ts'],
]) {
  test(`${name}: row reads "Read dir/file:range" and the detail keeps the full path`, async t => {
    const f = await fixture(t, file({ args: { path, start: 67, end: 79, title: 'Unrelated argument title' } }));
    assert.equal(f.row().textContent, `Read ${target}:67-79`);
    assert.equal(f.row().dataset.state, 'ok');
    assert.equal(f.sheet(), null, 'sheet mounts only when opened');
    await f.open();
    assert.equal(f.description().textContent, path);
    assert.equal(f.description().getAttribute('title'), path);
  });
}

for (const path of ['/', '\\', 'C:\\', '\\\\server\\share\\', '/workspace/components/', 'relative\\', '////', String.raw`\\server\share`, '//server/share', String.raw`\\server`]) {
  test(`root/trailing separator ${JSON.stringify(path)} falls back to the exact raw path`, async t => {
    const f = await fixture(t, file({ args: { path, range: '9-11' } }));
    assert.equal(f.row().textContent, `Read ${path}:9-11`, 'no invented basename or parent');
    await f.open();
    assert.equal(f.description().textContent, path);
  });
}

for (const key of ['path', 'file', 'file_path', 'filename']) {
  test(`${key} path alias retains the target despite an argument title`, async t => {
    const f = await fixture(t, file({ args: { [key]: '/workspace/src/file.ts', title: 'Describe this file' } }));
    assert.equal(f.row().textContent, 'Read src/file.ts');
    await f.open(); assert.equal(f.description().textContent, '/workspace/src/file.ts');
  });
}
for (const key of ['input', 'content', 'patch']) {
  test(`hashline target in ${key} gets a dir/file label and the exact path in the sheet`, async t => {
    const path = String.raw`C:\workspace\组件\file.ts`;
    const part = file({ name: 'edit', args: { [key]: `\n[${path}#A1b2]\n-1: old\n+1: new`, title: 'Do not use this title' }, output: diff });
    const f = await fixture(t, part);
    assert.equal(f.row().textContent, 'Edited 组件/file.ts');
    await f.open(); assert.equal(f.description().textContent, path);
  });
}
test('direct path remains authoritative over a hashline target', async t => {
  const f = await fixture(t, file({ args: { path: '/direct/src/file.ts', input: '[other/path.ts#ABCD]' } }));
  assert.equal(f.row().textContent, 'Read src/file.ts');
  await f.open(); assert.equal(f.description().textContent, '/direct/src/file.ts');
});

for (const [name, state, verb, suffix = ''] of [
  ['read', 'running', 'Reading', 'Running'], ['read', 'ok', 'Read'], ['READ', 'ok', 'Read'],
  ['write', 'running', 'Writing', 'Running'], ['write', 'ok', 'Wrote'],
  ['edit', 'running', 'Editing', 'Running'], ['edit', 'ok', 'Edited'],
  ['hashline', 'ok', 'Edited'], ['apply_patch', 'ok', 'Edited'], ['read', 'error', 'Read', 'firstFailed'],
]) {
  test(`${name}/${state} reads "${verb} src/demo.ts"`, async t => {
    // Running is only claimed while the turn is live.
    const f = await fixture(t, file({ name, state }), state === 'running');
    // Running announces itself (sr-only); failure trails "Failed".
    assert.equal(f.row().textContent, `${verb} src/demo.ts${suffix}`);
    assert.equal(f.row().dataset.state, state);
  });
}
for (const [args, range] of [
  [{ range: ' 67-79 ' }, '67-79'], [{ selection: '67:79' }, '67:79'],
  [{ lineRange: '67–79' }, '67–79'], [{ lines: '67,79' }, '67,79'],
  [{ start: 67, end: 79 }, '67-79'], [{ offset: 67, limit: 12 }, '67-79'],
  [{ line: 67 }, '67'], [{ start: '67' }, '67'],
]) {
  test(`range ${JSON.stringify(args)} follows the file in row and detail`, async t => {
    const f = await fixture(t, file({ args: { path: '/workspace/src/file.ts', ...args } }));
    assert.equal(f.row().textContent, `Read src/file.ts:${range}`);
    await f.open();
    assert.equal(f.description().textContent, '/workspace/src/file.ts');
  });
}

test('intent replaces verb and target on the row; the detail keeps the path', async t => {
  const intent = '  Check the complete target\nwithout replacing this intent  ';
  const f = await fixture(t, file({ intent, args: { path: '/workspace/src/file.ts', range: '67-79' } }));
  // A 32px row holds the intent's first line only; gluing the target after it pushed both off the row.
  assert.equal(f.row().textContent, 'Check the complete target');
  await f.open(); assert.equal(f.description().textContent, '/workspace/src/file.ts');
});
test('whitespace-only intent keeps the file label fallback', async t => {
  const f = await fixture(t, file({ intent: ' \n ' }));
  assert.equal(f.row().textContent, 'Read src/demo.ts');
});
for (const [args, expected] of [
  // Nothing to name: the verb stands alone rather than echoing the tool's own name.
  [{}, 'Read'],
  [{ title: 'Existing summary', range: '7' }, 'Read Existing summary:7'],
  [{ path: '', title: 'Existing title' }, 'Read Existing title'],
  [{ title: 'x'.repeat(100) }, `Read ${'x'.repeat(100)}`],
  [{ description: 'x'.repeat(100) }, `Read ${'x'.repeat(64)}…`],
]) {
  test(`no-path fallback: ${expected.length > 40 ? `${expected.slice(0, 40)}…` : expected}`, async t => {
    const f = await fixture(t, file({ args }));
    assert.equal(f.row().textContent, expected);
    await f.open();
    assert.equal(f.description(), null, 'no path, no invented description');
  });
}

for (const [name, overrides] of [
  ['plain', {}], ['plain with range', { range: '67-79' }],
  ['diff', { output: diff }], ['diff with range', { output: diff, range: '67-79' }],
  ['empty', { output: '' }], ['empty with range', { output: '', range: '67-79' }],
  ['error', { output: 'Permission denied\n', state: 'error' }],
  ['pruned', { output: '', pruned: true }],
  ['pruned with range', { output: '', pruned: true, range: '67-79' }],
]) {
  test(`${name}: detail path keeps the original path across repeated opening`, async t => {
    const { range, ...partOverrides } = overrides;
    const path = String.raw`C:\unchanged\..\parent name` + '\\' + longName;
    const part = file({ ...partOverrides, args: { path, ...(range ? { range } : {}) } });
    const originalPart = JSON.stringify(part);
    const f = await fixture(t, part);
    for (let i = 0; i < 3; i++) {
      await f.open();
      const description = f.description();
      assert.ok(description, 'path exists independently of output');
      assert.equal(description.textContent, path);
      assert.equal(description.getAttribute('title'), path);
      const detail = f.sheet().querySelector('[data-testid="tool-detail"]');
      assert.ok(detail);
      if (part.pruned) assert.match(detail.textContent, /Output removed from the transcript to save space\./);
      assert.equal(detail.querySelectorAll('[data-testid="path-chip"]').length, 0, 'no path control was added');
      await f.close();
    }
    assert.equal(JSON.stringify(part), originalPart, 'presentation does not mutate transport data');
  });
}

test('detail path holds repeated spaces, tabs, newlines and Unicode exactly', async t => {
  const path = ' /工作区/parent  name/  👩🏽‍💻 re\u0301sume\u0301\tsecond\nline.ts  ';
  const f = await fixture(t, file({ args: { path }, output: '' }));
  assert.equal(f.row().textContent, 'Read parent  name/  👩🏽‍💻 re\u0301sume\u0301\tsecond\nline.ts  ');
  await f.open();
  assert.equal(f.description().textContent, path);
  assert.equal(f.description().getAttribute('title'), path);
});

for (const [name, output, label] of [
  ['plain', '  first\r\n\u001b[32mPASS\u001b[0m\n\nlast  \n', 'Copy output'],
  ['patch-looking read', diff, 'Copy output'],
]) {
  test(`${name}: repeated opening preserves exact original clipboard text`, async t => {
    const f = await fixture(t, file({ output, args: { path: '/workspace/src/file.ts', range: '67-79' } }));
    for (let i = 0; i < 2; i++) {
      await f.open();
      const copy = f.button(label);
      assert.ok(copy, `${label} (pass ${i}) among ${[...f.sheet().querySelectorAll('button')].map(b => b.getAttribute('aria-label') ?? b.textContent)}`);
      await f.act(async () => copy.click());
      assert.equal(copy.getAttribute('aria-label'), 'Copied');
      await f.close();
      // Reopening remounts the detail, so Copy starts fresh each time.
    }
    assert.deepEqual(f.writes, [output, output]);
  });
}

test('row is label + target: shimmer while live, failure and interruption trail it', async t => {
  const part = file({ state: 'running', startedAt: Date.now() - 2000 });
  const f = await fixture(t, part, true);
  const shimmer = () => f.row().querySelector('[data-shimmer]');
  assert.equal(f.row().dataset.state, 'running');
  assert.equal(shimmer()?.textContent, 'Reading');
  // Under 5s no duration is shown.
  assert.equal(f.row().querySelector('[data-testid="tool-duration"]'), null);
  await f.render({ ...part, state: 'ok' });
  assert.equal(shimmer(), null);
  assert.equal(f.row().textContent, 'Read src/demo.ts');
  await f.render({ ...part, state: 'error' });
  assert.equal(f.row().dataset.state, 'error');
  assert.equal(f.row().textContent, 'Read src/demo.tsfirstFailed');
  assert.equal(f.row().querySelector('[data-testid="tool-error-line"]').textContent, 'first');
  // A running call whose turn has ended is not "Running": it was interrupted,
  // and its face makes no tense claim either way ("File", not "Reading"/"Read").
  await f.render(part, false);
  assert.equal(f.row().dataset.state, 'interrupted');
  assert.equal(shimmer(), null);
  assert.equal(f.row().textContent, 'File src/demo.tsInterrupted');
});

test('a finished call shows no duration on its row (the sheet says "Took"); a live one of 5s+ ticks', async t => {
  const f = await fixture(t, file({ startedAt: 1_000_000, endedAt: 1_012_000 }));
  const duration = () => f.row().querySelector('[data-testid="tool-duration"]');
  assert.equal(duration(), null, 'a completed row carries no duration');
  await f.open();
  assert.match(f.sheet().textContent, /Took 12s/);
  await f.render(file({ state: 'running', startedAt: Date.now() - 7_000 }), true);
  assert.match(duration()?.getAttribute('aria-label') ?? '', /^Running for [78]s$/);
  await f.render(file({ state: 'running', startedAt: Date.now() - 7_000 }), false);
  assert.equal(duration(), null, 'an interrupted call claims no duration');
});
