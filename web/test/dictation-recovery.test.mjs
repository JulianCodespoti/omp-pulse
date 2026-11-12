import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture, createDomFixture, root} from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h, act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {DictationNotice} from ${JSON.stringify(resolve(root, 'web/src/app/composer/DictationNotice.tsx'))};
const calls = {record:0,retry:0,dismiss:0,settings:0};
window.fixture = {act,calls,mount(options={}) {
  const r = createRoot(document.getElementById('root'));
  const dictation = {status:'error',canRetry:false,start:async()=>{calls.record++},retry:()=>{calls.retry++},...options};
  r.render(h(DictationNotice,{dictation,message:options.message??'Could not transcribe.',onDismiss:()=>{calls.dismiss++}}));
  return r;
}};
`, [{name:'inline-recovery-sheet',resolveId(id,importer) {
  return importer?.endsWith('/DictationNotice.tsx') && id === '../ui/Sheet' ? '\0sheet' : null;
},load(id) {
  return id === '\0sheet' ? `import {createElement as h} from ${JSON.stringify(require.resolve('react'))}; export const BottomSheet=({open,title,children})=>open?h('section',{'data-testid':'recovery-help'},h('h2',null,title),children):null;` : null;
}}]);

async function fixture(t, options={}, native=false) {
  const dom = createDomFixture(code), w = dom.window, {act,calls} = w.fixture;
  if (native) {
    w.Capacitor = {isNativePlatform:()=>true};
    w.OmpLocal = {state:()=>JSON.stringify({mode:'phone'})};
    if (native !== 'legacy') w.OmpLocal.openAppSettings = ()=>{calls.settings++};
  }
  let mounted;
  await act(async()=>{mounted=w.fixture.mount(options)});
  t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  return {w,calls,button:label=>[...w.document.querySelectorAll('button')].find(button=>button.textContent===label),tap:button=>act(async()=>button.click())};
}

test('blocked native microphone opens app settings only after an explicit tap', async t=>{
  const f=await fixture(t,{status:'denied',message:'Microphone access is blocked.'},true);
  assert.equal(f.calls.settings,0);
  assert.equal(f.calls.record,0);
  await f.tap(f.button('Microphone settings'));
  assert.equal(f.calls.settings,1);
  assert.equal(f.calls.record,0);
  assert.equal(f.calls.retry,0);
});

test('browser microphone denial offers help without pretending permission was granted', async t=>{
  const f=await fixture(t,{status:'denied',message:'Microphone access is blocked.'});
  await f.tap(f.button('Microphone help'));
  assert.equal(Boolean(f.w.document.querySelector('[data-testid="recovery-help"]')),true);
  assert.equal(f.calls.record,0);
  await f.tap(f.button('Try microphone'));
  assert.equal(f.calls.record,1);
  assert.equal(f.calls.retry,0);
});

test('older native shell keeps manual microphone help and explicit recording retry', async t=>{
  const f=await fixture(t,{status:'denied'},'legacy');
  assert.equal(f.button('Microphone settings'),undefined);
  await f.tap(f.button('Microphone help'));
  const details=f.w.document.querySelector('[data-testid="recovery-help"] details');
  assert.equal(Boolean(details),true);
  assert.equal(details.open,false);
  assert.equal(f.calls.settings,0);
  assert.equal(f.calls.record,0);
  await f.tap(f.button('Try microphone'));
  assert.equal(f.calls.record,1);
  assert.equal(f.calls.retry,0);
});

test('missing speech model offers setup and retains transcription until deliberate retry', async t=>{
  const f=await fixture(t,{canRetry:true,recoveryError:'ASR model missing',message:'Speech recognition needs setup.'});
  assert.equal(f.button('Retry'),undefined);
  await f.tap(f.button('Set up dictation'));
  assert.equal(f.calls.retry,0);
  assert.equal(f.calls.record,0);
  assert.equal(f.w.document.body.textContent.includes('omp-pulse asr install'),true);
  assert.equal(Boolean(f.w.document.querySelector('button[aria-label="Copy setup command"]')),true);
  const help=f.w.document.querySelector('[data-testid="recovery-help"]');
  assert.equal(help.querySelector('details').open,false);
  assert.equal(help.querySelector('p').textContent.includes('650 MB'),true);
  await f.tap(f.button('Retry transcription'));
  assert.equal(f.calls.retry,1);
  assert.equal(f.calls.record,0);
});

test('ordinary transcription failure retries the kept recording instead of recording again', async t=>{
  const f=await fixture(t,{canRetry:true});
  await f.tap(f.button('Retry'));
  assert.equal(f.calls.retry,1);
  assert.equal(f.calls.record,0);
});
