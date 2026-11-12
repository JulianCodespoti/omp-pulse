import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
// Hold only BottomSheet's animation completion. Reference rows, visit state,
// focus/navigation listeners, controls and React event handling remain real.
const code = await bundleDomFixture(`
import {createElement as h,act,useState} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {AgentReferenceRows} from ${JSON.stringify(resolve(root, 'web/src/app/composer/AgentReferenceRows.tsx'))};
import {agentDiscussionReference} from ${JSON.stringify(resolve(root, 'web/src/domain/agent-discussion.ts'))};
const references=['a','b'].map(id=>agentDiscussionReference({id,name:'Agent '+id,source:'rpc'}));
window.exits=[];window.editorAllowed=true;
function App(){const [refs,setRefs]=useState(references);window.readd=()=>setRefs(current=>[...current,references[0]]);return h('main',{},
 h('textarea',{'data-testid':'editor',defaultValue:'Original prose'}),h('button',{type:'button','data-testid':'successor'},'Successor'),
 h(AgentReferenceRows,{references:refs,onRemove:id=>setRefs(current=>current.filter(ref=>ref.identity!==id)),onEditFullDraft:()=>setRefs([]),getEditor:()=>window.editorAllowed?document.querySelector('[data-testid="editor"]'):null}))}
window.fixture={act,mount(){const r=createRoot(document.getElementById('root'));r.render(h(App));return r},finishExit(index){
 const exit=window.exits[index],target=exit.returnFocus();
 // The actual shared BottomSheet only checks the current active owner; this
 // intentionally does not remember a successor that has already blurred.
 const active=document.activeElement;
 const allowed=!!target&&!(active&&active!==document.body&&active!==target&&!exit.panel?.contains(active));
 if(allowed)target.focus();return{target,allowed};
}};
`, [{
  name: 'hold-reference-sheet-exit',
  resolveId(id, importer) { return importer?.endsWith('/AgentReferenceRows.tsx') && id === '../ui/Sheet' ? '\0held-sheet' : null; },
  load(id) {
    if (id !== '\0held-sheet') return null;
    return `import {createElement as h,useLayoutEffect,useRef} from ${JSON.stringify(require.resolve('react'))};
export function BottomSheet({open,onOpenChange,returnFocus,children,footer,testId,title}){
 const panel=useRef(null),previous=useRef({open:false,returnFocus:null});
 useLayoutEffect(()=>{
   if(previous.current.open&&!open)window.exits.push({returnFocus:previous.current.returnFocus,panel:panel.current});
   if(open&&!previous.current.open)panel.current?.querySelector('button')?.focus();
   previous.current={open,returnFocus};
 });
 return h('section',{'data-testid':testId,'data-sheet-panel':'',role:'dialog','aria-label':title,ref:panel,'data-open':open?'true':'false'},
 h('button',{type:'button','data-testid':'sheet-close',onClick:()=>onOpenChange(false)},'Close'),children,footer);
}`;
  },
}]);

