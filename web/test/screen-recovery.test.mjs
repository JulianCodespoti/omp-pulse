import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
import { pluginHostStub } from './support/plugin-host-stub.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const react = JSON.stringify(require.resolve('react'));
const sourcePath = path => JSON.stringify(resolve(root, 'web/src', path));
// App, navigation, React.lazy, draft owners and the durability barrier are real.
// Transport/module downloads and the browser document-reload boundary are synthetic.
const stubs = {
  '../runtime/omp-session-controller': `export class OmpSessionController {
    constructor(store) { this.store = store; } getStore() { return this.store; }
    resume() {} dispose() {} async loadSessions() {} closeSession() {} fencePairingReplacement() {}
    async openSession(path) { this.store.setState({sessionPath:path}); }
  }`,
  '../platform/service-worker': `export const registerServiceWorker=async()=>{},onOpenMessage=()=>()=>{};`,
  // The launch decision reads which chats are waiting on the user.
  '../runtime/rpc-client': `export class DaemonApi { async awaiting() { return []; } }
    export const sendPromptDurably=async()=>{ throw Error('synthetic: no durable sends in this fixture'); };`,
  './Notices': `export const Notices=()=>null,showToast=()=>{};`,
  './NativeUpgradeBoundary': `export const NativeUpgradeBoundary=({children})=>children;`,
  './nav/SidePanel': `export const SidePanel=()=>null;`,
  './nav/SessionSwitcher': `export const SessionSwitcher=()=>null;`,
  './SettingsScreen': `import {createElement as h} from ${react};
    export default function Settings({onClose}) { return h('main',null,'Loaded settings',h('button',{onClick:onClose},'Close settings')); }`,
  // Home is the new-chat screen: the base screen a cold start lands on.
  './sessions/NewSessionScreen': `import {createElement as h} from ${react};
    import {openSettings} from ${sourcePath('app/nav/panels.ts')};
    export default function NewSession({onOpenSession}) {
      if(window.crashSessions) throw Error('injected render failure');
      return h('main',null,'Loaded new session',
        h('button',{onClick:()=>onOpenSession('/synthetic/chat')},'Open conversation'),h('button',{onClick:openSettings},'Settings'));
    }`,
  './PairScreen': `import {createElement as h} from ${react};export const PairScreen=()=>h('main',null,'Loaded pairing');`,
  './commands/GlobalPalette': `import {createElement as h} from ${react};export const GlobalPalette=()=>h('div',null,'Loaded palette');`,
  './tools': `export const loaded=true;`,
};
const chatModule = `import {createElement as h,useEffect} from ${react};
  import {openNewSession,openSettings} from ${sourcePath('app/nav/panels.ts')};
  import {useDraft} from ${sourcePath('app/composer/use-draft.ts')};
  export const preloadMarkdown=async()=>{};
  export function ChatScreen({onBack}) {
    const {text,setText}=useDraft('/synthetic/chat');
    useEffect(()=>{window.chatMounts=(window.chatMounts??0)+1},[]);
    return h('main',null,'Loaded conversation',h('textarea',{'aria-label':'Draft',value:text,onInput:e=>setText(e.currentTarget.value),onChange:()=>{}}),
      h('button',{onClick:onBack},'Back to sessions'),h('button',{onClick:()=>openNewSession()},'New session'),h('button',{onClick:openSettings},'Settings'));
  }`;
