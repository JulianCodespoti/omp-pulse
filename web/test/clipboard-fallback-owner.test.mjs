import test from 'node:test';
import assert from 'node:assert/strict';
import {copyText,ClipboardAttempt} from '../src/platform/clipboard.ts';
function transport(t){
 const pending=[],legacy=[];let value='';
 const methods={
  writeText:text=>new Promise((resolve,reject)=>pending.push({
   succeed(){value=text;resolve()},fail(){reject(new Error('Synthetic denial'))}
  })),
  legacyCopy:text=>{legacy.push(text);value=text;return true}
 };
 if(t){
  const nav=Object.getOwnPropertyDescriptor(globalThis,'navigator'),doc=Object.getOwnPropertyDescriptor(globalThis,'document');
  t.after(()=>{if(nav)Object.defineProperty(globalThis,'navigator',nav);else delete globalThis.navigator;if(doc)Object.defineProperty(globalThis,'document',doc);else delete globalThis.document});
  let area;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:methods.writeText}}});
  Object.defineProperty(globalThis,'document',{configurable:true,value:{activeElement:null,createElement(){return area={style:{},select(){},remove(){}}},body:{appendChild(){}},execCommand(){return methods.legacyCopy(area.value)}}});
 }
 return {pending,legacy,methods,value:()=>value};
}
test('cancelled modern failure cannot start a legacy write',async context=>{
 const t=transport(context),attempt=new ClipboardAttempt();
 const old=attempt.run('old');attempt.cancel();t.pending[0].fail();
 assert.equal(await old,null);assert.deepEqual(t.legacy,[]);
});
test('obsolete fallback cannot overwrite a newer acknowledged copy',async context=>{
 const t=transport(context),attempt=new ClipboardAttempt();
 const old=attempt.run('old');attempt.cancel();const newer=attempt.run('new');
 t.pending[1].succeed();assert.equal(await newer,true);assert.equal(t.value(),'new');
 t.pending[0].fail();assert.equal(await old,null);assert.equal(t.value(),'new');assert.deepEqual(t.legacy,[]);
});
test('current fallback still copies exact bytes and reports success',async context=>{
 const t=transport(context),attempt=new ClipboardAttempt();
 const copy=attempt.run(' exact 🌿 path ');t.pending[0].fail();
 assert.equal(await copy,true);assert.equal(t.value(),' exact 🌿 path ');assert.deepEqual(t.legacy,[' exact 🌿 path ']);
});
test('old denied attempt cannot unlock a newer pending operation',async context=>{
 const t=transport(context),attempt=new ClipboardAttempt();
 const old=attempt.run('old');attempt.cancel();const newer=attempt.run('new');
 t.pending[0].fail();await old;assert.equal(attempt.busy,true);assert.deepEqual(t.legacy,[]);
 t.pending[1].fail();assert.equal(await newer,true);assert.equal(attempt.busy,false);assert.equal(t.value(),'new');
});
test('default ClipboardAttempt also forwards ownership to the real helper',async t=>{
 const navigator=Object.getOwnPropertyDescriptor(globalThis,'navigator'),document=Object.getOwnPropertyDescriptor(globalThis,'document');
 t.after(()=>{if(navigator)Object.defineProperty(globalThis,'navigator',navigator);else delete globalThis.navigator;if(document)Object.defineProperty(globalThis,'document',document);else delete globalThis.document});
 const tr=transport();let area;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:tr.methods.writeText}}});
 Object.defineProperty(globalThis,'document',{configurable:true,value:{
  activeElement:null,createElement(){return area={style:{},select(){},remove(){}}},
  body:{appendChild(){}},execCommand(){return tr.methods.legacyCopy(area.value)}
 }});
 const attempt=new ClipboardAttempt();const old=attempt.run('old');attempt.cancel();
 const newer=attempt.run('new');tr.pending[1].succeed();assert.equal(await newer,true);
 tr.pending[0].fail();assert.equal(await old,null);assert.equal(tr.value(),'new');assert.deepEqual(tr.legacy,[]);
});
test('an obsolete standalone request starts neither clipboard method',async context=>{
 const calls=[];assert.equal(await copyText('old',{writeText:async()=>{calls.push('native')},legacyCopy:()=>{calls.push('legacy');return true}},()=>false),false);
 assert.deepEqual(calls,[]);
});
test('cancellation suppresses native feedback but cannot undo an issued native write',async context=>{
 const tr=transport(context),attempt=new ClipboardAttempt();
 const old=attempt.run('old');attempt.cancel();const newer=attempt.run('new');
 tr.pending[1].succeed();assert.equal(await newer,true);tr.pending[0].succeed();
 assert.equal(await old,null);assert.equal(tr.value(),'old');assert.deepEqual(tr.legacy,[]);
});

test('explicit built-in copier retains its original constructor contract',async context=>{
 const tr=transport(context),attempt=new ClipboardAttempt(copyText);
 const copy=attempt.run('exact');tr.pending[0].fail();assert.equal(await copy,true);assert.equal(tr.value(),'exact');
});
