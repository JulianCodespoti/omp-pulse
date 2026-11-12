import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
import { FilesTab } from ${JSON.stringify(resolve(root, 'web/src/app/tools/FilesTab.tsx'))};
import { DaemonApi } from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
const files = [], browse = [], reads = [];
window.fetch = (url) => {
  if (!String(url).startsWith('/api/files?')) throw new Error('Unexpected request: ' + url);
  return new Promise((resolve, reject) => files.push({ url, resolve, reject }));
};
DaemonApi.prototype.browse = path => new Promise((resolve, reject) => browse.push({ path, resolve, reject }));
DaemonApi.prototype.readFile = (...args) => new Promise((resolve, reject) => reads.push({ args, resolve, reject }));
window.fixture = { act, files, browse, reads, mount() {
  const root = createRoot(document.getElementById('root'));
  const render = (active = true, sessionPath = '/synthetic/a') => root.render(h(FilesTab, { active, sessionPath }));
  render(); return { render, unmount: () => root.unmount() };
}};
`);

const dir = (name, path = name) => ({ name, path, type: 'dir', size: 0, mtime: 0 });
const file = (name, path = name) => ({ name, path, type: 'file', size: 10, mtime: 0 });
async function fixture(t) {
  const dom = createDomFixture(code), w = dom.window;
  w.Element.prototype.getAnimations = () => [];
  const { act, files, browse, reads } = w.fixture;
  let mounted, unmounted = false;
  await act(async () => { mounted = w.fixture.mount(); });
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => mounted.unmount()); } };
  t.after(async () => { try { await unmount(); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  return {
    w, act, files, browse, reads, unmount,
    text: () => w.document.body.textContent,
    loading: () => w.document.querySelector('[data-testid="files-loading"]') !== null,
    render: (...args) => act(async () => mounted.render(...args)),
    button: name => [...w.document.querySelectorAll('button')].find(b => b.textContent === name || b.getAttribute('aria-label') === name),
    async click(name) { const b = this.button(name); assert.ok(b, `Missing button: ${name}`); await act(async () => b.click()); },
    finish: (i, entries = [], cwd = '/project') => act(async () => files[i].resolve({ ok: true, status: 200, json: async () => ({ ok: true, cwd, entries }) })),
    invalid: i => act(async () => files[i].resolve({ ok: false, status: 400, json: async () => ({ ok: false, error: 'invalid session path' }) })),
    missing: (i, cwd = '/missing/project') => act(async () => files[i].resolve({ ok: false, status: 404, json: async () => ({ ok: false, code: 'project_folder_unavailable', cwd, error: `Project folder is unavailable: ${cwd}` }) })),
    home: (i, path = '/home/synthetic', dirs = [{ name: 'projects', path: '/home/synthetic/projects' }]) => act(async () => browse[i].resolve({ path, dirs })),
  };
}

test('Browse home settles once without restarting session reads', async t => {
  const f = await fixture(t);
  await f.invalid(0); await f.click('Browse home'); await f.home(0);
  assert.equal(f.files.length, 1);
  assert.equal(f.browse.length, 1);
  assert.ok(f.text().includes('projects'));
  assert.ok(!f.loading());
});

test('a missing project never browses home until explicitly chosen and discloses the new location', async t => {
  const f = await fixture(t);
  await f.missing(0);
  assert.equal(f.browse.length, 0);
  assert.equal(f.text().includes('/missing/project'), true);
  await f.click('Browse home');
  await f.home(0);
  const location = f.w.document.querySelector('[data-testid="files-browse-location"]');
  assert.equal(location?.textContent.includes('/home/synthetic'), true);
  await f.render(true, '/synthetic/b');
  await f.finish(1, [file('current.txt')], '/new-project');
  assert.equal(f.w.document.querySelector('[data-testid="files-browse-location"]') === null, true);
  assert.equal(f.text().includes('current.txt'), true);
  assert.equal(f.text().includes('projects'), false);
});

test('a previous session result cannot replace the new session folder', async t => {
  const f = await fixture(t);
  await f.render(true, '/synthetic/b');
  await f.finish(1, [file('current.txt')], '/current');
  await f.finish(0, [file('obsolete.txt')], '/obsolete');
  assert.ok(f.text().includes('current.txt'));
  assert.ok(!f.text().includes('obsolete.txt'));
});

test('a stale failure cannot stop the current session loading', async t => {
  const f = await fixture(t);
  await f.render(true, '/synthetic/b');
  await f.act(async () => f.files[0].reject(new Error('Old failure')));
  assert.ok(f.loading());
  assert.ok(!f.text().includes('Old failure'));
  await f.finish(1, [file('current.txt')]);
  assert.ok(f.text().includes('current.txt'));
});

test('fallback directory and parent navigation use absolute paths without extra reads', async t => {
  const f = await fixture(t);
  await f.invalid(0); await f.click('Browse home'); await f.home(0);
  await f.click('projects');
  assert.equal(f.browse[1].path, '/home/synthetic/projects');
  await f.home(1, '/home/synthetic/projects', [{ name: 'source', path: '/home/synthetic/projects/source' }]);
  assert.ok(f.text().includes('source'));
  await f.click('Parent folder');
  assert.equal(f.browse[2].path, '/home/synthetic');
  await f.home(2);
  await f.click('Parent folder');
  assert.equal(f.browse[3].path, '/home');
  await f.home(3, '/home', []);
  await f.click('Parent folder');
  assert.equal(f.browse[4].path, '/');
  await f.home(4, '/', []);
  await f.click('Parent folder');
  assert.equal(f.browse[5].path, '/');
  await f.home(5, '/', []);
  assert.equal(f.files.length, 1);
  assert.equal(f.browse.length, 6);
});

test('session directories, breadcrumbs, parent and FileViewer preserve relative paths', async t => {
  const f = await fixture(t);
  await f.finish(0, [dir('src')]);
  await f.click('src');
  assert.equal(new URL(f.files[1].url, 'http://synthetic.invalid').searchParams.get('path'), 'src');
  await f.finish(1, [dir('nested', 'src/nested')]);
  await f.click('nested');
  await f.finish(2, [file('readme.txt', 'src/nested/readme.txt')]);
  await f.act(async () => [...f.w.document.querySelectorAll('button')].find(b => b.textContent.startsWith('readme.txt')).click());
  assert.deepEqual(Array.from(f.reads[0].args), ['/synthetic/a', 'src/nested/readme.txt']);
  await f.act(async () => f.reads[0].resolve({ content: 'Synthetic file content', binary: false, truncated: false, size: 22 }));
  assert.ok(f.text().includes('Synthetic file content'));
  await f.act(async () => [...f.w.document.querySelectorAll('button[aria-label="Close"]')].at(-1).click());
  await f.click('Parent folder');
  assert.equal(new URL(f.files[3].url, 'http://synthetic.invalid').searchParams.get('path'), 'src');
  await f.finish(3, [dir('nested', 'src/nested')]);
  await f.click('project');
  assert.equal(new URL(f.files[4].url, 'http://synthetic.invalid').searchParams.get('path') === null, true);
  await f.finish(4, [dir('src')]);
  assert.equal(Boolean(f.button('Parent folder')), false);
  assert.equal(f.browse.length, 0);
});

test('newer parent navigation wins over an older pending directory response', async t => {
  const f = await fixture(t);
  await f.finish(0, [dir('src')]); await f.click('src');
  await f.finish(1, [dir('nested', 'src/nested')]); await f.click('nested');
  await f.click('Parent folder');
  await f.finish(3, [file('root.txt')]);
  await f.finish(2, [file('stale-child.txt')]);
  assert.ok(f.text().includes('root.txt'));
  assert.ok(!f.text().includes('stale-child.txt'));
  assert.equal(Boolean(f.button('Parent folder')), false);
});

test('hide and show invalidate the old request, including its loading completion', async t => {
  const f = await fixture(t);
  await f.render(false); await f.render(true);
  await f.finish(0, [file('closed.txt')]);
  assert.ok(f.loading());
  assert.ok(!f.text().includes('closed.txt'));
  await f.finish(1, [file('reopened.txt')]);
  assert.ok(f.text().includes('reopened.txt'));
});

test('inactive tab issues no read until it becomes active', async t => {
  const f = await fixture(t);
  await f.render(false, '/synthetic/b');
  await f.finish(0, [file('stale.txt')]);
  assert.equal(f.files.length, 1);
  await f.render(true, '/synthetic/b');
  assert.equal(f.files.length, 2);
  await f.finish(1, [file('current.txt')]);
  assert.ok(f.text().includes('current.txt'));
  assert.ok(!f.text().includes('stale.txt'));
});

test('reactivation keeps the folder and re-reads it quietly', async t => {
  const f = await fixture(t);
  await f.finish(0, [dir('src')]); await f.click('src');
  await f.finish(1, [file('old.txt', 'src/old.txt')]);
  await f.render(false); await f.render(true);
  assert.equal(new URL(f.files[2].url, 'http://synthetic.invalid').searchParams.get('path'), 'src');
  assert.ok(!f.loading(), 'quiet re-read keeps the list visible');
  assert.ok(f.text().includes('old.txt'));
  await f.finish(2, [file('new.txt', 'src/new.txt')]);
  assert.ok(f.text().includes('new.txt'));
  assert.ok(f.button('Parent folder'));
});

test('a pending home response cannot switch a new session into fallback mode', async t => {
  const f = await fixture(t);
  await f.invalid(0); await f.click('Browse home');
  await f.render(true, '/synthetic/b');
  await f.finish(1, [file('current.txt')]); await f.home(0);
  assert.ok(f.text().includes('current.txt'));
  assert.ok(!f.text().includes('projects'));
  assert.equal(f.files.length, 2);
  assert.equal(f.browse.length, 1);
});

test('current session error remains retryable', async t => {
  const f = await fixture(t);
  await f.act(async () => f.files[0].reject(new Error('Synthetic failure')));
  assert.ok(f.text().includes('Synthetic failure'));
  await f.click('Retry'); await f.finish(1, [file('retried.txt')]);
  assert.ok(f.text().includes('retried.txt'));
});

test('Retry after a failed subfolder opens that subfolder, and the notice names it', async t => {
  const f = await fixture(t);
  await f.finish(0, [dir('src')]);
  await f.click('src');
  await f.act(async () => f.files[1].reject(new Error('Synthetic failure')));
  assert.ok(f.text().includes('Couldn’t open src'));
  await f.click('Retry');
  assert.equal(new URL(f.files[2].url, 'http://synthetic.invalid').searchParams.get('path'), 'src');
});

test('a failed quiet refresh keeps the rows and offers Retry above them', async t => {
  const f = await fixture(t);
  await f.finish(0, [file('kept.txt')]);
  await f.render(false); await f.render(true);
  await f.act(async () => f.files[1].reject(new Error('Synthetic failure')));
  assert.ok(f.text().includes('kept.txt'));
  assert.ok(f.text().includes('Couldn’t refresh'));
  await f.click('Retry'); await f.finish(2, [file('fresh.txt')]);
  assert.ok(f.text().includes('fresh.txt'));
  assert.ok(!f.text().includes('Couldn’t refresh'));
});

test('unmount ignores pending browse completion without issuing more reads', async t => {
  const f = await fixture(t);
  await f.invalid(0); await f.click('Browse home'); await f.unmount();
  await f.home(0);
  assert.equal(f.files.length, 1);
  assert.equal(f.browse.length, 1);
});

test('session changes also invalidate a response whose JSON is still pending', async t => {
  const f = await fixture(t);
  let finishJson;
  await f.act(async () => f.files[0].resolve({ ok: true, status: 200, json: () => new Promise(resolve => { finishJson = resolve; }) }));
  await f.render(true, '/synthetic/b');
  await f.finish(1, [file('current.txt')]);
  await f.act(async () => finishJson({ ok: true, cwd: '/old', entries: [file('old-json.txt')] }));
  assert.ok(f.text().includes('current.txt'));
  assert.ok(!f.text().includes('old-json.txt'));
});

test('a stale browse failure cannot overwrite newer parent navigation', async t => {
  const f = await fixture(t);
  await f.invalid(0); await f.click('Browse home'); await f.home(0);
  await f.click('projects'); await f.click('Parent folder');
  assert.equal(f.browse[2].path, '/home');
  await f.home(2, '/home', [{ name: 'current-folder', path: '/home/current-folder' }]);
  await f.act(async () => f.browse[1].reject(new Error('Old browse failure')));
  assert.ok(f.text().includes('current-folder'));
  assert.ok(!f.text().includes('Old browse failure'));
});


test('root folder stays identified once through the breadcrumb, including long names', async t => {
  const f = await fixture(t);
  const name = 'a-long-root-folder-'.repeat(8);
  await f.finish(0, [], '/synthetic/' + name);
  const location = f.w.document.querySelector('nav[aria-label="File location"]');
  assert.ok(location); assert.equal(location.textContent, name);
  assert.equal(f.w.document.querySelector('[data-testid="sheet-description"]') === null, true);
  const root = location.querySelector('[aria-current="location"]');
  assert.ok(root, 'current location has explicit text semantics');
  assert.equal(root.tagName, 'SPAN');
  assert.equal(location.querySelector('button') === null, true, 'root is a label, not a disabled 44px action');
  assert.equal(root.classList.contains('min-h-11'), false);
  assert.equal(root.classList.contains('truncate'), false);
  assert.equal(root.title, name);
  assert.ok(root.classList.contains('min-w-0'));
  assert.ok(root.classList.contains('[overflow-wrap:anywhere]'));
  assert.equal(root.classList.contains('break-words'), false, 'competing utility overrode anywhere in a real browser capture');
});

// Layout class contracts only; this synthetic DOM does not measure pixel space.
test('only ancestor locations reserve 44px targets and still navigate to the same path', async t => {
  const f = await fixture(t);
  await f.finish(0, [dir('src')], '/synthetic/root');
  await f.click('src');
  const name = 'unbroken-location-'.repeat(8);
  await f.finish(1, [dir(name, 'src/' + name)], '/synthetic/root');
  await f.click(name);
  await f.finish(2, [], '/synthetic/root');
  const nav = f.w.document.querySelector('nav[aria-label="File location"]');
  const ancestors = [...nav.querySelectorAll('button:not([aria-label="Parent folder"])')];
  assert.deepEqual(ancestors.map(b => b.textContent), ['root', 'src']);
  for (const button of ancestors) {
    assert.ok(button.classList.contains('min-h-11'));
    assert.equal(button.disabled, false);
  }
  const current = nav.querySelector('[aria-current="location"]');
  assert.equal(current.textContent, name);
  assert.equal(current.title, name);
  assert.ok(current.classList.contains('[overflow-wrap:anywhere]'));
  assert.equal(current.classList.contains('break-words'), false, 'long current labels must not have competing overflow-wrap rules');
  await f.act(async () => ancestors[1].click());
  assert.equal(new URL(f.files[3].url, 'http://synthetic.invalid').searchParams.get('path'), 'src');
  assert.equal(f.browse.length, 0);
});
