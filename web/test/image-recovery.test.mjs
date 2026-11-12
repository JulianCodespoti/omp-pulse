import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {ImagePart} from ${JSON.stringify(resolve(root,'web/src/app/parts/ImagePart.tsx'))};
 import {noteDaemonReachable} from ${JSON.stringify(resolve(root,'web/src/runtime/daemon-reachability.ts'))};
 let r;const render=src=>r.render(Array.isArray(src) ? src.map((value,key)=>h(ImagePart,{key,src:value,alt:'Synthetic screenshot',mimeType:'image/png'})) : h(ImagePart,{src,alt:'Synthetic screenshot',mimeType:'image/png'}));
 window.fixture={act,render,reachable:noteDaemonReachable,mount:src=>{r=createRoot(document.getElementById('root'));render(src);return r}};
`,[{name:'viewer-shell',resolveId:(id,importer)=>importer?.endsWith('/ImagePart.tsx')&&id==='@/app/parts/ImageViewer'?'\0viewer':null,
 load:id=>id==='\0viewer'?`import {createElement as h} from ${JSON.stringify(require.resolve('react'))};export const ImageViewer=({src,open})=>open?h('div',{'data-testid':'viewer','data-src':src}):null;`:null}]);
const A='blob:sha256:aaaaaaaa',B='blob:sha256:bbbbbbbb';
async function fixture(t,src=A,{observer=false}={}){
 const dom=createDomFixture(code),w=dom.window,{act,render}=w.fixture,requests=[],created=[],revoked=[],observers=[],timers=[];
 w.fetch=(path,options)=>new Promise((resolve,reject)=>requests.push({path,options,resolve,reject}));
 w.URL.createObjectURL=()=>{const url=`blob:synthetic-${created.length}`;created.push(url);return url};w.URL.revokeObjectURL=url=>revoked.push(url);
 // No observer: images read at once (the fallback). With one, the test decides what is near.
 if(observer)w.IntersectionObserver=class{constructor(callback,options){this.callback=callback;this.options=options;this.targets=[];observers.push(this)}observe(target){this.targets.push(target)}disconnect(){this.disconnected=true}};
 else w.IntersectionObserver=undefined;
 // Retry waits are seconds long: hold them for the test to fire; React's own short timers run.
 const realSetTimeout=w.setTimeout.bind(w),realClearTimeout=w.clearTimeout.bind(w);
 w.setTimeout=(fn,delay,...args)=>{if(!(delay>=1000))return realSetTimeout(fn,delay,...args);timers.push({fn,delay,cleared:false});return -timers.length};
 w.clearTimeout=id=>{if(typeof id==='number'&&id<0){timers[-id-1].cleared=true;return}realClearTimeout(id)};
 let mounted;await act(async()=>{mounted=w.fixture.mount(src)});
 t.after(async()=>{try{await act(async()=>mounted?.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 return {w,act,render,requests,created,revoked,observers,img:()=>w.document.querySelector('img'),
  text:()=>w.document.body.textContent,
  // The 20 s request read deadline (request.ts) is not a retry wait.
  pending:()=>timers.filter(timer=>!timer.cleared&&timer.delay!==20_000).map(timer=>timer.delay),
  fire:()=>act(async()=>{const timer=timers.find(item=>!item.cleared&&item.delay!==20_000);timer.cleared=true;timer.fn()}),
  resolve:(i,ok=true,status=ok?200:503)=>act(async()=>requests[i].resolve({ok,status,blob:async()=>({synthetic:true})})),
  reject:i=>act(async()=>requests[i].reject(Error('synthetic network failure'))),
  retryButton:()=>[...w.document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Retry'),
  retry:()=>act(async()=>[...w.document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Retry').click()),
  change:src=>act(async()=>render(src)),
  unmount:()=>act(async()=>{mounted.unmount();mounted=null})};
}
test('loading has a labelled status and uses the existing relative blob route',async t=>{
 const f=await fixture(t);assert.equal(f.requests[0].path,'/api/blob/aaaaaaaa');
 const tile=f.w.document.querySelector('[data-testid="image-tile"]');
 assert.equal(tile?.getAttribute('role'),'status');assert.equal(tile.textContent,'Loading image…');
 assert.equal(f.img() === null, true);
});
test('fetch failure offers an in-place Retry and recovers the same image',async t=>{
 const f=await fixture(t);await f.resolve(0,false);assert.ok(f.text().includes('Waiting for the connection…'));
 await f.retry();assert.equal(f.requests.length,2);assert.equal(f.requests[1].path,f.requests[0].path);
 assert.equal(f.w.document.querySelector('[role="alert"]') === null, true);await f.resolve(1);assert.equal(f.img().getAttribute('src'),'blob:synthetic-0');
});
test('replacement after failure starts fresh rather than inheriting the old error',async t=>{
 const f=await fixture(t);await f.reject(0);await f.change(B);assert.equal(f.w.document.querySelector('[role="alert"]') === null, true);
 assert.ok(f.w.document.querySelector('[role="status"]'));await f.resolve(1);assert.ok(f.img());
});
test('replacement after success hides the old image and revokes its object URL',async t=>{
 const f=await fixture(t);await f.resolve(0);await f.change(B);assert.equal(f.img() === null, true);assert.deepEqual(f.revoked,['blob:synthetic-0']);
 await f.resolve(1);assert.equal(f.img().getAttribute('src'),'blob:synthetic-1');
});
test('late old fetch cannot replace the new image or allocate an object URL',async t=>{
 const f=await fixture(t);await f.change(B);await f.resolve(1);await f.resolve(0);
 assert.equal(f.img().getAttribute('src'),'blob:synthetic-0');assert.equal(f.created.length,1);
});
test('unmount during fetch suppresses object URL creation',async t=>{
 const f=await fixture(t);await f.unmount();await f.resolve(0);assert.equal(f.created.length,0);
});
test('loaded object URL is revoked on unmount',async t=>{
 const f=await fixture(t);await f.resolve(0);await f.unmount();assert.deepEqual(f.revoked,['blob:synthetic-0']);
});
test('decode failure gets Retry and releases the failed blob URL',async t=>{
 const f=await fixture(t);await f.resolve(0);await f.act(async()=>f.img().dispatchEvent(new f.w.Event('error')));
 assert.equal(f.img() === null, true);await f.retry();assert.deepEqual(f.revoked,['blob:synthetic-0']);assert.equal(f.requests.length,2);
});
test('inline image failure recreates its element without a daemon request',async t=>{
 const f=await fixture(t,'data:image/png;base64,c3ludGhldGlj');const before=f.img();
 await f.act(async()=>before.dispatchEvent(new f.w.Event('error')));await f.retry();
 assert.notEqual(f.img(),before);assert.equal(f.requests.length,0);assert.equal(f.img().getAttribute('src'),'data:image/png;base64,c3ludGhldGlj');
});
test('image uses a labelled native button and replacement closes the old viewer',async t=>{
 const f=await fixture(t);await f.resolve(0);const button=f.img().closest('button');assert.ok(button);
 assert.equal(button.type,'button');assert.equal(button.getAttribute('aria-label'),'Open image: Synthetic screenshot');
 await f.act(async()=>button.click());assert.ok(f.w.document.querySelector('[data-testid="viewer"]'));
 await f.change(B);assert.equal(f.w.document.querySelector('[data-testid="viewer"]') === null, true);
});
test('unavailable phone image retains explanation without a dead Retry',async t=>{
 const f=await fixture(t,null),tile=f.w.document.querySelector('[data-testid="image-tile"]');
 assert.equal(tile?.textContent,'Image not on this device');assert.equal(tile.getAttribute('role'),null);
 assert.equal(f.w.document.querySelector('button') === null, true);assert.equal(f.requests.length,0);
});

for (const transition of ['unmount', 'replace']) {
 for (const stage of ['headers', 'body']) {
  test(`${transition} aborts owned image ${stage} read`, async t => {
   const f = await fixture(t), request = f.requests[0];
   let finishBody;
   if (stage === 'body') await f.act(async () => request.resolve({ok:true, blob:() => new Promise(resolve => { finishBody = resolve; })}));
   assert.equal(request.options.signal?.aborted, false);
   if (transition === 'unmount') await f.unmount(); else await f.change(B);
   assert.equal(request.options.signal.aborted, true);
   // Deliberately ignore abort: stale completion must remain harmless too.
   if (finishBody) await f.act(async () => finishBody({synthetic:true}));
   else await f.resolve(0);
   assert.equal(f.created.length, 0);
   if (transition === 'replace') {
    assert.equal(f.requests[1].options.signal.aborted, false);
    await f.resolve(1);
    assert.equal(f.img().getAttribute('src'), 'blob:synthetic-0');
   }
  });
 }
}

test('separate same-hash image consumers own separate request cancellation', async t => {
 const f = await fixture(t, [A, A]);
 assert.equal(f.requests.length, 2);
 assert.equal(f.requests[0].path, f.requests[1].path);
 assert.notEqual(f.requests[0].options.signal, f.requests[1].options.signal);
 await f.change([A]);
 assert.equal(f.requests[0].options.signal.aborted, false);
 assert.equal(f.requests[1].options.signal.aborted, true);
 await f.resolve(0);
 await f.resolve(1);
 assert.ok(f.img());
 assert.equal(f.created.length, 1);
});

test('aborted old read rejection cannot display an error in its replacement', async t => {
 const f = await fixture(t);
 await f.change(B);
 assert.equal(f.requests[0].options.signal?.aborted, true);
 await f.act(async () => f.requests[0].reject(new f.w.DOMException('Aborted', 'AbortError')));
 assert.equal(f.w.document.querySelector('[role="alert"]') === null, true);
 await f.resolve(1);
 assert.ok(f.img());
});

test('an image is read only once it nears the viewport, and a retry does not wait again', async t => {
 const f = await fixture(t, A, { observer: true });
 assert.equal(f.requests.length, 0, 'an off-screen image costs no fetch');
 assert.ok(f.text().includes('Loading image'));
 const [observer] = f.observers;
 assert.equal(observer.options.rootMargin, '150% 0px');
 assert.equal(observer.targets.length, 1);
 await f.act(async () => observer.callback([{ isIntersecting: false }]));
 assert.equal(f.requests.length, 0);
 await f.act(async () => observer.callback([{ isIntersecting: true }]));
 assert.equal(f.requests.length, 1);
 assert.equal(observer.disconnected, true);
 await f.reject(0); await f.retry();
 assert.equal(f.requests.length, 2, 'once near, it stays near');
 assert.equal(f.observers.length, 1);
});

test('an unreachable daemon reads as waiting and the image retries itself with backoff', async t => {
 const f = await fixture(t);
 await f.reject(0);
 assert.ok(f.text().includes('Waiting for the connection…'));
 assert.equal(f.w.document.querySelector('[role="alert"]') === null, true, 'waiting is calm, not an error');
 assert.ok(f.retryButton(), 'manual Retry stays');
 assert.deepEqual(f.pending(), [2000]);
 await f.fire();
 assert.equal(f.requests.length, 2);
 await f.resolve(1, false, 502);
 assert.deepEqual(f.pending(), [5000], 'each failure waits longer');
 await f.act(async () => f.w.dispatchEvent(new f.w.Event('online')));
 assert.equal(f.requests.length, 3, 'the network coming back retries at once');
 await f.resolve(2);
 assert.equal(f.img().getAttribute('src'), 'blob:synthetic-0');
 assert.deepEqual(f.pending(), []);
});

test('a reconnected daemon retries waiting images at once', async t => {
 const f = await fixture(t);
 await f.reject(0);
 await f.act(async () => f.w.fixture.reachable());
 assert.equal(f.requests.length, 2);
 await f.resolve(1);
 assert.ok(f.img());
});

test('a blob the daemon does not have says so, waits for no timer, and retries when the daemon comes back', async t => {
 const f = await fixture(t);
 await f.resolve(0, false, 404);
 assert.ok(f.text().includes('Image is no longer available'));
 assert.equal(f.text().includes('connection'), false);
 assert.deepEqual(f.pending(), []);
 assert.ok(f.retryButton());
 await f.act(async () => f.w.fixture.reachable());
 assert.equal(f.requests.length, 2, 'a restarted daemon may have it now');
});

test('leaving a waiting image cancels its retry', async t => {
 const f = await fixture(t);
 await f.reject(0);
 await f.unmount();
 assert.deepEqual(f.pending(), []);
 await f.act(async () => f.w.fixture.reachable());
 assert.equal(f.requests.length, 1);
});