async function fixture(t) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  let mounted;
  const act = async fn => f.act(async () => { await fn?.(); });
  await act(() => { mounted = f.mount(); });
  t.after(async () => {
    try { await act(() => mounted.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  const get = selector => w.document.querySelector(selector);
  const all = selector => [...w.document.querySelectorAll(selector)];
  const click = async selector => {
    const node = typeof selector === 'string' ? get(selector) : selector;
    assert.ok(node); await act(() => node.click());
  };
  const open = async (index = 0) => {
    const opener = all('[data-testid="compact-reference-details"]')[index];
    await act(() => opener.focus()); await click(opener);
    assert.equal(get('[data-testid="compact-reference-sheet"]').getAttribute('data-open'), 'true');
    return opener;
  };
  const close = async () => {
    await click('[data-testid="sheet-close"]');
    assert.equal(get('[data-testid="compact-reference-sheet"]').getAttribute('data-open'), 'false');
    assert.ok(w.exits.length);
  };
  const focusThenBlurSuccessor = () => act(() => { const successor = get('[data-testid="successor"]'); successor.focus(); successor.blur(); });
  const finish = async (index = w.exits.length - 1) => { let result; await act(() => { result = f.finishExit(index); }); return result; };
  return { w, f, act, get, all, click, open, close, focusThenBlurSuccessor, finish };
}

test('normal held Details close retains its own connected opener focus', async t => {
  const f = await fixture(t); const opener = await f.open(); await f.close();
  const result = await f.finish(); assert.equal(result.target, opener); assert.equal(result.allowed, true);
  assert.equal(f.w.document.activeElement === opener, true);
});

test('successor focus then blur permanently relinquishes a closing reference visit', async t => {
  const f = await fixture(t); await f.open(); await f.close();
  await f.focusThenBlurSuccessor(); assert.equal(f.w.document.activeElement === f.w.document.body, true);
  const result = await f.finish(); assert.equal(result.target === false, true, 'old visit permanently relinquishes focus');
  assert.equal(f.w.document.activeElement === f.w.document.body, true);
});

for (const event of ['popstate', 'hashchange']) {
  test(`${event} during held reference exit permanently relinquishes focus ownership`, async t => {
    const f = await fixture(t); await f.open(); await f.close();
    await f.act(() => f.w.dispatchEvent(new f.w.Event(event)));
    await f.act(() => f.w.document.activeElement.blur());
    const result = await f.finish(); assert.equal(result.target === false, true, 'old visit permanently relinquishes focus');
    assert.equal(f.w.document.activeElement === f.w.document.body, true);
  });
}

test('reopening references obsoletes an earlier held exit and the new visit can still restore its own opener', async t => {
  const f = await fixture(t); await f.open(); await f.close();
  const newer = await f.open(1);
  await f.act(() => f.w.document.activeElement.blur());
  const stale = await f.finish(0); assert.equal(stale.target === false, true, 'earlier visit cannot restore after reopening');
  await f.close(); const current = await f.finish(1);
  assert.equal(current.target, newer); assert.equal(f.w.document.activeElement === newer, true);
});

test('normal full-draft expansion restores the surviving editor instead of a detached row', async t => {
  const f = await fixture(t); const opener = await f.open();
  await f.click('[data-testid="compact-reference-edit-full-draft"]');
  assert.equal(opener.isConnected, false);
  const result = await f.finish(); assert.equal(result.target, f.get('[data-testid="editor"]'));
  assert.equal(f.w.document.activeElement === f.get('[data-testid="editor"]'), true);
});

test('expansion cannot refocus the editor after a successor took focus and blurred during exit', async t => {
  const f = await fixture(t); await f.open(); await f.click('[data-testid="compact-reference-edit-full-draft"]');
  await f.focusThenBlurSuccessor();
  const result = await f.finish(); assert.equal(result.target === false, true, 'old visit permanently relinquishes focus');
  assert.equal(f.w.document.activeElement === f.w.document.body, true);
});

test('changed composer scope cannot restore any old reference target', async t => {
  const f = await fixture(t); await f.open(); await f.close(); f.w.editorAllowed = false;
  const result = await f.finish(); assert.equal(result.target === false, true, 'old visit permanently relinquishes focus');
});


for (const action of ['sheet-close', 'compact-reference-edit-full-draft']) {
  test(`${action} relinquishes synchronously when successor focus and blur precede the React commit`, async t => {
    const f = await fixture(t); await f.open();
    await f.act(() => {
      f.get(`[data-testid="${action}"]`).click();
      const successor = f.get('[data-testid="successor"]');
      successor.focus(); successor.blur();
    });
    assert.equal(f.get('[data-testid="compact-reference-sheet"]').getAttribute('data-open'), 'false');
    const result = await f.finish();
    assert.equal(result.target === false, true, 'same-event successor permanently owns focus');
    assert.equal(f.w.document.activeElement === f.w.document.body, true);
  });
}

test('same-act inspected-reference Remove and readd of its identity leaves Details closed', async t => {
  const f = await fixture(t); await f.open();
  await f.act(() => {
    f.all('[data-testid="compact-reference-remove"]')[0].click();
    f.w.readd();
  });
  assert.equal(f.all('[data-testid="compact-reference-row"]').length, 2);
  assert.equal(f.get('[data-testid="compact-reference-sheet"]').getAttribute('data-open'), 'false');
  assert.equal(f.w.exits.length, 1);
});
