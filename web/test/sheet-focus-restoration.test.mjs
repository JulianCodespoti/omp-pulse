import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h,act,useState} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {BottomSheet} from ${JSON.stringify(resolve(root,'web/src/app/ui/Sheet.tsx'))};
import {handleNativeBack} from ${JSON.stringify(resolve(root,'web/src/platform/native-back.ts'))};
import {ScreenActivityContext} from ${JSON.stringify(resolve(root,'web/src/app/nav/screen-activity.ts'))};
import {useBackLayer} from ${JSON.stringify(resolve(root,'web/src/app/back-layer.ts'))};
let change,changeActive,show=true,rootNode;
const calls={sheet:0,recoveryBack:0};
function App(){const [open,setOpen]=useState(false);const [active,setActive]=useState(true);change=setOpen;changeActive=setActive;
 useBackLayer(!active,{base:true,onBack:()=>{calls.recoveryBack++;setActive(true)}});
 return h('main',null,
 h('button',{id:'opener',onClick:()=>setOpen(true)},'Open'),h('input',{id:'other'}),
 !active?h('input',{id:'recovery'}):null,
 show?h(ScreenActivityContext.Provider,{value:active},h(BottomSheet,{open,onOpenChange:value=>{calls.sheet++;setOpen(value)},title:'Fixture'},h('input',{id:'inside',defaultValue:'original editor'}))):null);}
window.fixture={act,calls,mount(){rootNode=createRoot(document.getElementById('root'));rootNode.render(h(App));return rootNode},
 close:()=>change(false),reopen:()=>change(true),navigate(){show=false;rootNode.render(h(App))},
 suspend:()=>changeActive(false),resume:()=>changeActive(true),
 back:()=>handleNativeBack('commit'),previewBack:()=>{handleNativeBack('start');handleNativeBack('progress',0.75)}};
