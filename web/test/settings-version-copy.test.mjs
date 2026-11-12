import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const version = ' build-0123456789abcdef-π ';
const stubs = {
  '../platform/push': `export const isPushSupported=()=>false,pushStatus=()=> 'default',pushSubscriptionStatus=async()=>false,subscribePush=()=>{throw Error('Forbidden push')},unsubscribePush=subscribePush;`,
  '../platform/browser-storage': `export const readPairingToken=()=>'',clearPairingToken=()=>{throw Error('Forbidden pairing')};`,
  '../platform/service-worker': `export const applyClientUpdate=()=>{throw Error('Forbidden update')};`,
  '../platform/native-notifications': `export const hasNativeNotificationControls=()=>false,clearNativeNotificationToken=()=>{throw Error('Forbidden native')},openNativeNotificationControls=clearNativeNotificationToken;`,
  '../runtime/rpc-client': `export class DaemonApi {async fetchJson(){return {releaseId:window.services.version}}}`,
  './DeviceAccess': `export const DeviceAccess=()=>null,PairAnotherDevice=()=>null;`,
  './HealthPanel': `export const HealthPanel=()=>null,HealthDetails=()=>null;`,
  './LocalModeSettings': `export const useLocalMode=()=>null,RunOnSettings=()=>null,PhoneAccessSettings=()=>null;`,
  './Notices': `export const showToast=(...args)=>window.services.toasts.push(args);`,
};
const code = await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {SettingsScreen} from ${JSON.stringify(resolve(root, 'web/src/app/SettingsScreen.tsx'))};
window.services={version:${JSON.stringify(version)},toasts:[]};
window.fixture={act,mount(){const r=createRoot(document.getElementById('root'));r.render(h(SettingsScreen,{onClose(){},controller:new Proxy({},{get(){throw Error('Forbidden controller access')}})}));return {unmount:()=>r.unmount()}}};
`, [{
  name: 'version-copy-platform-isolation',
  resolveId(id, importer) { return importer?.endsWith('/SettingsScreen.tsx') && id in stubs ? '\0stub:' + id : null; },
  load(id) { return id.startsWith('\0stub:') ? stubs[id.slice(6)] : null; },
}]);

async function fixture(t, { modern, legacy = true } = {}) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  const writes = [], fallbacks = [], errors = [];
  w.Element.prototype.getAnimations = () => [];
  w.addEventListener('error', event => { errors.push(event.error); event.preventDefault(); });
  Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: modern ? {
    writeText(text) { writes.push(text); return modern(text); },
  } : undefined });
  w.document.execCommand = command => {
    assert.equal(command, 'copy');
    fallbacks.push(w.document.querySelector('textarea').value);
    if (legacy instanceof Error) throw legacy;
    return legacy;
  };
  let mounted, unmounted = false;
  await act(async () => { mounted = w.fixture.mount(); });
  const unmount = async () => { if (!unmounted) { unmounted = true; await act(async () => mounted.unmount()); } };
  t.after(async () => {
    try { await unmount(); assert.deepEqual(dom.blocked, []); assert.deepEqual(errors, []); }
    finally { dom.close(); }
  });
  // Build ids live in About only: open it the way a person would.
  await act(async () => w.document.querySelector('[data-testid="settings-about"]').click());
  const page = () => w.document.querySelector('[data-settings-page="about"]');
  const buttons = () => [...page().querySelectorAll('button[aria-label="Copy version"]')];
  const button = (index = 1) => buttons()[index];
  return { w, act, writes, fallbacks, errors, unmount, button, page,
    click: (index = 1) => act(async () => button(index).click()),
    toasts: () => Array.from(w.services.toasts, args => Array.from(args)),
  };
}

test('build ids appear only on the About page, with the computer state on the root row', async t => {
  const f = await fixture(t);
  const rootPage = f.w.document.querySelector('[data-settings-page="root"]');
  assert.equal(rootPage.querySelector('button[aria-label="Copy version"]'), null);
  assert.equal(rootPage.textContent.includes('build-0123'), false);
  assert.ok(rootPage.textContent.includes('Update available'));
  assert.equal(rootPage.textContent.includes('Daemon'), false);
  assert.ok(f.page().textContent.includes('Computer build'));
});

test('missing clipboard API copies full computer version through acknowledged fallback', async t => {
  const f = await fixture(t);
  await f.click();
  assert.deepEqual(f.fallbacks, [version]);
  assert.deepEqual(f.toasts(), [['Copied version', 'success']]);
  assert.equal(f.w.document.querySelector('textarea') === null, true);
  const label = f.button().previousElementSibling;
  assert.equal(label.title, version);
  assert.equal(label.textContent, `${version.slice(0, 8)}…${version.slice(-6)}`);
});

test('modern success copies each row exactly without fallback', async t => {
  const f = await fixture(t, { modern: async () => {} });
  await f.click(0); await f.click();
  assert.deepEqual(f.writes, ['unit', version]);
  assert.deepEqual(f.fallbacks, []);
  assert.deepEqual(f.toasts(), [['Copied version', 'success'], ['Copied version', 'success']]);
});

for (const modern of [() => { throw Error('sync denial'); }, async () => { throw Error('denied'); }]) {
  test(`modern ${modern.constructor.name} failure uses acknowledged fallback`, async t => {
    const f = await fixture(t, { modern }); await f.click();
    assert.deepEqual(f.writes, [version]); assert.deepEqual(f.fallbacks, [version]);
    assert.deepEqual(f.toasts(), [['Copied version', 'success']]);
  });
}

for (const legacy of [false, new Error('legacy denied')]) {
  test(`failed fallback (${String(legacy)}) reports error without success`, async t => {
    const f = await fixture(t, { legacy }); await f.click();
    assert.deepEqual(f.toasts(), [['Couldn’t copy the version.', 'error']]);
    assert.equal(f.w.document.querySelector('textarea') === null, true);
    await f.click(); assert.equal(f.fallbacks.length, 2);
  });
}

test('same-tick duplicate taps issue one pending write and allow retry after failure', async t => {
  let finish;
  const f = await fixture(t, { modern: () => new Promise((resolve, reject) => { finish = { resolve, reject }; }), legacy: false });
  await f.act(async () => { f.button().click(); f.button().click(); });
  assert.equal(f.writes.length, 1);
  await f.act(async () => finish.reject(Error('denied')));
  assert.deepEqual(f.toasts(), [['Couldn’t copy the version.', 'error']]);
  await f.click(); assert.equal(f.writes.length, 2);
  await f.act(async () => finish.resolve());
  assert.deepEqual(f.toasts().at(-1), ['Copied version', 'success']);
});

test('a copy still pending when Settings closes reports nothing', async t => {
  let reject;
  const f = await fixture(t, { modern: () => new Promise((_, fail) => { reject = fail; }), legacy: false });
  await f.click(); await f.unmount(); await f.act(async () => reject(Error('old')));
  assert.deepEqual(f.toasts(), []);
});

test('Back pops About before Settings closes', async t => {
  const f = await fixture(t);
  await f.act(async () => f.page().querySelector('button[aria-label="Back"]').click());
  await f.act(() => new Promise(r => f.w.setTimeout(r, 450)));
  assert.equal(f.w.document.querySelector('[data-settings-page="about"]'), null);
  assert.equal(f.w.document.querySelector('[data-settings-page="root"]').hasAttribute('inert'), false);
});

test('appearance text size scales the root rem and persists', async t => {
  const f = await fixture(t);
  await f.act(async () => f.page().querySelector('button[aria-label="Back"]').click());
  await f.act(() => new Promise(r => f.w.setTimeout(r, 450)));
  await f.act(async () => f.w.document.querySelector('[data-testid="settings-appearance"]').click());
  const textTab = [...f.w.document.querySelectorAll('[data-settings-page="appearance"] [data-testid="appearance-tabs"] [role="radio"]')].find(b => b.textContent === 'Text');
  await f.act(async () => textTab.click());
  const radio = (label) => [...f.w.document.querySelectorAll('[data-settings-page="appearance"] [data-testid="appearance-text-size"] [role="radio"]')].find(b => b.textContent === label);
  const option = radio('Larger');
  await f.act(async () => option.click());
  assert.equal(f.w.document.documentElement.style.fontSize, '125%');
  assert.equal(JSON.parse(f.w.localStorage.getItem('omp-appearance')).textSize, 'larger');
  const reset = radio('Default');
  await f.act(async () => reset.click());
  assert.equal(f.w.document.documentElement.style.fontSize, '');
  assert.equal(f.w.localStorage.getItem('omp-appearance'), null);
  // The Android shell's system font scale multiplies the chosen size, so a
  // phone set one step small renders like its native apps.
  f.w.OmpNative = { senderRequired: () => true, fontScale: () => 0.9 };
  await f.act(async () => option.click());
  assert.equal(f.w.document.documentElement.style.fontSize, '112.5%');
  await f.act(async () => reset.click());
  assert.equal(f.w.document.documentElement.style.fontSize, '90%');
});
