import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {ProviderSignIn,parseSignInPrompt} from ${JSON.stringify(resolve(root, 'web/src/app/ProviderSignIn.tsx'))};
const PROMPT='Open this link to sign in:\\nhttps://example.test/auth?code=true&id=1.\\nThen enter code ABCD-1234.';
const net={log:[],lists:0,signedIn:['anthropic'],started:null,login:{running:false,exitCode:null,output:''},signedAfterLogin:false};
const providers=[{id:'zzz-proxy',label:'Zzz Proxy'},{id:'openrouter',label:'OpenRouter'},{id:'openai-codex',label:'ChatGPT Plus/Pro'},{id:'anthropic',label:'Anthropic'},{id:'aaa-custom',label:'Aaa Custom'}];
const transport={
  list:async()=>{net.lists++;return {error:null,providers:providers.map(p=>({...p,signedIn:net.signedIn.includes(p.id)}))}},
  start:async id=>{net.log.push('start:'+id);net.started=id;net.login={running:true,exitCode:null,output:PROMPT}},
  state:async()=>({...net.login}),
  send:async text=>{net.log.push('send:'+text);net.signedIn.push(net.started);net.login={running:false,exitCode:0,output:PROMPT+'\\nSigned in.'}},
  cancel:async()=>{net.log.push('cancel');net.login={running:false,exitCode:null,output:''}},
};
const calls={signedIn:[],status:[],choose:0};
window.fixture={act,net,calls,parseSignInPrompt,
  mount(props){const r=createRoot(document.getElementById('root'));
    r.render(h(ProviderSignIn,{transport,active:true,onSignedIn:id=>calls.signedIn.push(id),onStatus:v=>calls.status.push(v),...props,onChooseModel:props?.choose?()=>calls.choose++:undefined}));
    return ()=>r.unmount()}};