`);
async function fixture(t){
 const dom=createDomFixture(code),w=dom.window,f=w.fixture;w.Element.prototype.getAnimations=()=>[];
 let r;await f.act(async()=>{r=f.mount()});
 t.after(async()=>{try{await f.act(async()=>r.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const get=s=>w.document.querySelector(s),act=async(fn,ms=40)=>{await f.act(async()=>{fn?.()});await f.act(async()=>{await new Promise(r=>w.setTimeout(r,ms))})};
 const opener=get('#opener');opener.focus();await act(()=>opener.click());assert.ok(get('[role="dialog"]').contains(w.document.activeElement));
 // The sheet itself takes focus on open, so no control wears a ring the moment it appears.
 assert.notEqual(w.document.activeElement,get('[data-testid="sheet-close"]'));
 let calls=0;const focus=opener.focus.bind(opener);opener.focus=(...args)=>{calls++;focus(...args)};
 return {w,f,get,act,opener,calls:()=>calls,resetCalls:()=>{calls=0},settle:()=>act(null,350)};
}
for(const method of ['close','Escape','back'])test('ordinary '+method+' restores connected opener',async t=>{
 const f=await fixture(t);
 await f.act(()=>method==='Escape'?f.w.document.activeElement.dispatchEvent(new f.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true})):method==='back'?f.f.back():f.get('[aria-label="Close"]').click());
 await f.settle();assert.equal(f.w.document.activeElement === f.opener, true);assert.equal(f.get('[role="dialog"]') === null, true);
});
test('pending close timer is cancelled on rapid reopen',async t=>{
 const f=await fixture(t);await f.act(()=>f.f.close());await f.act(()=>f.f.reopen());f.resetCalls();await f.settle();
 assert.equal(f.calls(),0);assert.ok(f.get('[role="dialog"]').contains(f.w.document.activeElement));
});
for(const removed of [false,true])test('unmount/session navigation cancels pending restoration'+(removed?' with removed opener':''),async t=>{
 const f=await fixture(t);await f.act(()=>f.f.close());await f.act(()=>f.f.navigate());if(removed)f.opener.remove();f.resetCalls();await f.settle();assert.equal(f.calls(),0);
});
test('removed opener is rechecked when timer expires',async t=>{
 const f=await fixture(t);await f.act(()=>f.f.close());f.opener.remove();f.resetCalls();await f.settle();assert.equal(f.calls(),0);
});
for(const blur of [false,true])test('deliberately focused control keeps ownership'+(blur?' after blur':''),async t=>{
 const f=await fixture(t);await f.act(()=>f.f.close());const other=f.get('#other');other.focus();if(blur)other.blur();f.resetCalls();await f.settle();
 assert.equal(f.calls(),0);assert.equal(f.w.document.activeElement === (blur?f.w.document.body:other), true);
});
test('successor sheet blocks restoration even without moving focus',async t=>{
 const f=await fixture(t);await f.act(()=>f.f.close());f.w.document.documentElement.dataset.sheetOpen='1';f.resetCalls();await f.settle();assert.equal(f.calls(),0);delete f.w.document.documentElement.dataset.sheetOpen;
});
test('history navigation cancels pending restoration',async t=>{
 const f=await fixture(t);await f.act(()=>f.f.close());f.w.dispatchEvent(new f.w.PopStateEvent('popstate'));f.resetCalls();await f.settle();assert.equal(f.calls(),0);
});
test('repeated close is harmless and predictive drag resets on reopen',async t=>{
 const f=await fixture(t);await f.act(()=>f.f.previewBack());await f.act(()=>f.f.back());await f.act(()=>f.f.close());await f.settle();assert.equal(f.w.document.activeElement === f.opener, true);
 await f.act(()=>f.f.reopen());assert.equal(f.get('[data-sheet-panel]').style.getPropertyValue('--sheet-from'),'0px');assert.ok(f.get('[role="dialog"]').contains(f.w.document.activeElement));
});

for (const event of ['focus', 'focusin']) test('new control blurs synchronously inside '+event, async t => {
 const f=await fixture(t);await f.act(()=>f.f.close());const other=f.get('#other');
 other.addEventListener(event,()=>other.blur()); other.focus();
 assert.equal(f.w.document.activeElement === f.w.document.body, true);f.resetCalls();await f.settle();
 assert.equal(f.calls(),0, 'a new focus owner must cancel old restoration even if it blurs in its handler');
});
test('focusin propagation stopped by newer control',async t=>{
 const f=await fixture(t);await f.act(()=>f.f.close());const other=f.get('#other');
 other.addEventListener('focusin',e=>e.stopPropagation());other.focus();other.blur();
 f.resetCalls();await f.settle();assert.equal(f.calls(),0);
});

test('recovery suspension retains portal DOM, scroll and uncontrolled editor selection past exit',async t=>{
 const f=await fixture(t);
 const panel=f.get('[data-sheet-panel]'),input=f.get('#inside');
 const viewport=panel.querySelector('[data-slot="scroll-area-viewport"]');
 await f.act(()=>{
  input.value='unsaved uncontrolled draft';input.focus();input.setSelectionRange(3,12);
  viewport.scrollTop=184;viewport.dispatchEvent(new f.w.Event('scroll',{bubbles:true}));
 });
 await f.act(()=>f.f.suspend());
 const portal=panel.closest('[data-slot="dialog-portal"]');
 assert.equal(portal.hidden,true);assert.equal(portal.hasAttribute('inert'),true);
 assert.equal(f.w.document.documentElement.dataset.sheetOpen,undefined);
 await f.act(()=>f.get('#recovery').focus());
 await f.settle();
 assert.equal(input.isConnected,true);
 assert.equal(f.get('#inside')===input,true);
 assert.equal(viewport.scrollTop,184);
 assert.equal(input.value,'unsaved uncontrolled draft');
 assert.equal(input.selectionStart,3);assert.equal(input.selectionEnd,12);
 assert.equal(f.w.document.activeElement===f.get('#recovery'),true);
 assert.equal(f.calls(),0);
 await f.act(()=>f.f.back());
 assert.equal(f.f.calls.recoveryBack,1);assert.equal(f.f.calls.sheet,0);
 assert.equal(portal.hidden,false);assert.equal(portal.hasAttribute('inert'),false);
 assert.equal(f.get('#inside')===input,true);
 assert.equal(f.get('[data-slot="scroll-area-viewport"]')===viewport,true);
 assert.equal(viewport.scrollTop,184);assert.equal(input.value,'unsaved uncontrolled draft');
 assert.equal(f.w.document.activeElement===input,true);
 assert.equal(input.selectionStart,3);assert.equal(input.selectionEnd,12);
 await f.act(()=>f.f.back());await f.settle();
 assert.equal(f.f.calls.sheet,1);
 assert.equal(f.get('#inside')===null,true,'ordinary close still releases portal contents');
});

test('a rapid recovery return and departure never lets queued sheet focus steal the recovery control',async t=>{
 const f=await fixture(t);
 await f.act(()=>f.get('#inside').focus());
 await f.act(()=>f.f.suspend());
 await f.act(()=>f.f.resume(),0);
 await f.act(()=>{f.f.suspend()},0);
 await f.act(()=>f.get('#recovery').focus());
 await f.settle();
 assert.equal(f.w.document.activeElement===f.get('#recovery'),true);
 assert.equal(f.get('[data-slot="dialog-portal"]').hidden,true);
 assert.equal(f.f.calls.sheet,0);
});
