import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { rolldown } from '../node_modules/rolldown/dist/index.mjs';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// Pure rewrite: the production helper, bundled as-is. Mounted section: the real
// Markdown component with the lazily loaded maths plugin (jsdom proves the
// rendered elements and untouched text, not Chromium's MathML layout).
const helperPath = resolve(root, 'web/src/components/math-plugin.ts');
const build = await rolldown({
  input: 'math-fixture', platform: 'node',
  plugins: [{
    name: 'math-fixture',
    resolveId: id => id === 'math-fixture' ? '\0math-fixture' : null,
    load: id => id === '\0math-fixture' ? `export { prepareMathSource } from ${JSON.stringify(helperPath)};` : null,
  }],
});
let prepareMathSource;
try {
  const out = await build.generate({ format: 'esm', codeSplitting: false });
  ({ prepareMathSource } = await import(`data:text/javascript;base64,${Buffer.from(out.output[0].code).toString('base64')}`));
} finally { await build.close(); }

test('LaTeX bracket forms become double-dollar maths without moving a single character', () => {
  for (const [input, expected] of [
    ['Energy \\(E=mc^2\\) here', 'Energy $$E=mc^2$$ here'],
    ['\\[ x = 1 \\]', '$$ x = 1 $$'],
    ['\\[\nx = 1\n\\]', '$$\nx = 1\n$$'],
    ['See \\(a\nb\\) ok', 'See $$a\nb$$ ok'],
    ['$$E=mc^2$$ stays', '$$E=mc^2$$ stays'],
  ]) {
    const out = prepareMathSource(input);
    assert.equal(out, expected);
    assert.equal(out.length, input.length, 'source offsets are preserved');
  }
});

test('a single dollar, code, escapes and unfinished delimiters are left exactly as written', () => {
  for (const input of [
    'echo $HOME costs $5',
    '```sh\necho \\(x\\) \\[y\\]\n```',
    '~~~\n\\(x\\)\n~~~',
    '  - ```\n    \\(x\\)\n    ```',
    'Run `echo \\(x\\)` to see it',
    'Run ``a ` \\(x\\)`` to see it',
    'Escaped \\\\(x\\\\) pair',
    'Streaming \\(x = 1',
    'Streaming \\[\nx = 1\n',
    'No body \\(\\) here',
    '\\[x\ny\\]',
    '\\[\nx\n\\] trailing text',
    '```\nunclosed fence \\(x\\)',
  ]) assert.equal(prepareMathSource(input), input);
});

test('code before and after a formula does not hide it', () => {
  assert.equal(prepareMathSource('`a` \\(x\\) `b`'), '`a` $$x$$ `b`');
  assert.equal(prepareMathSource('```\ncode\n```\n\nThen \\(x\\)'), '```\ncode\n```\n\nThen $$x$$');
});

// ── Mounted ──────────────────────────────────────────────────────────────────
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { Markdown } from ${JSON.stringify(resolve(root, 'web/src/components/markdown.tsx'))};
window.fixture = { act,
  mount(props) { const r = createRoot(document.getElementById('root')); r.render(h(Markdown, props)); return { render: props => r.render(h(Markdown, props)), unmount: () => r.unmount() }; } };
`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function mounted(t, props) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  w.HTMLElement.prototype.scrollTo = () => {}; // jsdom has no scrolling geometry
  const settle = async () => { for (let i = 0; i < 16; i++) await act(async () => { await sleep(5); }); };
  let handle;
  await act(async () => { handle = w.fixture.mount(props); });
  await settle();
  t.after(async () => { try { await act(async () => handle.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  return { d: w.document };
}

test('mounted: $$ and LaTeX brackets render as MathML once the plugin has loaded', async t => {
  for (const text of ['Energy $$E=mc^2$$ here', 'Energy \\(E=mc^2\\) here', '\\[\nE=mc^2\n\\]']) {
    const f = await mounted(t, { children: text });
    assert.ok(f.d.querySelector('math'), text);
    assert.equal(f.d.querySelector('.katex-html'), null, 'MathML output needs no KaTeX stylesheet');
  }
});

test('mounted: shell variables and prices are never maths', async t => {
  const text = 'echo $HOME costs $5 and $PATH:$HOME/bin';
  const f = await mounted(t, { children: text });
  assert.equal(f.d.querySelector('math'), null);
  assert.ok(f.d.body.textContent.includes(text));
});
