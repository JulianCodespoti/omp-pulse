import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));

// Real Composer, native textarea, picker, shared Markdown renderer and metadata
// owner. Only read-only daemon transport is controlled; no renderer echoes.
const code=await bundleDomFixture(`
import {createElement as h,act,useState} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {Composer} from ${JSON.stringify(resolve(root,'web/src/app/composer/Composer.tsx'))};
import {MessageParts} from ${JSON.stringify(resolve(root,'web/src/app/parts/MessageParts.tsx'))};
import {DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
const reads=[],choices=[],sends=[],mutations=[];let update;
DaemonApi.prototype.getPromptConfig=function(path){return new Promise((resolve,reject)=>reads.push({path,resolve,reject}))};
DaemonApi.prototype.getModelMentionChoices=function(path){return new Promise((resolve,reject)=>choices.push({path,resolve,reject}))};
DaemonApi.prototype.warmTranscriber=async()=>{};
DaemonApi.prototype.listFiles=async()=>[{name:'README.md',path:'README.md',type:'file'}];
DaemonApi.prototype.searchFiles=async()=>({entries:[{name:'README.md',path:'README.md',type:'file'}],truncated:false});
DaemonApi.prototype.setModel=async(...args)=>{mutations.push(args);throw Error('Model selection forbidden')};
function App(){const [view,setView]=useState({path:'/session/a',sent:'ultrathink workflowz orchestrate jevify'});update=setView;
 const message={id:'sent',role:'user',text:view.sent,parts:[{kind:'text',text:view.sent}]};
 return h('main',{},h('section',{'data-sent':''},h(MessageParts,{message,sessionPath:view.path}),h(MessageParts,{message:{...message,id:'fallback',parts:[]},sessionPath:view.path})),
 h(Composer,{sessionPath:view.path,busy:false,commands:[{name:'help',description:'Help',source:'builtin'}],onStop:()=>{throw Error('Stop forbidden')},onSend:async(text,images,path,saved)=>{sends.push({text,path});setView(v=>({...v,sent:text}));await saved()}}))}
window.fixture={act,reads,choices,sends,mutations,change:patch=>update(v=>({...v,...patch})),mount(){const r=createRoot(document.getElementById('root'));r.render(h(App));return r}};
`,[{name:'test-import-meta',options(options){return {...options,transform:{...options.transform,define:{...options.transform?.define,'import.meta':'{}'}}}}}]);

