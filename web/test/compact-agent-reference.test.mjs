import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h,act,useState} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {Composer} from ${JSON.stringify(resolve(root, 'web/src/app/composer/Composer.tsx'))};
import {agentDiscussionReference} from ${JSON.stringify(resolve(root, 'web/src/domain/agent-discussion.ts'))};
import {flushAllDraftWrites,getDraftNamespace,readDraft} from ${JSON.stringify(resolve(root, 'web/src/app/composer/use-draft.ts'))};
import {getAttachmentDraft} from ${JSON.stringify(resolve(root, 'web/src/runtime/attachment-draft.ts'))};
import {DaemonApi} from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
window.drafts=new Map();window.imageWrites=[];window.decodes=[];window.transcriptions=[];
DaemonApi.prototype.transcribe=async blob=>{window.transcriptions.push({size:blob.size,type:blob.type});return new Promise(resolve=>window.finishTranscription=resolve)};
DaemonApi.prototype.warmTranscriber=async()=>{};
// Read-only prompt metadata is outside this agent-reference fixture's scope.
DaemonApi.prototype.getPromptConfig=async()=>({magicKeywords:[]});
DaemonApi.prototype.search=async()=>window.historyHits??[];
DaemonApi.prototype.readUserMessageAt=(...args)=>new Promise((resolve,reject)=>{(window.historyReads??=[]).push({args,resolve,reject})});
const actions={current:null},sends=[],commands=[],pickers=[];let setView;
function App(){const [view,update]=useState({path:'/synthetic/a',visit:0,allowed:true});setView=update;
 return h(Composer,{key:view.path+':'+view.visit,sessionPath:view.path,busy:false,sendAllowed:view.allowed,draftActionsRef:actions,
 commands:[{name:'compact',description:'Compact conversation',source:'builtin',shape:'immediate'},{name:'model',description:'Choose model',source:'builtin',shape:'pick',picker:'model'},
 {name:'skill:plugin/review',description:'Review this project',source:'skill',shape:'compose'},
 {name:'team-summary',description:'Team summary (project)',source:'prompt',shape:'compose'}],
 onRunCommand:command=>commands.push(command.name),onOpenPicker:picker=>pickers.push(picker),onStop:()=>{throw Error('Unexpected stop')},
 onSend:async(text,images,path,onSaved)=>{const call={text,images,path,onSaved};sends.push(call);
 if(window.sendMode==='fail')throw Error('Synthetic pre-save failure');
 if(window.sendMode==='hold')await new Promise(resolve=>call.release=resolve);
 await onSaved();}})}
window.fixture={act,actions,sends,commands,pickers,agentDiscussionReference,getDraftNamespace,readDraft,flushAllDraftWrites,
 owner:()=>getAttachmentDraft(getDraftNamespace(),'/synthetic/a'),setView:patch=>setView(v=>({...v,...patch})),
 mount(){const r=createRoot(document.getElementById('root'));r.render(h(App));return r}};
`, [{
  name: 'synthetic-image-boundaries',
  resolveId(id, importer) {
    if (importer?.endsWith('/attachment-draft.ts') && id === './offline-queue') return '\0attachments';
    if (importer?.endsWith('/Composer.tsx') && id === './image-intake') return '\0intake';
    return null;
  },
  load(id) {
    if (id === '\0attachments') return `export * from ${JSON.stringify(resolve(root, 'web/src/runtime/offline-queue.ts'))};
