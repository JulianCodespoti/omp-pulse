import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
import { pluginHostStub } from './support/plugin-host-stub.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h,act,useState} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {ExtensionFeedback} from ${JSON.stringify(resolve(root, 'web/src/app/chat/ExtensionFeedback.tsx'))};
import {PluginSlot} from ${JSON.stringify(resolve(root, 'web/src/app/plugins/PluginSlot.tsx'))};
import {DrawerSessionRow} from ${JSON.stringify(resolve(root, 'web/src/app/nav/DrawerSessionRow.tsx'))};
import {SessionActionsSheet} from ${JSON.stringify(resolve(root, 'web/src/app/sessions/SessionActionsSheet.tsx'))};
import {Composer} from ${JSON.stringify(resolve(root, 'web/src/app/composer/Composer.tsx'))};
import {DaemonApi} from ${JSON.stringify(resolve(root, 'web/src/runtime/rpc-client.ts'))};
import {EMPTY_EXTENSION_FEEDBACK} from ${JSON.stringify(resolve(root, 'web/src/runtime/extension-feedback.ts'))};
import {usePluginKey} from ${JSON.stringify(resolve(root, 'web/src/app/plugins/use-plugin-host.ts'))};
import {pluginHost} from ${JSON.stringify(resolve(root, 'web/src/runtime/plugin-host'))};
DaemonApi.prototype.getPromptConfig=async()=>({magicKeywords:[]});
window.photos=new Map();
const chip=(text,click)=>({k:'chip',p:{text,actions:{click}},c:[]});
const menuList=(click,id,label)=>({k:'list',p:{actions:{click},items:[{id,label,detail:'Detail'}]},c:[]});
const A={path:'/s/a.jsonl',title:'Alpha',cwd:'/work/alpha',activeAt:Date.now()};
const B={path:'/s/b.jsonl',title:'Bravo',cwd:'/work/bravo',activeAt:Date.now()};
const hooks=window.pluginHostTest={
  state:{catalog:[],catalogError:null,runtimes:{},haltedAfterCrash:false,
    views:{
      'composer.status':[{pluginId:'demo',pluginName:'Demo',view:chip('Load 0.1','status-tap')}],
      'composer.actions':[{pluginId:'demo',pluginName:'Demo',view:menuList('plus-act','plus-1','Plus thing')}],
      drawer:[{pluginId:'demo',pluginName:'Demo',view:chip('Drawer chip','drawer-tap')}],
      page:[]},
    keyed:{
      'session.row':{[A.path]:[{pluginId:'demo',pluginName:'Demo',view:chip('Row chip','row-tap')}]},
      'session.menu':{[A.path]:[{pluginId:'demo',pluginName:'Demo',view:menuList('menu-act','item-1','Menu thing')}],k:[{pluginId:'demo',pluginName:'Demo',view:chip('k','x')}]},
      'transcript.tool':{},'transcript.message':{}}},
  retains:[],releases:[],dispatches:[],keyRetains:[],keyReleases:[]};
// The stub's subscribe is inert; give it real listeners so a host publish can be simulated.
const listeners=new Set();
pluginHost.subscribe=l=>{listeners.add(l);return()=>{listeners.delete(l)}};
const publish=state=>{hooks.state=state;listeners.forEach(l=>l())};
// One timeline across both arrays, to see which came first.
const order=[];
for(const [name,label] of [['keyRetains','retain'],['keyReleases','release']]){
  const list=hooks[name],push=list.push.bind(list);list.push=(...a)=>{order.push(label);return push(...a)};}
const renders={};
const view=(text)=>({pluginId:'demo',pluginName:'Demo',view:chip(text,'x')});
let setProbe;
function CtxProbe(){renders.ctx=(renders.ctx||0)+1;const [v,set]=useState({title:'one',tick:0});setProbe=set;
  const {views}=usePluginKey('session.menu','k',{session:{id:'k',title:v.title,cwd:'',model:'',status:'idle',activeAt:null}});
  return h('span',{'data-testid':'probe-ctx'},String(views.length));}
function IdleProbe(){renders.idle=(renders.idle||0)+1;const {views}=usePluginKey('session.menu',null,null);
  return h('span',{'data-testid':'probe-idle'},String(views.length));}
const opens=[];
let setSession;
function SheetHost(){const [session,set]=useState(null);setSession=set;
  return h(SessionActionsSheet,{session,onOpenChange:v=>{opens.push(v);if(!v)set(null)},onChanged(){},onOpenSession(){}});}
