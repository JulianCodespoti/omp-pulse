import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const stubs = {
  './ConnectComputer': 'export const ConnectComputer=()=>null;',
  './ProviderSignIn': 'export const bridgeSignInTransport=()=>({}),ProviderSignIn=()=>null;',
};
const DESK = 'https://desk.tail1234.ts.net/app/';
const LAPTOP = 'https://laptop.tail1234.ts.net:8443/app/';
const code = await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {Onboarding} from ${JSON.stringify(resolve(root, 'web/src/app/Onboarding.tsx'))};
const calls=window.calls={prepare:0,modes:[],use:[],status:[]};
// A runtime that is ready the moment prepare() is asked, so no poll is needed.
const runtime=window.runtime={supported:true,mode:'unset',phase:'idle',installed:false,progress:-1,laptopUrl:null,downloadBytes:200000000,ompVersion:'fixture'};
// What the shell answers to computerStatus(true), and to useComputer().
window.statuses={};
window.useResult={ok:true};
const intervals=window.intervals=new Map();let timer=0;
window.setInterval=(fn,ms)=>{intervals.set(++timer,{fn,ms});return timer};
window.clearInterval=id=>intervals.delete(id);
window.OmpLocal={
  state:()=>JSON.stringify(runtime),
  access:()=>'{}',
  prepare(){calls.prepare++;runtime.phase='ready';runtime.installed=true;runtime.downloadBytes=0},
  setMode(mode){calls.modes.push(mode)},
  useComputer(url){calls.use.push(url);return JSON.stringify(window.useResult)},
  computerStatus(active){calls.status.push(active);return active?JSON.stringify(window.statuses):'{}'},
};
window.fixture={act,mount(){const r=createRoot(document.getElementById('root'));r.render(h(Onboarding,{bridge:window.OmpLocal}));return ()=>r.unmount()}};
`, [{
  name: 'onboarding-isolation',
  resolveId(id, importer) { return importer?.endsWith('/Onboarding.tsx') && id in stubs ? '\0stub:' + id : null; },
  load(id) { return id.startsWith('\0stub:') ? stubs[id.slice(6)] : null; },
}]);

async function fixture(t, runtime = {}, statuses = {}) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  Object.assign(w.runtime, runtime);
  w.statuses = statuses;
  let unmount;
  await act(async () => { unmount = w.fixture.mount(); });
  let mounted = true;
  const stop = async () => { if (mounted) { mounted = false; await act(async () => unmount()); } };
  t.after(async () => { try { await stop(); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const el = testId => w.document.querySelector(`[data-testid="${testId}"]`);
  const has = testId => el(testId) !== null;
  const click = testId => act(async () => el(testId).click());
  const text = testId => el(testId)?.textContent ?? null;
  // The 1s visible poll; nothing else on the welcome screen runs on a timer.
  const tick = () => act(async () => { for (const { fn, ms } of [...w.intervals.values()]) if (ms === 1000) fn(); });
  const polling = () => [...w.intervals.values()].some(({ ms }) => ms === 1000);
  const visibility = value => act(async () => {
    Object.defineProperty(w.document, 'visibilityState', { configurable: true, value });
    w.document.dispatchEvent(new w.Event('visibilitychange'));
  });
  const retry = () => act(async () => w.document.querySelector('[data-testid="onboarding-computer-error"] button[aria-label="Retry"]').click());
  return { w, has, click, text, tick, polling, visibility, retry, stop, statusCalls: () => Array.from(w.calls.status), uses: () => Array.from(w.calls.use) };
}

const STOPPED = { installed: true, downloadBytes: 200000000 };

// Assertions compare strings and booleans, never DOM nodes (see support/react-dom.mjs).
test('a fresh install continues into model setup instead of switching modes', async t => {
  const f = await fixture(t);
  await f.click('onboarding-phone');
  assert.equal(f.w.calls.prepare, 1);
  assert.equal(f.has('onboarding-skip') || f.has('onboarding-continue'), true, 'model setup follows');
  assert.deepEqual(Array.from(f.w.calls.modes), []);
});

test('an installed runtime resumes only on request without repeating model setup', async t => {
  const f = await fixture(t, STOPPED);
  assert.deepEqual(Array.from(f.w.calls.modes), [], 'nothing switches before the user asks');
  await f.click('onboarding-phone');
  assert.equal(f.w.calls.prepare, 1);
  assert.deepEqual(Array.from(f.w.calls.modes), ['phone']);
  assert.equal(f.has('onboarding-skip') || f.has('onboarding-continue'), false, 'no repeated model setup');
});

test('no saved computers or first-run setup starts no availability checks', async t => {
  for (const runtime of [
    { ...STOPPED, computers: [] },
    // A first run has no phone runtime to be "stopped"; it never lists computers.
    { installed: false, computers: [DESK] },
  ]) {
    const f = await fixture(t, runtime);
    assert.equal(f.has('onboarding-computer-list'), false);
    assert.deepEqual(f.statusCalls(), []);
    assert.equal(f.polling(), false);
    assert.equal(f.has('onboarding-laptop'), true);
    await f.stop();
  }
});

test('the stopped chooser lists each saved computer with its checked status and keeps the other actions', async t => {
  const f = await fixture(t, { ...STOPPED, computers: [DESK, LAPTOP] });
  assert.equal(f.text('onboarding-computer-status-0'), 'Checking…', 'unknown until the shell answers');
  assert.equal(f.text('onboarding-computer-status-1'), 'Checking…');
  assert.equal(f.has('onboarding-phone'), true);
  assert.equal(f.has('onboarding-laptop'), true);

  f.w.statuses = { [DESK]: 'online', [LAPTOP]: 'offline' };
  await f.tick();
  assert.equal(f.text('onboarding-computer-status-0'), 'Online');
  assert.equal(f.text('onboarding-computer-status-1'), 'Offline');
  assert.equal(f.text('onboarding-computer-1').includes('laptop.tail1234.ts.net:8443'), true, 'the port is part of the address');

  // The same computer can drop and come back while the screen stays open.
  f.w.statuses = { [DESK]: 'offline', [LAPTOP]: 'online' };
  await f.tick();
  assert.equal(f.text('onboarding-computer-status-0'), 'Offline');
  assert.equal(f.text('onboarding-computer-status-1'), 'Online');

  // Looking never chooses.
  assert.deepEqual(f.uses(), []);
  assert.deepEqual(Array.from(f.w.calls.modes), []);
  assert.equal(f.w.calls.prepare, 0);
});

test('an offline computer remains selectable and repeated taps cannot switch twice', async t => {
  const f = await fixture(t, { ...STOPPED, computers: [DESK, LAPTOP] }, { [DESK]: 'online', [LAPTOP]: 'offline' });
  await f.click('onboarding-computer-1');
  await f.click('onboarding-computer-1');
  await f.click('onboarding-computer-0');
  assert.deepEqual(f.uses(), [LAPTOP], 'a second tap cannot restart the shell again');
  assert.deepEqual(Array.from(f.w.calls.modes), [], 'the shell owns the mode change');
  assert.equal(f.w.calls.prepare, 0);
  assert.equal(f.has('onboarding-computer-error'), false);
});

test('a refused switch says why, keeps every computer selectable and can be retried', async t => {
  const f = await fixture(t, { ...STOPPED, computers: [DESK, LAPTOP] });
  f.w.useResult = { ok: false, error: "That computer isn't saved on this phone." };
  await f.click('onboarding-computer-0');
  assert.equal(f.text('onboarding-computer-error').includes("That computer isn't saved on this phone."), true);
  assert.equal(f.has('onboarding-computer-0') && f.has('onboarding-computer-1'), true);

  f.w.useResult = { ok: true };
  await f.retry();
  assert.deepEqual(f.uses(), [DESK, DESK]);
  assert.equal(f.has('onboarding-computer-error'), false);
  await f.click('onboarding-computer-1');
  assert.deepEqual(f.uses(), [DESK, DESK], 'once the shell accepted, nothing else may switch');
});

test('an unreadable shell answer to a switch is a refusal, not a silent success', async t => {
  const f = await fixture(t, { ...STOPPED, computers: [DESK] });
  f.w.useResult = 'not json';
  f.w.OmpLocal.useComputer = url => { f.w.calls.use.push(url); return '{}'; };
  await f.click('onboarding-computer-0');
  assert.equal(f.has('onboarding-computer-error'), true);
  await f.click('onboarding-computer-0');
  assert.equal(f.uses().length, 2, 'refusal leaves it selectable');
});

test('hiding the page stops the check and forgets its answers; showing it starts a fresh one', async t => {
  const f = await fixture(t, { ...STOPPED, computers: [DESK] }, { [DESK]: 'online' });
  await f.tick();
  assert.equal(f.text('onboarding-computer-status-0'), 'Online');

  await f.visibility('hidden');
  assert.equal(f.statusCalls().at(-1), false, 'native work is cancelled');
  assert.equal(f.polling(), false, 'no timer survives while hidden');
  assert.equal(f.text('onboarding-computer-status-0'), 'Checking…', 'an old answer is not shown as current');
  const calls = f.statusCalls().length;
  await f.tick();
  assert.equal(f.statusCalls().length, calls, 'hidden pages never ask');

  await f.visibility('visible');
  assert.equal(f.statusCalls().at(-1), true);
  assert.equal(f.polling(), true);
  assert.equal(f.text('onboarding-computer-status-0'), 'Online');
});

test('leaving the chooser stops the check', async t => {
  const f = await fixture(t, { ...STOPPED, computers: [DESK] }, { [DESK]: 'online' });
  await f.click('onboarding-laptop');
  assert.equal(f.has('onboarding-computer-list'), false);
  assert.equal(f.statusCalls().at(-1), false);
  assert.equal(f.polling(), false);
  assert.deepEqual(f.uses(), []);
});

test('resuming on the phone also stops the check without switching to a computer', async t => {
  const f = await fixture(t, { ...STOPPED, computers: [DESK] }, { [DESK]: 'online' });
  await f.click('onboarding-phone');
  assert.deepEqual(Array.from(f.w.calls.modes), ['phone']);
  assert.deepEqual(f.uses(), []);
  assert.equal(f.statusCalls().at(-1), false);
  assert.equal(f.polling(), false);
});

test('unmounting cancels the check and removes its timer', async t => {
  const f = await fixture(t, { ...STOPPED, computers: [DESK] });
  assert.equal(f.polling(), true);
  await f.stop();
  assert.equal(f.statusCalls().at(-1), false);
  assert.equal(f.polling(), false);
});
