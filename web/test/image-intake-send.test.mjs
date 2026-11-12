import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,act,StrictMode,Fragment} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {Composer} from ${JSON.stringify(resolve(root,'web/src/app/composer/Composer.tsx'))};
const sent=[];window.intakes=[];window.drafts=new Map();window.draftWrites=[];window.loads=[];window.flushers=new Set();window.speculativeLoads=[];
function Slow(){window.speculativeLoads.push(window.loads.length);const start=performance.now();while(performance.now()-start<12){};return h('span');}
window.fixture={act,sent,mount(){const r=createRoot(document.getElementById('root'));const render=(sessionPath='/synthetic/a')=>{const composer=h(Composer,{key:sessionPath,sessionPath,busy:false,onSend:async(text,images,path,onSaved)=>{const entry={text,images,path,onSaved};sent.push(entry);await window.sendImpl?.(entry)},onStop(){}});r.render(window.concurrent?h(Fragment,null,composer,...Array.from({length:4},(_,i)=>h(Slow,{key:i}))):window.strict?h(StrictMode,null,composer):composer)};render();return{render,unmount:()=>r.unmount()}}};
`,[{name:'synthetic-intake-storage',resolveId(id,importer){if(importer?.endsWith('/attachment-draft.ts') && id==='./offline-queue')return '\0draft-storage';if(!importer?.endsWith('/Composer.tsx'))return null;if(id==='./image-intake')return '\0intake';if(id==='../../runtime/offline-queue')return '\0draft-storage';return null},load(id){if(id==='\0intake')return 'export const MAX_IMAGES=8; export const PAYLOAD_TOO_LARGE_COPY="This message is too large to send. Try fewer photos."; export const imagesTooLargeToSend=images=>images.some(image=>image.data==="oversize"); export const intakeFiles=(files,count)=>new Promise((resolve,reject)=>window.intakes.push({files,count,resolve,reject}));';if(id==='\0draft-storage')return 'export const makeCommandId=()=>"synthetic-recovery-"+Math.random(); export const loadDraftAttachments=async path=>{window.loads.push(path);return window.drafts.get(path)??[]}; export const saveDraftAttachments=async(path,images,namespace,expected)=>{await window.beforeDraftWrite?.(path,images);window.draftWrites.push({path,images});if(expected&&!sameDraftAttachments(window.drafts.get(path)??[],expected))return false;window.drafts.set(path,images);return true}; export const sameDraftAttachments=(a,b)=>JSON.stringify(a)===JSON.stringify(b); export const registerDraftAttachmentFlusher=flush=>{window.flushers.add(flush);return()=>window.flushers.delete(flush)}; export const clearAllDraftAttachments=async()=>window.drafts.clear(); export {assertNoPendingEdit} from '+JSON.stringify(resolve(root,'web/src/runtime/offline-queue.ts'))+';';return null}}]);
const photo=name=>({data:'c3ludGhldGlj',mimeType:'image/png',previewUrl:'data:image/png;base64,c3ludGhldGlj',name,width:10,height:10});
async function fixture(t,{concurrent=false}={}){const dom=createDomFixture(code),w=dom.window,{act,sent}=w.fixture;let r,unmounted=false;if(concurrent){w.concurrent=true;w.IS_REACT_ACT_ENVIRONMENT=false;r=w.fixture.mount();const deadline=Date.now()+3000;while((!w.document.querySelector('[data-testid="composer-input"]')||!w.loads.length)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(w.document.querySelector('[data-testid="composer-input"]'));await new Promise(resolve=>setTimeout(resolve,20));w.IS_REACT_ACT_ENVIRONMENT=true;w.concurrent=false;}else await act(async()=>{r=w.fixture.mount()});const unmount=async()=>{if(!unmounted){unmounted=true;await act(async()=>r.unmount())}};t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});const input=()=>w.document.querySelector('[data-testid="composer-input"]'),send=()=>w.document.querySelector('[data-testid="composer-send-btn"]');return{w,act,sent,input,send,unmount,intakes:w.intakes,remount:async()=>{await unmount();await act(async()=>{r=w.fixture.mount();unmounted=false})},render:(...a)=>act(async()=>r.render(...a)),paste:(text='Caption')=>act(async()=>{const e=new w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(e,'clipboardData',{value:{items:[{kind:'file',getAsFile:()=>new w.File(['fake'],'synthetic.png',{type:'image/png'})}],getData:()=>text}});input().dispatchEvent(e)}),finish:(i,images=[photo('synthetic.png')],error)=>act(async()=>w.intakes[i].resolve({images,error})),click:()=>act(async()=>send()?.click()),type:value=>act(async()=>{Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(input(),value);input().dispatchEvent(new w.Event('input',{bubbles:true}))})};}
test('mixed text/image paste cannot send before its image is ready',async t=>{const f=await fixture(t);await f.paste();assert.equal(f.intakes.length,1);await f.click();assert.equal(f.sent.length,0);await f.finish(0);await f.click();assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,'Caption');assert.equal(f.sent[0].images.length,1);assert.equal(f.input().value,'');assert.equal(f.w.document.querySelectorAll('[data-testid="composer-attachments"]').length,0)});
test('two pending image intakes cannot unlock Send after only one finishes',async t=>{const f=await fixture(t);await f.paste('Caption');await f.paste('');await f.finish(0,[photo('one.png')]);await f.click();assert.equal(f.sent.length,0);await f.finish(1,[photo('two.png')]);await f.click();assert.equal(f.sent[0].images.length,2)});
test('another session can send while the original image is processing',async t=>{const f=await fixture(t);await f.paste();await f.render('/synthetic/b');await f.type('Other session');await f.click();assert.equal(f.sent.length,1);assert.equal(f.sent[0].path,'/synthetic/b');await f.render('/synthetic/a');await f.click();assert.equal(f.sent.length,1);await f.finish(0);await f.click();assert.equal(f.sent.length,2);assert.equal(f.sent[1].images.length,1)});
test('failed image processing releases Send and retains pasted text',async t=>{const f=await fixture(t);await f.paste();await f.finish(0,[],'Image could not be read');assert.equal(f.input().value,'Caption');assert.ok(f.w.document.body.textContent.includes('Image could not be read'));await f.click();assert.equal(f.sent.length,1);assert.equal(f.sent[0].images.length,0)});
test('direct form submission waits for intake and never auto-sends on completion',async t=>{const f=await fixture(t);await f.paste();await f.act(async()=>f.input().closest('form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true})));assert.equal(f.sent.length,0);await f.finish(0);assert.equal(f.sent.length,0);await f.act(async()=>f.input().closest('form').dispatchEvent(new f.w.Event('submit',{bubbles:true,cancelable:true})));assert.equal(f.sent.length,1)});
test('image-only paste exposes the existing busy Send control until ready',async t=>{const f=await fixture(t);await f.paste('');assert.equal(f.send()?.disabled,true);assert.equal(f.send()?.getAttribute('aria-label'),'Preparing images');assert.equal(f.send()?.getAttribute('aria-busy'),'true');await f.finish(0);assert.equal(f.send().disabled,false);assert.equal(f.send().getAttribute('aria-label'),'Send');assert.equal(f.sent.length,0)});
test('typing during image processing is preserved and sent with the image',async t=>{const f=await fixture(t);await f.paste();await f.type('Newer caption');await f.finish(0);assert.equal(f.input().value,'Newer caption');await f.click();assert.equal(f.sent[0].text,'Newer caption');assert.equal(f.sent[0].images.length,1)});
test('an unexpected intake rejection releases the busy guard without losing text',async t=>{const f=await fixture(t);await f.paste();await f.act(async()=>f.intakes[0].reject(new Error('Synthetic decode failure')));assert.equal(f.send().disabled,false);assert.equal(f.input().value,'Caption');assert.ok(f.w.document.body.textContent.includes('Synthetic decode failure'));await f.click();assert.equal(f.sent.length,1)});
test('old-session image failure does not appear in the current composer',async t=>{const f=await fixture(t);await f.paste();await f.render('/synthetic/b');await f.type('Other draft');await f.finish(0,[],'Old image failure');assert.equal(f.w.document.body.textContent.includes('Old image failure'),false);assert.equal(f.input().value,'Other draft');assert.equal(f.send().disabled,false)});
test('Enter obeys the intake wait and still sends after readiness',async t=>{const f=await fixture(t);await f.paste();const enter=()=>f.act(async()=>f.input().dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})));await enter();assert.equal(f.sent.length,0);await f.finish(0);await enter();assert.equal(f.sent.length,1)});
test('same-session intakes reserve their order and see the preceding tray count',async t=>{const f=await fixture(t);await f.paste('Caption');await f.paste('');assert.equal(f.intakes.length,1);await f.finish(0,Array.from({length:8},(_,i)=>photo(`image-${i}.png`)));assert.equal(f.intakes.length,2);assert.equal(f.intakes[1].count,8);await f.finish(1,[],'You can add up to 8 images per message.');await f.click();assert.equal(f.sent[0].images.length,8)});
test('the production intake cap rejects images when the preceding tray is full',async()=>{const {intakeFiles}=await import('../src/app/composer/image-intake.ts');const result=await intakeFiles([{type:'image/png'}],8);assert.equal(result.images.length,0);assert.ok(result.error.includes('up to 8'))});
test('the shared total cap matches the daemon: eight full photos fit, one byte more does not',async()=>{const {imagesTooLargeToSend,MAX_TOTAL_IMAGE_BASE64_CHARS,MAX_IMAGE_BASE64_CHARS,MAX_IMAGES}=await import('../src/app/composer/image-intake.ts');assert.equal(MAX_TOTAL_IMAGE_BASE64_CHARS,MAX_IMAGES*MAX_IMAGE_BASE64_CHARS);const full={data:'a'.repeat(MAX_IMAGE_BASE64_CHARS)};assert.equal(imagesTooLargeToSend(Array(MAX_IMAGES).fill(full)),false);assert.equal(imagesTooLargeToSend([...Array(MAX_IMAGES).fill(full),{data:'a'}]),true)});
test('an over-size message is held in the composer with calm copy instead of sent',async t=>{const f=await fixture(t);await f.paste();await f.finish(0,[{...photo('big.jpg'),data:'oversize'}]);await f.click();assert.equal(f.sent.length,0);assert.ok(f.w.document.body.textContent.includes('This message is too large to send. Try fewer photos.'));assert.equal(f.input().value,'Caption');assert.equal(f.w.document.querySelectorAll('[data-testid="attachment-strip"] img').length,1)});
test('a pending intake in one session does not queue decoding in another',async t=>{const f=await fixture(t);await f.paste();await f.render('/synthetic/b');await f.paste('Other caption');assert.equal(f.intakes.length,2);await f.finish(1,[photo('other.png')]);await f.click();assert.equal(f.sent[0].path,'/synthetic/b');assert.equal(f.sent[0].images.length,1);await f.finish(0)});
test('a failed earlier intake releases the next queued selection without unlocking Send early',async t=>{const f=await fixture(t);await f.paste();await f.paste('');await f.act(async()=>f.intakes[0].reject(new Error('First decode failed')));assert.equal(f.intakes.length,2);assert.equal(f.send().disabled,true);await f.finish(1,[photo('second.png')]);assert.equal(f.send().disabled,false);await f.click();assert.equal(f.sent[0].images.length,1)});

test('a photo batch shows every pending tile and cancellation discards only that photo', async t => {
  const f = await fixture(t);
  await f.act(async () => {
    const picker = f.w.document.querySelector('input[type="file"]');
    Object.defineProperty(picker, 'files', { configurable: true, value:
      Array.from({length: 5}, (_, i) => new f.w.File(['fake'], `${i}.png`, {type: 'image/png'})) });
    picker.dispatchEvent(new f.w.Event('change', {bubbles: true}));
  });
  assert.equal(f.w.document.querySelectorAll('[data-testid="attachment-pending"]').length, 5);
  await f.act(async () => f.w.document.querySelector('[data-testid="attachment-cancel"]').click());
  assert.equal(f.w.document.querySelectorAll('[data-testid="attachment-pending"]').length, 4);
  await f.finish(0, [photo('cancelled.png')]);
  for (let i = 1; i < 5; i++) await f.finish(i, [photo(`${i}.png`)]);
  assert.deepEqual(names(f), ['1.png', '2.png', '3.png', '4.png']);
  assert.equal(f.w.document.querySelectorAll('[data-testid="attachment-pending"]').length, 0);
});

test('multiple photo failures produce one batch summary', async t => {
  const f = await fixture(t);
  await f.act(async () => {
    const picker = f.w.document.querySelector('input[type="file"]');
    Object.defineProperty(picker, 'files', { configurable: true, value:
      ['a.png', 'b.png'].map(name => new f.w.File(['fake'], name, {type: 'image/png'})) });
    picker.dispatchEvent(new f.w.Event('change', {bubbles: true}));
  });
  await f.finish(0, [], 'First photo could not be opened.');
  await f.finish(1, [], 'Second photo could not be opened.');
  assert.ok(f.w.document.body.textContent.includes('2 of 2 photos couldn’t be added. First photo could not be opened.'));
});

test('a send preserves editor focus', async t => {
  const f = await fixture(t);
  await f.type('Keep the keyboard');
  await f.act(async () => f.input().focus());
  await f.click();
  assert.equal(f.w.document.activeElement, f.input());
});


test('decode completing after real unmount persists before the composer reopens', async t => {
  const f = await fixture(t);
  await f.paste('Caption that survives');
  await f.unmount();
  await f.finish(0);
  assert.equal(f.w.drafts.get('/synthetic/a')?.length, 1);
  await f.remount();
  assert.equal(f.input().value, 'Caption that survives');
  assert.equal(f.w.document.querySelectorAll('[data-testid="attachment-strip"] img').length, 1);
  await f.click();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].images.length, 1);
});

test('immediate remount inherits pending intake and blocks all draft send paths', async t => {
  const f = await fixture(t);
  await f.paste('Caption before navigation');
  await f.remount();
  assert.equal(f.input().value, 'Caption before navigation');
  assert.equal(f.send().disabled, true);
  assert.equal(f.send().getAttribute('aria-label'), 'Preparing images');
  await f.click();
  await f.act(async () => f.input().dispatchEvent(new f.w.KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true})));
  await f.act(async () => f.input().closest('form').dispatchEvent(new f.w.Event('submit', {bubbles:true, cancelable:true})));
  assert.equal(f.sent.length, 0);
  await f.type('New caption after reopen');
  await f.finish(0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.input().value, 'New caption after reopen');
  assert.equal(f.w.document.querySelectorAll('[data-testid="attachment-strip"] img').length, 1);
  await f.click();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, 'New caption after reopen');
  assert.equal(f.sent[0].images.length, 1);
});


const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b}); return {promise,resolve,reject}; };
const names = f => [...f.w.document.querySelectorAll('[data-testid="attachment-strip"] img')].map(node => node.getAttribute('alt'));

test('selected image and caption survive unmount before decoding finishes', async t => {
  const f = await fixture(t);
  await f.type('File picker caption');
  await f.act(async () => {
    const input = f.w.document.querySelector('input[type="file"]');
    Object.defineProperty(input, 'files', {configurable:true, value:[new f.w.File(['fake'],'chosen.png',{type:'image/png'})]});
    input.dispatchEvent(new f.w.Event('change', {bubbles:true}));
  });
  await f.remount();
  assert.equal(f.send().disabled, true);
  await f.finish(0, [photo('chosen.png')]);
  await f.click();
  assert.equal(f.sent[0].text, 'File picker caption');
  assert.equal(f.sent[0].images.length, 1);
});

test('reopened draft removal is authoritative when an older intake completes', async t => {
  const f = await fixture(t);
  await f.paste('Caption');
  await f.finish(0, [photo('existing.png')]);
  await f.paste('');
  await f.remount();
  await f.act(async () => f.w.document.querySelector('[data-testid="attachment-remove"]').click());
  await f.finish(1, [photo('new.png')]);
  assert.deepEqual(names(f), ['new.png']);
  assert.deepEqual([...f.w.drafts.get('/synthetic/a')].map(image => image.name), ['new.png']);
});

test('remount during enqueue inherits one lease and acknowledges the current editor', async t => {
  const f = await fixture(t), sending = deferred();
  f.w.sendImpl = () => sending.promise;
  await f.paste('Submitted caption');
  await f.finish(0);
  await f.click();
  await f.remount();
  assert.equal(f.send().disabled, true);
  await f.act(async () => f.input().closest('form').dispatchEvent(new f.w.Event('submit', {bubbles:true,cancelable:true})));
  assert.equal(f.sent.length, 1);
  await f.act(async () => { await f.sent[0].onSaved(); });
  assert.equal(f.input().value, '');
  assert.deepEqual(names(f), []);
  await f.act(async () => sending.resolve());
  await f.remount();
  assert.equal(f.input().value, '');
  assert.deepEqual(names(f), []);
  assert.equal(f.sent.length, 1);
});

test('acknowledgement after remount retains newer text and photos', async t => {
  const f = await fixture(t), sending = deferred();
  f.w.sendImpl = () => sending.promise;
  await f.paste('First caption');
  await f.finish(0, [photo('first.png')]);
  await f.click();
  await f.remount();
  await f.type('Second caption');
  await f.paste('');
  await f.finish(1, [photo('second.png')]);
  await f.act(async () => { await f.sent[0].onSaved(); });
  assert.equal(f.input().value, 'Second caption');
  assert.deepEqual(names(f), ['second.png']);
  await f.act(async () => sending.resolve());
  f.w.sendImpl = undefined;
  await f.click();
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].text, 'Second caption');
  assert.equal(f.sent[1].images.length, 1);
});

test('edit away and back after remount still counts as newer work', async t => {
  const f = await fixture(t), sending = deferred();
  f.w.sendImpl = () => sending.promise;
  await f.paste('Repeated caption');
  await f.finish(0);
  await f.click();
  await f.remount();
  await f.type('Different caption');
  await f.type('Repeated caption');
  await f.act(async () => { await f.sent[0].onSaved(); });
  assert.equal(f.input().value, 'Repeated caption');
  assert.deepEqual(names(f), []);
  await f.act(async () => sending.resolve());
});

test('rejected enqueue keeps current edits and removal instead of restoring stale images', async t => {
  const f = await fixture(t), sending = deferred();
  f.w.sendImpl = () => sending.promise;
  await f.paste('Old caption');
  await f.finish(0);
  await f.click();
  await f.remount();
  await f.type('Current caption');
  await f.act(async () => f.w.document.querySelector('[data-testid="attachment-remove"]').click());
  await f.act(async () => sending.reject(new Error('Queue unavailable')));
  assert.equal(f.input().value, 'Current caption');
  assert.deepEqual(names(f), []);
  assert.equal(f.send().disabled, false);
  assert.ok(f.w.document.body.textContent.includes('Queue unavailable'));
});

test('post-save network rejection never restores submitted images after remount', async t => {
  const f = await fixture(t), sending = deferred();
  f.w.sendImpl = () => sending.promise;
  await f.paste('Sent caption');
  await f.finish(0);
  await f.click();
  await f.act(async () => { await f.sent[0].onSaved(); });
  await f.remount();
  await f.act(async () => sending.reject(new Error('Delivery unavailable')));
  assert.equal(f.input().value, '');
  assert.deepEqual(names(f), []);
  assert.equal(f.w.drafts.get('/synthetic/a')?.length, 0);
});

test('failed cleanup survives remount and Retry clears without a second enqueue', async t => {
  const f = await fixture(t);
  await f.paste('Queued caption');
  await f.finish(0);
  let failures = 1;
  f.w.beforeDraftWrite = async (_path, images) => {if (!images.length && failures-- > 0) throw new Error('Synthetic disk failure')};
  await f.click();
  assert.equal(f.sent.length, 1);
  assert.equal(f.input().value, 'Queued caption');
  assert.deepEqual(names(f), []);
  await f.remount();
  assert.equal(f.sent.length, 1);
  assert.ok(f.w.document.body.textContent.includes('Retry to finish clearing'));
  await f.click();
  assert.equal(f.sent.length, 1);
  assert.equal(f.input().value, '');
  assert.deepEqual(names(f), []);
  assert.equal(f.w.drafts.get('/synthetic/a')?.length, 0);
});

test('offscreen decode failure appears only when its session reopens', async t => {
  const f = await fixture(t);
  await f.paste('Caption');
  await f.render('/synthetic/b');
  await f.act(async () => f.intakes[0].reject(new Error('Could not decode old photo')));
  assert.equal(f.w.document.body.textContent.includes('Could not decode old photo'), false);
  await f.render('/synthetic/a');
  assert.ok(f.w.document.body.textContent.includes('Could not decode old photo'));
  assert.equal(f.input().value, 'Caption');
});

test('StrictMode remount does not delete the restored tray or duplicate intake', async t => {
  const f = await fixture(t);
  await f.paste('Caption');
  await f.finish(0);
  f.w.strict = true;
  await f.remount();
  assert.equal(f.intakes.length, 1);
  assert.deepEqual(names(f), ['synthetic.png']);
  await f.click();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].images.length, 1);
});


test('image-only cleanup failure keeps its retry control available after remount', async t => {
  const f = await fixture(t);
  await f.paste('');
  await f.finish(0);
  let failures = 1;
  f.w.beforeDraftWrite = async (_path, images) => {if (!images.length && failures-- > 0) throw new Error('Synthetic disk failure')};
  await f.click();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(names(f), []);
  await f.remount();
  assert.ok(f.send());
  assert.equal(f.send().disabled, false);
  assert.equal(f.send().getAttribute('aria-label'), 'Retry saved draft cleanup');
  await f.click();
  assert.equal(f.sent.length, 1);
  // The slot never disappears: with nothing left to send it is a disabled Send.
  assert.equal(f.send().disabled, true);
  assert.equal(f.send().getAttribute('aria-label'), 'Send');
});


test('concurrent Composer render starts no speculative persistence and retains the committed intake owner', async t => {
  const f = await fixture(t, {concurrent:true});
  assert.ok(f.w.speculativeLoads.length >= 4);
  assert.deepEqual([...f.w.speculativeLoads], Array(f.w.speculativeLoads.length).fill(0));
  assert.equal(f.w.loads.length, 1);
  assert.equal(f.w.flushers.size, 1);
  await f.paste('Concurrent caption');
  await f.remount();
  assert.equal(f.send().disabled, true);
  assert.equal(f.w.flushers.size, 1);
  await f.unmount();
  let flushed = false;
  const flushing = Promise.all([...f.w.flushers].map(flush => flush())).then(() => {flushed=true});
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(flushed, false);
  await f.finish(0);
  await flushing;
  assert.equal(f.w.drafts.get('/synthetic/a').length, 1);
  await f.remount();
  await f.click();
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].text, 'Concurrent caption');
  assert.equal(f.sent[0].images.length, 1);
  await f.unmount();
  assert.equal(f.w.flushers.size, 0);
});
test('oversize recovery focuses image removal without deleting or sending the draft', async t => {
  const f = await fixture(t);
  await f.paste('Keep this caption');
  await f.finish(0, [{...photo('big.jpg'), data:'oversize'}]);
  const notice = f.w.document.querySelector('[data-testid="composer-error"]');
  const action = [...notice.querySelectorAll('button')].find(button => button.textContent === 'Review images');
  assert.equal(Boolean(action), true);
  await f.act(async () => action.click());
  assert.equal(f.w.document.activeElement?.getAttribute('data-testid'), 'attachment-remove');
  assert.equal(f.w.document.querySelectorAll('[data-testid="attachment-strip"] img').length, 1);
  assert.equal(f.input().value, 'Keep this caption');
  assert.equal(f.sent.length, 0);
});
