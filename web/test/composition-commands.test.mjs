import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {PromptInputTextarea} from ${JSON.stringify(resolve(root,'web/src/components/ai-elements/prompt-input.tsx'))};
 import {SlashPalette} from ${JSON.stringify(resolve(root,'web/src/app/composer/SlashPalette.tsx'))};
 import {CommandInputSheet} from ${JSON.stringify(resolve(root,'web/src/app/commands/CommandInputSheet.tsx'))};
 import {setAppearance} from ${JSON.stringify(resolve(root,'web/src/platform/appearance.ts'))};
 const calls={submit:[],external:[],pick:[],close:[]};
 window.fixture={act,calls,setAppearance,mount:kind=>{const r=createRoot(document.getElementById('root'));
 r.render(kind==='prompt'?h('form',{onSubmit:e=>{e.preventDefault();calls.submit.push(new FormData(e.currentTarget).get('message'))}},h(PromptInputTextarea,{defaultValue:'draft',onKeyDown:e=>calls.external.push(e.key)}),h('button',{type:'submit'},'Send')):
 kind==='slash'||kind==='bare'?h(SlashPalette,{text:kind==='bare'?'/':'/a',commands:[{name:'alpha',description:'First',source:'builtin'},{name:'beta',description:'Second',source:'builtin'}],onPick:n=>calls.pick.push(n),onClose:()=>calls.close.push(false)}):
 h(CommandInputSheet,{open:true,command:{name:'rename',hint:'<name>',shape:'input'},onSubmit:t=>calls.submit.push(t),onOpenChange:v=>calls.close.push(v)}));return r}};
`,[{name:'sheet-and-back-boundaries',resolveId:(id,importer)=>{
 if((importer?.endsWith('/SlashPalette.tsx')||importer?.endsWith('/CommandInputSheet.tsx'))&&id==='../ui/Sheet')return '\0sheet';
 if(importer?.endsWith('/SlashPalette.tsx')&&id==='../back-layer')return '\0back';return null;
},load:id=>id==='\0sheet'?`import {createElement as h} from ${JSON.stringify(require.resolve('react'))};export * from ${JSON.stringify(resolve(root,'web/src/app/ui/Sheet.tsx'))};export const BottomSheet=({children,footer})=>h('section',{},children,footer);`:id==='\0back'?'export const useBackLayer=()=>{};':null}]);
async function fixture(t,kind){
 const dom=createDomFixture(code),w=dom.window,{act,calls}=w.fixture;let mounted;
 await act(async()=>{mounted=w.fixture.mount(kind)});
 t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const input=()=>w.document.querySelector(kind==='command'?'input':'textarea');
 if(kind==='command')await act(async()=>{Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(input(),'New name');input().dispatchEvent(new w.Event('input',{bubbles:true}))});
 return {w,act,calls,input,key:async(key,options={})=>{const e=new w.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options});await act(async()=>(kind==='slash'||kind==='bare'?w:input()).dispatchEvent(e));return e}};
}
for(const kind of ['prompt','slash','command']){
 test(`${kind}: native composition Enter does not dispatch or prevent candidate confirmation`,async t=>{
  const f=await fixture(t,kind);const e=await f.key('Enter',{isComposing:true});assert.equal(f.calls.submit.length+f.calls.pick.length,0);assert.equal(e.defaultPrevented,false);assert.equal(f.calls.external.length,0);
 });
 test(`${kind}: legacy229 composition does not dispatch`,async t=>{
  const f=await fixture(t,kind);await f.key('Enter',{keyCode:229});assert.equal(f.calls.submit.length+f.calls.pick.length,0);assert.equal(f.calls.external.length,0);
 });
 test(`${kind}: held Enter does not repeat dispatch`,async t=>{
  const f=await fixture(t,kind);await f.key('Enter',{repeat:true});assert.equal(f.calls.submit.length+f.calls.pick.length,0);
 });
 test(`${kind}: ordinary Enter keeps its existing action`,async t=>{
  const f=await fixture(t,kind);await f.key('Enter');assert.equal(f.calls.submit.length+f.calls.pick.length,1);
 });
}
test('prompt: tracked composition suppresses external handlers even when native flag is absent',async t=>{
 const f=await fixture(t,'prompt');await f.act(async()=>f.input().dispatchEvent(new f.w.CompositionEvent('compositionstart',{bubbles:true,data:''})));
 await f.key('Enter');assert.equal(f.calls.external.length,0);assert.equal(f.calls.submit.length,0);
 await f.act(async()=>f.input().dispatchEvent(new f.w.CompositionEvent('compositionend',{bubbles:true,data:'text'})));
 await f.key('Enter');assert.equal(f.calls.submit.length,1);
});
test('slash: composing arrows and Escape do not move or dismiss commands',async t=>{
 const f=await fixture(t,'slash');await f.key('ArrowDown',{isComposing:true});await f.key('Escape',{isComposing:true});assert.equal(f.calls.close.length,0);
 await f.key('Enter');assert.equal(f.calls.pick[0],'alpha');
});
test('slash: repeated arrows still navigate normally',async t=>{
 const f=await fixture(t,'slash');await f.key('ArrowDown',{repeat:true});await f.key('Enter');assert.equal(f.calls.pick[0],'beta');
});
test('prompt and argument Shift+Enter remain non-submitting',async t=>{
 const f=await fixture(t,'prompt');await f.key('Enter',{shiftKey:true});assert.equal(f.calls.submit.length,0);
 const g=await fixture(t,'command');await g.key('Enter',{shiftKey:true});assert.equal(g.calls.submit.length,0);
});
test('slash: Shift+Enter is available for a newline rather than choosing a command',async t=>{
 const f=await fixture(t,'slash');const e=await f.key('Enter',{shiftKey:true});assert.equal(f.calls.pick.length,0);assert.equal(e.defaultPrevented,false);
});
test('bare slash: Enter runs nothing until a row is chosen with the arrows',async t=>{
 const f=await fixture(t,'bare');await f.key('Enter');assert.equal(f.calls.pick.length,0);
 await f.key('ArrowDown');await f.key('Enter');assert.deepEqual([...f.calls.pick],['alpha']);
});
test('prompt: Enter key "New line" leaves Enter as a newline and sends on Ctrl/Cmd+Enter',async t=>{
 const f=await fixture(t,'prompt');await f.act(async()=>f.w.fixture.setAppearance({enterKey:'newline'}));
 const e=await f.key('Enter');assert.equal(f.calls.submit.length,0);assert.equal(e.defaultPrevented,false);
 assert.equal(f.input().getAttribute('enterkeyhint'),'enter');
 await f.key('Enter',{ctrlKey:true});assert.equal(f.calls.submit.length,1);
 await f.key('Enter',{metaKey:true});assert.equal(f.calls.submit.length,2);
});
