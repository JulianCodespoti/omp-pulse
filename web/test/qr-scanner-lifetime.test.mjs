import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,useState,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {QrScanner} from ${JSON.stringify(resolve(root,'web/src/app/QrScanner.tsx'))};
const scans=[];
function App(){const [open,setOpen]=useState(true);return open?h(QrScanner,{hint:'Scan a code',onCancel:()=>setOpen(false),onScan:text=>{scans.push(text);setOpen(false);return true}}):h('p',null,'Camera closed')}
window.fixture={act,scans,mount(){const r=createRoot(document.getElementById('root'));r.render(h(App));return r}};
`);
async function fixture(t,{holdDecoder=false,playFails=false,scan=null,native=false}={}){
  const dom=createDomFixture(code),w=dom.window,{act,scans}=w.fixture;
  let resolveCamera,rejectCamera,resolveDecoder,stops=0,plays=0,settings=0;
  const track={stop(){stops++}};
  const stream={getTracks:()=>[track]};
  Object.defineProperty(w.navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>new Promise((resolve,reject)=>{resolveCamera=resolve;rejectCamera=reject})}});
  if(native){
    w.Capacitor={isNativePlatform:()=>true};
    w.OmpLocal={state:()=>JSON.stringify({mode:'phone'})};
    if(native!=='legacy')w.OmpLocal.openAppSettings=()=>{settings++};
  }
  w.BarcodeDetector=class{
    static getSupportedFormats(){return holdDecoder?new Promise(resolve=>{resolveDecoder=resolve}):Promise.resolve(['qr_code'])}
    async detect(){return scan?[{rawValue:scan}]:[]}
  };
  w.HTMLMediaElement.prototype.play=async()=>{plays++;if(playFails)throw new Error('Synthetic playback failure')};
  let r;await act(async()=>{r=w.fixture.mount()});
  t.after(async()=>{try{await act(async()=>r.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  return {w,act,scans,stops:()=>stops,plays:()=>plays,settings:()=>settings,
    camera:()=>act(async()=>resolveCamera(stream)),
    deny:()=>act(async()=>rejectCamera(new w.DOMException('Synthetic permission denial','NotAllowedError'))),
    decoder:()=>act(async()=>resolveDecoder(['qr_code'])),
    cancel:()=>act(async()=>w.document.querySelector('button[aria-label=Back]').click()),
    visible:()=>!!w.document.querySelector('[data-testid=qr-scanner]')};
}
test('camera arriving after cancellation is stopped instead of retained offscreen',async t=>{
  const f=await fixture(t);
  await f.cancel();assert.equal(f.visible(),false);
  await f.camera();
  assert.equal(f.stops(),1);
  assert.equal(f.plays(),0);
});
test('acquired camera is released while decoder startup is still pending',async t=>{
  const f=await fixture(t,{holdDecoder:true});
  await f.camera();assert.equal(f.stops(),0);
  await f.cancel();assert.equal(f.stops(),1);
  await f.decoder();
  assert.equal(f.stops(),1);
  assert.equal(f.plays(),0);
});
test('playback startup failure releases the camera and keeps fallback available',async t=>{
  const f=await fixture(t,{playFails:true});await f.camera();
  assert.equal(f.stops(),1);
  assert.equal(f.w.document.querySelector('[role=status]').textContent.includes('Couldn’t start the camera'),true);
  await f.cancel();assert.equal(f.visible(),false);
  assert.equal(f.stops(),1);
});
test('successful scan reaches its consumer and releases the active camera',async t=>{
  const f=await fixture(t,{scan:'synthetic-pairing-code'});await f.camera();
  assert.deepEqual(Array.from(f.scans),['synthetic-pairing-code']);
  assert.equal(f.plays(),1);
  assert.equal(f.visible(),false);
  assert.equal(f.stops(),1);
});

for(const native of [false,true,'legacy'])test(`camera denial keeps manual fallback and honest permission help (${native})`,async t=>{
  const f=await fixture(t,{native});await f.deny();
  const details=f.w.document.querySelector('[data-testid=qr-scanner] details');
  assert.equal(Boolean(details),native!==true);if(details)assert.equal(details.open,false);
  const button=label=>[...f.w.document.querySelectorAll('button')].find(b=>b.textContent.trim()===label);
  assert.equal(Boolean(button('Camera settings')),native===true);
  assert.equal(f.settings(),0);assert.equal(f.plays(),0);
  if(native===true){
    await f.act(async()=>button('Camera settings').click());
    assert.equal(f.settings(),1);assert.equal(f.visible(),true);
  }
  await f.act(async()=>button('Enter code instead').click());
  assert.equal(f.visible(),false);assert.equal(f.scans.length,0);
});
