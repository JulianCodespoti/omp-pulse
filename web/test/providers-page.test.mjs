import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
// The page asks its own computer for this device's role and the providers; the
// phone's bridge answers for the phone. Each answer is logged so a test can say
// which transport was used.
const daemon = 'const log=n=>{(window.providerCalls??=[]).push(n)};export class DaemonApi{async deviceRole(){log("role");return window.deviceRole??"read"}async listProviders(){log("list");return [{id:"anthropic",label:"Claude",signedIn:false}]}async startProviderLogin(){log("start")}async providerLoginState(){return {running:false,exitCode:null,output:""}}async sendProviderLoginInput(){}async cancelProviderLogin(){}}';
const code = await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {ProvidersPage} from ${JSON.stringify(resolve(root, 'web/src/app/settings/ProvidersPage.tsx'))};
const store={getState:()=>({sessions:[]}),subscribe:()=>()=>{}};
const bridgeCalls=[];
window.fixture={act,bridgeCalls,mount(mode){
  window.OmpLocal=mode==='web'?undefined:{state:()=>JSON.stringify({mode,supported:true}),providers:()=>{bridgeCalls.push('providers');return JSON.stringify([{id:'anthropic',label:'Claude',signedIn:true}])},loginState:()=>JSON.stringify({running:false,exitCode:null,output:''}),loginStart:()=>bridgeCalls.push('start'),loginInput:()=>{},loginCancel:()=>{}};
  const r=createRoot(document.getElementById('root'));r.render(h(ProvidersPage,{controller:{getStore:()=>store}}));return ()=>r.unmount()}};
`, [{ name: 'providers-page-daemon', resolveId: (id, importer) => importer?.endsWith('/ProvidersPage.tsx') && id === '../../runtime/rpc-client' ? '\0stub:daemon' : null, load: (id) => id === '\0stub:daemon' ? daemon : null }]);

async function fixture(t, mode, role) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  if (role) w.deviceRole = role;
  let unmount;
  await f.act(async () => { unmount = f.mount(mode); });
  // The phone's list is deferred past the page's opening animation.
  await f.act(async () => { await new Promise((done) => setTimeout(done, 250)); });
  t.after(async () => { try { await f.act(async () => unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  return { w, f, text: () => w.document.body.textContent, add: () => w.document.querySelector('[data-testid="provider-add"]'), calls: () => (w.providerCalls ?? []).join() };
}

for (const mode of ['web', 'laptop']) {
  test(`${mode}: a read-only device lists the computer's providers and cannot add`, async (t) => {
    const x = await fixture(t, mode, 'control');
    assert.equal(x.calls(), 'role,list');
    assert.equal(x.text().includes('Only an admin device can add providers.'), true);
    assert.equal(x.add(), null);
    assert.equal(x.f.bridgeCalls.length, 0, 'the phone bridge is never asked about a computer');
  });

  test(`${mode}: an administrator signs in through the daemon`, async (t) => {
    const x = await fixture(t, mode, 'admin');
    assert.equal(x.calls(), 'role,list');
    assert.equal([...x.w.document.querySelectorAll('button')].some((b) => b.textContent === 'Add a provider'), true);
    assert.equal(x.f.bridgeCalls.length, 0);
  });
}

test('phone: the phone is its own administrator and uses the bridge only', async (t) => {
  const x = await fixture(t, 'phone');
  assert.equal(x.calls(), '', 'no daemon role or list call');
  assert.equal(x.f.bridgeCalls.join(), 'providers');
  assert.notEqual(x.add(), null);
  assert.equal(x.text().includes('Claude'), true);
});
