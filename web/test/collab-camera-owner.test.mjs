import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {CollabConnectSheet} from ${JSON.stringify(resolve(root,'web/src/app/chat/CollabConnectSheet.tsx'))};
import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
const attached=[];DaemonApi.prototype.collabAttach=async(...args)=>attached.push(args);
window.fixture={act,attached,mount(){const r=createRoot(document.getElementById('root'));const render=(open=true,sessionPath='/synthetic')=>r.render(h(CollabConnectSheet,{open,sessionPath,onOpenChange(){}}));render();return{render,unmount:()=>r.unmount()}}};
`);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
async function fixture(t){const dom=createDomFixture(code),w=dom.window,{act,attached}=w.fixture,permissions=[],detections=[],timers=new Map();let next=1000,root;
 Object.defineProperty(w.navigator,'mediaDevices',{value:{getUserMedia(){const p=deferred();permissions.push(p);return p.promise}}});
 w.BarcodeDetector=class{detect(){const p=deferred();detections.push(p);return p.promise}};
 w.HTMLMediaElement.prototype.play=async()=>{};
 const interval=w.setInterval.bind(w),clear=w.clearInterval.bind(w);w.setInterval=(cb,ms,...args)=>{if(ms===400){const id=next++;timers.set(id,cb);return id}return interval(cb,ms,...args)};w.clearInterval=id=>{timers.delete(id);clear(id)};
 await act(async()=>{root=w.fixture.mount()});let closed=false;
 const unmount=async()=>{if(!closed){closed=true;await act(async()=>root.unmount())}};
 t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const button=text=>[...w.document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
 return{w,act,attached,permissions,detections,timers,button,unmount,render:(open,path)=>act(async()=>root.render(open,path)),click:text=>act(async()=>{assert.ok(button(text),text);button(text).click()}),tick:()=>act(async()=>{for(const cb of timers.values())void cb()}),resolve:async(index=0)=>{const stream={stops:0,getTracks(){return[{stop:()=>stream.stops++}]}};await act(async()=>permissions[index].resolve(stream));return stream;}};
}
test('closing while permission is pending stops the late stream instead of starting scanning',async t=>{const f=await fixture(t);await f.click('Scan QR code');await f.render(false);const stream=await f.resolve();assert.equal(stream.stops,1);assert.equal(f.timers.size,0)});
test('unmount while permission is pending stops the late stream',async t=>{const f=await fixture(t);await f.click('Scan QR code');await f.unmount();const stream=await f.resolve();assert.equal(stream.stops,1);assert.equal(f.timers.size,0)});
test('a session change rejects the previous camera request',async t=>{const f=await fixture(t);await f.click('Scan QR code');await f.render(true,'/other');const stream=await f.resolve();assert.equal(stream.stops,1);assert.equal(f.timers.size,0)});
test('repeated scan clicks issue only one pending media request',async t=>{const f=await fixture(t);await f.act(async()=>{f.button('Scan QR code').click();f.button('Scan QR code').click()});assert.equal(f.permissions.length,1)});
test('a current scan still starts and Stop releases tracks and timer',async t=>{const f=await fixture(t);await f.click('Scan QR code');const stream=await f.resolve();assert.equal(stream.stops,0);assert.equal(f.timers.size,1);await f.click('Stop scanning');assert.equal(stream.stops,1);assert.equal(f.timers.size,0)});
test('a cancelled old rejection cannot replace a newer scan with an error',async t=>{const f=await fixture(t);await f.click('Scan QR code');await f.render(false);await f.render(true);await f.click('Scan QR code');const stream=await f.resolve(1);await f.act(async()=>f.permissions[0].reject(new Error('obsolete permission failure')));assert.ok(f.button('Stop scanning'));assert.equal(f.w.document.body.textContent.includes('obsolete permission failure'),false);assert.equal(stream.stops,0)});
test('a QR detection resolving after Stop cannot attach a session',async t=>{const f=await fixture(t);await f.click('Scan QR code');await f.resolve();await f.tick();assert.equal(f.detections.length,1);await f.click('Stop scanning');await f.act(async()=>f.detections[0].resolve([{rawValue:'synthetic-collab-link'}]));assert.equal(f.attached.length,0)});
test('a late old stream cannot stop or replace the newer scan',async t=>{const f=await fixture(t);await f.click('Scan QR code');await f.render(false);await f.render(true);await f.click('Scan QR code');const current=await f.resolve(1),old=await f.resolve(0);assert.equal(old.stops,1);assert.equal(current.stops,0);assert.equal(f.timers.size,1)});
// Camera failures read as one human line; the raw platform message never shows.
test('current permission failure remains visible and permits a fresh attempt',async t=>{const f=await fixture(t);await f.click('Scan QR code');await f.act(async()=>f.permissions[0].reject(new Error('Camera unavailable')));assert.ok(f.w.document.body.textContent.includes("Couldn't open the camera."));assert.equal(f.w.document.body.textContent.includes('Camera unavailable'),false);await f.click('Scan QR code');assert.equal(f.permissions.length,2);await f.resolve(1);assert.ok(f.button('Stop scanning'))});
test('detector setup failure releases the acquired stream',async t=>{const f=await fixture(t);f.w.BarcodeDetector=class{constructor(){throw new Error('Unsupported detector')}};await f.click('Scan QR code');const stream=await f.resolve();assert.equal(stream.stops,1);assert.equal(f.timers.size,0);assert.ok(f.w.document.body.textContent.includes("Couldn't open the camera."));assert.equal(f.w.document.body.textContent.includes('Unsupported detector'),false)});
test('overlapping detections may attach only once for the current scan',async t=>{const f=await fixture(t);await f.click('Scan QR code');await f.resolve();await f.tick();await f.tick();assert.equal(f.detections.length,2);await f.act(async()=>{for(const d of f.detections)d.resolve([{rawValue:'synthetic-collab-link'}])});assert.equal(f.attached.length,1);assert.equal(f.timers.size,0)});
test('accepted media is attached and played after the preview mounts',async t=>{const f=await fixture(t);let plays=0;f.w.HTMLMediaElement.prototype.play=async()=>{plays++};await f.click('Scan QR code');const stream=await f.resolve();const video=f.w.document.querySelector('video');assert.ok(video);assert.equal(video.srcObject===stream,true);assert.equal(plays,1)});
test('current playback failure stops the stream and leaves a retryable scan control',async t=>{const f=await fixture(t);f.w.HTMLMediaElement.prototype.play=async()=>{throw new Error('Preview playback failed')};await f.click('Scan QR code');const stream=await f.resolve();assert.equal(stream.stops,1);assert.equal(f.timers.size,0);assert.ok(f.button('Scan QR code'));assert.ok(f.w.document.body.textContent.includes("Couldn't start the camera."));assert.equal(f.w.document.body.textContent.includes('Preview playback failed'),false)});
test('obsolete playback rejection cannot stop a newer preview',async t=>{const f=await fixture(t),plays=[];f.w.HTMLMediaElement.prototype.play=()=>{const p=deferred();plays.push(p);return p.promise};await f.click('Scan QR code');const old=await f.resolve();assert.equal(plays.length,1);await f.click('Stop scanning');await f.click('Scan QR code');const current=await f.resolve(1);assert.equal(plays.length,2);await f.act(async()=>plays[0].reject(new Error('old playback failed')));assert.equal(old.stops,1);assert.equal(current.stops,0);assert.ok(f.button('Stop scanning'));assert.equal(f.w.document.body.textContent.includes('old playback failed'),false);await f.act(async()=>plays[1].resolve())});

test('browser camera denial offers a working paste-link fallback without starting another request',async t=>{
 const f=await fixture(t);await f.click('Scan QR code');
 await f.act(async()=>f.permissions[0].reject(new f.w.DOMException('Denied','NotAllowedError')));
 await f.click('Paste link');
 assert.equal(f.w.document.activeElement===f.w.document.querySelector('input[aria-label="Collab link"]'),true);
 assert.equal(f.permissions.length,1);assert.equal(f.attached.length,0);
});
test('native camera denial opens app settings only on explicit action and never grants or attaches',async t=>{
 const f=await fixture(t),calls=[];
 f.w.OmpLocal={state:()=>JSON.stringify({mode:'laptop'}),openAppSettings:()=>calls.push('settings'),grant:()=>calls.push('grant')};
 await f.click('Scan QR code');await f.act(async()=>f.permissions[0].reject(new f.w.DOMException('Denied','NotAllowedError')));
 assert.deepEqual(calls,[]);await f.click('Open app settings');
 assert.deepEqual(calls,['settings']);assert.equal(f.permissions.length,1);assert.equal(f.attached.length,0);
});