window.fixture={act,
  log:()=>JSON.stringify({
    retains:hooks.retains.map(String),releases:hooks.releases.map(String),
    dispatches:hooks.dispatches.map(a=>a.map(String).join('|')),
    keyRetains:hooks.keyRetains.map(a=>a.slice(0,2).join('|')),
    keyReleases:hooks.keyReleases.map(a=>a.slice(0,2).join('|')),
    opens}),
  mountComposerArea(){const r=createRoot(document.getElementById('root'));
    r.render(h('div',null,
      h(ExtensionFeedback,{feedback:EMPTY_EXTENSION_FEEDBACK,placement:'aboveEditor'}),
      h(ExtensionFeedback,{feedback:EMPTY_EXTENSION_FEEDBACK,placement:'belowEditor'})));return r;},
  mountDrawer(active){const r=createRoot(document.getElementById('root'));
    r.render(h(PluginSlot,{slot:'drawer',active}));return r;},
  mountRows(){const r=createRoot(document.getElementById('root'));
    r.render(h('div',null,
      h(DrawerSessionRow,{session:A,selected:false,pinned:false,ambiguousTitle:false,raised:false,onOpen(){},onActions(){}}),
      h(DrawerSessionRow,{session:B,selected:false,pinned:false,ambiguousTitle:false,raised:false,onOpen(){},onActions(){}})));return r;},
  mountSheet(){const r=createRoot(document.getElementById('root'));r.render(h(SheetHost));return r;},
  openSheet(){setSession(A)},
  closeSheet(){setSession(null)},
  mountComposer(){const r=createRoot(document.getElementById('root'));
    r.render(h(Composer,{sessionPath:'/s/a.jsonl',busy:false,sendAllowed:true,draftActionsRef:{current:null},
      extensionDraft:EMPTY_EXTENSION_FEEDBACK.editorDraft,onConsumeExtensionDraft(){},onSend(){},onStop(){}}));return r;},
  mountProbes(){const r=createRoot(document.getElementById('root'));
    r.render(h('div',null,h(CtxProbe),h(IdleProbe)));return r;},
  setTitle(title){setProbe(v=>({...v,title}))},
  rerenderSame(){setProbe(v=>({...v,tick:v.tick+1}))},
  publishUnrelated(){publish({...hooks.state,views:{...hooks.state.views,'composer.status':[view('Other')]}})},
  publishKeyViews(){publish({...hooks.state,keyed:{...hooks.state.keyed,'session.menu':{...hooks.state.keyed['session.menu'],k:[view('a'),view('b')]}}})},
  timeline:()=>JSON.stringify(order),
  renders:()=>JSON.stringify(renders)};