const keyword=(id,word=id,hue=[0,330])=>({id,word,hue});
const allKeywords=[keyword('ultrathink'),keyword('workflow','workflowz',[30,150]),keyword('orchestrate','orchestrate',[150,280]),keyword('jevify','jevify',[300,420])];
const models=[{selector:'provider/alpha',name:'Alpha',provider:'provider'},{selector:'provider/beta',name:'Beta',provider:'provider'}];
async function fixture(t){
 const dom=createDomFixture(code),w=dom.window,f=w.fixture;
 w.localStorage.setItem('omp-remote-token','synthetic-prompt-token');
 w.Element.prototype.getAnimations=()=>[];w.HTMLElement.prototype.scrollIntoView=()=>{};
 let mounted;
 const act=async fn=>{await f.act(async()=>{await fn?.()});await f.act(async()=>{await new Promise(resolve=>w.setTimeout(resolve,25))})};
 await act(()=>{mounted=f.mount()});
 t.after(async()=>{try{await f.act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const get=s=>w.document.querySelector(s),all=s=>[...w.document.querySelectorAll(s)],input=()=>get('[data-testid="composer-input"]');
 return {w,f,act,get,all,input,
  type:(text,caret=text.length)=>act(()=>{const node=input();node.focus();Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(node,text);node.setSelectionRange(caret,caret);node.dispatchEvent(new w.Event('input',{bubbles:true}));node.dispatchEvent(new w.Event('select',{bubbles:true}))}),
  key:(key,extra={})=>act(()=>input().dispatchEvent(new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}))),
  read:(index,keywords)=>act(()=>f.reads[index].resolve({magicKeywords:keywords})),
  choose:(index,entries=models)=>act(()=>f.choices[index].resolve(entries)),
  focus:()=>act(()=>w.dispatchEvent(new w.Event('focus'))),
  change:patch=>act(()=>f.change(patch)),
  highlights:scope=>all(`${scope} [data-magic-keyword]`).map(node=>node.textContent),
 };
}

test('typing and both sent-message branches share one authoritative effective keyword configuration',async t=>{
 const f=await fixture(t);await f.type('ultrathink workflowz orchestrate jevify');
 assert.equal(f.f.reads.length,1,'composer and transcript share one read');
 assert.deepEqual(f.highlights('main'),[],'unknown configuration never assumes defaults');
 await f.read(0,allKeywords);
 assert.deepEqual(f.highlights('[data-testid="composer-keyword-overlay"]'),['ultrathink','workflowz','orchestrate','jevify']);
 assert.deepEqual(f.highlights('[data-sent]'),['ultrathink','workflowz','orchestrate','jevify','ultrathink','workflowz','orchestrate','jevify']);
 await f.focus();assert.deepEqual(f.highlights('main'),[],'revalidation withdraws stale authority');
 await f.read(1,[allKeywords[0]]);
 assert.deepEqual(f.highlights('[data-testid="composer-keyword-overlay"]'),['ultrathink']);
 assert.deepEqual(f.highlights('[data-sent]'),['ultrathink','ultrathink']);
 await f.focus();await f.read(2,[]);
 assert.deepEqual(f.highlights('main'),[],'globally disabled or tool-ineligible metadata removes every highlight');
 await f.focus();await f.read(3,allKeywords);
 assert.deepEqual(f.highlights('[data-testid="composer-keyword-overlay"]'),['ultrathink','workflowz','orchestrate','jevify'],'re-enabling effective keywords restores highlighting');
});

test('matching never changes editable or submitted bytes, selection, native scroll, or IME ownership',async t=>{
 const f=await fixture(t);await f.read(0,allKeywords);
 const text='😀 ultrathink. ULTRATHINK myultrathink /ultrathink ultrathink.ts ultrathink()\nworkflowz';
 await f.type(text,5);const node=f.input();
 assert.deepEqual(f.highlights('[data-testid="composer-keyword-overlay"]'),['ultrathink','workflowz']);
 assert.equal(node.value,text);assert.equal(node.selectionStart,5);
 await f.act(()=>{node.setSelectionRange(2,12,'backward');node.scrollTop=39;node.scrollLeft=7;node.dispatchEvent(new f.w.Event('scroll'))});
 assert.equal(node.selectionStart,2);assert.equal(node.selectionEnd,12);assert.equal(node.selectionDirection,'backward');
 assert.match(f.get('[data-testid="composer-keyword-overlay"]').style.transform,/-7px, -39px/);
 assert.equal(f.get('[data-testid="composer-keyword-overlay"]').parentElement.getAttribute('aria-hidden'),'true');
 await f.act(()=>node.dispatchEvent(new f.w.CompositionEvent('compositionstart',{bubbles:true})));
 await f.key('Enter');assert.equal(f.f.sends.length,0);
 await f.act(()=>node.dispatchEvent(new f.w.CompositionEvent('compositionend',{bubbles:true})));
 await f.act(()=>f.get('[data-testid="composer-send-btn"]').click());
 assert.equal(f.f.sends[0].text,text);assert.equal(f.f.sends[0].path,'/session/a');
 assert.deepEqual(f.highlights('[data-sent]'),['ultrathink','workflowz','ultrathink','workflowz']);
});

test('sent markdown retains links and code while only raw OMP prose matches highlight',async t=>{
 const f=await fixture(t);await f.read(0,allKeywords);
 await f.change({sent:'**ultrathink** and [workflowz](https://example.test) and `ultrathink` and /tmp/ultrathink.ts and <note>jevify</note>'});
 assert.deepEqual(f.all('[data-sent] a').map(node=>new URL(node.href).href),Array(2).fill(new URL('https://example.test').href));
 assert.equal(f.all('[data-sent] code [data-magic-keyword]').length,0);
 assert.equal(f.all('[data-sent] [data-testid="path-chip"] [data-magic-keyword]').length,0);
 assert.deepEqual(f.highlights('[data-sent]'),['ultrathink','workflowz','ultrathink','workflowz']);
});

test('session changes and overlapping config refreshes cannot publish stale highlights',async t=>{
 const f=await fixture(t);await f.type('ultrathink');await f.change({path:'/session/b'});
 assert.deepEqual(f.highlights('main'),[]);assert.equal(f.f.reads[1].path,'/session/b');
 await f.read(1,[allKeywords[1]]);await f.read(0,[allKeywords[0]]);
 assert.deepEqual(f.highlights('[data-sent]'),['workflowz','workflowz']);
 await f.focus();await f.focus();await f.read(3,[]);await f.read(2,allKeywords);
 assert.deepEqual(f.highlights('main'),[]);
 await f.focus();await f.act(()=>f.f.reads[4].reject(new Error('Unavailable')));
 assert.deepEqual(f.highlights('main'),[]);
});

test('model picker keyboard selection replaces a token at the caret, preserves suffix, and never sends or sets model',async t=>{
 const f=await fixture(t);await f.read(0,[]);
 const text='compare ^provider/unfinished then continue';await f.type(text,'compare ^'.length);await f.choose(0);
 assert.equal(f.get('[role="listbox"][aria-label="Models"]')!==null,true);
 await f.key('ArrowDown');assert.equal(f.input().getAttribute('aria-activedescendant'),'model-mention-list-1');
 await f.key('Enter');
 assert.equal(f.input().value,'compare ^provider/beta then continue');
 assert.equal(f.input().selectionStart,'compare ^provider/beta '.length);
 assert.equal(f.f.sends.length,0);assert.equal(f.f.mutations.length,0);
 assert.equal(f.get('[role="listbox"][aria-label="Models"]')===null,true);
});

test('model picker pointer choice and Tab insert exact selectors; Escape and IME keep control of typing',async t=>{
 const f=await fixture(t);await f.read(0,[]);await f.type('^');await f.choose(0);
 await f.key('ArrowDown',{isComposing:true});await f.key('Enter',{isComposing:true});assert.equal(f.input().value,'^');
 const option=f.get('#model-mention-list-0');let pointer;
 await f.act(()=>{pointer=new f.w.Event('pointerdown',{bubbles:true,cancelable:true});option.dispatchEvent(pointer);option.click()});
 assert.equal(pointer.defaultPrevented,true);assert.equal(f.input().value,'^provider/alpha ');
 assert.equal(f.w.document.activeElement===f.input(),true);
 await f.type('^');await f.choose(1);await f.key('Escape');assert.equal(f.get('[aria-label="Models"]')===null,true);assert.equal(f.input().value,'^');
 await f.type('plain');await f.type('^');await f.choose(2);await f.key('Tab');assert.equal(f.input().value,'^provider/alpha ');
 assert.equal(f.f.sends.length,0);assert.equal(f.f.mutations.length,0);
});

test('file and slash menus exclude model mentions, and old session choices never appear in a new composer',async t=>{
 const f=await fixture(t);await f.read(0,[]);await f.type('^');
 await f.type('@R');await f.act(()=>new Promise(resolve=>f.w.setTimeout(resolve,160)));assert.equal(f.get('[aria-label="Files"]')!==null,true);assert.equal(f.get('[aria-label="Models"]')===null,true);
 await f.choose(0);assert.equal(f.get('[aria-label="Models"]')===null,true);
 await f.type('/h');assert.equal(f.get('[aria-label="Models"]')===null,true);assert.equal(f.get('[aria-label="Files"]')===null,true);
 await f.type('^');await f.change({path:'/session/b'});await f.choose(1);assert.equal(f.get('[aria-label="Models"]')===null,true);
 assert.equal(f.f.sends.length,0);assert.equal(f.f.mutations.length,0);
});
