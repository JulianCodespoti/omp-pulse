import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,act,useState} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {Composer} from ${JSON.stringify(resolve(root,'web/src/app/composer/Composer.tsx'))};
import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
const searches=[],sends=[];let change;
DaemonApi.prototype.getPromptConfig=async()=>({magicKeywords:[]});
DaemonApi.prototype.warmTranscriber=async()=>{};
DaemonApi.prototype.listFiles=async()=>{if(window.rootError)throw Object.assign(new Error(window.rootError),{code:'project_folder_unavailable'});return [{name:'src',path:'src',type:'dir'}]};
DaemonApi.prototype.searchFiles=function(path,query,signal){return new Promise((resolve,reject)=>searches.push({path,query,signal,resolve,reject}))};
function App(){const [path,setPath]=useState('/synthetic/project-a');change=setPath;return h(Composer,{sessionPath:path,busy:false,onStop:()=>{},onSend:(...args)=>sends.push(args)});}
window.fixture={act,searches,sends,change:path=>change(path),mount(){const root=createRoot(document.getElementById('root'));root.render(h(App));return root}};
`);
const file=path=>({name:path.split('/').at(-1),path,type:'file'});
async function fixture(t){
 const dom=createDomFixture(code),w=dom.window,f=w.fixture;
 w.Element.prototype.getAnimations=()=>[];w.HTMLElement.prototype.scrollIntoView=()=>{};
 const act=async fn=>{await f.act(async()=>{await fn?.()});await f.act(async()=>{await new Promise(resolve=>w.setTimeout(resolve,25))})};
 let mounted;await act(()=>{mounted=f.mount()});
 t.after(async()=>{try{await f.act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const input=()=>w.document.querySelector('[data-testid="composer-input"]');
 return {w,f,act,input,rows:()=>[...w.document.querySelectorAll('[data-testid="mention-row"]')],
  type:async(text,caret=text.length)=>{await act(()=>{const node=input();node.focus();Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(node,text);node.setSelectionRange(caret,caret);node.dispatchEvent(new w.Event('input',{bubbles:true}));node.dispatchEvent(new w.Event('select',{bubbles:true}))});await act(()=>new Promise(resolve=>w.setTimeout(resolve,160)))},
  answer:(index,entries,truncated=false)=>act(()=>f.searches[index].resolve({entries,truncated})),
  key:key=>act(()=>input().dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}))),
 };
}

test('nested same-name matches expose directories and insert the selected full reference at the caret',async t=>{
 const f=await fixture(t);const text='read @Composer unfinished';await f.type(text,'read @Com'.length);
 await f.answer(0,[file('src/a/Composer.tsx'),file('src/b/Composer.tsx')]);
 assert.match(f.rows()[0].textContent,/src\/a/);assert.match(f.rows()[1].textContent,/src\/b/);
 const activeChoice=()=>f.w.document.getElementById(f.input().getAttribute('aria-activedescendant'));
 assert.equal(activeChoice()?.getAttribute('aria-label'),'src/a/Composer.tsx');
 assert.equal(activeChoice()?.getAttribute('aria-selected'),'true');
 assert.equal(f.w.document.getElementById(f.input().getAttribute('aria-controls'))?.getAttribute('role'),'listbox');
 await f.key('ArrowDown');
 assert.equal(activeChoice()?.getAttribute('aria-label'),'src/b/Composer.tsx');
 assert.equal(activeChoice()?.getAttribute('aria-selected'),'true');
 assert.equal(f.w.document.activeElement===f.input(),true);
 await f.key('Enter');
 assert.equal(f.input().hasAttribute('aria-activedescendant'),false);
 assert.equal(f.input().value,'read @src/b/Composer.tsx unfinished');
 assert.equal(f.input().selectionStart,'read @src/b/Composer.tsx '.length);
 assert.equal(f.f.sends.length,0);
});

test('touch insertion preserves Unicode and quotes a nested filename containing spaces',async t=>{
 const f=await fixture(t);await f.type('@rés');await f.answer(0,[file('docs/Résumé notes.md')]);
 await f.act(()=>{const row=f.rows()[0];row.dispatchEvent(new f.w.Event('pointerdown',{bubbles:true,cancelable:true}));row.click()});
 assert.equal(f.input().value,'@"docs/Résumé notes.md" ');assert.equal(f.w.document.activeElement===f.input(),true);
 assert.equal(f.f.sends.length,0);
});

test('superseded query and conversation results cannot replace current file choices',async t=>{
 const f=await fixture(t);await f.type('@old');await f.type('@new');
 assert.equal(f.f.searches[0].signal.aborted,true);
 await f.answer(0,[file('old/stale.ts')]);assert.equal(f.rows().length,0);
 await f.answer(1,[file('new/current.ts')]);assert.match(f.rows()[0].textContent,/current.ts/);
 await f.act(()=>f.f.change('/synthetic/project-b'));await f.type('@other');
 await f.answer(2,[file('other/visible.ts')]);assert.match(f.rows()[0].textContent,/visible.ts/);
 assert.doesNotMatch(f.rows()[0].textContent,/current.ts|stale.ts/);
 await f.type('@pending');await f.act(()=>f.f.change('/synthetic/project-c'));
 await f.answer(3,[file('other/late.ts')]);assert.equal(f.rows().length,0);
});

test('bare directory navigation leads to a project search and incomplete or failed searches remain distinguishable',async t=>{
 const f=await fixture(t);await f.type('@');await f.act(()=>f.rows()[0].click());
 await f.act(()=>new Promise(resolve=>f.w.setTimeout(resolve,160)));
 await f.answer(0,[file('src/deep/result.ts')],true);
 assert.match(f.w.document.querySelector('[role="status"]').textContent,/More matches/);
 await f.key('Tab');assert.equal(f.input().value,'@src/deep/result.ts ');
 await f.type('@broken');await f.act(()=>f.f.searches[1].reject(new Error('Synthetic failure')));
 assert.equal(f.rows().length,0);assert.equal(f.input().value,'@broken');assert.equal(f.f.sends.length,0);
 assert.equal(f.input().hasAttribute('aria-activedescendant'),false);
 await f.type('@absent');await f.answer(2,[]);
 assert.match(f.w.document.querySelector('[role="status"]').textContent,/No matching files/);
});

test('bare mentions report the unavailable project without suggesting home files and recover after reopening',async t=>{
 const f=await fixture(t);
 f.w.rootError='Project folder is unavailable: /missing/project';
 await f.type('@');
 assert.equal(f.rows().length,0);
 assert.equal(f.w.document.querySelector('[role="alert"]').textContent.includes('/missing/project'),true);
 assert.equal(f.input().value,'@');assert.equal(f.f.sends.length,0);
 await f.type('keep draft');
 f.w.rootError=null;
 await f.type('keep draft @');
 assert.equal(f.rows()[0].textContent.includes('src'),true);
 assert.equal(f.input().value,'keep draft @');
});
