import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {DiffPart} from ${JSON.stringify(resolve(root,'web/src/app/parts/DiffPart.tsx'))};
 import {ChangesTab} from ${JSON.stringify(resolve(root,'web/src/app/tools/ChangesTab.tsx'))};
 // A string is a bare diff; an object passes DiffPart props (path, exact counts, note).
 window.fixture={act,mount:(items,changes)=>{const r=createRoot(document.getElementById('root'));r.render(changes?h(ChangesTab,{sessionPath:'/synthetic/session.jsonl',active:true}):h('div',{},...items.map((item,i)=>h(DiffPart,{...(typeof item==='string'?{text:item}:item),key:i}))));return r}};
`,[{name:'toast-sink',resolveId:(id,importer)=>importer?.endsWith('/CopyButton.tsx')&&id==='../Notices'?'\0notices':null,load:id=>id==='\0notices'?'export const showToast=()=>{};':null}]);
// What a sighted reader sees: sr-only prefixes ("Added: ") and counts are spoken, not shown.
const visible=el=>{const c=el.cloneNode(true);for(const s of c.querySelectorAll('.sr-only'))s.remove();return c.textContent};
async function fixture(t,items,changes=null){
 const dom=createDomFixture(code),w=dom.window,{act}=w.fixture,copied=[];
 // JSDOM has no Web Animations API; match the suite's ScrollArea adapter.
 w.Element.prototype.getAnimations=()=>[];
 Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>copied.push(text)},configurable:true});
 if(changes)w.fetch=async url=>{assert.ok(String(url).startsWith('/api/changes?'));return{ok:true,status:200,json:async()=>({ok:true,branch:'main',notRepo:false,truncated:false,files:changes})}};
 let mounted;await act(async()=>{mounted=w.fixture.mount(items,changes)});
 t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const all=sel=>Array.from(w.document.querySelectorAll(sel));
 return {w,act,copied,all,wraps:()=>all('button[aria-label="Wrap lines"]'),
  contents:()=>all('[data-testid="diff-line-content"]').map(visible),
  kinds:()=>all('[data-testid="diff-line"]').map(x=>x.dataset.kind),
  button:text=>all('button').find(b=>b.textContent===text)};
}
const raw='@@ -1,2 +1,2 @@\n-old\n+new\n context\n\\ No newline at end of file\n';
test('unwrapped remains the default and viewport is keyboard-focusable',async t=>{
 const f=await fixture(t,[raw]);assert.equal(f.wraps().length,1);assert.equal(f.wraps()[0].getAttribute('aria-pressed'),'false');
 assert.ok(f.w.document.querySelector('[data-testid="diff-lines"]').classList.contains('min-w-max'));
 const region=f.w.document.querySelector('[role="region"]');assert.equal(region.getAttribute('aria-label'),'Code diff');assert.equal(region.tabIndex,0);
});
test('wrap toggles width and whitespace without changing logical content',async t=>{
 const f=await fixture(t,[raw]);const before=f.contents();await f.act(async()=>f.wraps()[0].click());
 assert.equal(f.wraps()[0].getAttribute('aria-pressed'),'true');assert.deepEqual(f.contents(),before);
 assert.ok(f.w.document.querySelector('[data-testid="diff-line"]').classList.contains('whitespace-pre-wrap'));
 assert.ok(f.w.document.querySelector('[data-testid="diff-line-content"]').classList.contains('[overflow-wrap:anywhere]'));
 await f.act(async()=>f.wraps()[0].click());assert.equal(f.wraps()[0].getAttribute('aria-pressed'),'false');assert.deepEqual(f.contents(),before);
});
test('no-final-newline marker and unprefixed text retain their first character',async t=>{
 const f=await fixture(t,[raw+'unprefixed']);assert.ok(f.contents().includes('\\ No newline at end of file'));assert.ok(f.contents().includes('unprefixed'));
});
test('git preamble is hidden, hunk headers stay, and sign prefixes become gutters',async t=>{
 const f=await fixture(t,['diff --git a/x b/x\nindex 1234567..89abcde 100644\n--- a/x\n+++ b/x\n'+raw]);
 assert.deepEqual(f.contents(),['@@ -1,2 +1,2 @@','old','new','context','\\ No newline at end of file']);
 assert.deepEqual(f.kinds(),['hunk','del','add','context','context']);
 const lines=f.all('[data-testid="diff-line"]');
 // The sign is decoration; screen readers hear the sr-only word instead.
 assert.equal(lines[1].querySelector('[aria-hidden]').textContent,'−');assert.equal(lines[2].querySelector('[aria-hidden]').textContent,'+');
 assert.equal(lines[1].querySelector('[data-testid="diff-line-content"] .sr-only').textContent,'Removed: ');
 assert.equal(lines[2].querySelector('[data-testid="diff-line-content"] .sr-only').textContent,'Added: ');
 assert.equal(lines[3].querySelector('.sr-only'),null);
});
test('header shows one path with counts, preferring exact caller counts over a capped diff',async t=>{
 const f=await fixture(t,[raw,{text:raw,path:'src/x.ts',added:40,removed:7,note:'Diff shortened; the counts cover the whole change.'}]);
 const parts=f.all('[data-testid="diff-part"]');assert.equal(parts.length,2);
 assert.match(visible(parts[0]),/^Changes\+1 −1/);
 assert.match(visible(parts[1]),/^src\/x\.ts\+40 −7/);assert.match(parts[1].textContent,/40 added, 7 removed/);
 assert.match(parts[1].textContent,/Diff shortened; the counts cover the whole change\./);assert.doesNotMatch(parts[0].textContent,/Diff shortened/);
});
test('copy receives exact original bytes including prefixes and final newline in both modes',async t=>{
 const f=await fixture(t,[raw]);const copy=f.w.document.querySelector('button[aria-label="Copy diff"]');await f.act(async()=>copy.click());
 await f.act(async()=>f.wraps()[0].click());await f.act(async()=>copy.click());assert.deepEqual(f.copied,[raw,raw]);
});
test('200-line collapse expands independently from wrapping',async t=>{
 const text=Array.from({length:230},(_,i)=>`+line ${i}`).join('\n')+'\n';const f=await fixture(t,[text]);assert.equal(f.contents().length,200);
 // The header counts cover every line, not only the mounted ones.
 assert.match(visible(f.w.document.querySelector('[data-testid="diff-part"]')),/\+230 −0/);
 await f.act(async()=>f.wraps()[0].click());await f.act(async()=>f.button('Show all (30 more lines)').click());assert.equal(f.contents().length,230);
 assert.equal(f.contents()[229],'line 229');assert.equal(f.wraps()[0].getAttribute('aria-pressed'),'true');
 assert.equal(f.button('Show all (30 more lines)'),undefined);
});
test('separate diffs keep independent wrap settings',async t=>{
 const f=await fixture(t,[raw,raw]);await f.act(async()=>f.wraps()[0].click());assert.equal(f.wraps()[0].getAttribute('aria-pressed'),'true');assert.equal(f.wraps()[1].getAttribute('aria-pressed'),'false');
});
test('long unbroken lines stay complete and wrap is a real icon button with a touch target',async t=>{
 const long='x'.repeat(4000);const f=await fixture(t,['+'+long]);await f.act(async()=>f.wraps()[0].click());assert.equal(f.contents()[0],long);
 // Both icon tiers keep a 44px hit area (icon-sm extends it with an ::after inset).
 assert.ok(['icon-sm','icon'].includes(f.wraps()[0].getAttribute('data-size')),'icon size tier');assert.equal(f.wraps()[0].type,'button');
 assert.equal(visible(f.wraps()[0]),'');
});

test('Changes uses the chat wrap convention for every expanded file without changing long lines',async t=>{
 const long='x'.repeat(4000),patch='@@ -1 +1 @@\n-old\n+'+long+'\n';
 const files=['a.txt','b.txt'].map(path=>({path,status:'modified',additions:1,deletions:1,patch,binary:false,patchTruncated:false}));
 const f=await fixture(t,[],files);
 assert.equal(f.wraps().length,1);assert.equal(f.wraps()[0].getAttribute('aria-pressed'),'false');
 const expand=path=>f.act(async()=>f.w.document.querySelector(`button[aria-label^="Modified ${path},"]`).click());
 await expand('a.txt');
 const before=f.contents();assert.ok(before.includes(long));
 assert.ok(f.all('[role="region"][aria-label="Code diff"]')[0].classList.contains('overflow-x-auto'));
 await f.act(async()=>f.wraps()[0].click());
 assert.equal(f.wraps()[0].getAttribute('aria-pressed'),'true');assert.deepEqual(f.contents(),before);
 await expand('b.txt');
 for(const line of f.all('[data-testid="diff-line"]'))assert.ok(line.classList.contains('whitespace-pre-wrap'));
 for(const content of f.all('[data-testid="diff-line-content"]'))assert.ok(content.classList.contains('[overflow-wrap:anywhere]'));
 for(const region of f.all('[role="region"][aria-label="Code diff"]')){assert.equal(region.tabIndex,0);assert.equal(region.classList.contains('overflow-x-auto'),false)}
 assert.equal(f.contents().filter(content=>content===long).length,2);
 await f.act(async()=>f.wraps()[0].click());
 assert.equal(f.wraps()[0].getAttribute('aria-pressed'),'false');
 for(const line of f.all('[data-testid="diff-line"]'))assert.ok(line.classList.contains('whitespace-pre'));
});

test('Changes distinguishes every Git unmerged index state from normal edits',async t=>{
 const labels={DD:'Both deleted',AU:'Added by us',UD:'Deleted by them',UA:'Added by them',DU:'Deleted by us',AA:'Both added',UU:'Both modified'};
 const files=Object.keys(labels).map(unmerged=>({path:`${unmerged}.txt`,status:'conflicted',unmerged,additions:0,deletions:0,patch:'',binary:false,patchTruncated:false}));
 files.push({path:'ordinary.txt',status:'modified',additions:1,deletions:1,patch:raw,binary:false,patchTruncated:false});
 const f=await fixture(t,[],files),rows=f.all('[data-testid="changes-file"]');
 assert.equal(rows.length,8);
 for(const [code,label] of Object.entries(labels)){
  const row=rows.find(row=>row.querySelector(`[title="${code}.txt"]`));
  assert.equal(row.dataset.status,'conflicted');
  assert.ok(row.textContent.includes(`Unresolved conflict · ${label}`));
  const button=row.querySelector('button');
  assert.ok(button.getAttribute('aria-label').includes(`Unresolved conflict · ${label}`));
  await f.act(async()=>button.click());
  assert.equal(button.getAttribute('aria-expanded'),'true');
  assert.equal(row.querySelectorAll('[data-testid="diff-line"]').length,0);
 }
 const ordinary=rows.find(row=>row.dataset.status==='modified');
 assert.equal(ordinary.textContent.includes('Unresolved conflict'),false);
});
