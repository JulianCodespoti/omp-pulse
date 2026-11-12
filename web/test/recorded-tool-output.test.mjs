import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
// Synthetic payload matches tagged OMP 18.10.4 edit/index.ts aggregateDetails
// and toPerFileResult. Snapshots deliberately disagree with recorded patches.
const multi = JSON.parse(readFileSync(new URL('./fixtures/multi-file-edit.json', import.meta.url), 'utf8'));
const code = await bundleDomFixture(`
  import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
  import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
  import { entriesToUiMessages, parseToolEdits } from ${JSON.stringify(resolve(root, 'web/src/domain/messages.ts'))};
  import { FileTool } from ${JSON.stringify(resolve(root, 'web/src/app/parts/tools/FileTool.tsx'))};
  import { ToolPart } from ${JSON.stringify(resolve(root, 'web/src/app/parts/ToolPart.tsx'))};
  import { EditSummary } from ${JSON.stringify(resolve(root, 'web/src/app/parts/EditSummary.tsx'))};
  window.fixture = { act, parseToolEdits, mount(name, args, output, details, mode, isError) {
    const messages = entriesToUiMessages([
      {type:'message',id:'call',message:{role:'assistant',content:[{type:'toolCall',id:'edit-call',name,arguments:args}]}},
      {type:'message',id:'result',message:{role:'toolResult',toolCallId:'edit-call',toolName:name,content:[{type:'text',text:output}],details,isError}},
    ]);
    const part = messages[0].parts.find(part => part.kind === 'tool');
    const r = createRoot(document.getElementById('root'));
    r.render(mode === 'summary' ? h(EditSummary,{messages}) : mode === 'row' ? h(ToolPart,{part,live:false}) : h(FileTool,{part}));
    return r;
  }};
`, [{ name:'notice-sink', resolveId:id => id === '@/app/Notices' || id === '../Notices' ? '\0notices' : null,
  load:id => id === '\0notices' ? 'export const showToast=()=>{};' : null }]);

async function fixture(t, {name='edit',args={},output='Edited files.',details=multi,mode='detail',isError=false}={}) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture, copies=[];
  w.Element.prototype.getAnimations = () => [];
  Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>copies.push(text)}});
  let mounted;
  await act(async()=>{mounted=w.fixture.mount(name,args,output,details,mode,isError)});
  t.after(async()=>{try {await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])} finally {dom.close()}});
  const all = selector => [...w.document.querySelectorAll(selector)];
  const click = async label => act(async()=>{
    const button=all('button').find(button=>button.getAttribute('aria-label')===label || button.textContent===label);
    assert.ok(button,label);button.click();await Promise.resolve();
  });
  return {w,act,copies,all,click};
}

for (const name of ['read','functions.read','mcp/read']) {
  for (const [path,text] of [
    ['notes.txt:raw','+ordinary plus\n-ordinary minus\n'],
    ['data.json?q=.text&raw=true','--- literal header\n+++ literal header\nindex literal\n'],
    ['patch.txt:raw','diff --git a/demo b/demo\nindex 123..456 100644\n--- a/demo\n+++ b/demo\n@@ -1 +1 @@\n-old\n+new\n'],
    ['notes.txt:raw:2-4','@@ not a change\n+still content\n-still content\n\n'],
  ]) {
    test(`${name} ${path} preserves literal returned text without edit semantics`,async t=>{
      const f=await fixture(t,{name,args:{path},output:text,details:{path,diff:text}});
      assert.equal(f.all('[data-testid="diff-part"]').length,0);
      assert.equal(f.all('[data-testid="diff-line"]').length,0);
      assert.equal(f.all('[data-bash-output]').map(pre=>pre.textContent).join(''),text);
      assert.equal(f.w.document.body.textContent.includes(' added, '),false);
      await f.click('Wrap lines');
      assert.equal(f.all('[data-bash-output]').map(pre=>pre.textContent).join(''),text);
      await f.click('Copy output');assert.deepEqual(f.copies,[text]);
    });
  }
}

test('multi-file edit details render every exact per-file recorded patch and missing-diff identity',async t=>{
  const f=await fixture(t);
  const cards=f.all('[data-testid="diff-part"]');
  assert.deepEqual(cards.map(card=>card.firstElementChild.firstElementChild.textContent),multi.perFileResults.slice(0,3).map(file=>file.path));
  for (const file of multi.perFileResults) assert.ok(f.w.document.querySelector(`section[aria-label="${file.path}"]`));
  assert.match(f.w.document.body.textContent,/Moved from src\/original\.ts/);
  assert.match(f.w.document.body.textContent,/No diff was recorded/);
  assert.doesNotMatch(f.w.document.body.textContent,/AGGREGATE|SNAPSHOT|CURRENT CONTENT/);
  const expected=[['Removed: export const one = 1;','Added: export const one = 2;'],["Added: export const two = 2;","Added: export const label = 'two';"],['Removed: export const obsolete = true;']];
  for (let i=0;i<cards.length;i++) {
    assert.deepEqual([...cards[i].querySelectorAll('[data-testid="diff-line-content"]')].slice(1).map(line=>line.textContent),expected[i]);
    await f.act(async()=>cards[i].querySelector('button[aria-label="Copy diff"]').click());
  }
  assert.deepEqual(f.copies,multi.perFileResults.slice(0,3).map(file=>file.diff));
});