`);

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function fixture(t, props = {}, setup = () => {}) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  setup(f.net);
  let unmount;
  await f.act(async () => { unmount = f.mount(props); });
  t.after(async () => { try { await f.act(async () => unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const doc = w.document;
  const q = (selector) => doc.querySelector(selector);
  const text = () => doc.body.textContent;
  const click = async (node) => { assert.ok(node); await f.act(async () => node.click()); };
  const button = (label) => [...doc.querySelectorAll('button')].find((b) => b.textContent.trim() === label || b.getAttribute('aria-label') === label);
  // Polling is real time (700 ms); give it room.
  const until = async (check) => {
    for (let i = 0; i < 40; i++) {
      if (check()) return;
      await f.act(async () => { await sleep(100); });
    }
    assert.fail('condition never held: ' + check);
  };
  const rowIds = () => [...doc.querySelectorAll('[data-testid="provider-add-sheet"] [data-slot="row"]')].map((r) => r.getAttribute('data-testid'));
  const paste = async (value) => {
    const input = q('input[aria-label="Code, redirect link or API key"]');
    assert.ok(input);
    await f.act(async () => {
      Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new w.Event('input', { bubbles: true }));
    });
  };
  const startChatGpt = async () => {
    await click(q('[data-testid="provider-add"]'));
    await click(q('[data-testid="provider-openai-codex"]'));
  };
  return { w, f, q, text, click, button, until, rowIds, paste, startChatGpt, doc };
}

test('lists signed-in providers first with a tick, then an Add a provider row', async (t) => {
  const x = await fixture(t);
  await x.until(() => x.q('[data-testid="provider-signed-in-row"]'));
  const rows = [...x.doc.querySelectorAll('[data-testid="provider-signed-in-row"]')];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].textContent, 'Anthropic');
  assert.equal(Boolean(rows[0].querySelector('[aria-label="Signed in"]')), true);
  assert.equal(x.q('[data-testid="provider-signed-in-row"]').compareDocumentPosition(x.q('[data-testid="provider-add"]')) & 4, 4, 'Add follows the signed-in group');
  assert.equal(JSON.stringify(x.f.calls.status), '[true]');
});

test('Add a provider: featured first, searchable, signed-in ones ticked', async (t) => {
  const x = await fixture(t);
  await x.until(() => x.q('[data-testid="provider-add"]'));
  await x.click(x.q('[data-testid="provider-add"]'));
  assert.deepEqual(x.rowIds(), ['provider-anthropic', 'provider-openai-codex', 'provider-openrouter', 'provider-aaa-custom', 'provider-zzz-proxy']);
  assert.equal(Boolean(x.q('[data-testid="provider-anthropic"] [aria-label="Signed in"]')), true);
  assert.equal(Boolean(x.q('[data-testid="provider-openrouter"] [aria-label="Signed in"]')), false);
  const search = x.q('[data-testid="provider-search"]');
  await x.f.act(async () => {
    Object.getOwnPropertyDescriptor(x.w.HTMLInputElement.prototype, 'value').set.call(search, 'zzz');
    search.dispatchEvent(new x.w.Event('input', { bubbles: true }));
  });
  assert.deepEqual(x.rowIds(), ['provider-zzz-proxy']);
});

test('signing in shows the link as a button and the device code with Copy, all inline', async (t) => {
  const x = await fixture(t);
  await x.until(() => x.q('[data-testid="provider-add"]'));
  await x.startChatGpt();
  await x.until(() => x.q('[data-testid="provider-auth-link"]'));
  assert.equal(JSON.stringify(x.f.net.log), '["start:openai-codex"]');
  const link = x.q('[data-testid="provider-auth-link"]');
  assert.equal(link.getAttribute('href'), 'https://example.test/auth?code=true&id=1');
  assert.equal(link.getAttribute('target'), '_blank');
  assert.equal(x.q('[data-testid="provider-device-code"]').textContent.includes('ABCD-1234'), true);
  assert.equal(Boolean(x.button('Copy code')), true);
  assert.equal(Boolean(x.q('input[aria-label="Code, redirect link or API key"]')), true);
  assert.equal(x.doc.querySelector('details'), null, 'nothing is hidden behind an expander');
  assert.equal(x.text().includes('ChatGPT Plus/Pro'), true);
});

test('a pasted code reaches the sign-in, success refreshes and offers Choose a model', async (t) => {
  const x = await fixture(t, { choose: true });
  await x.until(() => x.q('[data-testid="provider-add"]'));
  const listsBefore = x.f.net.lists;
  await x.startChatGpt();
  await x.until(() => x.q('input[aria-label="Code, redirect link or API key"]'));
  assert.equal(x.button('Send').disabled, true, 'nothing to send yet');
  await x.paste('  pasted-secret  ');
  await x.click(x.button('Send'));
  assert.equal(JSON.stringify(x.f.net.log), '["start:openai-codex","send:pasted-secret"]');
  await x.until(() => x.q('[data-testid="provider-signed-in"]'));
  assert.equal(x.q('[data-testid="provider-signed-in"]').textContent.includes('Signed in to ChatGPT Plus/Pro.'), true);
  assert.equal(JSON.stringify(x.f.calls.signedIn), '["openai-codex"]', 'the catalogue refresh is requested once');
  await x.until(() => x.f.net.lists > listsBefore);
  await x.until(() => x.doc.querySelectorAll('[data-testid="provider-signed-in-row"]').length === 2);
  await x.click(x.button('Choose a model'));
  assert.equal(x.f.calls.choose, 1);
});

test('Cancel stops the sign-in and returns to the list', async (t) => {
  const x = await fixture(t);
  await x.until(() => x.q('[data-testid="provider-add"]'));
  await x.startChatGpt();
  await x.until(() => x.q('[data-testid="provider-cancel"]'));
  await x.click(x.q('[data-testid="provider-cancel"]'));
  assert.equal(JSON.stringify(x.f.net.log), '["start:openai-codex","cancel"]');
  await x.until(() => x.q('[data-testid="provider-add"]'));
  assert.equal(x.q('[data-testid="provider-auth-link"]'), null);
  assert.equal(JSON.stringify(x.f.calls.signedIn), '[]');
});

test('a failed sign-in says so inline with Try again and its output', async (t) => {
  const x = await fixture(t);
  await x.until(() => x.q('[data-testid="provider-add"]'));
  await x.startChatGpt();
  await x.until(() => x.q('[data-testid="provider-cancel"]'));
  x.f.net.login = { running: false, exitCode: 1, output: 'Error: access_denied' };
  await x.until(() => x.q('[data-testid="provider-failed"]'));
  assert.equal(x.text().includes('Couldn’t sign in to ChatGPT Plus/Pro.'), true);
  assert.equal(x.text().includes('access_denied'), true);
  await x.click(x.button('Try again'));
  assert.equal(JSON.stringify(x.f.net.log), '["start:openai-codex","start:openai-codex"]');
});

test('a read-only device sees the list and one line of explanation, no way to add', async (t) => {
  const x = await fixture(t, { canManage: false });
  await x.until(() => x.q('[data-testid="provider-signed-in-row"]'));
  assert.equal(x.q('[data-testid="provider-add"]'), null);
  assert.equal(x.text().split('Only an admin device can add providers.').length - 1, 1);
});

test('providers serving models count as signed in when the credential store lists none', async (t) => {
  const x = await fixture(t, { catalogueProviders: ['openrouter'] }, (net) => { net.signedIn.length = 0; });
  assert.equal(x.f.net.signedIn.length, 0);
  await x.until(() => [...x.doc.querySelectorAll('[data-testid="provider-signed-in-row"]')].some((r) => r.textContent === 'OpenRouter'));
});

test('the link and device code are read out of omp’s output', async (t) => {
  const x = await fixture(t);
  const parse = x.f.parseSignInPrompt;
  assert.deepEqual({ ...parse('Visit https://github.com/login/device and enter ABCD-1234') }, { url: 'https://github.com/login/device', code: 'ABCD-1234' });
  assert.deepEqual({ ...parse('Open https://x.test/a?client_id=9d1c250a-77') }, { url: 'https://x.test/a?client_id=9d1c250a-77', code: null });
  assert.deepEqual({ ...parse('Paste the API key:') }, { url: null, code: null });
  assert.equal(parse('see https://user:pw@evil.test/').url, null, 'credentials in a link are never offered');
});
