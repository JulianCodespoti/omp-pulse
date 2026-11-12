import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const stubs = {
  '../platform/service-worker': `export const applyClientUpdate=()=>{throw Error('Forbidden update')};`,
  '../runtime/rpc-client': `export class DaemonApi {async fetchJson(){
    if(window.services.rejected) throw Object.assign(new Error('Authentication failed'),{name:'AuthError',status:401});
    if(window.services.offline) throw new TypeError('Failed to fetch');
    return {releaseId:'unit'};
  }}`,
  './DeviceAccess': `export const DeviceAccess=()=>null,PairAnotherDevice=()=>null;`,
  './HealthPanel': `export const HealthPanel=()=>null,HealthDetails=()=>null;`,
  './LocalModeSettings': `export const useLocalMode=()=>window.services.local,RunOnSettings=()=>null,PhoneAccessSettings=()=>null;`,
  './Notices': `export const showToast=()=>{};`,
};
const code = await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {SettingsScreen} from ${JSON.stringify(resolve(root, 'web/src/app/SettingsScreen.tsx'))};
window.services={rejected:false,offline:false,local:null};
const controller={beginPairingRepair:()=>()=>{},getStore:()=>({getState:()=>({sessions:[],sessionPath:null}),subscribe:()=>()=>{}})};
window.fixture={act,mount(){const r=createRoot(document.getElementById('root'));r.render(h(SettingsScreen,{onClose(){},controller,onConnected(){}}));return {unmount:()=>r.unmount()}}};
`, [{
  name: 'settings-root-isolation',
  resolveId(id, importer) { return importer?.endsWith('/SettingsScreen.tsx') && id in stubs ? '\0stub:' + id : null; },
  load(id) { return id.startsWith('\0stub:') ? stubs[id.slice(6)] : null; },
}]);

async function fixture(t, services = {}) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  Object.assign(w.services, services);
  let mounted;
  await act(async () => { mounted = w.fixture.mount(); });
  t.after(async () => {
    try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); }
  });
  const rootPage = () => w.document.querySelector('[data-settings-page="root"]');
  return { w, act, rootPage };
}

// Assertions here compare booleans, never DOM nodes: a failed assert on a live jsdom
// element makes the test reporter pretty-print the whole window, which pins a core and
// grows without bound (it froze the developer's machine before this was understood).
test('Pair this device is gone while pairing works, and no repair row is offered', async t => {
  const f = await fixture(t);
  assert.equal(f.rootPage().querySelector('[data-testid="settings-repair-pairing"]') === null, true);
  assert.equal(f.rootPage().textContent.includes('Pair this device'), false);
  assert.equal(f.rootPage().textContent.includes('Repair pairing'), false);
});

test('a computer that cannot be reached is not a pairing problem', async t => {
  const f = await fixture(t, { offline: true });
  assert.equal(f.rootPage().querySelector('[data-testid="settings-repair-pairing"]') === null, true);
  assert.ok(f.rootPage().textContent.includes('Can\u2019t reach'));
});

test('a rejected credential offers Repair pairing, which opens the repair variant', async t => {
  const f = await fixture(t, { rejected: true });
  const row = f.rootPage().querySelector('[data-testid="settings-repair-pairing"]');
  assert.equal(row !== null, true, 'the repair row is offered');
  assert.ok(f.rootPage().textContent.includes('Pairing needed'));
  assert.equal(f.rootPage().textContent.includes('Pair this device'), false);
  await f.act(async () => row.click());
  const page = f.w.document.querySelector('[data-settings-page="repair-pairing"]');
  await f.act(async () => {});
  const pair = page.querySelector('[data-testid="pair-screen"]');
  assert.equal(pair !== null, true, 'the pairing form is shown');
  // The page's own header is an <h1> ("Repair pairing"); only the first-run hero is unwanted.
  assert.equal(pair.querySelector('h1') === null, true, 'no first-run hero inside Settings');
  assert.equal(page.textContent.includes('already connected'), false);
  assert.equal(page.textContent.includes('Pair another device'), false);
});

// The bridge lives on the test side: `calls` records what the app asked of it.
const phone = (overrides = {}) => {
  const calls = { modes: [], error: null };
  return {
    calls, onPhone: true, switching: false, summary: 'This phone', tone: 'ok', status: 'Running on this phone',
    bridge: { setMode(mode) { calls.modes.push(mode); if (calls.error) throw new Error(calls.error); } },
    ...overrides,
  };
};
const control = (f, id) => f.rootPage().querySelector(`[data-testid="${id}"]`);
const confirmButton = f => f.w.document.querySelector('[data-testid="confirm-sheet-confirm"]');

test('computer mode keeps the pairing actions and has no phone-mode stop', async t => {
  const f = await fixture(t);
  assert.equal(control(f, 'settings-unpair') !== null, true);
  assert.equal(control(f, 'settings-computer') !== null, true);
  assert.equal(control(f, 'settings-stop-phone') === null, true);
  assert.equal(control(f, 'settings-phone-access') === null, true);
  assert.equal(control(f, 'settings-providers') !== null, true);
});

test('the app on a phone paired to a computer still unpairs and has no stop', async t => {
  const f = await fixture(t, { local: phone({ onPhone: false, summary: 'Computer' }) });
  assert.equal(control(f, 'settings-unpair') !== null, true);
  assert.equal(control(f, 'settings-run-on') !== null, true);
  assert.equal(control(f, 'settings-stop-phone') === null, true);
});

test('phone mode offers stop and phone controls but never PC pairing, even when a stale credential is refused', async t => {
  const f = await fixture(t, { local: phone(), rejected: true });
  for (const id of ['settings-stop-phone', 'settings-phone-access', 'settings-device-access', 'settings-run-on', 'settings-providers'])
    assert.equal(control(f, id) !== null, true, `${id} is offered`);
  for (const id of ['settings-unpair', 'settings-repair-pairing', 'settings-computer', 'settings-saved-work'])
    assert.equal(control(f, id) === null, true, `${id} is not offered`);
  assert.equal(f.rootPage().textContent.includes('Pairing needed'), false);
  // Stop sits with the phone controls, not among general preferences.
  const group = control(f, 'settings-stop-phone').closest('[data-slot="row-group"]');
  assert.equal(group.contains(control(f, 'settings-phone-access')), true);
  assert.equal(group.contains(control(f, 'settings-notifications')), false);
});

test('stopping phone mode needs confirmation; cancel changes nothing', async t => {
  const local = phone();
  const f = await fixture(t, { local });
  await f.act(async () => control(f, 'settings-stop-phone').click());
  assert.deepEqual(local.calls.modes, [], 'opening the confirmation does not stop anything');
  const cancel = [...f.w.document.querySelectorAll('button')].find(el => el.textContent.trim() === 'Cancel');
  await f.act(async () => cancel.click());
  assert.deepEqual(local.calls.modes, []);
  await f.act(async () => control(f, 'settings-stop-phone').click());
  await f.act(async () => confirmButton(f).click());
  assert.deepEqual(local.calls.modes, ['unset'], 'only explicit confirmation stops the runtime');
});


test('a refused stop is reported in the confirmation and can be retried', async t => {
  const local = phone();
  local.calls.error = 'bridge refused';
  const f = await fixture(t, { local });
  await f.act(async () => control(f, 'settings-stop-phone').click());
  await f.act(async () => confirmButton(f).click());
  assert.deepEqual(local.calls.modes, ['unset']);
  assert.equal(f.w.document.querySelector('[data-slot="notice"][data-tone="danger"]') !== null, true, 'the failure is shown');
  assert.equal(confirmButton(f).disabled, false, 'the sheet stays open for a retry');
  local.calls.error = null;
  await f.act(async () => confirmButton(f).click());
  assert.deepEqual(local.calls.modes, ['unset', 'unset']);
});