const code = await bundleDomFixture(`
import {createElement as h,act,Fragment} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {App} from ${sourcePath('app/App.tsx')};
import {usePanels} from ${sourcePath('app/nav/panels.ts')};
import {retryableLazy} from ${sourcePath('app/ui/retryable-lazy.tsx')};
import {ScreenBoundary} from ${sourcePath('app/ui/RecoveryBoundary.tsx')};
import {LazyMount} from ${sourcePath('app/ui/LazyMount.tsx')};
import {handleNativeBack} from ${sourcePath('platform/native-back.ts')};
import {readDraft} from ${sourcePath('app/composer/use-draft.ts')};
import {getNewSessionDraft} from ${sourcePath('runtime/new-session-draft.ts')};
import {registerDraftAttachmentFlusher} from ${sourcePath('runtime/offline-queue.ts')};
window.fixture={act,readDraft,getNewSessionDraft,registerDraftAttachmentFlusher,nativeBack:()=>handleNativeBack('commit'),mount(){const r=createRoot(document.getElementById('root'));
    // The panels contract, observed the way a screen reads it.
    const Probe=()=>{window.panels=usePanels();return null};
    r.render(h(Fragment,null,h(App),h(Probe)));return r},
  async mountEntry(){await import(${sourcePath('main.tsx')});return window.entryRoot},
  mountPanel(){const r=createRoot(document.getElementById('root'));
    const Panel=retryableLazy(()=>window.importScreen('Panel',async()=>({default:()=>h('div',null,'Loaded panel')})));
    let open=true;const render=()=>r.render(h('div',null,h('textarea',{'aria-label':'Draft',defaultValue:'keep me'}),h(LazyMount,{open,onClose(){open=false;render()}},h(Panel))));
    render();return r},
  mountPreloaded(){const r=createRoot(document.getElementById('root'));
    const View=retryableLazy(()=>window.importScreen('Preloaded',async()=>({default:()=>h('main',null,'Loaded preloaded view')})));
    return {root:r,preload:View.preload,render:()=>r.render(h(ScreenBoundary,{title:'Preloaded'},h(View)))};
  }};
`, [pluginHostStub, {
  name: 'screen-import-network-boundary',
  resolveId(id, importer) {
    if (importer?.endsWith('/App.tsx') && id in stubs) return '\0screen-stub:' + id;
    if (importer?.endsWith('/chat-chunk.ts') && id === './ChatScreen') return '\0screen-chat';
    if (importer?.endsWith('/main.tsx') && id === './app/Onboarding') return '\0screen-onboarding';
    if (importer?.endsWith('/main.tsx') && id === './styles.css') return '\0screen-css';
  },
  load(id) {
    if (id.startsWith('\0screen-stub:')) return stubs[id.slice('\0screen-stub:'.length)];
    if (id === '\0screen-chat') return chatModule;
    if (id === '\0screen-onboarding') return `import {createElement as h} from ${react};export const Onboarding=()=>h('main',null,'Loaded onboarding');`;
    if (id === '\0screen-css') return '';
  },
  transform(source, id) {
    if (id.endsWith('/App.tsx')) {
      for (const [path, name] of [['./sessions/NewSessionScreen','New session'],['./SettingsScreen','Settings'],['./PairScreen','Pairing'],['./commands/GlobalPalette','Palette']]) {
        source = source.replaceAll(`import("${path}")`, `window.importScreen(${JSON.stringify(name)},()=>import("${path}"))`);
      }
      return source;
    }
    if (id.endsWith('/chat-chunk.ts')) return source.replace('import("./ChatScreen")', 'window.importScreen("Conversation",()=>import("./ChatScreen"))');
    if (id.endsWith('/main.tsx')) return source.replace('import("./app/Onboarding")', 'window.importScreen("Onboarding",()=>import("./app/Onboarding"))').replace('createRoot(root).render(', 'window.entryRoot=createRoot(root);window.entryRoot.render(');
    if (id.endsWith('/RecoveryBoundary.tsx')) return source.replace('window.location.reload()', 'window.requestReload()');
  },
}]);

