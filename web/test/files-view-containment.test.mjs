import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));

const code = await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {FilesTab} from ${JSON.stringify(resolve(root,'web/src/app/tools/FilesTab.tsx'))};
import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
import {handleNativeBack} from ${JSON.stringify(resolve(root,'web/src/platform/native-back.ts'))};
DaemonApi.prototype.readFile=async()=>({ok:true,path:'readme.txt',content:'Synthetic file contents',size:23});
const App=()=>h('main',null,h('textarea',{id:'draft',defaultValue:'Keep my unsent draft'}),h(FilesTab,{active:true,focused:true,sessionPath:'/synthetic'}));
window.fixture={act,back:()=>handleNativeBack('commit'),mount(){const r=createRoot(document.getElementById('root'));r.render(h(App));return r}};
`);

async function fixture(t){
 const dom=createDomFixture(code),w=dom.window,f=w.fixture;
 w.Element.prototype.getAnimations=()=>[];
 const requests=[];w.fetch=async url=>{requests.push(String(url));assert.match(String(url),/^\/api\/files\?/);return{ok:true,status:200,json:async()=>({ok:true,cwd:'/project',entries:[{name:'readme.txt',path:'readme.txt',type:'file',size:23,mtime:0}]})}};
 let r;await f.act(async()=>{r=f.mount()});
 t.after(async()=>{try{await f.act(async()=>r.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const get=s=>w.document.querySelector(s);
 const settle=()=>f.act(async()=>{await new Promise(res=>w.setTimeout(res,350))});
 const draft=get('#draft');
 const preserved=()=>{assert.ok(get('#draft')===draft,'same draft node');assert.equal(draft.value,'Keep my unsent draft')};
 return{w,f,get,settle,preserved,requests};
}

test('tab renders inline without a dialog and reads the session folder once',async t=>{
 const f=await fixture(t);
 assert.ok(f.get('[data-testid="files-tab"]'));
 assert.equal(f.get('[role="dialog"]'),null);
 assert.match(f.w.document.body.textContent,/readme.txt/);
 assert.equal(f.requests.length,1);
 assert.equal(new URL(f.requests[0],'http://synthetic.invalid').searchParams.get('session'),'/synthetic');
 f.preserved();
});

// The viewer stays a sheet; back closes it before anything else.
test('nested file viewer closes back to the Files tab and returns focus to its row',async t=>{
 const f=await fixture(t);
 const file=[...f.w.document.querySelectorAll('button')].find(b=>b.textContent.includes('readme.txt'));assert.ok(file);
 file.focus();await f.f.act(async()=>file.click());await f.settle();
 assert.equal(f.w.document.querySelectorAll('[role="dialog"]').length,1);
 assert.match(f.w.document.body.textContent,/Synthetic file contents/);f.preserved();
 await f.f.act(async()=>f.f.back());await f.settle();
 assert.equal(f.get('[role="dialog"]'),null);assert.ok(f.get('[data-testid="files-tab"]'));
 assert.ok(f.w.document.activeElement===file,'viewer returns focus to its original file row');
 assert.equal(f.requests.length,1,'closing the viewer does not re-read the folder');
 f.preserved();
});
