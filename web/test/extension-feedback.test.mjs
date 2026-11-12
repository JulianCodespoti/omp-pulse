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
import {ExtensionFeedback} from ${JSON.stringify(resolve(root, 'web/src/app/chat/ExtensionFeedback.tsx'))};
import {EMPTY_EXTENSION_FEEDBACK,reduceExtensionFeedback,readExtensionDraft,consumeExtensionDraft} from ${JSON.stringify(resolve(root, 'web/src/runtime/extension-feedback.ts'))};
import {getDraftNamespace,readDraft,flushAllDraftWrites} from ${JSON.stringify(resolve(root, 'web/src/app/composer/use-draft.ts'))};
import {getAttachmentDraft} from ${JSON.stringify(resolve(root, 'web/src/runtime/attachment-draft.ts'))};
import {DaemonApi} from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
import {agentDiscussionReference} from ${JSON.stringify(resolve(root, 'web/src/domain/agent-discussion.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
import {createOmpStore} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {getOfflineQueueNamespace} from ${JSON.stringify(resolve(root, 'web/src/runtime/offline-queue.ts'))};
DaemonApi.prototype.getPromptConfig=async()=>({magicKeywords:[]});
window.photos=new Map();const sends=[];let update,currentView,catchUpController;const actions={current:null};
function App(){const [view,setView]=useState({path:'/a',allowed:true,feedback:{...EMPTY_EXTENSION_FEEDBACK,editorDraft:readExtensionDraft(getDraftNamespace(),'/a')}});update=setView;currentView=view;
const consume=id=>{if(catchUpController){catchUpController.consumeEditorDraft(view.path,id);return}consumeExtensionDraft(getDraftNamespace(),view.path,id);setView(v=>({...v,feedback:{...v.feedback,editorDraft:readExtensionDraft(getDraftNamespace(),v.path)}}))};
return h('div',null,h(ExtensionFeedback,{feedback:view.feedback,placement:'aboveEditor'}),h(Composer,{sessionPath:view.path,busy:false,sendAllowed:view.allowed,draftActionsRef:actions,extensionDraft:view.feedback.editorDraft,onConsumeExtensionDraft:consume,onSend:(...args)=>sends.push(args),onStop:()=>{}}),h(ExtensionFeedback,{feedback:view.feedback,placement:'belowEditor'}));}
window.fixture={act,sends,actions,getDraftNamespace,readDraft,flushAllDraftWrites,
retainBeforeMount:event=>reduceExtensionFeedback(EMPTY_EXTENSION_FEEDBACK,event,getDraftNamespace(),'/a'),
receive:event=>update(v=>({...v,feedback:reduceExtensionFeedback(v.feedback,event,getDraftNamespace(),v.path)})),
startCatchUp:requests=>{
  const store=createOmpStore();
  const controller=catchUpController=new OmpSessionController(store,'','http://synthetic.invalid');
  controller.runningAgentCount.stop();store.getState().beginSession('/a');store.getState().setExtensionFeedback(()=>currentView.feedback);
  controller.activeSession='/a';
  store.subscribe(()=>update(v=>({...v,feedback:store.getState().extensionFeedback})));
  let finish;const held=new Promise(resolve=>{finish=resolve});
  controller.request=async()=>{await held;return {entries:[],endOffset:1,nextBefore:null,
    extensionFeedback:{type:'extension_ui_snapshot',requests},
    sessionState:{daemonInstanceId:'synthetic-daemon',revision:1,bindingEpoch:1,owner:{kind:'child',pid:1},
      turn:'idle',confidence:'confirmed',connection:'connected',observedAt:1,activity:null,capabilities:{read:true}}}};
  controller.handleFrame({type:'resync'},0,'/a');
  return finish;
},
stopCatchUp:()=>catchUpController?.dispose(),
prepareFromTree:(path,text)=>{
  const controller=Object.create(OmpSessionController.prototype);
  Object.assign(controller,{activeSession:'/a',queueNamespace:getOfflineQueueNamespace(),store:{getState:()=>({
    authRejected:false,setExtensionFeedback:apply=>update(v=>({...v,feedback:apply(v.feedback)})),
  })}});
  return controller.prepareEditorDraft(path,text);
},
switch:path=>{flushAllDraftWrites();update(v=>({...v,path,feedback:{...EMPTY_EXTENSION_FEEDBACK,editorDraft:readExtensionDraft(getDraftNamespace(),path)}}))},
prepareReference:()=>actions.current.prepareAgentResponse('/a',agentDiscussionReference({id:'worker',name:'Worker',source:'desktop',createdAt:7,connectionId:'desktop-a'})),
allowed:allowed=>update(v=>({...v,allowed})),owner:()=>getAttachmentDraft(getDraftNamespace(),'/a'),
mount(){const r=createRoot(document.getElementById('root'));r.render(h(App));return r;}};
`, [{
  name: 'synthetic-attachment-storage',
  resolveId(id, importer) { return importer?.endsWith('/attachment-draft.ts') && id === './offline-queue' ? '\0attachments' : null; },
  load(id) {
    if (id !== '\0attachments') return null;
    return `export * from ${JSON.stringify(resolve(root, 'web/src/runtime/offline-queue.ts'))};
export const loadDraftAttachments=async(path,namespace)=>window.photos.get(namespace+':'+path)??[];
export const saveDraftAttachments=async(path,images,namespace)=>{window.photos.set(namespace+':'+path,images);return true};
export const registerDraftAttachmentFlusher=()=>()=>{};`;
  },
}]);
const editorFrame = (id, text) => ({ type: 'extension_ui_request', id, method: 'set_editor_text', text });
const snapshot = requests => ({ type: 'extension_ui_snapshot', requests });
async function fixture(t, text = '', photos = [], storage = [], initialEditor = null) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  w.HTMLElement.prototype.scrollIntoView = () => {};
  for (const [key, value] of storage) w.localStorage.setItem(key, value);
  const namespace = f.getDraftNamespace();
  if (text) w.localStorage.setItem(`omp-draft:${namespace}:/a`, text);
  w.photos.set(`${namespace}:/a`, photos);
  if (initialEditor) f.retainBeforeMount(initialEditor);
  let mounted;
  const act = async callback => {
    await f.act(async () => { await callback?.(); });
    await f.act(async () => { await new Promise(resolve => w.setTimeout(resolve, 20)); });
  };
  await act(() => { mounted = f.mount(); });
  t.after(async () => { try { await f.act(async () => { mounted.unmount(); f.stopCatchUp(); }); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const input = () => w.document.querySelector('[data-testid="composer-input"]');
  const click = label => act(() => {
    const button = [...w.document.querySelectorAll('button')].find(button => button.textContent === label);
    assert.ok(button, label); button.click();
  });
  const type = value => act(() => {
    Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype, 'value').set.call(input(), value);
    input().dispatchEvent(new w.Event('input', { bubbles: true }));
  });
  return { w, f, act, input, click, type, receive: event => act(() => f.receive(event)),
    remount: () => act(() => { mounted.unmount(); mounted = f.mount(); }) };
}

test('extension text seeds an empty composer exactly, never sends, and consumed replay stays consumed after remount', async t => {
  const f = await fixture(t);
  const event = editorFrame('source-1:1', '  Prepared\ntext  ');
  await f.receive(event);
  assert.equal(f.input().value, event.text);
  assert.equal(f.f.sends.length, 0);
  await f.type('');
  await f.remount();
  await f.receive(snapshot([event]));
  assert.equal(f.input().value, '');
  assert.equal(f.w.document.querySelector('[data-testid="extension-editor-draft"]'), null);
  await f.act(() => f.f.flushAllDraftWrites());
  const storage = Array.from({ length: f.w.localStorage.length }, (_, index) => {
    const key = f.w.localStorage.key(index);
    return [key, f.w.localStorage.getItem(key)];
  });
  const reloaded = await fixture(t, '', [], storage);
  await reloaded.receive(snapshot([event]));
  assert.equal(reloaded.input().value, '');
  assert.equal(reloaded.w.document.querySelector('[data-testid="extension-editor-draft"]'), null);
});

test('prepared text present at the initial editor mount becomes visible after draft hydration without replacing saved input', async t => {
  const event = editorFrame('initial-mount', '  Prepared before mount\nExact text  ');
  const empty = await fixture(t, '', [], [], event);
  assert.equal(empty.input().value, event.text);
  assert.equal(empty.f.readDraft('/a', empty.f.getDraftNamespace()), event.text);
  assert.equal(empty.w.document.querySelector('[data-testid="extension-editor-draft"]'), null);
  const occupied = await fixture(t, 'Already saved', [], [], event);
  assert.equal(occupied.input().value, 'Already saved');
  assert.match(occupied.w.document.querySelector('[data-testid="extension-editor-draft"]').textContent, /Prepared before mount/);
  assert.equal(occupied.f.readDraft('/a', occupied.f.getDraftNamespace()), 'Already saved');
  assert.equal(empty.f.sends.length + occupied.f.sends.length, 0);
});

test('existing typed text is protected; review can keep both, replace explicitly, or dismiss without replay resurrection', async t => {
  const f = await fixture(t, 'My unsent words');
  const event = editorFrame('source-1:2', 'Prepared words');
  await f.receive(event);
  assert.equal(f.input().value, 'My unsent words');
  assert.match(f.w.document.body.textContent, /Your draft is kept/);
  await f.click('Add to draft');
  assert.equal(f.input().value, 'My unsent words\n\nPrepared words');
  await f.receive(editorFrame('source-1:3', 'Replacement'));
  assert.equal(f.input().value, 'My unsent words\n\nPrepared words');
  await f.click('Replace my text');
  assert.equal(f.input().value, 'Replacement');
  const dismissed = editorFrame('source-1:4', 'Discard me');
  await f.receive(dismissed);
  await f.click('Dismiss prepared text');
  await f.remount();
  await f.receive(snapshot([dismissed]));
  assert.equal(f.input().value, 'Replacement');
  assert.equal(f.w.document.querySelector('[data-testid="extension-editor-draft"]'), null);
  assert.equal(f.f.sends.length, 0);
});

test('prepared drafts follow their original conversation across switching and reload', async t => {
  const f = await fixture(t, 'Draft A');
  const event = editorFrame('source-1:5', 'For A');
  await f.receive(event);
  await f.act(() => f.f.switch('/b'));
  assert.equal(f.input().value, '');
  assert.equal(f.w.document.querySelector('[data-testid="extension-editor-draft"]'), null);
  await f.type('Draft B');
  await f.act(() => f.f.switch('/a'));
  assert.equal(f.input().value, 'Draft A');
  await f.remount();
  assert.match(f.w.document.body.textContent, /For A/);
  await f.click('Add to draft');
  assert.equal(f.input().value, 'Draft A\n\nFor A');
  await f.act(() => f.f.switch('/b'));
  assert.equal(f.input().value, 'Draft B');
  assert.equal(f.f.sends.length, 0);
});

test('photo-only input is not truly empty, and an empty editor update requires explicit clear', async t => {
  const photo = { data: 'cGhvdG8=', mimeType: 'image/png', previewUrl: 'data:image/png;base64,cGhvdG8=', name: 'kept.png', width: 1, height: 1 };
  const f = await fixture(t, '', [photo]);
  await f.receive(editorFrame('source-1:6', 'With photo'));
  assert.equal(f.input().value, '');
  assert.ok(f.w.document.querySelector('[data-testid="composer-attachments"]'));
  await f.click('Add to draft');
  await f.receive(editorFrame('source-1:7', ''));
  assert.equal(f.input().value, 'With photo');
  await f.click('Clear my text');
  assert.equal(f.input().value, '');
  assert.ok(f.w.document.querySelector('[data-testid="composer-attachments"]'));
  assert.equal(f.f.sends.length, 0);
});

test('disabled sends and IME composition defer prepared text and do not dispatch Enter', async t => {
  const f = await fixture(t);
  await f.act(() => f.f.allowed(false));
  await f.receive(editorFrame('source-1:8', 'Wait for input'));
  assert.equal(f.input().value, '');
  await f.act(() => f.f.allowed(true));
  assert.equal(f.input().value, 'Wait for input');
  await f.type('');
  await f.act(() => f.input().dispatchEvent(new f.w.CompositionEvent('compositionstart', { bubbles: true })));
  await f.receive(editorFrame('source-1:9', 'After composition'));
  assert.equal(f.input().value, '');
  await f.act(() => f.input().dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  assert.equal(f.f.sends.length, 0);
  await f.act(() => f.input().dispatchEvent(new f.w.CompositionEvent('compositionend', { bubbles: true })));
  assert.equal(f.input().value, 'After composition');
});

test('notices retain severity, statuses update and clear, widgets retain placement, snapshots remove stale feedback', async t => {
  const f = await fixture(t);
  const frame = (id, method, fields) => ({ type: 'extension_ui_request', id, method, ...fields });

  await f.receive(frame('n', 'notify', { message: 'Careful', notifyType: 'warning' }));
  assert.match(f.w.document.querySelector('[role="alert"]').textContent, /Careful/);
  await f.receive(frame('s', 'setStatus', { statusKey: 'review', statusText: 'Reviewing' }));
  await f.receive(frame('w', 'setWidget', { widgetKey: 'Summary', widgetLines: ['<b>plain</b>', 'second line'], widgetPlacement: 'belowEditor' }));
  const below = f.w.document.querySelector('[data-testid="extension-feedback-belowEditor"]');
  assert.equal(below.querySelector('pre').textContent, '<b>plain</b>\nsecond line');
  assert.equal(below.querySelector('b'), null);
  await f.receive(frame('s2', 'setStatus', { statusKey: 'review', statusText: 'Ready' }));
  assert.doesNotMatch(f.w.document.body.textContent, /Reviewing/);
  await f.receive(frame('s3', 'setStatus', { statusKey: 'review' }));
  assert.doesNotMatch(f.w.document.body.textContent, /Ready/);
  await f.receive(frame('internal', 'setWidget', { widgetKey: 'omp-pulse:state', widgetLines: ['hidden bookkeeping'] }));
  assert.doesNotMatch(f.w.document.body.textContent, /hidden bookkeeping/);
  await f.receive(snapshot([]));
  assert.equal(f.w.document.querySelector('[aria-label="Extension feedback"]'), null);
  assert.equal(f.f.sends.length, 0);
});
test('extension text does not replace a compact agent reference and adding retains its context', async t => {
  const f = await fixture(t, 'Discuss this');
  await f.act(() => { assert.equal(f.f.prepareReference(), null); });
  assert.ok(f.w.document.querySelector('[data-testid="compact-reference-details"]'));
  await f.receive(editorFrame('source-1:reference', 'Extra instructions'));
  assert.equal(f.input().value, 'Discuss this');
  assert.ok(f.w.document.querySelector('[data-testid="compact-reference-details"]'));
  await f.click('Add to draft');
  assert.equal(f.input().value, 'Discuss this\n\nExtra instructions');
  assert.ok(f.w.document.querySelector('[data-testid="compact-reference-details"]'));
  assert.equal(f.f.sends.length, 0);
});

test('committed tree editor text uses the native prepared draft review without replacing typed input', async t => {
  const f = await fixture(t, 'Draft kept');
  const prepared = '  Earlier prompt\nExact text  ';
  await f.act(() => f.f.prepareFromTree('/a', prepared));
  assert.equal(f.input().value, 'Draft kept');
  assert.equal(f.f.readDraft('/a'), 'Draft kept');
  assert.match(f.w.document.querySelector('[data-testid="extension-editor-draft"]').textContent, /Earlier prompt/);
  await f.click('Add to draft');
  assert.equal(f.input().value, 'Draft kept\n\n' + prepared);
  assert.equal(f.f.sends.length, 0);
});

test('a stale tree editor result cannot prepare text for another active conversation', async t => {
  const f = await fixture(t, 'Draft kept');
  await f.act(() => f.f.prepareFromTree('/b', 'Stale result'));
  assert.equal(f.input().value, 'Draft kept');
  assert.equal(f.w.document.querySelector('[data-testid="extension-editor-draft"]'), null);
  assert.equal(f.f.sends.length, 0);
});

test('failed explicit preparation preserves the durable inbox and typed draft', async t => {
  const f = await fixture(t, 'My unsent text');
  await f.act(() => assert.equal(f.f.prepareFromTree('/a', 'Previously prepared'), true));
  const key = `omp-extension-drafts:${f.f.getDraftNamespace()}`;
  const saved = f.w.localStorage.getItem(key);
  const original = f.w.Storage.prototype.setItem;
  f.w.Storage.prototype.setItem = function(name, value) {
    if (name === key) throw new Error('Synthetic quota refusal');
    return original.call(this, name, value);
  };
  try {
    await f.act(() => assert.throws(() => f.f.prepareFromTree('/a', 'Not durable'), /quota refusal/));
    assert.equal(f.w.localStorage.getItem(key), saved);
    assert.equal(f.input().value, 'My unsent text');
    assert.equal(f.w.document.querySelector('[data-testid="extension-editor-draft"] pre').textContent, 'Previously prepared');
  } finally {
    f.w.Storage.prototype.setItem = original;
  }
  await f.remount();
  assert.equal(f.input().value, 'My unsent text');
  assert.equal(f.w.document.querySelector('[data-testid="extension-editor-draft"] pre').textContent, 'Previously prepared');
  assert.equal(f.f.sends.length, 0);
});

for (const typed of [false, true]) test(`resync restores extension feedback and prepared text through the real composer (typed during read=${typed})`, async t => {
  const f = await fixture(t);
  await f.receive({ type: 'extension_ui_request', id: 'old-status', method: 'setStatus', statusKey: 'review', statusText: 'Reviewing before missed updates' });
  let finish;
  const prepared = '  Recovered prepared text\nExact spacing  ';
  await f.act(() => { finish = f.f.startCatchUp([editorFrame('recovered-editor', prepared)]); });
  if (typed) await f.type('My newer unsent words');
  await f.act(() => finish());
  assert.doesNotMatch(f.w.document.body.textContent, /Reviewing before missed updates/);
  assert.equal(f.input().value, typed ? 'My newer unsent words' : prepared);
  if (typed) {
    assert.equal(f.w.document.querySelector('[data-testid="extension-editor-draft"] pre').textContent, prepared);
    await f.click('Add to draft');
    assert.equal(f.input().value, 'My newer unsent words\n\n' + prepared);
  } else {
    assert.equal(f.w.document.querySelector('[data-testid="extension-editor-draft"]'), null);
  }
  assert.equal(f.f.sends.length, 0);
});
