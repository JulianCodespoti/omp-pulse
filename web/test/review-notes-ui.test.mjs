import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture, createDomFixture, root} from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h, Fragment, act, useSyncExternalStore} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {ChangesTab} from ${JSON.stringify(resolve(root, 'web/src/app/tools/ChangesTab.tsx'))};
import {DiffView} from ${JSON.stringify(resolve(root, 'web/src/app/parts/DiffPart.tsx'))};
import {useProvideWorkspaceHost} from ${JSON.stringify(resolve(root, 'web/src/app/tools/workspace-host.ts'))};
import {createOmpStore} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-store.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root, 'web/src/runtime/omp-session-controller.ts'))};
import {getOfflineQueueNamespace, setOfflineQueueNamespace} from ${JSON.stringify(resolve(root, 'web/src/runtime/offline-queue.ts'))};
import {readReviewNotes} from ${JSON.stringify(resolve(root, 'web/src/runtime/review-notes.ts'))};
import {readExtensionDraft} from ${JSON.stringify(resolve(root, 'web/src/runtime/extension-feedback.ts'))};
import {openWorkspace, usePanels} from ${JSON.stringify(resolve(root, 'web/src/app/nav/panels.ts'))};
import {Composer} from ${JSON.stringify(resolve(root, 'web/src/app/composer/Composer.tsx'))};
import {getDraftNamespace} from ${JSON.stringify(resolve(root, 'web/src/app/composer/use-draft.ts'))};
import {getAttachmentDraft} from ${JSON.stringify(resolve(root, 'web/src/runtime/attachment-draft.ts'))};
import {DaemonApi} from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
DaemonApi.prototype.getPromptConfig = async () => ({magicKeywords: []});
const store = createOmpStore();
const controller = Object.create(OmpSessionController.prototype);
const host = {controller, jumpTo: () => {}, onBranched: () => {}};
const panel = {}, sends = [], anchors = [];
let path = '/a';
window.photos = new Map();
setOfflineQueueNamespace('review-ui');
Object.assign(controller, {store, activeSession: path, queueNamespace: getOfflineQueueNamespace(), baseUrl: 'http://synthetic.invalid', disposed: false});
function Host({children}) { useProvideWorkspaceHost(host); return children; }
function Probe() { panel.workspace = usePanels().workspace; return null; }
function Draft({sessionPath}) {
 const feedback = useSyncExternalStore(store.subscribe, () => store.getState().extensionFeedback);
 return h(Composer, {sessionPath, busy:false, sendAllowed:true, extensionDraft: feedback.editorDraft,
 onConsumeExtensionDraft: id => controller.consumeEditorDraft(sessionPath, id), onSend:(...args) => sends.push(args), onStop:() => {}});
}
window.fixture = {act, sends, anchors, panel, getDraftNamespace,
 notes: () => readReviewNotes({namespace:getOfflineQueueNamespace(),sessionPath:path}),
 prepared: () => readExtensionDraft(getOfflineQueueNamespace(), path),
 owner: () => getAttachmentDraft(getDraftNamespace(), path),
 mount(options = {}) {
   const r = createRoot(document.getElementById('root'));
   const render = (next = options) => {
     path = next.sessionPath ?? '/a';
     if (next.namespace) setOfflineQueueNamespace(next.namespace);
     Object.assign(controller, {activeSession:path, queueNamespace:getOfflineQueueNamespace()});
     store.setState({sessionPath:path});
     openWorkspace('changes');
     const content = h(Fragment, null, h(Probe), h(ChangesTab, {sessionPath:path, active:next.active ?? true}), next.composer ? h(Draft, {sessionPath:path}) : null);
     r.render(next.host === false ? content : h(Host, null, content));
   };
   render(); return {render, unmount:() => r.unmount()};
 },
 mountDiff(patch, annotated=true) {
   const r = createRoot(document.getElementById('root'));
   const render = patch => r.render(h(DiffView, {patch, onAnnotate:annotated ? line => anchors.push(line) : undefined}));
   render(patch); return {render, unmount:() => r.unmount()};
 }
};
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

