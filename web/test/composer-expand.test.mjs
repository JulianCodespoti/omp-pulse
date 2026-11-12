import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
// Same storage and intake stand-ins as image-intake-send.test.mjs: the composer, nothing else.
const code=await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {Composer} from ${JSON.stringify(resolve(root,'web/src/app/composer/Composer.tsx'))};
const sent=[];window.drafts=new Map();
window.fixture={act,sent,mount(){const r=createRoot(document.getElementById('root'));r.render(h(Composer,{sessionPath:'/synthetic/a',busy:false,onSend:async(text,images,path,onSaved)=>{sent.push({text,images,path,onSaved})},onStop(){}}));return{unmount:()=>r.unmount()}}};
`,[{name:'synthetic-intake-storage',resolveId(id,importer){if(importer?.endsWith('/attachment-draft.ts') && id==='./offline-queue')return '\0draft-storage';if(!importer?.endsWith('/Composer.tsx'))return null;if(id==='./image-intake')return '\0intake';if(id==='../../runtime/offline-queue')return '\0draft-storage';return null},load(id){if(id==='\0intake')return 'export const MAX_IMAGES=8; export const PAYLOAD_TOO_LARGE_COPY=""; export const imagesTooLargeToSend=()=>false; export const intakeFiles=()=>new Promise(()=>{});';if(id==='\0draft-storage')return 'export const makeCommandId=()=>"synthetic-recovery-"+Math.random(); export const loadDraftAttachments=async path=>window.drafts.get(path)??[]; export const saveDraftAttachments=async(path,images)=>{window.drafts.set(path,images);return true}; export const sameDraftAttachments=(a,b)=>JSON.stringify(a)===JSON.stringify(b); export const registerDraftAttachmentFlusher=()=>()=>{}; export const clearAllDraftAttachments=async()=>window.drafts.clear(); export {assertNoPendingEdit} from '+JSON.stringify(resolve(root,'web/src/runtime/offline-queue.ts'))+';';return null}}]);
async function fixture(t){
  const dom=createDomFixture(code),w=dom.window,{act,sent}=w.fixture;let r;
  // jsdom has no layout: a draft over 20 characters "needs more than the compact box".
  Object.defineProperty(w.HTMLTextAreaElement.prototype,'scrollHeight',{configurable:true,get(){return this.value.length>20?999:0}});
  await act(async()=>{r=w.fixture.mount()});
  t.after(async()=>{try{await act(async()=>r.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  const q=id=>w.document.querySelector(`[data-testid="${id}"]`);
  return{w,sent,q,
    type:value=>act(async()=>{Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(q('composer-input'),value);q('composer-input').dispatchEvent(new w.Event('input',{bubbles:true}))}),
    click:id=>act(async()=>q(id).click())};
}
const LONG='a pasted stack trace that runs long';

test('the expand button appears only once the draft outgrows the compact box, and toggles the field to about 60dvh',async t=>{
  const f=await fixture(t);
  assert.equal(f.q('composer-expand'),null);
  await f.type('short');
  assert.equal(f.q('composer-expand'),null);
  await f.type(LONG);
  const button=()=>f.q('composer-expand');
  assert.equal(button().getAttribute('aria-label'),'Expand composer');
  assert.equal(button().getAttribute('aria-expanded'),'false');
  assert.equal(f.q('composer-input').style.maxHeight,'');
  await f.click('composer-expand');
  assert.equal(button().getAttribute('aria-label'),'Collapse composer');
  assert.equal(button().getAttribute('aria-expanded'),'true');
  assert.equal(f.q('composer-input').style.maxHeight.includes('100dvh')&&f.q('composer-input').style.maxHeight.includes('0.6'),true);
  assert.equal(f.q('composer-input').style.minHeight,f.q('composer-input').style.maxHeight);
  await f.click('composer-expand');
  assert.equal(button().getAttribute('aria-expanded'),'false');
  assert.equal(f.q('composer-input').style.maxHeight,'');
});

test('an expanded composer keeps its button when the draft shrinks, so it can always be collapsed',async t=>{
  const f=await fixture(t);
  await f.type(LONG);await f.click('composer-expand');
  await f.type('short');
  assert.equal(f.q('composer-expand').getAttribute('aria-expanded'),'true');
  await f.click('composer-expand');
  assert.equal(f.q('composer-expand'),null,'compact and short: nothing to expand');
});

test('sending collapses an expanded composer',async t=>{
  const f=await fixture(t);
  await f.type(LONG);await f.click('composer-expand');
  await f.click('composer-send-btn');
  assert.equal(f.sent.length,1);
  assert.equal(f.q('composer-input').value,'');
  assert.equal(f.q('composer-input').style.maxHeight,'');
  assert.equal(f.q('composer-expand'),null);
});
