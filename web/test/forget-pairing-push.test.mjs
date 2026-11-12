import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const stubs = {
  '../platform/service-worker': `export const applyClientUpdate=()=>{throw Error('Unexpected update')};`,
  '../platform/native-notifications': `export const hasNativeNotificationControls=()=>false,clearNativeNotificationToken=async()=>{},openNativeNotificationControls=()=>{};`,
  '../runtime/rpc-client': `export class DaemonApi {
    constructor(token){this.token=token}
    async fetchJson(path,init){
      if(path==='/api/device'){if(window.services.offline)throw Error('Offline');return {device:{id:'phone-1'}}}
      if(init?.method==='DELETE'){if(this.token!=='test-pairing')throw Error('Credential lost before revoke');window.services.revoked=decodeURIComponent(path.split('/').pop());return {ok:true}}
      return {releaseId:'unit'}
    }
    async vapidPublicKey(){return 'AQID'}
    async pushSubscribe(){window.services.remote=true}
    async pushUnsubscribe(){
      if(this.token!=='test-pairing')throw Error('Credential lost before unsubscribe');
      if(window.services.offline)throw Error('Offline');
      window.services.remote=false;
    }
  }`,
  './DeviceAccess': `export const DeviceAccess=()=>null,PairAnotherDevice=()=>null;`,
  './HealthPanel': `export const HealthPanel=()=>null,HealthDetails=()=>null;`,
  './LocalModeSettings': `export const useLocalMode=()=>null,RunOnSettings=()=>null,PhoneAccessSettings=()=>null;`,
  './Notices': `export const showToast=(...args)=>window.services.toasts.push(args);`,
};
const code = await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {SettingsScreen} from ${JSON.stringify(resolve(root, 'web/src/app/SettingsScreen.tsx'))};
import {unsubscribePush} from ${JSON.stringify(resolve(root, 'web/src/platform/push.ts'))};
const services=window.services={local:true,remote:true,offline:false,failLocal:false,registered:true,signedOut:false,cleared:false,revoked:null,toasts:[]};
localStorage.setItem('omp-remote-token','test-pairing');
Object.defineProperty(window,'isSecureContext',{value:true});
window.Notification={permission:'granted'};
window.PushManager=class {};
const subscription={endpoint:'https://push.invalid/test',toJSON:()=>({endpoint:'https://push.invalid/test',keys:{p256dh:'test',auth:'test'}}),async unsubscribe(){if(services.failLocal)throw Error('Could not remove subscription');services.local=false;return true}};
const registration={pushManager:{getSubscription:async()=>services.local?subscription:null,subscribe:()=>new Promise(resolve=>{services.finishSubscribe=()=>{services.local=true;resolve(subscription)}})}};
Object.defineProperty(navigator,'serviceWorker',{value:{getRegistration:async()=>services.registered?registration:undefined,ready:Promise.resolve(registration)}});
window.fetch=async()=>({ok:true,json:async()=>({subscribed:services.remote})});
const state={setSessions(){},setAuthRejected(value){services.signedOut=value}};
const controller={clearOfflineData:async()=>{services.cleared=true},closeSession(){},getStore:()=>({getState:()=>state})};
window.fixture={act,unsubscribePush,mount(){const r=createRoot(document.getElementById('root'));r.render(h(SettingsScreen,{onClose(){},controller}));return ()=>r.unmount()}};
`, [{
  name: 'pairing-push-platform',
  resolveId(id, importer) {
    return (importer?.endsWith('/SettingsScreen.tsx') || importer?.endsWith('/platform/push.ts')) && id in stubs ? '\0stub:' + id : null;
  },
  load(id) { return id.startsWith('\0stub:') ? stubs[id.slice(6)] : null; },
}]);

async function fixture(t, initial = {}) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  Object.assign(w.services, initial);
  w.Element.prototype.getAnimations = () => [];
  let unmount;
  await act(async () => { unmount = w.fixture.mount(); });
  t.after(async () => { try { await act(async () => unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const click = async text => act(async () => {
    const button = [...w.document.querySelectorAll('button')].find(el => el.textContent.trim() === text);
    assert.equal(Boolean(button), true, `Missing button: ${text}`);
    button.click();
  });
  return { w, act, state: w.services, click, async forget() { await click('Unpair this phone'); await click('Unpair'); } };
}

test('forgetting pairing removes browser and daemon notification delivery before sign-out', async t => {
  const f = await fixture(t);
  await f.forget();
  assert.equal(f.state.local, false);
  assert.equal(f.state.remote, false);
  assert.equal(f.state.signedOut, true);
  assert.equal(f.w.localStorage.getItem('omp-remote-token'), null);
  assert.equal(f.state.revoked, 'phone-1', 'the computer revokes this phone with its own credential, before sign-out clears it');
  assert.equal(f.state.toasts.length, 0);
});

test('offline sign-out still stops browser delivery', async t => {
  const f = await fixture(t);
  f.state.offline = true;
  await f.forget();
  assert.equal(f.state.local, false);
  assert.equal(f.state.signedOut, true);
  assert.equal(f.state.revoked, null);
  assert.match(String(f.state.toasts.at(-1)?.[0]), /couldn.t be reached.*Settings › Devices/, 'an unreachable computer is named, not silently skipped');
});

test('failed local unsubscribe keeps pairing available for retry', async t => {
  const f = await fixture(t);
  f.state.failLocal = true;
  await f.forget();
  assert.equal(f.state.local, true);
  assert.equal(f.state.signedOut, false);
  assert.equal(f.state.cleared, false);
  assert.equal(f.w.localStorage.getItem('omp-remote-token'), 'test-pairing');
  assert.equal(f.state.revoked, null, 'a failed unsubscribe stops before the computer revokes this phone');
  f.state.failLocal = false;
  await f.click('Unpair');
  assert.equal(f.state.local, false);
  assert.equal(f.state.signedOut, true);
});

test('a client without a worker can forget pairing without awaiting worker readiness', async t => {
  const f = await fixture(t);
  f.state.registered = false;
  Object.defineProperty(f.w.navigator.serviceWorker, 'ready', { get() { throw Error('Must not await worker installation'); } });
  await f.forget();
  assert.equal(f.state.signedOut, true);
});

test('forget waits for an in-flight notification enable then removes its subscription', async t => {
  const f = await fixture(t, { local: false, remote: false });
  // The switch lives on the Notifications page now; the root row only opens it.
  await f.act(async () => f.w.document.querySelector('[data-testid="settings-notifications"]').click());
  await f.act(async () => f.w.document.querySelector('[data-settings-page="notifications"] [role="switch"]').click());
  assert.equal(typeof f.state.finishSubscribe, 'function');
  await f.forget();
  assert.equal(f.state.signedOut, false);
  await f.act(async () => f.state.finishSubscribe());
  assert.equal(f.state.local, false);
  assert.equal(f.state.remote, false);
  assert.equal(f.state.signedOut, true);
});
