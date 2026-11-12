import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {FileViewer} from ${JSON.stringify(resolve(root,'web/src/app/tools/FileViewer.tsx'))};
 import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
 let previewName;
 DaemonApi.prototype.readFile=async()=>({name:previewName,content:'fixture',binary:false,truncated:false,size:7});
 let r;const render=(open=true,path='src/demo.txt',sessionPath='/synthetic/session.jsonl')=>r.render(h(FileViewer,{open,path,sessionPath,onOpenChange(){}}));
 window.fixture={act,render,setPreviewName:name=>{previewName=name},mount:()=>{r=createRoot(document.getElementById('root'));render();return r}};
`,[{name:'viewer-boundaries',resolveId:(id,importer)=>{
 if(importer?.endsWith('/FileViewer.tsx')&&id==='@/app/ui/Sheet')return '\0sheet';
 if(importer?.endsWith('/FileViewer.tsx')&&id==='@/app/Notices')return '\0notices';return null;
},load:id=>id==='\0sheet'?`import {createElement as h} from ${JSON.stringify(require.resolve('react'))};export * from ${JSON.stringify(resolve(root,'web/src/app/ui/Sheet.tsx'))};export const BottomSheet=({open,headerActions,subHeader,children})=>open?h('section',{},headerActions,subHeader,children):null;`:
 id==='\0notices'?'export const showToast=(...args)=>window.notices.push(args);':null}]);
async function fixture(t,{clickFails=false,native=false,fileShare=false,share}={}){
 const dom=createDomFixture(code),w=dom.window,{act,render}=w.fixture,requests=[],urls=[],revoked=[],clicks=[],shares=[];w.notices=[];
 w.fetch=path=>new Promise((resolve,reject)=>requests.push({path,resolve,reject}));
 if(native)w.Capacitor={isNativePlatform:()=>true};
 w.navigator.canShare=()=>fileShare;w.navigator.share=share??(async data=>{shares.push(data)});
 w.URL.createObjectURL=()=>{const u='blob:synthetic-'+urls.length;urls.push(u);return u};w.URL.revokeObjectURL=u=>revoked.push(u);
 w.HTMLAnchorElement.prototype.click=function(){if(clickFails)throw Error('synthetic browser failure');clicks.push({href:this.href,download:this.download})};
 let mounted;await act(async()=>{mounted=w.fixture.mount()});
 t.after(async()=>{try{await act(async()=>mounted?.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 return {w,act,render,requests,urls,revoked,clicks,shares,button:()=>w.document.querySelector('button[aria-label="Download file"],button[aria-label="Downloading file"]'),
 shareButton:()=>w.document.querySelector('button[aria-label="Share file"],button[aria-label="Sharing file"]'),
 response:(i,ok=true,blob=async()=>({synthetic:true}))=>act(async()=>requests[i].resolve({ok,status:ok?200:503,blob})),
 unmount:()=>act(async()=>{mounted.unmount();mounted=null})};
}
test('failed download reports recovery and permits a retry',async t=>{
 const f=await fixture(t);await f.act(async()=>f.button().click());await f.response(0,false);assert.equal(f.w.notices.length,1);assert.match(f.w.notices[0][0],/Couldn't download/);assert.equal(f.button().disabled,false);
 await f.act(async()=>f.button().click());assert.equal(f.requests.length,2);await f.response(1);assert.equal(f.clicks.length,1);
});
test('busy download has one request and labelled status under repeated clicks',async t=>{
 const f=await fixture(t);await f.act(async()=>{f.button().click();f.button().click()});assert.equal(f.requests.length,1);assert.equal(f.button().getAttribute('aria-busy'),'true');assert.equal(f.button().getAttribute('aria-label'),'Downloading file');
 await f.response(0);assert.equal(f.button().getAttribute('aria-busy'),'false');
});
test('successful initiation preserves filename and endpoint and cleans resources without claiming saved',async t=>{
 const f=await fixture(t);await f.act(async()=>f.button().click());const u=new URL(f.requests[0].path,'http://synthetic.invalid');assert.equal(u.pathname,'/api/raw');assert.equal(u.searchParams.get('session'),'/synthetic/session.jsonl');assert.equal(u.searchParams.get('path'),'src/demo.txt');
 await f.response(0);assert.deepEqual(f.clicks,[{href:'blob:synthetic-0',download:'demo.txt'}]);assert.deepEqual(f.revoked,f.urls);assert.equal(f.w.document.querySelectorAll('a[download]').length,0);assert.equal(f.w.notices.length,0);
});
test('close before response prevents a stale save or failure toast',async t=>{
 const f=await fixture(t);await f.act(async()=>f.button().click());await f.act(async()=>f.render(false));await f.response(0,false);assert.equal(f.clicks.length,0);assert.equal(f.w.notices.length,0);
});
test('changing file cancels the old result without clearing the new busy state',async t=>{
 const f=await fixture(t);await f.act(async()=>f.button().click());await f.act(async()=>f.render(true,'src/new.txt'));await f.act(async()=>f.button().click());await f.response(0);
 assert.equal(f.clicks.length,0);assert.equal(f.button().disabled,true);await f.response(1);assert.equal(f.clicks[0].download,'new.txt');
});
test('changing session invalidates old file response even with the same filename',async t=>{
 const f=await fixture(t);await f.act(async()=>f.button().click());await f.act(async()=>f.render(true,'src/demo.txt','/synthetic/other.jsonl'));await f.response(0);assert.equal(f.clicks.length,0);assert.equal(f.urls.length,0);
});
test('unmount during fetch prevents allocating URLs or invoking save',async t=>{
 const f=await fixture(t);await f.act(async()=>f.button().click());await f.unmount();await f.response(0);assert.equal(f.urls.length,0);assert.equal(f.clicks.length,0);
});
test('close during deferred blob conversion also prevents stale save',async t=>{
 const f=await fixture(t);let release;const blob=new Promise(r=>release=r);await f.act(async()=>f.button().click());await f.response(0,true,()=>blob);await f.act(async()=>f.render(false));await f.act(async()=>release({synthetic:true}));assert.equal(f.urls.length,0);assert.equal(f.clicks.length,0);
});
test('browser initiation failure still removes anchor and revokes URL',async t=>{
 const f=await fixture(t,{clickFails:true});await f.act(async()=>f.button().click());await f.response(0);assert.deepEqual(f.revoked,f.urls);assert.equal(f.w.document.querySelectorAll('a[download]').length,0);assert.equal(f.w.notices.length,1);assert.equal(f.button().disabled,false);
});
test('native shell with file share shares a named File instead of downloading',async t=>{
 const f=await fixture(t,{native:true,fileShare:true});assert.equal(f.button(),null);await f.act(async()=>f.shareButton().click());
 assert.equal(new URL(f.requests[0].path,'http://synthetic.invalid').pathname,'/api/raw');
 await f.response(0,true,async()=>new f.w.Blob(['x'],{type:'text/plain'}));
 assert.equal(f.shares.length,1);const file=f.shares[0].files[0];assert.equal(file instanceof f.w.File,true);assert.equal(file.name,'demo.txt');assert.equal(file.type,'text/plain');
 assert.equal(f.clicks.length,0);assert.equal(f.urls.length,0);assert.equal(f.w.notices.length,0);
});
test('session-output selectors never become the shared filename',async t=>{
 const f=await fixture(t,{native:true,fileShare:true});
 await f.act(async()=>{f.w.fixture.setPreviewName('0.bash');f.render(true,'artifact://0:raw:2-3')});
 await f.act(async()=>f.shareButton().click());
 const request=new URL(f.requests[0].path,'http://synthetic.invalid');
 assert.equal(request.searchParams.get('path'),'artifact://0:raw:2-3');
 await f.response(0,true,async()=>new f.w.Blob(['selected output'],{type:'text/plain'}));
 assert.equal(f.shares[0].files[0].name,'0.bash');
 assert.equal(f.clicks.length,0);
});
test('native shell without file share offers no Download',async t=>{
 const f=await fixture(t,{native:true,fileShare:false});assert.equal(f.button(),null);assert.equal(f.shareButton(),null);
});
test('cancelled share is silent; other share failures toast',async t=>{
 const cancel=await fixture(t,{native:true,fileShare:true,share:async()=>{throw new cancel.w.DOMException('dismissed','AbortError')}});
 await cancel.act(async()=>cancel.shareButton().click());await cancel.response(0);assert.equal(cancel.w.notices.length,0);assert.equal(cancel.shareButton().disabled,false);
});
test('share failure other than cancel shows a toast',async t=>{
 const f=await fixture(t,{native:true,fileShare:true,share:async()=>{throw new Error('synthetic')}});
 await f.act(async()=>f.shareButton().click());await f.response(0);assert.equal(f.w.notices.length,1);assert.match(f.w.notices[0][0],/Couldn't share/);
});
