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
 let data={content:' exact preview\\n',binary:false,truncated:false,size:15};
 DaemonApi.prototype.readFile=async()=>data;
 let r;const render=(open=true,path='src/demo.txt')=>r.render(h(FileViewer,{open,path,sessionPath:'/synthetic/session.jsonl',onOpenChange(){}}));
 window.fixture={act,render,setData:x=>data=x,mount:()=>{r=createRoot(document.getElementById('root'));render();return r}};
`,[{name:'viewer-boundaries',resolveId:(id,importer)=>{
 if(importer?.endsWith('/FileViewer.tsx')&&id==='@/components/markdown')return '\0markdown';
 if(importer?.endsWith('/FileViewer.tsx')&&id==='@/app/ui/Sheet')return '\0sheet';
 if(importer?.endsWith('/CopyButton.tsx')&&id==='../Notices')return '\0notices';return null;
},load:id=>id==='\0markdown'?`import {createElement as h} from ${JSON.stringify(require.resolve('react'))};export const Markdown=({children})=>h('pre',{},children);`:
 id==='\0sheet'?`import {createElement as h} from ${JSON.stringify(require.resolve('react'))};export * from ${JSON.stringify(resolve(root,'web/src/app/ui/Sheet.tsx'))};export const BottomSheet=({open,headerActions,subHeader,children})=>open?h('section',{},headerActions,subHeader,children):null;`:
 id==='\0notices'?'export const showToast=(...args)=>window.notices.push(args);':null}]);
async function fixture(t,{data,mode='success',legacy=false}={}){
 const dom=createDomFixture(code),w=dom.window,{act,render}=w.fixture,writes=[],pending=[],legacyCalls=[];w.notices=[];
 Object.defineProperty(w.navigator,'clipboard',{configurable:true,value:{writeText:text=>{writes.push(text);if(mode==='fail')return Promise.reject(Error('synthetic denial'));if(mode==='pending')return new Promise((resolve,reject)=>pending.push({resolve,reject}));return Promise.resolve()}}});
 w.document.execCommand=command=>{legacyCalls.push(command);return legacy};
 if(data)w.fixture.setData(data);let mounted;await act(async()=>{mounted=w.fixture.mount()});
 t.after(async()=>{try{await act(async()=>mounted?.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 return {w,act,writes,pending,legacyCalls,render,copy:()=>w.document.querySelector('button[aria-label="Copy file content"],button[aria-label="Copy file preview"],button[aria-label="Copying"],button[aria-label="Copied"]'),
  unmount:()=>act(async()=>{mounted.unmount();mounted=null})};
}
test('successful copy acknowledges exact preview text',async t=>{
 const f=await fixture(t);await f.act(async()=>f.copy().click());assert.deepEqual(f.writes,[' exact preview\n']);assert.equal(f.copy().getAttribute('aria-label'),'Copied');assert.equal(f.w.notices.length,0);
});
test('failed clipboard methods never claim Copied and show actionable feedback',async t=>{
 const f=await fixture(t,{mode:'fail'});await f.act(async()=>f.copy().click());assert.equal(f.copy().getAttribute('aria-label'),'Copy file content');assert.equal(f.w.notices.length,1);assert.match(f.w.notices[0][0],/Couldn't copy/);
});
test('legacy fallback acknowledgement can still succeed',async t=>{
 const f=await fixture(t,{mode:'fail',legacy:true});await f.act(async()=>f.copy().click());assert.equal(f.copy().getAttribute('aria-label'),'Copied');assert.equal(f.w.notices.length,0);assert.deepEqual(f.legacyCalls,['copy']);
});
test('pending copy disables repeats and only issues one clipboard write',async t=>{
 const f=await fixture(t,{mode:'pending'});await f.act(async()=>{f.copy().click();f.copy().click()});assert.equal(f.writes.length,1);assert.equal(f.copy().disabled,true);assert.equal(f.copy().getAttribute('aria-busy'),'true');
 await f.act(async()=>f.pending[0].resolve());assert.equal(f.copy().getAttribute('aria-label'),'Copied');
});
test('closing suppresses stale failed-copy feedback',async t=>{
 const f=await fixture(t,{mode:'pending'});await f.act(async()=>f.copy().click());await f.act(async()=>f.render(false));await f.act(async()=>f.pending[0].reject(Error('late failure')));
 assert.equal(f.w.notices.length,0);assert.equal(f.copy() === null, true);
});
test('switching file identity suppresses the previous copy outcome',async t=>{
 const f=await fixture(t,{mode:'pending'});await f.act(async()=>f.copy().click());await f.act(async()=>f.render(true,'src/other.txt'));await f.act(async()=>f.pending[0].resolve());
 assert.equal(f.copy().getAttribute('aria-label'),'Copy file content');assert.equal(f.w.notices.length,0);
});
test('empty text files can be copied without a dead control',async t=>{
 const f=await fixture(t,{data:{content:'',binary:false,truncated:false,size:0}});assert.ok(f.copy());await f.act(async()=>f.copy().click());assert.deepEqual(f.writes,['']);
});
test('truncated data is explicitly labelled as preview copying',async t=>{
 const f=await fixture(t,{data:{content:'partial',binary:false,truncated:true,size:2000000}});assert.equal(f.copy().getAttribute('aria-label'),'Copy file preview');await f.act(async()=>f.copy().click());assert.deepEqual(f.writes,['partial']);
});
test('binary files have no misleading text copy action',async t=>{
 const f=await fixture(t,{data:{content:'',binary:true,truncated:false,size:10}});assert.equal(f.copy() === null, true);
});
test('a truncated file ends with a note and its own Download',async t=>{
 const f=await fixture(t,{data:{content:'partial',binary:false,truncated:true,size:2000000}});const text=f.w.document.body.textContent;
 assert.ok(text.includes('Showing the first 1 MB'));assert.equal([...f.w.document.querySelectorAll('button')].some(b=>b.textContent==='Download'),true);
});
test('a binary file offers Download in place of its body',async t=>{
 const f=await fixture(t,{data:{content:'',binary:true,truncated:false,size:10}});
 assert.ok(f.w.document.body.textContent.includes('Binary file, not shown.'));assert.equal([...f.w.document.querySelectorAll('button')].some(b=>b.textContent==='Download'),true);
});
test('editing replaces saved-preview copying with draft copying',async t=>{
 const f=await fixture(t);await f.act(async()=>f.w.document.querySelector('[data-testid="file-edit"]').click());assert.equal(f.copy() === null, true);assert.ok(f.w.document.querySelector('button[aria-label="Copy draft"]'));assert.ok(f.w.document.querySelector('[data-testid="file-editor"]'));
});