test('multi-file call row names the whole batch rather than its first hashline section',async t=>{
  const f=await fixture(t,{mode:'row',args:{input:'*** Begin Patch\n[src/one.ts#1234]\nPUT 1.=1:\n+x\n[src/two.ts#1234]\nPUT 1.=1:\n+y\n*** End Patch'}});
  const row=f.w.document.querySelector('[data-testid="tool-row"]');
  assert.equal(row.textContent,'Edited 4 files');
  await f.act(async()=>row.click());
  assert.equal(f.all('[data-testid="diff-part"]').length,3);
  assert.ok(f.w.document.body.textContent.includes('src/moved.ts'));
});

test('summary counts and copies all per-file edits from one call',async t=>{
  const f=await fixture(t,{mode:'summary'});
  const toggle=f.w.document.querySelector('[data-testid="edit-summary-toggle"]');
  assert.match(toggle.getAttribute('aria-label'),/4 files, 3 added, 2 removed/);
  await f.act(async()=>toggle.click());
  assert.deepEqual(f.all('[data-testid="edited-file"]').map(file=>file.getAttribute('aria-label')),multi.perFileResults.map(file=>file.path));
  await f.click('Copy all diffs');
  assert.deepEqual(f.copies,[multi.perFileResults.map(file=>file.diff).filter(Boolean).join('\n')]);
});

test('single-file upstream result remains a recorded edit without snapshot synthesis',async t=>{
  const details=multi.perFileResults[0],f=await fixture(t,{details});
  assert.equal(f.all('[data-testid="diff-part"]').length,1);
  await f.click('Copy diff');assert.deepEqual(f.copies,[details.diff]);
});

test('per-file caps count complete changes independently and keep later files',async t=>{
  const f=await fixture(t);
  const diff='@@ -0,0 +1,2000 @@\n'+Array.from({length:2000},(_,i)=>`+recorded line ${i}`).join('\n');
  const edits=f.w.fixture.parseToolEdits('edit',{perFileResults:[{path:'large',diff},multi.perFileResults[1]]});
  assert.equal(edits.length,2);assert.equal(edits[0].added,2000);assert.equal(edits[0].truncated,true);
  assert.ok(edits[0].diff.length<=20000);assert.equal(edits[1].diff,multi.perFileResults[1].diff);
  assert.equal(edits[1].added,2);assert.equal(edits[1].truncated,false);
});

test('failed edit batches keep literal errors rather than claiming recorded success',async t=>{
  const output='Edit failed\n+not a change\n-not a change',f=await fixture(t,{isError:true,output});
  assert.equal(f.all('[data-testid="diff-part"]').length,0);
  assert.equal(f.all('[data-bash-output]').map(pre=>pre.textContent).join(''),output);
});

test('write output still uses a diff view when it actually reports a patch',async t=>{
  const output='diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n-before\n+after\n';
  const f=await fixture(t,{name:'write',args:{path:'file'},details:null,output});
  assert.equal(f.all('[data-testid="diff-part"]').length,1);
  await f.click('Copy diff');assert.deepEqual(f.copies,[output]);
});

test('recorded hunk contents resembling file headers count as changes',async t=>{
  const f=await fixture(t,{details:{path:'headers.txt',diff:'--- a/headers.txt\n+++ b/headers.txt\n@@ -1 +1 @@\n--- literal text\n+++ literal text\n'}});
  const card=f.all('[data-testid="diff-part"]')[0];
  assert.match(card.firstElementChild.textContent,/1 added, 1 removed/);
  assert.deepEqual(f.all('[data-testid="diff-line-content"]').slice(1).map(line=>line.textContent),['Removed: -- literal text','Added: ++ literal text']);
});

test('a batch without recorded details still names every input file without fabricating patches',async t=>{
  const paths=['src/one.ts','src/two.ts'];
  const input='*** Begin Patch\n'+paths.map(path=>`[${path}#1234]\nPUT 1.=1:\n+replacement\n`).join('')+'*** End Patch';
  const f=await fixture(t,{mode:'row',args:{input},details:null,output:'Edited two files.'});
  const row=f.w.document.querySelector('[data-testid="tool-row"]');
  assert.equal(row.textContent,'Edited 2 files');
  await f.act(async()=>row.click());
  assert.deepEqual(f.all('[data-testid="tool-path"]').map(path=>path.textContent),paths);
  assert.equal(f.all('[data-testid="diff-part"]').length,0);
});