const patch = "diff --git a/a.ts b/a.ts\nindex 123..456 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -10,3 +20,3 @@ heading\n context\n-old 'quoted'\n+new\tcode\n tail\n\\ No newline at end of file\n@@ -40,0 +50,2 @@\n+first\n+second\n";
const file = {path:'a.ts',status:'modified',additions:3,deletions:1,patch,binary:false,patchTruncated:false};
const changes = files => ({ok:true,cwd:'/repo',repoRoot:'/repo',branch:'main',notRepo:false,truncated:false,files});
const plain = value => JSON.parse(JSON.stringify(value));
async function fixture(t, options = {}) {
  const dom = createDomFixture(code), w = dom.window, api = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  w.HTMLElement.prototype.scrollIntoView = () => {};
  const requests = [];
  let response = changes(options.files ?? [file]), deferred = false;
  w.TextEncoder = TextEncoder;
  w.fetch = (url, init) => {
    assert.ok(String(url).startsWith('/api/changes?'), `Unexpected request: ${url}`);
    return new Promise((resolve, reject) => {
      const request = {url:String(url),init,resolve:body => resolve({ok:true,status:200,json:async() => body}),reject};
      requests.push(request);
      if (!deferred) request.resolve(response);
    });
  };
  for (const [key,value] of options.storage ?? []) w.localStorage.setItem(key,value);
  if (options.draft) w.localStorage.setItem(`omp-draft:${api.getDraftNamespace()}:/a`, options.draft);
  if (options.photos) w.photos.set(`${api.getDraftNamespace()}:/a`, options.photos);
  const act = async fn => {
    await api.act(async () => { await fn?.(); });
    await api.act(async () => { await new Promise(resolve => w.setTimeout(resolve, 20)); });
  };
  let mounted;
  await act(() => { mounted = options.diff !== undefined ? api.mountDiff(options.diff, options.annotated) : api.mount(options); });
  t.after(async () => { try { await api.act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const all = selector => [...w.document.querySelectorAll(selector)];
  const button = text => all('button').find(node => node.textContent.trim() === text);
  const click = target => act(() => { const node = typeof target === 'string' ? button(target) : target; assert.equal(Boolean(node),true,`Missing button: ${target}`); node.click(); });
  const select = async value => act(() => { const node = w.document.querySelector('select[aria-label="Line to annotate"]'); assert.equal(Boolean(node),true); node.value = String(value); node.dispatchEvent(new w.Event('change',{bubbles:true})); });
  const type = text => act(() => { const input = w.document.querySelector('textarea[aria-label="Note"]'); assert.equal(Boolean(input),true); Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(input,text); input.dispatchEvent(new w.Event('input',{bubbles:true})); });
  const expand = path => click(all('button[aria-expanded]').find(node => node.getAttribute('aria-label')?.includes(` ${path},`)));
  const openNotes = () => click(all('button').find(node => /^Notes(?: \(\d+\))?$/.test(node.getAttribute('aria-label') ?? '')));
  const savedRows = () => all('section[aria-label="Saved review notes"] button');
  const addFileNote = async text => { await openNotes(); await expand(options.files?.[0]?.path ?? 'a.ts'); await click('Add file note'); await type(text); await click('Save note'); };
  return {w,api,act,all,button,click,select,type,expand,openNotes,savedRows,addFileNote,requests,
    response:body => {response=body;}, defer:() => {deferred=true;},
    render:next => act(() => mounted.render(next)),
    remount:() => act(() => {mounted.unmount();mounted=api.mount(options);}),
    storage:() => Array.from({length:w.localStorage.length},(_,i) => {const key=w.localStorage.key(i);return [key,w.localStorage.getItem(key)];}),
  };
}

test('line annotations capture old/new coordinates across hunks without annotating headers or newline markers', async t => {
  const f = await fixture(t,{diff:patch});
  const options = f.all('select option').filter(node => node.value !== '');
  assert.equal(options.length,6);
  for (const option of options) { await f.select(option.value); await f.click('Add line note'); }
  assert.deepEqual(plain(f.api.anchors),[
    {hunkHeader:'@@ -10,3 +20,3 @@ heading',lineText:'context',oldLine:10,newLine:20},
    {hunkHeader:'@@ -10,3 +20,3 @@ heading',lineText:"old 'quoted'",oldLine:11},
    {hunkHeader:'@@ -10,3 +20,3 @@ heading',lineText:'new\tcode',newLine:21},
    {hunkHeader:'@@ -10,3 +20,3 @@ heading',lineText:'tail',oldLine:12,newLine:22},
    {hunkHeader:'@@ -40,0 +50,2 @@',lineText:'first',newLine:50},
    {hunkHeader:'@@ -40,0 +50,2 @@',lineText:'second',newLine:51},
  ]);
  await f.render('@@ -1 +1 @@\n-other\n+replacement\n');
  assert.equal(f.w.document.querySelector('select').value,'');
  assert.equal(f.button('Add line note').disabled,true,'refresh cannot silently retarget the chosen index');
});

test('read-only transcript diffs have no annotation controls', async t => {
  const f = await fixture(t,{diff:patch,annotated:false});
  assert.equal(f.all('select').length,0);
  assert.equal(f.api.anchors.length,0);
});

test('add, edit, cancel and remove preserve exact saved note text and captured line context', async t => {
  const f = await fixture(t);
  await f.openNotes(); await f.expand('a.ts'); await f.select(2); await f.click('Add line note');
  const text = "  Don't normalize \\ this\nsecond line  ";
  await f.type(text); await f.click('Save note');
  assert.equal(f.api.notes()[0].text,text);
  assert.deepEqual(plain(f.api.notes()[0].line),{hunkHeader:'@@ -10,3 +20,3 @@ heading',lineText:"old 'quoted'",oldLine:11});
  await f.expand('a.ts'); await f.expand('a.ts');
  await f.click(f.savedRows()[0]); await f.type('discard this edit'); await f.click('Cancel');
  assert.equal(f.api.notes()[0].text,text);
  await f.click(f.savedRows()[0]); await f.type('edited\nexact'); await f.click('Save note');
  assert.equal(f.api.notes()[0].text,'edited\nexact');
  await f.remount(); assert.equal(f.savedRows().length,1);
  await f.click(f.savedRows()[0]); await f.click('Remove');
  assert.equal(f.api.notes().length,0); assert.equal(f.savedRows().length,0);
});

test('file notes work for binary and missing patches and survive reload with credential/session isolation', async t => {
  const binary = {...file,path:'image.png',patch:'',binary:true};
  const f = await fixture(t,{files:[binary]});
  await f.addFileNote('Inspect binary metadata');
  assert.equal(f.api.notes()[0].scope,'file');
  await f.render({sessionPath:'/b'}); assert.equal(f.savedRows().length,0);
  await f.render({sessionPath:'/a'}); assert.equal(f.savedRows().length,1);
  await f.render({namespace:'another-device',sessionPath:'/a'}); assert.equal(f.savedRows().length,0);
  await f.render({namespace:'review-ui',sessionPath:'/a'}); assert.equal(f.savedRows().length,1);
  const reloaded = await fixture(t,{files:[binary],storage:f.storage()});
  assert.equal(reloaded.savedRows().length,1);
  assert.equal(reloaded.api.notes()[0].text,'Inspect binary metadata');
  const noPatch = await fixture(t,{files:[{...file,patch:'',patchTruncated:true}]});
  await noPatch.addFileNote('Need full diff'); assert.equal(noPatch.api.notes().length,1);
});

test('refresh marks changed or missing snapshots stale and opens their old context without moving notes', async t => {
  const f = await fixture(t); await f.addFileNote('Check original');
  f.response(changes([{...file,patch:'@@ -1 +1 @@\n-other\n+replacement\n'}]));
  await f.click(f.all('button').find(node => node.getAttribute('aria-label') === 'Refresh changes'));
  assert.match(f.savedRows()[0].textContent,/Stale/);
  assert.equal(f.button('Prepare review').disabled,true);
  await f.click(f.savedRows()[0]);
  const sheet = f.w.document.querySelector('[data-testid="review-note-editor"]');
  assert.match(sheet.textContent,/snapshot changed or is missing/);
  assert.equal(sheet.querySelector('details [data-testid="diff-line-content"]').textContent,'@@ -10,3 +20,3 @@ heading');
  await f.click('Cancel');
  f.response(changes([])); await f.click(f.all('button').find(node => node.getAttribute('aria-label') === 'Refresh changes'));
  assert.match(f.savedRows()[0].textContent,/Stale/);
  assert.equal(f.api.notes()[0].file.patch,patch);
});

test('preparation rechecks changes, preserves typed draft/photos and notes, and never sends', async t => {
  const photo={data:'cGhvdG8=',mimeType:'image/png',previewUrl:'data:image/png;base64,cGhvdG8=',name:'kept.png',width:1,height:1};
  const f = await fixture(t,{composer:true,draft:'My unsent words',photos:[photo]});
  await f.addFileNote("Don't lose exact note bytes");
  const count=f.requests.length;
  await f.click('Prepare review');
  assert.equal(f.requests.length,count+1);
  assert.equal(f.api.panel.workspace,null);
  assert.equal(f.w.document.querySelector('[data-testid="composer-input"]').value,'My unsent words');
  assert.equal(f.api.owner().getSnapshot().images.length,1);
  assert.equal(f.api.sends.length,0);
  assert.equal(f.api.notes().length,1);
  assert.match(f.api.prepared().text,/^\/review /);
  assert.match(f.api.prepared().text,/lose exact note bytes/);
});

test('preparation discovers stale changes before touching the prepared inbox', async t => {
  const f = await fixture(t); await f.addFileNote('Review original');
  f.response(changes([{...file,patch:'@@ -1 +1 @@\n-before\n+after\n'}]));
  await f.click('Prepare review');
  assert.equal(f.api.prepared(),null);
  assert.equal(f.api.panel.workspace,'changes');
  assert.equal(f.api.notes().length,1);
  assert.match(f.savedRows()[0].textContent,/Stale/);
});

test('late preparation is fenced after session, credential or active-view changes', async t => {
  for (const next of [{sessionPath:'/b'},{sessionPath:'/a',namespace:'new-device'},{sessionPath:'/a',active:false},{sessionPath:'/a',host:false}]) {
    const f=await fixture(t); await f.addFileNote('Retain original'); f.defer();
    await f.click('Prepare review'); const pending=f.requests.at(-1);
    await f.render(next);
    await f.act(() => pending.resolve(changes([file])));
    assert.equal(f.api.prepared(),null);
    assert.equal(f.api.sends.length,0);
    assert.equal(f.api.panel.workspace,'changes');
  }
});

test('persistence failures keep typed note recoverable and no-host preparation stays unavailable', async t => {
  const f=await fixture(t,{host:false}); await f.openNotes(); await f.expand('a.ts'); await f.click('Add file note');
  await f.type('Keep this unsaved note');
  const set=f.w.Storage.prototype.setItem;
  f.w.Storage.prototype.setItem=function(){throw new Error('Synthetic quota failure');};
  await f.click('Save note');
  assert.equal(f.w.document.querySelector('textarea[aria-label="Note"]').value,'Keep this unsaved note');
  assert.equal(f.api.notes().length,0);
  f.w.Storage.prototype.setItem=set;
  await f.click('Save note'); assert.equal(f.api.notes().length,1);
  assert.equal(f.button('Prepare review').disabled,true);
});

test('oversized note errors preserve typed text and oversized preparation preserves all saved notes', async t => {
  const f=await fixture(t);
  await f.openNotes(); await f.expand('a.ts'); await f.click('Add file note');
  const text='n'.repeat(32_769);
  await f.type(text); await f.click('Save note');
  assert.equal(f.w.document.querySelector('textarea[aria-label="Note"]').value,text);
  assert.equal(f.api.notes().length,0);
  await f.type('Shorter note'); await f.click('Save note');
  assert.equal(f.api.notes()[0].text,'Shorter note');
  const large={...file,patch:'@@ -1 +1 @@\n-before\n+'+'x'.repeat(70_000)+'\n'};
  const oversized=await fixture(t,{files:[large]});
  await oversized.addFileNote('Review the whole captured change');
  await oversized.click('Prepare review');
  assert.equal(oversized.api.prepared(),null);
  assert.equal(oversized.api.panel.workspace,'changes');
  assert.equal(oversized.api.notes().length,1);
  assert.equal(oversized.api.notes()[0].file.patch,large.patch);
  assert.match(oversized.w.document.body.textContent,/65,536/);
});

test('failed durable preparation retains notes and the existing prepared inbox', async t => {
  const f=await fixture(t);
  await f.addFileNote('Keep the previous prepared text safe');
  await f.click('Prepare review');
  const previous=plain(f.api.prepared());
  await f.render({});
  const set=f.w.Storage.prototype.setItem;
  f.w.Storage.prototype.setItem=function(key,value) {
    if (key.startsWith('omp-extension-drafts:')) throw new Error('Synthetic prepared inbox quota failure');
    return set.call(this,key,value);
  };
  await f.click('Prepare review');
  f.w.Storage.prototype.setItem=set;
  assert.deepEqual(plain(f.api.prepared()),previous);
  assert.equal(f.api.notes().length,1);
  assert.equal(f.api.panel.workspace,'changes');
  assert.match(f.w.document.body.textContent,/Synthetic prepared inbox quota failure/);
});
