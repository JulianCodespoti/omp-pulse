import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
 import {createElement as h,act,useState} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {SearchField} from ${JSON.stringify(resolve(root,'web/src/app/ui/SearchField.tsx'))};
 const calls={changes:[],keys:[],submit:0};
 function Field({initial,index}){const [value,setValue]=useState(initial);return h(SearchField,{value,onChange:v=>{calls.changes.push([index,v]);setValue(v)},
 placeholder:'Search commands',testId:'search-'+index,autoFocus:index===0,className:'fixture-style',onKeyDown:e=>calls.keys.push(e.key)})}
 window.fixture={act,calls,mount:values=>{const r=createRoot(document.getElementById('root'));r.render(h('form',{onSubmit:e=>{e.preventDefault();calls.submit++}},...values.map((initial,index)=>h(Field,{initial,index,key:index}))));return r}};
`);
async function fixture(t,values=['']){
 const dom=createDomFixture(code),w=dom.window,{act,calls}=w.fixture;let mounted;
 await act(async()=>{mounted=w.fixture.mount(values)});
 t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 return {w,act,calls,input:(i=0)=>w.document.querySelector(`[data-testid="search-${i}"]`),clears:()=>Array.from(w.document.querySelectorAll('button[aria-label="Clear search"]')),
 type:(value,i=0)=>act(async()=>{const input=w.document.querySelector(`[data-testid="search-${i}"]`);Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new w.Event('input',{bubbles:true}))})};
}
test('empty field has no dead clear control and preserves input identity',async t=>{
 const f=await fixture(t);assert.equal(f.clears().length,0);assert.equal(f.input().type,'search');assert.equal(f.input().getAttribute('aria-label'),'Search commands');assert.equal(f.input().placeholder,'Search commands');
});
test('populated field clears through one callback and restores input focus',async t=>{
 const f=await fixture(t,['compact']);f.clears()[0].focus();await f.act(async()=>f.clears()[0].click());
 assert.equal(f.input().value,'');assert.equal(f.w.document.activeElement === f.input(), true);assert.equal(f.clears().length,0);
 assert.deepEqual(Array.from(f.calls.changes,entry=>Array.from(entry)),[[0,'']]);
});
test('whitespace is clearable even when the caller treats it as an empty filter',async t=>{
 const f=await fixture(t,['   ']);assert.equal(f.clears().length,1);await f.act(async()=>f.clears()[0].click());assert.equal(f.input().value,'');
});
test('typing after clear shows the control again without submitting the form',async t=>{
 const f=await fixture(t,['old']);await f.act(async()=>f.clears()[0].click());await f.type('new');assert.equal(f.clears().length,1);assert.equal(f.input().value,'new');
 assert.equal(f.clears()[0].type,'button');assert.equal(f.calls.submit,0);
});
test('two searches retain independent controlled values',async t=>{
 const f=await fixture(t,['alpha','beta']);await f.act(async()=>f.clears()[1].click());assert.equal(f.input().value,'alpha');assert.equal(f.input(1).value,'');assert.equal(f.w.document.activeElement === f.input(1), true);
});
test('clear is outside the input label and has a 44px target',async t=>{
 const f=await fixture(t,['query']);const clear=f.clears()[0];assert.equal(clear.closest('label') === null, true);assert.ok(clear.classList.contains('size-11'));assert.ok(f.input().closest('label'));
 assert.equal(clear.querySelector('svg').getAttribute('aria-hidden'),'true');
});
test('autofocus, caller styling and key handler remain intact',async t=>{
 const f=await fixture(t);assert.equal(f.w.document.activeElement === f.input(), true);assert.ok(f.w.document.querySelector('.fixture-style'));
 await f.act(async()=>f.input().dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.deepEqual(Array.from(f.calls.keys),['Escape']);
});
test('clearing a second time after new text sends the current empty value once',async t=>{
 const f=await fixture(t,['first']);await f.act(async()=>f.clears()[0].click());await f.type('second');await f.act(async()=>f.clears()[0].click());
 assert.equal(f.calls.changes.filter(entry=>entry[1]==='').length,2);assert.equal(f.calls.submit,0);
});
