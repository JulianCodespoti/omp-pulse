import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const rpc = resolve(root, 'web/src/runtime/rpc-client.ts');
const code = await bundleDomFixture(`
  import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
  import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
  import {useMessageActions} from ${JSON.stringify(resolve(root, 'web/src/app/parts/MessageActions.tsx'))};
  const sends=[];
  const message={id:'old-failed-command',role:'user',text:'Original request',parts:[
    {kind:'text',text:'Original request'},
    {kind:'image',src:'data:image/png;base64,cGhvdG8=',mimeType:'image/png'},
  ]};
  function App(){
    window.actions=useMessageActions({sessionPath:'/synthetic/failed',messages:[message]});
    return window.actions.sheet;
  }
  window.fixture={act,sends,message,mount(){
    const r=createRoot(document.getElementById('root'));
    r.render(h(App));return r;
  }};
`, [{
  name: 'capture-explicit-edit',
  resolveId(id, importer) {
    if (!/\/(MessageActions|EditResendSheet)\.tsx$/.test(importer ?? '')) return null;
    return id.endsWith('runtime/rpc-client') ? '\0edit-delivery' : null;
  },
  load(id) {
    if (id !== '\0edit-delivery') return null;
    return `export {DaemonApi,isOwnershipError} from ${JSON.stringify(rpc)};
      export const sendPromptDurably=(...args)=>new Promise(resolve=>
        window.fixture.sends.push({args,resolve:value=>{args[3].onSaved?.();resolve(value)}}));`;
  },
}]);

async function fixture(t) {
  const dom = createDomFixture(code);
  const w = dom.window, { act, sends, message } = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  const timers = new Map();
  const set = w.setTimeout.bind(w), clear = w.clearTimeout.bind(w);
  let sequence = 9000;
  w.setTimeout = (callback, ms, ...args) => {
    if (ms !== 120) return set(callback, ms, ...args);
    const id = sequence++;
    timers.set(id, callback);
    return id;
  };
  w.clearTimeout = id => { timers.delete(id); clear(id); };
  let mounted;
  await act(async () => { mounted = w.fixture.mount(); });
  t.after(async () => {
    try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  const button = label => [...w.document.querySelectorAll('button')].find(b => b.textContent === label);
  return {
    w, act, sends, button,
    editor: () => w.document.querySelector('textarea[placeholder="Edit your message…"]'),
    open: () => act(async () => w.actions.open(message)),
    click: label => act(async () => { assert.ok(button(label), label); button(label).click(); }),
    tick: () => act(async () => {
      const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback());
    }),
    type: value => act(async () => {
      const editor = w.document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(editor, value);
      editor.dispatchEvent(new w.Event('input', { bubbles: true }));
    }),
  };
}

test('Edit & resend requires review and preserves photos with the edited text', async t => {
  const f = await fixture(t);
  await f.open();
  assert.equal(f.sends.length, 0);
  await f.click('Edit & resend');
  assert.equal(f.editor() === null, true);
  await f.tick();
  assert.equal(f.editor()?.value, 'Original request');
  assert.ok(f.w.document.body.textContent.includes('Sends as a new message. The original stays in the transcript.'));
  assert.equal(f.sends.length, 0);
  await f.type(' Reviewed request ');
  assert.equal(f.sends.length, 0);
  await f.act(async () => { const send = f.button('Send'); send.click(); send.click(); send.click(); });
  assert.equal(f.sends.length, 1);
  assert.deepEqual(Array.from(f.sends[0].args).slice(0,2), ['/synthetic/failed', 'Reviewed request']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.sends[0].args[2])), [{data:'cGhvdG8=',mimeType:'image/png'}]);
  assert.equal(f.sends[0].args[3].commandId,undefined,'editing is a new command, not a retry of the old failed one');
  await f.act(async () => f.sends[0].resolve({ state: 'completed' }));
  assert.equal(f.editor() === null, true);
});

test('cancelling existing Edit & resend never submits the failed message', async t => {
  const f = await fixture(t);
  await f.open();
  await f.click('Edit & resend');
  await f.tick();
  await f.type('Unsent revision');
  await f.click('Cancel');
  await f.tick();
  assert.equal(f.editor() === null, true);
  assert.equal(f.sends.length, 0);
  await f.open();
  await f.click('Edit & resend');
  await f.tick();
  assert.equal(f.editor()?.value, 'Original request');
  assert.equal(f.sends.length, 0);
});