export const loadDraftAttachments=async(path,namespace)=>window.drafts.get(namespace+':'+path)??[];
export const saveDraftAttachments=async(path,images,namespace)=>{window.imageWrites.push({path,images});if(window.failImageSave)throw Error('Synthetic storage unavailable');window.drafts.set(namespace+':'+path,images);return true};
export const registerDraftAttachmentFlusher=()=>()=>{};`;
    if (id === '\0intake') return `export const MAX_IMAGES=4;export const PAYLOAD_TOO_LARGE_COPY='too large';export const imagesTooLargeToSend=()=>false;export const intakeFiles=async(files,count)=>{window.decodes.push({files,count});if(window.holdDecode)await new Promise(resolve=>window.finishDecode=resolve);return{images:files.map(file=>({data:'decoded:'+file.name,mimeType:file.type,previewUrl:'data:'+file.type+';base64,c3ludGhldGlj',name:file.name,width:1,height:1}))}};`;
    return null;
  },
}]);

const path = '/synthetic/a';
const agent = (id = 'a', name = `Agent ${id}`) => ({ id, name, source: 'desktop', createdAt: 7, connectionId: 'desktop-a' });
const compose = (prefix, refs) => refs.reduce((text, ref) => text ? `${text}\n\n${ref.text}` : ref.text, prefix);
const initialImage = { data: 'original-image', mimeType: 'image/png', previewUrl: 'data:image/png;base64,c3ludGhldGlj', name: 'kept.png', width: 1, height: 1 };

async function fixture(t, { prefix = '', images = [], token = '' } = {}) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.HTMLElement.prototype.setPointerCapture = () => {};
  w.HTMLElement.prototype.releasePointerCapture = () => {};
  // Capture adapter only: the real hook, VoiceButton gesture, async transcription
  // settlement and Composer callbacks remain composed. No microphone or network.
  Object.defineProperty(w.navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
  w.MediaRecorder = class {
    state = 'inactive'; mimeType = 'audio/webm';
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable?.({ data: new w.Blob(['synthetic audio'], { type: this.mimeType }) });
      this.onstop?.(new w.Event('stop'));
    }
  };
  if (token) w.localStorage.setItem('omp-remote-token', token);
  const namespace = f.getDraftNamespace(), key = `omp-draft:${namespace}:${path}`;
  if (prefix) w.localStorage.setItem(key, prefix);
  w.drafts.set(namespace + ':' + path, images);
  let mounted;
  const act = async (fn, delay = 30) => {
    await f.act(async () => { await fn?.(); });
    if (delay) await f.act(async () => { await new Promise(resolve => w.setTimeout(resolve, delay)); });
  };
  await act(() => { mounted = f.mount(); });
  t.after(async () => {
    try { await f.act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  const submitEvents = [];
  w.document.addEventListener('submit', event => submitEvents.push(event));
  const get = selector => w.document.querySelector(selector);
  const all = selector => [...w.document.querySelectorAll(selector)];
  const input = () => get('[data-testid="composer-input"]');
  const click = async target => {
    const node = typeof target === 'string' ? get(target) : target;
    assert.ok(node, String(target)); await act(() => node.click());
  };
  const type = async value => act(() => {
    Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(input(), value);
    input().dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  const prepare = async (spec = agent(), target = path) => {
    const ref = f.agentDiscussionReference(spec); let error;
    await act(() => { error = f.actions.current.prepareAgentResponse(target, ref); });
    assert.equal(error === null, true); return ref;
  };
  const canonical = async () => {
    await act(() => f.flushAllDraftWrites(), 0);
    return f.readDraft(path, namespace);
  };
  const details = async (index = 0) => {
    await click(all('[data-testid="compact-reference-details"]')[index]);
    const text = get('[data-testid="compact-reference-text"]')?.textContent;
    assert.equal(get('[data-testid="sheet-title-text"]')?.textContent, 'Agent reference');
    return text;
  };
  const close = () => click('[data-testid="sheet-close"]');
  const expand = async () => { await details(); await click('[data-testid="compact-reference-edit-full-draft"]'); };
  const remove = index => click(all('[data-testid="compact-reference-remove"]')[index]);
  const keydown = async (key, options = {}, target = input()) => {
    const event = new w.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    await act(() => target.dispatchEvent(event)); return event;
  };
  const paste = async (text, name = 'pasted.png') => {
    const file = new w.File(['synthetic'], name, { type: 'image/png' });
    const event = new w.Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', getAsFile: () => file }], getData: type => type === 'text/plain' ? text : '' } });
    await act(() => input().dispatchEvent(event)); assert.equal(event.defaultPrevented, true);
  };
  const beginDictation = async () => { await click('[data-testid="voice-button"]'); assert.match(get('[data-testid="dictation-status"]').textContent, /Recording/); };
  const transcribe = async text => {
    await click('[data-testid="dictation-insert"]');
    assert.match(get('[data-testid="dictation-status"]').textContent, /Transcribing/);
    assert.equal(typeof w.finishTranscription, 'function');
    if (text !== undefined) await act(() => w.finishTranscription(text));
  };
  const releaseSend = async (index = 0) => { await act(() => f.sends[index].release()); };
  return { w, f, submitEvents, act, get, all, input, click, type, prepare, canonical, details, close, expand, remove, keydown, paste, beginDictation, transcribe, releaseSend, namespace, key };
}

function assertNoDispatch(f) {
  assert.equal(f.f.sends.length, 0, 'no prompt submission');
  assert.equal(f.f.commands.length, 0, 'no command execution');
  assert.equal(f.f.pickers.length, 0, 'no command picker');
}
function assertSelection(node, start, end = start, direction = 'none') {
  assert.equal(node.selectionStart, start); assert.equal(node.selectionEnd, end); assert.equal(node.selectionDirection, direction);
}

// jsdom does not synthesize a trusted browser click from Enter/Space. Dispatch
// both keyboard phases then its keyboard-shaped (detail=0) activation, and assert
// explicit native button type. Browser keyboard/focus acceptance stays separate.
async function keyboardActivate(f, node, key) {
  assert.equal(node.getAttribute('type'), 'button');
  node.focus(); await f.keydown(key, {}, node);
  await f.act(() => {
    node.dispatchEvent(new f.w.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    node.dispatchEvent(new f.w.MouseEvent('click', { detail: 0, bubbles: true, cancelable: true }));
  });
}

test('prepare keeps Unicode prose, backward UTF-16 selection and image identity while exact canonical text persists', async t => {
  const prefix = '  Cafe\u0301 👩🏽‍💻\n第二行  \n';
  const f = await fixture(t, { prefix, images: [initialImage] });
  const node = f.input(); node.setSelectionRange(3, 16, 'backward');
  const ref = await f.prepare(agent('a', '<Research> "quoted" 🧭'));
  assert.equal(f.input(), node); assert.equal(node.value, prefix); assertSelection(node, 3, 16, 'backward');
  assert.equal(await f.canonical(), compose(prefix, [ref]));
  const image = f.f.owner().getSnapshot().images[0];
  assert.equal(image.data, initialImage.data);
  assert.equal(await f.details(), ref.text);
  assert.equal(f.get('[data-testid="compact-reference-text"]').querySelector('research') === null, true, 'reference rendered as text');
  await f.close(); assertSelection(node, 3, 16, 'backward');
  await f.remove(0); assert.equal(node.value, prefix); assertSelection(node, 3, 16, 'backward');
  assert.equal(f.f.owner().getSnapshot().images[0], image); assert.equal(await f.canonical(), prefix);
  assertNoDispatch(f);
});

test('Details, Close, Remove and Edit full draft controls never submit for clicks or synthetic keyboard activation', async t => {
  const f = await fixture(t, { prefix: 'Draft' });
  const a = await f.prepare();
  for (const key of ['Enter', ' ']) {
    await keyboardActivate(f, f.get('[data-testid="compact-reference-details"]'), key);
    assert.equal(f.get('[data-testid="compact-reference-text"]').textContent, a.text); assertNoDispatch(f);
    await keyboardActivate(f, f.get('[data-testid="sheet-close"]'), key); assertNoDispatch(f);
  }
  await f.prepare(agent('b'));
  await keyboardActivate(f, f.all('[data-testid="compact-reference-remove"]')[1], ' ');
  assert.equal(f.all('[data-testid="compact-reference-row"]').length, 1); assertNoDispatch(f);
  const node = f.input(); node.setSelectionRange(1, 4, 'backward');
  await f.details(); await keyboardActivate(f, f.get('[data-testid="compact-reference-edit-full-draft"]'), 'Enter');
  assert.equal(f.input(), node); assert.equal(node.value, compose('Draft', [a])); assertSelection(node, 1, 4, 'backward');
  assert.equal(f.all('[data-testid="compact-reference-row"]').length, 0);
  assert.equal(await f.canonical(), compose('Draft', [a])); assertNoDispatch(f);
  assert.equal(f.submitEvents.length, 0, 'reference controls never even submit the enclosing form');
});

for (const prefix of ['', ' \t ', 'First\n第二行', 'With trailing spaces  \n\n']) {
  test(`first, middle, last and sole removals retain owned separator boundaries for ${JSON.stringify(prefix)}`, async t => {
    const f = await fixture(t, { prefix });
    const refs = [];
    for (const id of ['a', 'b', 'c', 'd']) refs.push(await f.prepare(agent(id)));
    for (const index of [1, 0, 1, 0]) {
      f.input().setSelectionRange(0, prefix.length, 'backward');
      await f.remove(index); refs.splice(index, 1);
      assert.equal(f.input().value, prefix); assertSelection(f.input(), 0, prefix.length, 'backward');
      assert.equal(await f.canonical(), compose(prefix, refs));
      assert.equal(f.all('[data-testid="compact-reference-row"]').length, refs.length);
    }
    assertNoDispatch(f);
  });
}

test('same-turn preparations deduplicate captured identity/name and removals see current ordered references', async t => {
  const f = await fixture(t, { prefix: 'Same turn' });
  const a = f.f.agentDiscussionReference(agent()), b = f.f.agentDiscussionReference(agent('b'));
  await f.act(() => {
    assert.equal(f.f.actions.current.prepareAgentResponse(path, a) === null, true);
    assert.equal(f.f.actions.current.prepareAgentResponse(path, a) === null, true);
    assert.equal(f.f.actions.current.prepareAgentResponse(path, b) === null, true);
  });
  await f.prepare(agent('a', 'Renamed later'));
  assert.equal(f.all('[data-testid="compact-reference-row"]').length, 2);
  assert.equal(await f.details(), a.text); await f.close();
  const buttons = f.all('[data-testid="compact-reference-remove"]');
  await f.act(() => { buttons[0].click(); buttons[1].click(); });
  assert.equal(await f.canonical(), 'Same turn'); assert.equal(f.input().value, 'Same turn');
  assertNoDispatch(f);
});

test('input replacement, deletion and empty/nonempty transitions edit only the visible prefix', async t => {
  const f = await fixture(t, { prefix: 'Cafe\u0301 👩🏽‍💻 中文  ' });
  const ref = await f.prepare(), node = f.input();
  const replacement = node.value.slice(0, 6) + '🎉\n新' + node.value.slice(13);
  await f.type(replacement); assert.equal(await f.canonical(), compose(replacement, [ref]));
  await f.type(replacement.slice(0, -1)); assert.equal(await f.canonical(), compose(replacement.slice(0, -1), [ref]));
  await f.type(''); assert.equal(await f.canonical(), ref.text); assertSelection(node, 0);
  await f.type('  \n'); assert.equal(await f.canonical(), compose('  \n', [ref]));
  await f.remove(0); assert.equal(node.value, '  \n'); assertNoDispatch(f);
});

test('mixed image/text paste replaces visible Unicode selection and keeps references during delayed image intake', async t => {
  const prefix = 'A😀B combining e\u0301 end';
  const f = await fixture(t, { prefix, images: [initialImage] }); const ref = await f.prepare();
  f.input().setSelectionRange(1, 4, 'backward'); f.w.holdDecode = true;
  await f.paste('中\n文'); const edited = prefix.slice(0, 1) + '中\n文' + prefix.slice(4);
  assert.equal(f.input().value, edited); assertSelection(f.input(), 1 + '中\n文'.length);
  assert.equal(await f.canonical(), compose(edited, [ref]));
  assert.equal(f.get('[data-testid="composer-send-btn"]').disabled, true); assertNoDispatch(f);
  await f.act(() => f.w.finishDecode());
  assert.deepEqual(Array.from(f.f.owner().getSnapshot().images, image => image.data), ['original-image', 'decoded:pasted.png']);
  await f.click('[data-testid="composer-send-btn"]');
  assert.equal(f.f.sends[0].text, compose(edited, [ref]));
  assert.deepEqual(Array.from(f.f.sends[0].images, image => image.data), ['original-image', 'decoded:pasted.png']);
});

for (const prefix of ['', 'Words', 'Words ', 'Words\n']) {
  test(`normal dictation uses visible prose spacing and UTF-16 caret for ${JSON.stringify(prefix)}`, async t => {
    const f = await fixture(t, { prefix }); const ref = await f.prepare();
    await f.beginDictation(); await f.transcribe('  新 👩🏽‍💻  ');
    const visible = prefix + (prefix && !/[ \n]$/.test(prefix) ? ' ' : '') + '新 👩🏽‍💻';
    assert.equal(f.input().value, visible); assertSelection(f.input(), visible.length);
    assert.equal(await f.canonical(), compose(visible, [ref])); assertNoDispatch(f);
    assert.equal(f.w.transcriptions.length, 1); assert.ok(f.w.transcriptions[0].size > 0);
  });
}

test('full-draft expansion during pending transcription settles against current raw bytes without refolding', async t => {
  const f = await fixture(t, { prefix: 'Before' }); const ref = await f.prepare();
  await f.beginDictation(); await f.transcribe(); await f.expand();
  const raw = compose('Before', [ref]); assert.equal(f.input().value, raw);
  await f.act(() => f.w.finishTranscription('Later 😀'));
  assert.equal(f.input().value, raw + 'Later 😀'); assertSelection(f.input(), (raw + 'Later 😀').length);
  assert.equal(f.all('[data-testid="compact-reference-row"]').length, 0);
  assert.equal(await f.canonical(), raw + 'Later 😀'); assertNoDispatch(f);
});

test('failed Insert and send keeps the whole draft, its reference and its images', async t => {
  const f = await fixture(t, { prefix: 'Typed draft', images: [initialImage] }); const ref = await f.prepare();
  f.w.sendMode = 'fail';
  await f.beginDictation();
  await f.click('[data-testid="dictation-send"]');
  assert.match(f.get('[data-testid="dictation-status"]').textContent, /Transcribing/);
  await f.act(() => f.w.finishTranscription('Only voice'));
  const expected = compose('Typed draft Only voice', [ref]);
  assert.equal(f.f.sends.length, 1); assert.equal(f.f.sends[0].text, expected); assert.equal(f.f.sends[0].path, path);
  assert.equal(f.f.sends[0].images.length, 1, 'the draft sends whole, photos included');
  assert.equal(await f.canonical(), expected);
  assert.equal(f.f.owner().getSnapshot().images[0].data, 'original-image');
});

for (const change of ['prose', 'prepare', 'remove-readd']) {
  test(`held onSaved preserves a newer ${change} revision, even when canonical bytes return to the submitted snapshot`, async t => {
    const f = await fixture(t, { prefix: 'Before' }); const a = await f.prepare();
    f.w.sendMode = 'hold'; await f.click('[data-testid="composer-send-btn"]');
    const submitted = compose('Before', [a]); assert.equal(f.f.sends[0].text, submitted);
    let expected = submitted, visible = 'Before';
    if (change === 'prose') { visible = 'After 😀'; await f.type(visible); expected = compose(visible, [a]); }
    if (change === 'prepare') expected = compose('Before', [a, await f.prepare(agent('b'))]);
    if (change === 'remove-readd') { await f.remove(0); await f.prepare(); }
    await f.releaseSend();
    assert.equal(f.input().value, visible); assert.equal(await f.canonical(), expected);
    assert.equal(f.f.sends.length, 1);
  });
}
for (const view of ['details', 'expand']) {
  test(`held onSaved still clears an unchanged submitted draft after view-only ${view}`, async t => {
    const f = await fixture(t, { prefix: 'Before' }); const ref = await f.prepare();
    f.w.sendMode = 'hold'; await f.click('[data-testid="composer-send-btn"]');
    if (view === 'details') { assert.equal(await f.details(), ref.text); await f.close(); }
    else await f.expand();
    await f.releaseSend(); assert.equal(f.input().value, ''); assert.equal(await f.canonical(), '');
    assert.equal(f.all('[data-testid="compact-reference-row"]').length, 0); assert.equal(f.f.sends.length, 1);
  });
}

test('new images and compact prose survive an older send acknowledgement', async t => {
  const f = await fixture(t, { prefix: 'Before', images: [initialImage] }); const ref = await f.prepare();
  f.w.sendMode = 'hold'; await f.click('[data-testid="composer-send-btn"]');
  await f.type('New draft'); await f.paste('', 'new.png'); await f.releaseSend();
  assert.equal(await f.canonical(), compose('New draft', [ref]));
  assert.deepEqual(Array.from(f.f.owner().getSnapshot().images, image => image.data), ['decoded:new.png']);
  assert.equal(f.f.sends[0].images[0].data, 'original-image'); assert.equal(f.f.sends.length, 1);
});

test('pre-save failure keeps compact canonical draft, and a retry submits those exact bytes once more', async t => {
  const f = await fixture(t, { prefix: 'Unsent', images: [initialImage] }); const ref = await f.prepare();
  f.w.sendMode = 'fail'; await f.click('[data-testid="composer-send-btn"]');
  assert.equal(f.input().value, 'Unsent'); assert.equal(await f.canonical(), compose('Unsent', [ref]));
  assert.equal(f.f.owner().getSnapshot().images[0].data, 'original-image');
  f.w.sendMode = 'save'; await f.click('[data-testid="composer-send-btn"]');
  assert.equal(f.f.sends.length, 2); assert.equal(f.f.sends[1].text, f.f.sends[0].text); assert.equal(f.input().value, '');
});

for (const route of ['send', 'palette']) {
  test(`saved cleanup retry precedes compact slash refusal via ${route} and never enqueues again`, async t => {
    const f = await fixture(t, { prefix: 'Submitted', images: [initialImage] }); const ref = await f.prepare();
    f.w.failImageSave = true; await f.click('[data-testid="composer-send-btn"]');
    assert.equal(f.f.owner().getSnapshot().cleanupPending, true); assert.equal(f.f.sends.length, 1);
    await f.type(route === 'send' ? '/unknown-command' : '/compact');
    f.w.failImageSave = false;
    if (route === 'send') {
      assert.equal(f.get('[data-testid="composer-send-btn"]').disabled, false);
      await f.click('[data-testid="composer-send-btn"]');
    } else {
      const command = f.all('[data-testid="slash-palette"] button').find(node => node.textContent.includes('/compact'));
      assert.ok(command); await f.click(command);
    }
    assert.equal(f.f.owner().getSnapshot().cleanupPending, false);
    assert.equal(f.input().value, route === 'send' ? '/unknown-command' : '/compact');
    assert.equal(await f.canonical(), compose(f.input().value, [ref]));
    assert.equal(f.f.sends.length, 1); assert.equal(f.f.commands.length, 0); assert.equal(f.f.pickers.length, 0);
  });
}

for (const route of ['send', 'enter', 'palette']) {
  test(`compact command refusal via ${route} leaves prose, references and images unchanged`, async t => {
    const f = await fixture(t, { prefix: 'Before', images: [initialImage] }); const ref = await f.prepare();
    const prefix = route === 'palette' ? '/compact' : '  /compact arguments'; await f.type(prefix);
    if (route === 'send') await f.click('[data-testid="composer-send-btn"]');
    else if (route === 'enter') await f.keydown('Enter');
    else await f.click(f.all('[data-testid="slash-palette"] button').find(node => node.textContent.includes('/compact')));
    assert.equal(await f.canonical(), compose(prefix, [ref])); assert.equal(f.input().value, prefix);
    assert.match(f.get('[data-testid="composer-error"]').textContent, /remove|edit full draft/i);
    assert.equal(f.f.owner().getSnapshot().images[0].data, 'original-image'); assertNoDispatch(f);
  });
}

test('reference-only deliberate Send uses the full canonical string at caret zero', async t => {
  const f = await fixture(t); const ref = await f.prepare();
  assert.equal(f.input().value, ''); assertSelection(f.input(), 0); assertNoDispatch(f);
  await f.click('[data-testid="composer-send-btn"]');
  assert.equal(f.f.sends.length, 1); assert.equal(f.f.sends[0].text, ref.text); assert.equal(f.f.sends[0].path, path);
});

test('capability denial, composing Enter, legacy 229, held Enter and Shift+Enter do not submit compact drafts', async t => {
  const f = await fixture(t, { prefix: 'Draft' }); const ref = await f.prepare();
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { shiftKey: true }]) await f.keydown('Enter', options);
  assertNoDispatch(f);
  await f.act(() => f.f.setView({ allowed: false }));
  assert.equal(f.get('[data-testid="composer-send-btn"]').disabled, true);
  await f.click('[data-testid="composer-send-btn"]'); await f.keydown('Enter');
  await f.act(() => f.input().closest('form').dispatchEvent(new f.w.Event('submit', { bubbles: true, cancelable: true })));
  assertNoDispatch(f); assert.equal(await f.canonical(), compose('Draft', [ref]));
});

for (const kind of ['remount', 'session']) {
  test(`${kind} discards folding provenance and restores only canonical raw text`, async t => {
    const f = await fixture(t, { prefix: 'Original' }); const ref = await f.prepare();
    const raw = compose('Original', [ref]); await f.canonical();
    if (kind === 'remount') await f.act(() => f.f.setView({ visit: 1 }));
    else {
      await f.act(() => f.f.setView({ path: '/synthetic/b' })); assert.equal(f.input().value, '');
      await f.type('Other session'); await f.act(() => f.f.setView({ path }));
    }
    assert.equal(f.input().value, raw); assert.equal(f.all('[data-testid="compact-reference-row"]').length, 0);
    await f.prepare(); assert.equal(f.input().value, raw); assert.equal(f.all('[data-testid="compact-reference-row"]').length, 0);
    assertNoDispatch(f);
  });
}

test('credential remount cannot expose old references or carry their provenance into another namespace', async t => {
  const f = await fixture(t, { prefix: 'Old credential', token: 'credential-a' }); const ref = await f.prepare();
  const raw = await f.canonical();
  f.w.localStorage.setItem('omp-remote-token', 'credential-b');
  await f.act(() => f.f.setView({ visit: 1 }));
  assert.equal(f.input().value, ''); assert.equal(f.all('[data-testid="compact-reference-row"]').length, 0);
  await f.type('Other credential');
  f.w.localStorage.setItem('omp-remote-token', 'credential-a');
  await f.act(() => f.f.setView({ visit: 2 }));
  assert.equal(f.input().value, raw); assert.equal(raw, compose('Old credential', [ref]));
  assert.equal(f.all('[data-testid="compact-reference-row"]').length, 0); assertNoDispatch(f);
});

for (const foreign of ['', 'External raw edit\n{"id":"foreign"}']) {
  test(`foreign storage ${foreign ? 'replacement' : 'clear'} permanently discards projection even if the former bytes return`, async t => {
    const f = await fixture(t, { prefix: 'Original' }); const ref = await f.prepare(); const raw = await f.canonical();
    const replace = async value => f.act(() => {
      f.w.localStorage.setItem(f.key, value);
      f.w.dispatchEvent(new f.w.StorageEvent('storage', { key: f.key, newValue: value }));
    });
    await replace(foreign); assert.equal(f.input().value, foreign); assert.equal(f.all('[data-testid="compact-reference-row"]').length, 0);
    await replace(raw); assert.equal(f.input().value, compose('Original', [ref])); assert.equal(f.all('[data-testid="compact-reference-row"]').length, 0);
    await f.type(raw + '\nnew raw bytes'); assert.equal(await f.canonical(), raw + '\nnew raw bytes'); assertNoDispatch(f);
  });
}

test('legacy literal identity and arbitrary generated-looking text never gain inferred folding provenance', async t => {
  const f = await fixture(t); const ref = f.f.agentDiscussionReference(agent());
  const raw = 'Legacy prefix\n' + ref.text + '\ninterleaved {"id":"partial"';
  await f.type(raw); await f.prepare();
  assert.equal(f.input().value, raw); assert.equal(f.all('[data-testid="compact-reference-row"]').length, 0);
  const added = await f.prepare(agent('b'));
  assert.equal(f.input().value, raw); assert.equal(f.all('[data-testid="compact-reference-row"]').length, 1);
  assert.equal(await f.details(), added.text); await f.close();
  assert.equal(await f.canonical(), compose(raw, [added])); assertNoDispatch(f);
});

test('editing full raw text stays raw and duplicate preparation cannot automatically refold it', async t => {
  const f = await fixture(t, { prefix: 'Original' }); const ref = await f.prepare(); await f.expand();
  const raw = compose('Original', [ref]);
  await f.type(raw + '\nArbitrary text after identity'); await f.type(raw); await f.prepare();
  assert.equal(f.input().value, raw); assert.equal(f.all('[data-testid="compact-reference-row"]').length, 0);
  assert.equal(await f.canonical(), raw); assertNoDispatch(f);
});


test('same-turn remove/readd preserves a newer revision even when React receives the same final canonical value', async t => {
  const f = await fixture(t, { prefix: 'Unchanged bytes' }); const ref = await f.prepare();
  f.w.sendMode = 'hold'; await f.click('[data-testid="composer-send-btn"]');
  const remove = f.get('[data-testid="compact-reference-remove"]');
  await f.act(() => {
    remove.click();
    assert.equal(f.f.actions.current.prepareAgentResponse(path, ref) === null, true);
  });
  assert.equal(f.all('[data-testid="compact-reference-row"]').length, 1);
  await f.releaseSend();
  assert.equal(f.input().value, 'Unchanged bytes');
  assert.equal(await f.canonical(), compose('Unchanged bytes', [ref]));
  assert.equal(f.f.sends.length, 1);
});

test('stale compact input after a credential change exposes raw text instead of replacing it with the old prefix', async t => {
  const f = await fixture(t, { prefix: 'Old prefix', token: 'credential-a' }); const ref = await f.prepare();
  const raw = await f.canonical();
  f.w.localStorage.setItem('omp-remote-token', 'credential-b');
  await f.type('Stale visible edit');
  assert.equal(f.input().value, raw); assert.equal(f.all('[data-testid="compact-reference-row"]').length, 0);
  assert.equal(f.f.readDraft(path, f.namespace), compose('Old prefix', [ref]));
  f.w.localStorage.setItem('omp-remote-token', 'credential-a');
  await f.act(() => f.f.setView({ allowed: false }));
  assert.equal(f.input().value, raw); assert.equal(f.all('[data-testid="compact-reference-row"]').length, 0);
  assertNoDispatch(f);
});

for (const edit of [false, true]) {
  test(`remount during held save exposes raw text and ${edit ? 'preserves a later edit' : 'allows unchanged cleanup'}`, async t => {
    const f = await fixture(t, { prefix: 'Held text', images: [initialImage] }); const ref = await f.prepare();
    f.w.sendMode = 'hold'; await f.click('[data-testid="composer-send-btn"]');
    await f.act(() => f.f.setView({ visit: 1 }));
    const raw = compose('Held text', [ref]); assert.equal(f.input().value, raw);
    assert.equal(f.all('[data-testid="compact-reference-row"]').length, 0);
    if (edit) await f.type(raw + 'Later raw edit');
    await f.releaseSend();
    const expected = edit ? raw + 'Later raw edit' : '';
    assert.equal(f.input().value, expected); assert.equal(await f.canonical(), expected);
    assert.equal(f.f.owner().getSnapshot().images.length, 0); assert.equal(f.f.sends.length, 1);
  });
}

test('Details dismissal returns focus to its connected opener and removing that opener cannot steal successor focus', async t => {
  const f = await fixture(t, { prefix: 'Focus draft' }); await f.prepare(); await f.prepare(agent('b'));
  const opener = f.all('[data-testid="compact-reference-details"]')[0];
  opener.focus(); await f.details(); await f.close();
  assert.equal(f.w.document.activeElement === opener, true);
  await f.details();
  const successor = f.input();
  await f.act(() => {
    f.all('[data-testid="compact-reference-remove"]')[0].click();
    successor.focus();
  });
  assert.equal(f.w.document.activeElement === successor, true);
  assert.equal(opener.isConnected, false);
  assert.equal(f.all('[data-testid="compact-reference-row"]').length, 1); assertNoDispatch(f);
});


test('empty-prose same-turn multiple preparation keeps caret zero and sends exact ordered reference-only bytes', async t => {
  const f = await fixture(t);
  const a = f.f.agentDiscussionReference(agent()), b = f.f.agentDiscussionReference(agent('b'));
  await f.act(() => {
    assert.equal(f.f.actions.current.prepareAgentResponse(path, a) === null, true);
    assert.equal(f.f.actions.current.prepareAgentResponse(path, b) === null, true);
  });
  assert.equal(f.input().value, ''); assertSelection(f.input(), 0);
  assert.equal(f.all('[data-testid="compact-reference-row"]').length, 2);
  assert.equal(f.get('[data-testid="compact-reference-list"]').getAttribute('aria-label'), '2 agent references');
  assert.equal(await f.canonical(), compose('', [a, b])); assertNoDispatch(f);
  await f.click('[data-testid="composer-send-btn"]');
  assert.equal(f.f.sends[0].text, compose('', [a, b]));
});

test('removing the inspected reference ends Details and readding the same identity does not reopen it', async t => {
  const f = await fixture(t, { prefix: 'Draft' }); const ref = await f.prepare();
  await f.details(); await f.remove(0);
  assert.equal(f.get('[data-testid="compact-reference-sheet"]') === null, true);
  await f.prepare();
  assert.equal(f.get('[data-testid="compact-reference-sheet"]') === null, true);
  assert.equal(f.input().value, 'Draft'); assert.equal(await f.canonical(), compose('Draft', [ref])); assertNoDispatch(f);
});

test('an exiting Details sheet cannot focus the next session after keyed navigation', async t => {
  const f = await fixture(t, { prefix: 'Session a' }); await f.prepare(); await f.details();
  const oldEditor = f.input();
  await f.act(() => f.f.setView({ path: '/synthetic/b' }));
  const successor = f.input(); successor.focus();
  await f.act(undefined, 80);
  assert.equal(oldEditor.isConnected, false); assert.equal(f.w.document.activeElement === successor, true);
  assert.equal(successor.value, ''); assert.equal(f.get('[data-testid="compact-reference-sheet"]') === null, true);
  assertNoDispatch(f);
});


test('same-act inspected reference removal and actual preparation of the same identity cannot reopen Details', async t => {
  const f = await fixture(t, { prefix: 'Draft' }); const ref = await f.prepare(); await f.details();
  await f.act(() => {
    f.get('[data-testid="compact-reference-remove"]').click();
    assert.equal(f.f.actions.current.prepareAgentResponse(path, ref) === null, true);
  });
  assert.equal(f.get('[data-testid="compact-reference-sheet"]') === null, true);
  assert.equal(f.all('[data-testid="compact-reference-row"]').length, 1);
  assert.equal(f.input().value, 'Draft'); assert.equal(await f.canonical(), compose('Draft', [ref])); assertNoDispatch(f);
});

test('a declined prompt goes back to the composer ahead of the draft and is never sent', async t => {
  const f = await fixture(t, { prefix: 'kept draft' });
  let problem;
  await f.act(() => { problem = f.f.actions.current.placeForEdit('/synthetic/elsewhere', 'Declined prompt'); });
  assert.equal(typeof problem, 'string'); assert.equal(f.input().value, 'kept draft');
  await f.act(() => { problem = f.f.actions.current.placeForEdit(path, 'Declined prompt'); });
  assert.equal(problem, null);
  assert.equal(f.input().value, 'Declined prompt\n\nkept draft');
  assert.equal(await f.canonical(), 'Declined prompt\n\nkept draft');
  assertNoDispatch(f);
});

test('a missing template catalogue never disables a draft with arguments or blocks an explicit Send tap', async t => {
  const f = await fixture(t, { prefix: '/uncatalogued-template "one two" three' });
  assert.equal(f.get('[data-testid="composer-send-btn"]').disabled, false);
  assert.equal(f.get('[data-testid="uncatalogued-command"]')?.textContent.includes('OMP will resolve it'), true);
  await f.click('[data-testid="composer-send-btn"]');
  assert.equal(f.f.sends[0].text, '/uncatalogued-template "one two" three');
  assert.equal(f.f.commands.length, 0);
});

test('selecting a discovered template stages its invocation and keeps photos without sending', async t => {
  const f = await fixture(t, { prefix: '/team-s', images: [initialImage] });
  const row = f.all('[data-testid="command-row"]').find(node => node.textContent.includes('/team-summary'));
  await f.click(row);
  assert.equal(f.input().value, '/team-summary ');
  assert.equal(f.f.owner().getSnapshot().images[0].data, initialImage.data);
  assertNoDispatch(f);
  await f.type('/team-summary "one two" next');
  await f.click('[data-testid="composer-send-btn"]');
  assert.equal(f.f.sends[0].text, '/team-summary "one two" next');
  assert.equal(f.f.sends[0].images[0].data, initialImage.data);
});

test('shell-looking drafts name Run/context policy and change visibly to Send prompt with a photo', async t => {
  const f = await fixture(t, { prefix: '!echo hi' });
  assert.equal(f.get('[data-testid="composer-send-btn"]').getAttribute('aria-label'), 'Run');
  assert.equal(f.get('[data-testid="composer-send-btn"]').textContent.includes('Run'), true);
  assert.match(f.get('[data-testid="composer-action"]').textContent, /Output enters model context.*no terminal PTY/);
  await f.type('!!echo hi');
  assert.match(f.get('[data-testid="composer-action"]').textContent, /Output stays out of model context/);
  await f.paste('', 'keep.png');
  assert.equal(f.get('[data-testid="composer-send-btn"]').getAttribute('aria-label'), 'Send');
  assert.match(f.get('[data-testid="composer-action"]').textContent, /Send as a prompt with photos.*Nothing runs directly/);
  await f.click('[data-testid="composer-send-btn"]');
  assert.equal(f.f.sends[0].text, '!!echo hi');
  assert.equal(f.f.sends[0].images.length, 1);
});

test('insert skill edits at the remembered caret without dispatching, losing text, photos or references', async t => {
  const prefix = 'Review 👩🏽‍💻 here\nkeep the end';
  const f = await fixture(t, { prefix, images: [initialImage] });
  const ref = await f.prepare();
  const caret = prefix.indexOf('here');
  f.input().setSelectionRange(caret, caret);
  await f.click('[data-testid="composer-plus-btn"]');
  await f.click('[data-testid="composer-insert-skill"]');
  await f.click('[data-testid="skill-row"]');
  const next = 'Review 👩🏽‍💻 /skill:plugin/review here\nkeep the end';
  assert.equal(f.input().value, next);
  assertSelection(f.input(), next.indexOf('here'));
  assert.equal(await f.canonical(), compose(next, [ref]));
  assert.equal(f.f.owner().getSnapshot().images[0].data, initialImage.data);
  assert.equal(f.all('[data-testid="compact-reference-row"]').length, 1);
  assertNoDispatch(f);
});

async function selectHistoryResult(f, line, offset = 42) {
  const before = f.w.historyReads?.length ?? 0;
  f.w.historyHits = [{ path: '/synthetic/original', line, offset, role: 'user', entryId: 'original-entry' }];
  await f.click('[data-testid="composer-plus-btn"]');
  await f.click('[data-testid="composer-history"]');
  await f.act(() => {
    const input = f.get('[data-testid="history-search"]');
    Object.getOwnPropertyDescriptor(f.w.HTMLInputElement.prototype, 'value').set.call(input, 'history');
    input.dispatchEvent(new f.w.Event('input', { bubbles: true }));
  }, 300);
  await f.click('[data-testid="history-row"]');
  assert.equal(f.w.historyReads.length, before + 1);
  return f.w.historyReads[before];
}

test('History restores full original whitespace, preserves photos and never inserts an unavailable preview', async t => {
  const f = await fixture(t, { prefix: 'Existing draft', images: [initialImage] });
  const full = '  original\n\nhistory message  ';
  const request = await selectHistoryResult(f, 'original history message');
  assert.deepEqual(Array.from(request.args), ['/synthetic/original', 42, 'original-entry']);
  await f.act(() => request.resolve(null));
  assert.equal(f.input().value, 'Existing draft');
  assert.match(f.get('[data-testid="history-error"]').textContent, /full original prompt is unavailable.*preview was not inserted/);
  await f.click('[data-testid="history-row"]');
  await f.act(() => f.w.historyReads[1].resolve(full));
  assert.equal(f.input().value, full + '\n\nExisting draft');
  assert.equal(f.f.owner().getSnapshot().images[0].data, initialImage.data);
  assertNoDispatch(f);
});

test('History pending recall cannot modify an editor that changed and then undid its edit', async t => {
  const f = await fixture(t, { prefix: 'Original draft' });
  const request = await selectHistoryResult(f, 'history original');
  await f.type('New draft');
  await f.type('Original draft');
  await f.act(() => request.resolve('history original'));
  assert.equal(f.input().value, 'Original draft');
  assert.match(f.get('[data-testid="history-error"]').textContent, /draft changed/);
  assertNoDispatch(f);
});

test('History pending recall cannot cross session A→B→A editor visits', async t => {
  const f = await fixture(t, { prefix: 'Original draft' });
  const request = await selectHistoryResult(f, 'history original');
  await f.act(() => f.f.setView({ path: '/synthetic/b' }));
  await f.act(() => f.f.setView({ path: '/synthetic/a' }));
  await f.act(() => request.resolve('history original'));
  assert.equal(f.input().value, 'Original draft');
  assert.equal(f.get('[data-testid="history-error"]') === null, true, 'outgoing sheet cannot report into the new visit');
  assertNoDispatch(f);
});

test('History pending recall cannot cross credentials even before a React remount', async t => {
  const f = await fixture(t, { prefix: 'Original draft', token: 'first-credential' });
  const request = await selectHistoryResult(f, 'history original');
  f.w.localStorage.setItem('omp-remote-token', 'second-credential');
  await f.act(() => request.resolve('history original'));
  assert.equal(f.input().value, 'Original draft');
  assertNoDispatch(f);
});

test('closing and reopening History fences an earlier full-prompt result from the new visit', async t => {
  const f = await fixture(t, { prefix: 'Kept draft' });
  const first = await selectHistoryResult(f, 'history first');
  await f.click('[data-testid="history-sheet"] [data-testid="sheet-close"]');
  const second = await selectHistoryResult(f, 'history second');
  await f.act(() => first.resolve('history first'));
  assert.equal(f.input().value, 'Kept draft');
  await f.act(() => second.resolve('history second'));
  assert.equal(f.input().value, 'history second\n\nKept draft');
  assertNoDispatch(f);
});

test('a skill chosen after the draft changes never replaces the newer editable content', async t => {
  const f = await fixture(t, { prefix: 'Original prose', images: [initialImage] });
  f.input().setSelectionRange(8, 8);
  await f.click('[data-testid="composer-plus-btn"]');
  await f.click('[data-testid="composer-insert-skill"]');
  await f.type('Newer prose');
  await f.click('[data-testid="skill-row"]');
  assert.equal(f.input().value, 'Newer prose');
  assert.equal(f.f.owner().getSnapshot().images[0].data, initialImage.data);
  assertNoDispatch(f);
});

test('a live agent reference never advertises a shell Run action', async t => {
  const f = await fixture(t, { prefix: 'Discuss findings' });
  const reference = await f.prepare();
  await f.type('!!echo hi');
  assert.equal(f.get('[data-testid="composer-send-btn"]').getAttribute('aria-label'), 'Send');
  assert.match(f.get('[data-testid="composer-action"]').textContent, /Send as a prompt with agent references.*Nothing runs directly/);
  assert.equal(await f.canonical(), compose('!!echo hi', [reference]));
  // Preserve the existing compact-reference boundary: reveal/remove it before
  // a leading command can be submitted, never execute hidden reference text.
  await f.click('[data-testid="composer-send-btn"]');
  assertNoDispatch(f);
});
