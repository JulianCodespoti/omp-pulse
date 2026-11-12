import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
// Actual Markdown, PathChip and React lifetime; only the lazy rich dependency
// is replaced to isolate our paragraph scan from third-party parser costs.
const code = await bundleDomFixture(`
import {createElement as h, act, useState} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {Markdown} from ${JSON.stringify(resolve(root, 'web/src/components/markdown.tsx'))};
const paths=[];
function App({text}) {const [count,setCount]=useState(0);return h('main',{},h('button',{id:'sibling',onClick:()=>setCount(n=>n+1)},'Control '+count),h(Markdown,{onOpenPath:p=>paths.push(p)},text));}
window.fixture={act,paths,mount(mode,text){window.richMode=mode;const r=createRoot(document.getElementById('root'),{onCaughtError(){}});const render=text=>r.render(h(App,{text}));render(text);return{render,unmount:()=>r.unmount()}}};
`, [{
  name: 'controlled-rich-paragraph',
  resolveId(id) { if (id === 'streamdown') return '\0rich-paragraph'; },
  load(id) {
    if (id === '\0rich-paragraph') return `import {createElement as h} from ${JSON.stringify(require.resolve('react'))};
      const pending=new Promise(()=>{});
      export function Streamdown({children,components}) {
        if(window.richMode==='pending') throw pending;
        if(window.richMode==='failed') throw Error('Synthetic rich failure');
        return h('section',{'data-testid':'rich-paragraph'},h(components.p,{},children));
      }`;
  },
}]);

async function fixture(t, mode, text = 'Warmup') {
  const dom = createDomFixture(code), w = dom.window, { act, paths } = w.fixture;
  let mounted;
  await act(async () => { mounted = w.fixture.mount(mode, text); });
  t.after(async () => {
    try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  const content = () => w.document.querySelector('main > .md-body');
  return { w, act, paths, content,
    render: text => act(async () => mounted.render(text)),
    chips: () => [...content().querySelectorAll('[data-testid="path-chip"]')],
  };
}

// Frozen legacy semantics: candidate boundaries, punctuation and URL context.
// Random inputs stay short so the old matcher never becomes a test-time DoS.
function legacyPaths(text) {
  function isPathLike(token) {
    if (!token.includes('/') || token.includes('://')) return false;
    if (['/', '//', './', '../'].includes(token)) return false;
    if (token.startsWith('./') || token.startsWith('../') || token.startsWith('~/')) return token.length > 2;
    const withoutLine = token.split(':')[0] ?? token;
    return /\.[A-Za-z0-9]{1,10}$/.test(withoutLine) || /^\/(?:home|Users|tmp|etc|usr|var|opt|mnt|srv|root|private|Volumes)\//.test(withoutLine);
  }
  const paths = [];
  for (const match of text.matchAll(/[^\s"'`<>|]*\/[^\s"'`<>|]+/g)) {
    let core = match[0];
    const tail = core.match(/[.,;:!?)\]}'"]+$/)?.[0];
    if (tail && core.length > tail.length && isPathLike(core.slice(0, -tail.length))) core = core.slice(0, -tail.length);
    if (isPathLike(core) && !text.slice(Math.max(0, match.index - 8), match.index).includes('://')) paths.push(core);
  }
  return paths;
}

const golden = [
  'src/example.ts', './local', '../parent/', '~/notes', '/tmp/log', '/Users/me/file',
  '/api/users', '/', '//', './', '../', 'trailing/', 'a//', '//a', 'a/b/',
  'src/file.ts:31', 'src/file.ts).', '(src/file.ts)', 'src/file.ts! src/next.ts?',
  'https://example.test/a.ts', 'https:// src/a.ts', 'https://        src/a.ts',
  '"src/quoted.ts"|src/pipe.ts<../unicode-café>\'src/single.ts\'',
  '前置き/src/café.ts', 'src/emoji-🦊.txt', 'x/y.abcdefghij', 'x/y.abcdefghijk',
].join(' ');
function randomTokens() {
  let seed = 0x13579bdf;
  const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const alphabet = 'abcXYZ012./:!?)]}é🦊';
  const delimiters = [' ', '  ', '|', '"', "'", '<', '>'];
  return Array.from({ length: 1800 }, () => {
    let token = ['', './', '../', '/tmp/', 'https://', 'src/'][next(6)];
    for (let n = next(22); n > 0; n--) token += alphabet[next(alphabet.length)];
    return token + ['', '.ts', '/'][next(3)] + delimiters[next(delimiters.length)];
  }).join('');
}

for (const mode of ['pending', 'failed', 'rich']) {
  test(`${mode}: golden and seeded short tokens preserve exact text and legacy path actions`, async t => {
    const text = golden + ' ' + randomTokens();
    const f = await fixture(t, mode, text);
    assert.equal(f.content().textContent, text);
    const expected = legacyPaths(text);
    assert.deepEqual(f.chips().map(chip => chip.getAttribute('aria-label').slice('Open file '.length)), expected);
    for (const chip of f.chips()) await f.act(async () => chip.click());
    assert.deepEqual(Array.from(f.paths), expected);
    assert.equal(Boolean(f.w.document.querySelector('[data-testid="rich-paragraph"]')), mode === 'rich');
  });

  test(`${mode}: 80k slash-ended token paints within a generous two-second bound`, async t => {
    const f = await fixture(t, mode);
    const text = 'x'.repeat(80000) + '/';
    const start = performance.now();
    await f.render(text);
    const elapsed = performance.now() - start;
    t.diagnostic(`80,001-character actual Markdown update: ${elapsed.toFixed(1)} ms`);
    assert.ok(elapsed < 2000, `path scan blocked the update for ${elapsed.toFixed(1)} ms`);
    assert.equal(f.content().textContent, text);
    assert.equal(f.chips().length, 0);
    await f.act(async () => f.w.document.querySelector('#sibling').click());
    assert.equal(f.w.document.querySelector('#sibling').textContent, 'Control 1');
    await f.render(text + ' src/recovered.ts');
    assert.equal(f.content().textContent, text + ' src/recovered.ts');
    assert.equal(f.chips().length, 1);
    await f.act(async () => f.chips()[0].click());
    assert.deepEqual(Array.from(f.paths), ['src/recovered.ts']);
  });
}