async function fixture(t, { paired = true, failed = [], held = [], entry = false, firstRun = false, panel = false, crash = false, preloaded = false, link = false } = {}) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  const offline = new Set(failed), attempts = [], idle = [], pending = new Map(), reloads = [];
  w.importScreen = (name, load) => {
    attempts.push(name);
    if (held.includes(name)) return new Promise((resolve, reject) => pending.set(name, { resolve: () => resolve(load()), reject }));
    return offline.has(name) ? Promise.reject(Error('injected offline import: ' + name)) : load();
  };
  w.requestReload = () => reloads.push({ draft: f.readDraft('/synthetic/chat'), saved: { ...w.localStorage } });
  w.requestIdleCallback = callback => { idle.push(callback); return idle.length; };
  w.cancelIdleCallback = () => {};
  w.Element.prototype.getAnimations = () => [];
  if (paired) w.localStorage.setItem('omp-remote-token', 'synthetic-token');
  if (firstRun) w.OmpLocal = { state: () => JSON.stringify({ mode: 'unset' }) };
  w.crashSessions = crash;
  if (link) w.history.replaceState(null, '', '#s=' + encodeURIComponent('/synthetic/chat'));
  // Expected deliberately caught failures, not an assertion on console wording.
  w.console.error = () => {};
  let mounted;
  const act = fn => f.act(async () => { await fn?.(); });
  await act(async () => { mounted = preloaded ? f.mountPreloaded() : panel ? f.mountPanel() : entry ? await f.mountEntry() : f.mount(); });
  t.after(async () => { try { await act(() => (mounted.root ?? mounted).unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const click = async (label, scope = w.document) => {
    const button = [...scope.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label);
    assert.equal(Boolean(button), true, 'visible action: ' + label);
    await act(() => button.click());
  };
  return { w, f, act, click, attempts, idle, pending, reloads, mounted, restore: name => offline.delete(name), text: () => w.document.body.textContent };
}

// New session is the home screen now, not a pushed layer; its import failure has its own test below.
for (const [name, layer] of [['Settings', 'settings-layer']]) {
  test(`${name}: failed import preserves the draft and saves it before requesting a reload`, async t => {
    const f = await fixture(t, { failed: [name] });
    await f.click('Open conversation');
    const draft = f.w.document.querySelector('textarea');
    assert.equal(Boolean(draft), true);
    await f.act(() => { draft.value = 'unsent words'; draft.dispatchEvent(new f.w.Event('input', { bubbles: true })); });
    await f.click(name);
    const overlay = f.w.document.querySelector(`[data-testid="${layer}"]`);
    assert.equal(Boolean(overlay?.querySelector('[role="alert"]')), true);
    assert.equal(f.w.document.querySelector('textarea') === draft, true);
    assert.equal(draft.value, 'unsent words');
    assert.equal(f.w.chatMounts, 1);
    f.restore(name);
    await f.click('Reload app', overlay);
    assert.equal(f.reloads.length, 1);
    assert.equal(f.reloads[0].draft, 'unsent words');
    assert.equal(f.attempts.filter(value => value === name).length, 1, 'no misleading retry of a browser-cached failed module');
  });

  test(`${name}: native Back and visible Back leave failed imports without reloading`, async t => {
    const f = await fixture(t, { failed: [name] });
    await f.click(name);
    await f.click('Back', f.w.document.querySelector(`[data-testid="${layer}"]`));
    assert.equal(Boolean(f.w.document.querySelector(`[data-testid="${layer}"]`)), false);
    await f.click(name);
    await f.act(() => f.w.fixture.nativeBack());
    assert.equal(Boolean(f.w.document.querySelector(`[data-testid="${layer}"]`)), false);
    assert.equal(f.text().includes('Loaded new session'), true);
    assert.equal(f.reloads.length, 0);
  });

  test(`${name}: loading keeps Back available and late rejection cannot blank the list`, async t => {
    const f = await fixture(t, { held: [name] });
    await f.click(name);
    const overlay = f.w.document.querySelector(`[data-testid="${layer}"]`);
    assert.equal(Boolean(overlay?.querySelector('[role="status"]')), true);
    await f.click('Back', overlay);
    await f.act(() => f.pending.get(name).reject(Error('late offline failure')));
    assert.equal(f.text().includes('Loaded new session'), true);
    assert.equal(Boolean(f.w.document.querySelector('[role="alert"]')), false);
  });
}

test('home import failure after New session keeps the chat draft and offers draft-safe document recovery', async t => {
  const f = await fixture(t, { failed: ['New session'], link: true });
  const draft = f.w.document.querySelector('textarea');
  assert.equal(Boolean(draft), true);
  await f.act(() => { draft.value = 'unsent words'; draft.dispatchEvent(new f.w.Event('input', { bubbles: true })); });
  await f.click('New session');
  assert.equal(Boolean(f.w.document.querySelector('[role="alert"]')), true);
  f.restore('New session');
  await f.click('Reload app');
  assert.equal(f.reloads.length, 1);
  assert.equal(f.reloads[0].draft, 'unsent words');
  assert.equal(f.attempts.filter(value => value === 'New session').length, 1, 'no misleading retry of a browser-cached failed module');
});

test('reload waits for pending attachment persistence and is cancelled when Back dismisses recovery', async t => {
  const f = await fixture(t, { failed: ['Settings'] });
  let finish;
  const remove = f.f.registerDraftAttachmentFlusher(() => new Promise(resolve => { finish = resolve; }));
  t.after(remove);
  await f.click('Settings');
  await f.click('Reload app');
  assert.equal(f.text().includes('Saving drafts…'), true);
  assert.equal(f.reloads.length, 0);
  await f.click('Back');
  await f.act(() => finish());
  assert.equal(f.reloads.length, 0);
  assert.equal(f.text().includes('Loaded new session'), true);
});

test('reload waits for all attachment owners before navigating', async t => {
  const f = await fixture(t, { failed: ['Settings'] });
  let finish;
  const remove = f.f.registerDraftAttachmentFlusher(() => new Promise(resolve => { finish = resolve; }));
  t.after(remove);
  await f.click('Settings');
  await f.click('Reload app');
  assert.equal(f.reloads.length, 0);
  await f.act(() => finish());
  assert.equal(f.reloads.length, 1);
});

test('draft persistence failure visibly refuses reload; fixing storage allows safe recovery', async t => {
  const f = await fixture(t, { failed: ['Settings'] });
  const owner = f.f.getNewSessionDraft();
  const setItem = f.w.Storage.prototype.setItem;
  f.w.Storage.prototype.setItem = function () { throw Error('injected storage unavailable'); };
  owner.update({ text: 'new session unsent draft' });
  await f.click('Settings');
  await f.click('Reload app');
  assert.equal(f.reloads.length, 0);
  assert.equal(f.text().includes('Couldn’t save your drafts. The app was not reloaded.'), true);
  assert.equal(owner.getSnapshot().value.text, 'new session unsent draft');
  f.w.Storage.prototype.setItem = setItem;
  await f.click('Reload app');
  assert.equal(f.reloads.length, 1);
  assert.equal(Object.values(f.reloads[0].saved).some(raw => raw.includes('new session unsent draft')), true);
});

test('failed idle preload does not poison reopening when the loader itself is recoverable', async t => {
  const f = await fixture(t, { failed: ['Settings'] });
  await f.act(() => { for (const callback of f.idle) callback(); });
  f.restore('Settings');
  await f.click('Settings');
  assert.equal(f.text().includes('Loaded settings'), true);
  assert.equal(f.attempts.filter(name => name === 'Settings').length, 2);
});

test('successful idle preload is reused when opening Settings', async t => {
  const f = await fixture(t);
  await f.act(() => { for (const callback of f.idle) callback(); });
  await f.click('Settings');
  assert.equal(f.text().includes('Loaded settings'), true);
  assert.equal(f.attempts.filter(name => name === 'Settings').length, 1);
});

for (const [name, options, open] of [
  ['Conversation', {}, 'Open conversation'],
  ['Pairing', { paired: false }, null],
  ['Onboarding', { entry: true, firstRun: true }, null],
]) test(`${name} import failure offers draft-safe document recovery`, async t => {
  const f = await fixture(t, { ...options, failed: [name] });
  if (open) await f.click(open);
  assert.equal(Boolean(f.w.document.querySelector('[role="alert"]')), true);
  f.restore(name);
  await f.click('Reload app');
  assert.equal(f.reloads.length, 1);
  assert.equal(f.attempts.filter(value => value === name).length, 1);
});

test('conversation import failure: Back opens the drawer over the failed chat, not home', async t => {
  const f = await fixture(t, { failed: ['Conversation'] });
  await f.click('Open conversation');
  await f.click('Back');
  assert.equal(f.w.panels.switcher, true, 'the list comes over the failed chat');
  assert.equal(f.text().includes('Loaded new session'), false, 'you stay where you were');
});

test('unexpected render errors retain local Retry rather than reloading the document', async t => {
  const f = await fixture(t, { entry: true, crash: true });
  assert.equal(f.text().includes('New chat'), true);
  assert.equal(Boolean(f.w.document.querySelector('[role="alert"]')), true);
  f.w.crashSessions = false;
  await f.click('Retry');
  assert.equal(f.text().includes('Loaded new session'), true);
  assert.equal(f.reloads.length, 0);
});

test('failed lazy panel preserves its sibling draft and native Back dismisses recovery', async t => {
  const f = await fixture(t, { panel: true, failed: ['Panel'] });
  const draft = f.w.document.querySelector('textarea');
  assert.equal(draft.value, 'keep me');
  assert.equal(Boolean(f.w.document.querySelector('[role="alert"]')), true);
  await f.act(() => f.w.fixture.nativeBack());
  assert.equal(f.w.document.querySelector('textarea') === draft, true);
  assert.equal(draft.value, 'keep me');
  assert.equal(Boolean(f.w.document.querySelector('[role="dialog"][data-open]')), false);
  assert.equal(f.reloads.length, 0);
});

test('repeated preloads and rendering share one successful module', async t => {
  const f = await fixture(t, { preloaded: true });
  await f.act(() => Promise.all([f.mounted.preload(), f.mounted.preload()]));
  await f.act(() => f.mounted.render());
  assert.equal(f.text().includes('Loaded preloaded view'), true);
  assert.equal(f.attempts.filter(name => name === 'Preloaded').length, 1);
});
