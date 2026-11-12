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
  import { GenericTool } from ${JSON.stringify(resolve(root, 'web/src/app/parts/tools/GenericTool.tsx'))};
  import { ToolPart } from ${JSON.stringify(resolve(root, 'web/src/app/parts/ToolPart.tsx'))};
  let r;
  // row: the transcript row that opens the call's detail in place; otherwise the detail on its own.
  const render = (kind, part, { row = false, live = false } = {}) => r.render(row
    ? h(ToolPart, { part, live })
    : kind === 'bash' ? h(BashTool, { part, live }) : h(kind === 'generic' ? GenericTool : FileTool, { part }));
  window.fixture = { act, cn, render, mount: (...args) => { r = createRoot(document.getElementById('root')); render(...args); return r; } };
`, [{
  name: 'notice-sink',
  resolveId: (id, importer) =>
    (importer?.endsWith('/CopyButton.tsx') && id === '../Notices') ||
    (importer?.endsWith('/BashTool.tsx') && id === '@/app/Notices') ? '\0notices' : null,
  load: id => id === '\0notices' ? 'export const showToast=(...args)=>window.notices.push(args);' : null,
}]);

const bash = (overrides = {}) => ({ kind: 'tool', callId: 'synthetic-call', name: 'bash', state: 'ok', args: { command: 'npm test' }, output: 'test passed\n', ...overrides });
const file = (overrides = {}) => ({ kind: 'tool', callId: 'synthetic-call', name: 'read', state: 'ok', args: { path: 'src/demo.ts', start: 3, end: 5 }, output: 'first\nsecond\n', ...overrides });
// Absence as a boolean: a failing assert.equal on a DOM node would render the
// node's React fiber graph (see test-support/react-dom.mjs).
const none = (node, message) => assert.equal(node == null, true, message);
async function fixture(t, kind, part, options = {}) {
  const dom = createDomFixture(code), w = dom.window, { act, render } = w.fixture;
  const writes = [];
  w.notices = [];
  w.Element.prototype.getAnimations = () => [];
  Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async text => { writes.push(text); } } });
  let mounted;
  await act(async () => { mounted = w.fixture.mount(kind, part, options); });
  t.after(async () => { try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  // The row opens the call's ToolSheet (portalled, mounted on first tap).
  const sheet = () => w.document.querySelector('[data-testid="tool-sheet"]');
  const panel = () => sheet() ?? w.document.getElementById('root');
  const row = () => w.document.querySelector('[data-testid="tool-row"]');
  return {
    w, act, writes, sheet, panel, row,
    render: (next, opts = options) => act(async () => render(kind, next, opts)),
    open: () => act(async () => { assert.ok(row(), 'tool row'); row().click(); }),
    close: () => act(async () => { row().click(); }),
    region: () => panel().querySelector('[role="region"][aria-label="Output"]'),
    pres: () => [...panel().querySelectorAll('[data-bash-output]')],
    toolbar: () => panel().querySelector('[data-testid="tool-output"]')?.firstElementChild ?? null,
    showAll: () => [...panel().querySelectorAll('button')].find(b => b.textContent.startsWith('Show all')),
    button: label => [...panel().querySelectorAll('button')].find(b => b.getAttribute('aria-label') === label || b.textContent === label),
  };
}
// Progressive chunks each omit their joining newline; unchunked ranges (a failed
// call's danger-coloured first line, then the rest) are contiguous slices.
function projected(f) {
  const region = f.region(); if (!region) return '';
  const chunks = [...region.children].filter(el => (el.getAttribute('style') ?? '').includes('content-visibility'));
  if (chunks.length) return chunks.map(c => c.querySelector('[data-bash-output]').textContent).join('\n');
  return f.pres().map(p => p.textContent).join('');
}
const lineCount = f => projected(f).split('\n').length;
function assertSingleSurface(f) {
  const blocks = f.panel().querySelectorAll('[data-testid="tool-output"]');
  assert.equal(blocks.length, 1, 'one output block');
  const region = f.region();
  for (const cls of ['rounded-lg', 'bg-surface-1']) assert.ok(region.classList.contains(cls), `the one surface: ${cls}`);
  assert.equal(blocks[0].querySelectorAll('.border:not(button)').length, 0, 'no nested bordered surface');
  for (const pre of f.pres()) assert.equal([...pre.classList].some(c => c.startsWith('rounded') || c.startsWith('bg-')), false, 'no inner well');
  assert.equal(f.panel().querySelectorAll('h1,h2,h3,h4,h5,h6').length, 0, 'no section headings');
  assert.doesNotMatch(f.panel().textContent, /Result|Parameters|Recorded output/);
}

for (const [kind, makePart] of [['bash', bash], ['file', file]]) {
  test(`${kind}: plain output is one mono surface with one Copy and no headings`, async t => {
    const f = await fixture(t, kind, makePart());
    assertSingleSurface(f);
    assert.equal(f.panel().querySelectorAll('button[aria-label="Copy output"]').length, 1);
    assert.ok(f.region().classList.contains('overflow-x-auto'), 'horizontal output scroll remains');
    assert.equal(f.region().tabIndex, 0, 'the scroll region is keyboard reachable');
  });
  test(`${kind}: full output copies byte-for-byte, including whitespace, ANSI, and final newline`, async t => {
    const output = '  start\r\n\u001b[32mPASS\u001b[0m\n\nend  \n';
    const f = await fixture(t, kind, makePart({ output }));
    const copy = f.button('Copy output');
    assert.equal(copy.getAttribute('data-size'), 'icon-sm', '32px toolbar icon (44px hit area)');
    await f.act(async () => copy.click());
    assert.deepEqual(f.writes, [output]);
  });
  test(`${kind}: 500-line clamp, Show all/less, and full-output copy are preserved`, async t => {
    const output = Array.from({ length: 550 }, (_, i) => `row ${i}`).join('\n') + '\n';
    const f = await fixture(t, kind, makePart({ output }));
    assert.equal(lineCount(f), 500);
    assert.equal(f.showAll().textContent, 'Show all (51 more lines)');
    await f.act(async () => f.button('Copy output').click());
    assert.deepEqual(f.writes, [output]);
    await f.act(async () => f.showAll().click());
    assert.equal(lineCount(f), 551);
    assertSingleSurface(f);
    await f.act(async () => f.button('Show less').click());
    assert.equal(lineCount(f), 500);
  });
  test(`${kind}: large output progressively expands into unframed chunks, then collapses`, async t => {
    const output = Array.from({ length: 600 }, (_, i) => `row ${i} ${'x'.repeat(120)}`).join('\n');
    const f = await fixture(t, kind, makePart({ output }));
    const frames = new Map(); let nextFrame = 0;
    f.w.requestAnimationFrame = cb => { frames.set(++nextFrame, cb); return nextFrame; };
    f.w.cancelAnimationFrame = id => frames.delete(id);
    await f.act(async () => f.showAll().click());
    assert.equal(f.pres().length, 1, 'the first chunk paints at once');
    assert.ok(frames.size > 0, 'the rest follow frame by frame');
    for (let i = 0; frames.size && i < 30; i++) {
      const callbacks = [...frames.values()]; frames.clear();
      await f.act(async () => callbacks.forEach(cb => cb(i * 16)));
    }
    assert.equal(frames.size, 0);
    assert.ok(f.pres().length > 1);
    assert.equal(projected(f), output);
    assertSingleSurface(f);
    await f.act(async () => f.button('Copy output').click()); assert.deepEqual(f.writes, [output]);
    await f.act(async () => f.button('Show less').click());
    assert.equal(f.pres().length, 1);
  });
  test(`${kind}: error output leads with its first line in danger and copies exactly`, async t => {
    const output = 'Permission denied\n  unable to open target\n';
    const f = await fixture(t, kind, makePart({ state: 'error', output }));
    const [first, rest] = f.pres();
    assert.equal(first.textContent, 'Permission denied\n');
    assert.ok(first.classList.contains('text-danger'));
    assert.equal(rest.textContent, '  unable to open target\n');
    assert.ok(rest.classList.contains('text-foreground'));
    assert.equal(f.panel().querySelector('.font-semibold') === null, true, 'no bold error heuristic');
    assertSingleSurface(f);
    if (kind === 'bash') assert.equal(f.toolbar().textContent.includes('exit 1'), false);
    const label = kind === 'bash' ? 'Copy output' : 'Copy error';
    await f.act(async () => f.button(label).click()); assert.deepEqual(f.writes, [output]);
  });
  test(`${kind}: a long unbroken token stays horizontally scrollable and char-clamped`, async t => {
    const output = 'x'.repeat(65001);
    const f = await fixture(t, kind, makePart({ output }));
    assert.equal(f.panel().querySelector('[data-bash-output] code').textContent.length, 60000);
    assert.equal(f.showAll().textContent, 'Show all (5,001 more characters)');
    assert.ok(f.region().classList.contains('overflow-x-auto'));
    await f.act(async () => f.showAll().click());
    assert.equal(projected(f) === output, true, 'the whole token after Show all');
    assertSingleSurface(f);
    await f.act(async () => f.button('Copy output').click()); assert.deepEqual(f.writes, [output]);
    await f.act(async () => f.button('Show less').click());
    assert.equal(f.panel().querySelector('[data-bash-output] code').textContent.length, 60000);
  });
  test(`${kind}: expanded error chunks retain whitespace without repeated headings`, async t => {
    const output = Array.from({ length: 550 }, (_, i) => `failure ${i}\n  details for the failed operation`).join('\n');
    const f = await fixture(t, kind, makePart({ state: 'error', output }));
    await f.act(async () => f.showAll().click());
    const chunks = f.pres();
    assert.ok(chunks.length > 1);
    assert.equal(projected(f), output);
    for (const pre of chunks) {
      for (const token of ['whitespace-pre', 'font-mono', 'text-code']) assert.ok(pre.classList.contains(token), token);
    }
    assertSingleSurface(f);
    const copy = kind === 'bash' ? 'Copy output' : 'Copy error';
    await f.act(async () => f.button(copy).click()); assert.deepEqual(f.writes, [output]);
    await f.act(async () => f.button('Show less').click());
    assert.equal(f.pres().length, 2, 'clamped failure: danger first line, then the rest');
    assert.ok(f.pres()[0].classList.contains('text-danger'));
  });
  test(`${kind}: pruned and interrupted cues show in the tool sheet`, async t => {
    const f = await fixture(t, kind, makePart({ state: 'running', output: '', pruned: true }), { row: true, live: false });
    assert.equal(f.row().dataset.state, 'interrupted');
    assert.match(f.row().textContent, /Interrupted$/);
    await f.open();
    const notes = () => f.panel().textContent;
    assert.match(notes(), /Stopped before it finished\./);
    assert.match(notes(), /Output removed from the transcript to save space\./);
    none(f.button('Copy output'));
    none(f.panel().querySelector('[data-testid="stop-command"]'), 'an interrupted command cannot be stopped');
  });
}

test('bash: copying diff output preserves its exact original bytes', async t => {
  const output = '@@ -1,2 +1,2 @@\n-old\n+new\n context\n';
  const f = await fixture(t, 'bash', bash({ output }));
  const copy = f.panel().querySelector('button[aria-label="Copy diff"]');
  assert.ok(copy);
  await f.act(async () => copy.click());
  assert.deepEqual(f.writes, [output]);
});

test('bash: the command is the block\'s `$` head; Copy takes the output, or the exact command when there is none', async t => {
  const command = '  printf "first\\n"\n\tprintf "second\\n"  \n';
  const f = await fixture(t, 'bash', bash({ args: { command } }));
  const head = f.panel().querySelector('[data-testid="tool-command"]');
  assert.equal(f.region().firstElementChild === head, true, 'the command opens the one mono region');
  assert.equal(head.textContent, `$ ${command}`);
  const prompt = head.firstElementChild;
  assert.equal(prompt.textContent, '$ ');
  assert.equal(prompt.getAttribute('aria-hidden'), 'true');
  for (const cls of ['select-none', 'text-tertiary']) assert.ok(prompt.classList.contains(cls), cls);
  for (const cls of ['font-mono', 'text-code', 'text-foreground']) assert.ok(head.classList.contains(cls), cls);
  none(f.button('Copy command'), 'one Copy per block');
  await f.act(async () => f.button('Copy output').click());
  await f.render(bash({ args: { command }, output: '' }));
  await f.act(async () => f.button('Copy command').click());
  assert.deepEqual(f.writes, ['test passed\n', command]);
});
test('bash: running row has a live tail; the finished card claims no exit it was not told', async t => {
  const output = Array.from({ length: 10 }, (_, i) => `live ${i}`).join('\n');
  const part = bash({ state: 'running', output, startedAt: Date.now() - 3000 });
  const f = await fixture(t, 'bash', part, { row: true, live: true });
  assert.equal(f.row().dataset.state, 'running');
  assert.match(f.row().textContent, /^Running npm test/);
  assert.equal(f.w.document.querySelector('[data-testid="live-tool-output"] pre').textContent, output.split('\n').slice(-4).join('\n'));
  await f.render({ ...part, state: 'ok', output });
  none(f.w.document.querySelector('[data-testid="live-tool-output"]'), 'no tail once finished');
  assert.match(f.row().textContent, /^Ran npm test/);
  await f.open(); assert.equal(f.row().textContent.includes('exit'), false, 'exit 0 is not news; the header shows only a failure\'s code');
  assert.equal(projected(f), output);
});
test('file: range, target, and running label remain available', async t => {
  const f = await fixture(t, 'file', file({ state: 'running', output: '' }), { row: true, live: true });
  assert.equal(f.row().dataset.state, 'running');
  assert.match(f.row().textContent, /^Reading src\/demo\.ts:3-5/);
  await f.open();
  assert.ok(f.sheet(), 'tapping the row opens the sheet');
  assert.equal(f.panel().querySelector('[data-testid="tool-path"]').textContent, 'src/demo.ts', 'the detail names the full path');
});
test('generic: result in one output block; arguments behind Details as labelled values', async t => {
  const part = { kind: 'tool', callId: 'g1', name: 'mcp_lookup', state: 'ok', args: { query: 'raw  text', options: { deep: true } }, output: 'generic output\n' };
  const f = await fixture(t, 'generic', part);
  assertSingleSurface(f);
  assert.equal(projected(f), 'generic output\n');
  const details = f.panel().querySelector('[data-testid="tool-args"] button');
  assert.equal(details.getAttribute('aria-expanded'), 'false');
  none(f.panel().querySelector('[data-testid="tool-args"] dl'), 'arguments are closed by default');
  await f.act(async () => details.click());
  assert.equal(details.getAttribute('aria-expanded'), 'true');
  const pairs = [...f.panel().querySelectorAll('[data-testid="tool-args"] dl > div')].map(d => [d.querySelector('dt').textContent, d.querySelector('dd').textContent]);
  assert.deepEqual(pairs, [['query', 'raw  text'], ['options', JSON.stringify({ deep: true }, null, 2)]]);
  await f.act(async () => f.button('Copy output').click()); assert.deepEqual(f.writes, ['generic output\n']);
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

for (const output of ['{"output":"ok","items":[1,2]}', '{"output":"ok","exitCode":42}', '{"result":{"output":"ok"},"exitCode":42}']) {
  test(`bash preserves command-printed JSON in display and copy: ${output}`, async t => {
    const f = await fixture(t, 'bash', bash({ output }), { row: true });
    await f.open();
    assert.equal(projected(f), output);
    await f.act(async () => f.button('Copy output').click());
    assert.deepEqual(f.writes, [output]);
    assert.equal(f.row().textContent.includes('exit'), false);
  });
}

for (const [shell, label] of [[{kind:'exit',code:23},'exit 23'],[{kind:'timeout'},'Timed out'],[{kind:'cancelled'},'Cancelled'],[undefined,'Exit status unknown']]) {
  test(`bash details and card show the reported outcome: ${label}`, async t => {
    const part = bash({state:'error',shell,output:'original failure text'});
    const detail = await fixture(t,'bash',part);
    assert.equal(detail.toolbar().textContent,label);
    const card = await fixture(t,'bash',part,{row:true});
    assert.equal(card.row().textContent.includes(label),true);
  });
}

for (const path of ['data.txt', 'data.txt:raw']) test(`reads preserve diff-shaped contents, including Git headers: ${path}`, async t => {
  const output='diff --git a/a b/a\n--- header\n+++ header\n-old\n+new\n';
  const f=await fixture(t,'file',file({args:{path},output}));
  assert.equal(f.panel().querySelector('[data-testid="diff-part"]')===null,true);
  assert.equal(projected(f),output);
  await f.act(async()=>f.button('Copy output').click());
  assert.deepEqual(f.writes,[output]);
});
