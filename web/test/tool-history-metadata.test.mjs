import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
  import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
  import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
  import { entriesToTranscript, applyToolResults, toolResultFromEntry, mergeToolParts, parseTodoPhases } from ${JSON.stringify(resolve(root, 'web/src/domain/messages.ts'))};
  import { ToolPart } from ${JSON.stringify(resolve(root, 'web/src/app/parts/ToolPart.tsx'))};
  import { ToolDetail } from ${JSON.stringify(resolve(root, 'web/src/app/parts/ToolSheet.tsx'))};
  import { TodoBoard } from ${JSON.stringify(resolve(root, 'web/src/app/parts/tools/TodoTool.tsx'))};
  import { summarizeEdits } from ${JSON.stringify(resolve(root, 'web/src/app/parts/run-summary.ts'))};
  window.fixture = { act, entriesToTranscript, applyToolResults, toolResultFromEntry, mergeToolParts, parseTodoPhases, summarizeEdits,
    mount(part, mode='row') { const r=createRoot(document.getElementById('root')); r.render(mode==='todo' ? h(TodoBoard,{phases:part}) : h(mode==='reader'?ToolDetail:ToolPart,{part,live:false})); return r; }
  };
`);
const plain = value => JSON.parse(JSON.stringify(value));
const call = name => ({type:'message',id:'assistant',message:{role:'assistant',content:[{type:'toolCall',id:'call',name,arguments:{}}]}});
const result = (name, details, text='Result', extra={}) => ({type:'message',id:'result',message:{role:'toolResult',toolCallId:'call',toolName:name,content:[{type:'text',text}],details,...extra}});
async function fixture(t) {
  const dom=createDomFixture(code), w=dom.window, f=w.fixture, mounted=[];
  w.Element.prototype.getAnimations=()=>[];
  const copies=[];
  Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>copies.push(text)}});
  t.after(async()=>{try { await f.act(async()=>mounted.forEach(r=>r.unmount())); assert.deepEqual(dom.blocked,[]); } finally { dom.close(); }});
  return {w,f,copies,mount:async(part,mode)=>f.act(async()=>mounted.push(f.mount(part,mode))),click:async label=>f.act(async()=>{const b=[...w.document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent===label); assert.ok(b,label); b.click();})};
}

for (const ingestion of ['saved','live']) test(`multi-file recorded edits survive ${ingestion} normalization, including partial failures`,async t=>{
  const {w,f,mount}=await fixture(t);
  const details={perFileResults:[{path:'a.ts',diff:'-old\n+new',op:'update'},{path:'b.ts',sourcePath:'old.ts',diff:'+created',op:'create'},{path:'c.ts',diff:'',isError:true,errorText:'Permission denied'}]};
  const entry=result('edit',details,'Partial edit',{isError:true});
  const messages=ingestion==='saved'?f.entriesToTranscript([call('edit'),entry]).messages:f.applyToolResults(f.entriesToTranscript([call('edit')]).messages,[f.toolResultFromEntry(entry.message,123)]).messages;
  const part=messages[0].parts[0];
  assert.deepEqual(plain(part.edits.map(edit=>edit.path)),['a.ts','b.ts','c.ts']);
  assert.deepEqual(plain(f.summarizeEdits(messages).map(file=>file.path)),['a.ts','b.ts']);
  await mount(part,'reader');
  assert.equal(w.document.querySelectorAll('section[aria-label]').length,3);
  assert.equal(w.document.querySelectorAll('[data-testid="diff-part"]').length,2);
  assert.match(w.document.body.textContent,/Moved from old\.ts/);
  assert.match(w.document.body.textContent,/Permission denied/);
});

for (const mode of ['row','reader']) test(`generated images render every result and missing slot in ${mode}`,async t=>{
  const {w,f,mount}=await fixture(t);
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jV7kAAAAASUVORK5CYII=';
  const details={imageCount:3,imagePaths:['one.png','two.png','missing.png'],images:[{data:png,mimeType:'image/png'},{data:'YQ==',mimeType:'image/png'},{}]};
  const part=f.entriesToTranscript([call('generate_image'),result('generate_image',details)]).messages[0].parts[0];
  assert.equal(part.images.length,3);
  await mount(part,mode);
  assert.equal(w.document.querySelectorAll('button[aria-label="Open image"]').length,2);
  assert.match(w.document.body.textContent,/Image not on this device/);
  await f.act(async()=>w.document.querySelectorAll('img')[1].dispatchEvent(new w.Event('error')));
  assert.match(w.document.body.textContent,/Couldn't load image/);
  await f.act(async()=>w.document.querySelector('button[aria-label="Open image"]').click());
  assert.equal(w.document.querySelector('[role="dialog"]')!==null,true);
});

test('large generated data and blob references are retained, never replaced by paths',async t=>{
  const {f}=await fixture(t);
  const message=result('generate_image',{images:[{data:'YQ=='.repeat(60000),mimeType:'image/png'},{data:'blob:sha256:abcdef0123456789',mimeType:'image/webp'}],imageCount:2,imagePaths:['one','two']}).message;
  const images=f.toolResultFromEntry(message).images;
  assert.equal(images[0].src.length>200000,true);
  assert.equal(images[1].src,'blob:sha256:abcdef0123456789');
});

test('blocked tasks retain reason and notes in saved snapshots and plan reader',async t=>{
  const {w,f,mount}=await fixture(t);
  const phases=[{name:'Ship',tasks:[{content:'Release',status:'blocked',blocker:'Waiting for credentials',notes:['Owner notified','Do not retry']},{content:'Review',status:'pending'}]}];
  const part=f.entriesToTranscript([call('todo'),result('todo',{phases})]).messages[0].parts[0];
  assert.equal(part.todo[0].tasks[0].blocker,'Waiting for credentials');
  await mount(part.todo,'todo');
  assert.match(w.document.body.textContent,/Blocked: Waiting for credentials/);
  assert.match(w.document.body.textContent,/Owner notified\nDo not retry/);
  assert.equal(w.document.querySelector('[data-status="blocked"]')!==null,true);
});

test('web search outcome and grep coverage survive reopening and live merge',async t=>{
  const {f}=await fixture(t);
  const grep=result('grep',{matchCount:1,truncated:true,perFileLimitReached:20,linesTruncated:true},'a.ts:1 no matches found');
  const saved=f.entriesToTranscript([call('grep'),grep]).messages[0];
  assert.equal(saved.parts[0].search.truncated,true);
  const merged=f.mergeToolParts(f.entriesToTranscript([call('grep')]).messages[0],saved);
  assert.deepEqual(plain(merged.parts[0].search),plain(saved.parts[0].search));
  const failed=f.entriesToTranscript([call('web_search'),result('web_search',{error:'All providers failed',response:{provider:'none',sources:[]}},'All providers failed')]).messages[0].parts[0];
  assert.equal(failed.state,'error');
  assert.equal(failed.search.error,'All providers failed');
});

for (const [details,expected] of [[{exitCode:42},{kind:'exit',code:42}],[{timedOut:true},{kind:'timeout'}],[{async:{state:'cancelled'}},{kind:'cancelled'}],[{},{kind:'unknown'}]]) test(`shell metadata is authoritative: ${JSON.stringify(details)}`,async t=>{
  const {f}=await fixture(t);
  const entry=result('bash',details,'{"output":"ok","exitCode":99,"items":[1,2]}',{isError:true});
  const live=f.toolResultFromEntry(entry.message);
  const saved=f.entriesToTranscript([call('bash'),entry]).messages[0].parts[0];
  assert.deepEqual(plain(live.shell),expected);
  assert.deepEqual(plain(saved.shell),expected);
  assert.equal(saved.output,entry.message.content[0].text);
});

test('mentioned-file outcomes and deliberately excluded executions survive saved history',async t=>{
  const {f}=await fixture(t);
  const entries=[{type:'message',id:'mention',message:{role:'fileMention',files:[{path:'large.txt',skippedReason:'tooLarge',byteSize:6000000},{path:'binary.dat',skippedReason:'binary',byteSize:20},{path:'read.txt',lineCount:4},{path:'photo.png',image:true}]}},{type:'message',id:'excluded',message:{role:'bashExecution',command:'echo secret',output:'secret',exitCode:0,excludeFromContext:true}},{type:'message',id:'ordinary',message:{role:'bashExecution',command:'echo hello',output:'hello',exitCode:0}}];
  const messages=f.entriesToTranscript(entries).messages;
  assert.equal(messages.length,3);
  assert.match(messages[0].text,/Skipped "large.txt": file too large \(6,000,000 bytes\)/);
  assert.match(messages[0].text,/binary file/);
  assert.match(messages[0].text,/Read "read.txt" \(4 lines\)/);
  assert.match(messages[0].text,/Contents were not automatically included/);
  assert.match(messages[1].text,/deliberately excluded from model context/);
  assert.doesNotMatch(messages[2].text,/included|context/);
});

test('a failed single edit records no diff, and a generated image kept only by path keeps its slot',async t=>{
  const {f}=await fixture(t);
  const failed=f.toolResultFromEntry(result('edit',{path:'a.ts',diff:'+x'},'boom',{isError:true}).message);
  assert.equal(failed.edits,undefined);
  const slots=f.toolResultFromEntry(result('generate_image',{imagePaths:['one.png','two.png']}).message).images;
  assert.deepEqual(plain(slots),[{src:null,mimeType:'image/png'},{src:null,mimeType:'image/png'}]);
});