`, [pluginHostStub, {
  // Same draft-photo storage stand-in the other Composer fixtures use.
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

async function fixture(t, mountName, ...args) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  w.HTMLElement.prototype.scrollIntoView = () => {};
  let mounted;
  const act = callback => f.act(async () => { await callback(); });
  await act(() => { mounted = f[mountName](...args); });
  const unmount = () => act(() => mounted.unmount());
  let unmounted = false;
  t.after(async () => {
    try { if (!unmounted) await unmount(); assert.deepEqual(dom.blocked, []); } finally { dom.close(); }
  });
  const find = selector => w.document.querySelector(selector);
  return { w, f, act, find, log: () => JSON.parse(f.log()), unmount: async () => { unmounted = true; await unmount(); } };
}

test('a composer.status chip is drawn once, above the composer, and tapping it reaches the host', async t => {
  const { w, act, log } = await fixture(t, 'mountComposerArea');
  const views = [...w.document.querySelectorAll("[data-testid='plugin-view'][data-plugin='demo']")];
  assert.equal(views.length, 1);
  assert.ok(views[0].closest("[data-testid='extension-feedback-aboveEditor']"));
  assert.equal(w.document.querySelector("[data-testid='extension-feedback-belowEditor']"), null);

  const chip = w.document.querySelector("[data-testid='plugin-view'] button[data-testid='plugin-chip']");
  assert.ok(chip);
  await act(() => chip.click());
  // A chip has no list item, so the fourth argument is recorded as "undefined".
  assert.deepEqual(log().dispatches, ['demo|composer.status|status-tap|undefined']);
});

test('an inactive slot still shows its views but does not retain the plugins', async t => {
  const { w, log } = await fixture(t, 'mountDrawer', false);
  assert.equal(w.document.querySelectorAll("[data-testid='plugin-slot-drawer'] [data-plugin='demo']").length, 1);
  assert.deepEqual(log().retains, []);
});

test('an active slot retains once and releases when it unmounts', async t => {
  const { w, log, unmount } = await fixture(t, 'mountDrawer', true);
  assert.equal(w.document.querySelectorAll("[data-testid='plugin-slot-drawer'] [data-plugin='demo']").length, 1);
  // retainSlot("drawer", undefined): String() renders the missing plugin id as empty.
  assert.deepEqual(log().retains, ['drawer,']);
  assert.deepEqual(log().releases, []);
  await unmount();
  assert.deepEqual(log().releases, ['drawer,']);
});

test('a session row shows plugin chips for its own conversation only', async t => {
  const { find, log } = await fixture(t, 'mountRows');
  const own = find("[data-testid='plugin-row-badges'][data-session='/s/a.jsonl']");
  assert.ok(own);
  assert.equal(own.textContent, 'Row chip');
  assert.equal(find("[data-testid='plugin-row-badges'][data-session='/s/b.jsonl']"), null);
  assert.equal(own.parentElement?.querySelector("[data-testid='session-row']")?.getAttribute("data-session-path"), '/s/a.jsonl');
  // Both rows asked for their own key; the host decides what each gets.
  assert.deepEqual(log().keyRetains.sort(), ['session.row|/s/a.jsonl', 'session.row|/s/b.jsonl']);
});

test('the actions sheet retains session.menu for its session only while it is open', async t => {
  const { find, act, f, log } = await fixture(t, 'mountSheet');
  assert.deepEqual(log().keyRetains, []);
  assert.equal(find("[data-testid='plugin-menu-item']"), null);
  await act(() => f.openSheet());
  assert.deepEqual(log().keyRetains, ['session.menu|/s/a.jsonl']);
  assert.deepEqual(log().keyReleases, []);
  const item = find("[data-testid='plugin-menu-item'][data-plugin='demo'][data-item='item-1']");
  assert.ok(item);
  assert.match(item.textContent, /Menu thing/);
  // The parent closing the sheet (it passes no session) releases the key.
  await act(() => f.closeSheet());
  assert.deepEqual(log().keyReleases, ['session.menu|/s/a.jsonl']);
});

test('tapping a plugin menu item dispatches the list action with the item and key, then closes the sheet', async t => {
  const { find, act, f, log } = await fixture(t, 'mountSheet');
  await act(() => f.openSheet());
  await act(() => find("[data-testid='plugin-menu-item'][data-item='item-1']").click());
  assert.deepEqual(log().dispatches, ['demo|session.menu|menu-act|item-1|/s/a.jsonl']);
  assert.deepEqual(log().opens, [false]);
});

test('the composer plus sheet lists composer.actions items and a tap dispatches them', async t => {
  const { find, act, log } = await fixture(t, 'mountComposer');
  assert.equal(find("[data-testid='plugin-menu-item']"), null);
  assert.deepEqual(log().retains, []);
  await act(() => find("[data-testid='composer-plus-btn']").click());
  const item = find("[data-testid='composer-plus-sheet'] [data-testid='plugin-menu-item'][data-plugin='demo'][data-item='plus-1']");
  assert.ok(item);
  assert.match(item.textContent, /Plus thing/);
  assert.deepEqual(log().retains, ['composer.actions,']);
  await act(() => item.click());
  assert.deepEqual(log().dispatches, ['demo|composer.actions|plus-act|plus-1']);
});

test('a changed context is retained before the previous handle is released, and an equal one is not retained again', async t => {
  const { act, f, unmount } = await fixture(t, 'mountProbes');
  const timeline = () => JSON.parse(f.timeline());
  assert.deepEqual(timeline(), ['retain']);
  // A release first would drop the key's views in the host and flicker the card.
  await act(() => f.setTitle('two'));
  assert.deepEqual(timeline(), ['retain', 'retain', 'release']);
  await act(() => f.rerenderSame());
  assert.deepEqual(timeline(), ['retain', 'retain', 'release']);
  await unmount();
  assert.deepEqual(timeline(), ['retain', 'retain', 'release', 'release']);
});

test('a surface subscribes to its own key only: a null key never re-renders, a keyed one follows its views', async t => {
  const { act, find, f } = await fixture(t, 'mountProbes');
  const renders = () => JSON.parse(f.renders());
  const before = renders();
  assert.equal(find("[data-testid='probe-ctx']").textContent, '1');
  await act(() => f.publishUnrelated());
  assert.deepEqual(renders(), before);
  await act(() => f.publishKeyViews());
  assert.equal(find("[data-testid='probe-ctx']").textContent, '2');
  assert.equal(renders().idle, before.idle);
});
