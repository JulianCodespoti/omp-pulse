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
const reads=[],closed=[];DaemonApi.prototype.readFile=(...args)=>new Promise((resolve,reject)=>reads.push({args,resolve,reject}));
window.fixture={act,reads,closed,mount(){const r=createRoot(document.getElementById('root'));const render=(open=true,path='src/a.txt',sessionPath='/synthetic')=>r.render(h(FileViewer,{open,path,sessionPath,onOpenChange:v=>closed.push(v)}));render();return{render,unmount:()=>r.unmount()}}};
`);
async function fixture(t){const dom=createDomFixture(code),w=dom.window,{act,reads,closed}=w.fixture,requests=[],timers=new Map();let next=9000,r,unmounted=false;
 w.fetch=(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,method:options?.method??'GET',resolve,reject}));
 const timeout=w.setTimeout.bind(w),clear=w.clearTimeout.bind(w);w.setTimeout=(cb,ms,...args)=>{if(ms===2200){const id=next++;timers.set(id,cb);return id}return timeout(cb,ms,...args)};w.clearTimeout=id=>{timers.delete(id);clear(id)};
 await act(async()=>{r=w.fixture.mount()});const unmount=async()=>{if(!unmounted){unmounted=true;await act(async()=>r.unmount())}};
 t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const el=id=>w.document.querySelector(`[data-testid="${id}"]`);
 const type=value=>act(async()=>{const input=el('file-editor');assert.ok(input,'editor');Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set.call(input,value);input.dispatchEvent(new w.Event('input',{bubbles:true}))});
 return{w,act,reads,closed,requests,timers,el,unmount,type,posts:()=>requests.filter(r=>r.method==='POST'),render:(...args)=>act(async()=>r.render(...args)),read:(i,content='baseline',extra={})=>act(async()=>reads[i].resolve({content,size:content.length,binary:false,truncated:false,...extra})),edit:async value=>{await act(async()=>{if(el('file-edit'))el('file-edit').click();else assert.ok(el('file-editor'),'restored editor')});await type(value)},save:()=>act(async()=>el('file-save').click()),response:(i,body={ok:true,content:'baseline'},status=200)=>act(async()=>requests[i].resolve({ok:status>=200&&status<300,status,json:async()=>body})),escape:()=>act(async()=>el('file-editor').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))};
}
test('a late read cannot replace the newly selected file',async t=>{const f=await fixture(t);await f.render(true,'src/b.txt');await f.read(1,'B content');await f.read(0,'A content');assert.ok(f.w.document.body.textContent.includes('B content'));assert.equal(f.w.document.body.textContent.includes('A content'),false)});
test('an old read failure cannot end the newer loading state or show its error',async t=>{const f=await fixture(t);await f.render(true,'src/b.txt');await f.act(async()=>f.reads[0].reject(new Error('Old read failed')));assert.ok(f.w.document.body.textContent.includes('Loading…'));assert.equal(f.w.document.body.textContent.includes('Old read failed'),false);await f.read(1,'B content')});
test('same filename in another session rejects the old read',async t=>{const f=await fixture(t);await f.render(true,'src/a.txt','/other');await f.read(1,'Other session');await f.read(0,'Old session');assert.ok(f.w.document.body.textContent.includes('Other session'));assert.equal(f.w.document.body.textContent.includes('Old session'),false)});
test('repeated Save taps issue one preflight and one POST',async t=>{const f=await fixture(t);await f.read(0);await f.edit('submitted');await f.act(async()=>{f.el('file-save').click();f.el('file-save').click()});assert.equal(f.requests.length,1);await f.response(0);assert.equal(f.posts().length,1);await f.response(1,{ok:true})});
test('Dismiss during preflight prevents a later write',async t=>{const f=await fixture(t);await f.read(0);await f.edit('submitted');await f.save();await f.escape();await f.response(0);assert.equal(f.posts().length,0)});
test('switching file during preflight prevents a stale write',async t=>{const f=await fixture(t);await f.read(0);await f.edit('submitted');await f.save();await f.render(true,'src/b.txt');await f.read(1,'baseline');await f.response(0);assert.equal(f.posts().length,0)});
test('old save acknowledgement cannot overwrite another file preview',async t=>{const f=await fixture(t);await f.read(0);await f.edit('submitted A');await f.save();await f.response(0);await f.render(true,'src/b.txt');await f.read(1,'B content');await f.response(1,{ok:true});assert.ok(f.w.document.body.textContent.includes('B content'));assert.equal(f.w.document.body.textContent.includes('submitted A'),false)});
test('typing during Save preserves the newer draft and advances only its saved baseline',async t=>{const f=await fixture(t);await f.read(0);await f.edit('submitted');await f.save();await f.type('newer draft');await f.response(0);assert.equal(JSON.parse(f.posts()[0].options.body).content,'submitted');await f.response(1,{ok:true});assert.equal(f.el('file-editor')?.value,'newer draft');await f.save();await f.response(2,{ok:true,content:'submitted'});assert.equal(JSON.parse(f.posts()[1].options.body).content,'newer draft');await f.response(3,{ok:true})});
for(const body of [null,{ok:true},{ok:true,content:42}])test(`unverifiable preflight cannot authorize an empty-file save: ${JSON.stringify(body)}`,async t=>{const f=await fixture(t);await f.read(0,'');await f.edit('new text');await f.save();await f.response(0,body);assert.equal(f.posts().length,0);assert.equal(f.el('file-editor')?.value,'new text')});
test('a changed disk baseline retains the conflict guard',async t=>{const f=await fixture(t);await f.read(0);await f.edit('submitted');await f.save();await f.response(0,{ok:true,content:'agent change'});assert.equal(f.posts().length,0);assert.ok(f.w.document.body.textContent.includes('changed on disk'));assert.equal(f.el('file-editor').value,'submitted')});
test('a valid current save updates the preview and owns its Saved timer',async t=>{const f=await fixture(t);await f.read(0);await f.edit('submitted');await f.save();await f.response(0);await f.response(1,{ok:true});assert.equal(Boolean(f.el('file-editor')),false);assert.ok(f.w.document.body.textContent.includes('submitted'));assert.equal(f.timers.size,1);await f.render(true,'src/b.txt');assert.equal(f.timers.size,0)});
test('unmount during preflight cannot issue its later POST',async t=>{const f=await fixture(t);await f.read(0);await f.edit('submitted');await f.save();await f.unmount();await f.response(0);assert.equal(f.posts().length,0)});
test('Dismiss while preflight JSON is pending prevents POST',async t=>{const f=await fixture(t);await f.read(0);await f.edit('submitted');await f.save();let resolveBody;await f.act(async()=>f.requests[0].resolve({ok:true,status:200,json:()=>new Promise(r=>{resolveBody=r})}));await f.escape();await f.act(async()=>resolveBody({ok:true,content:'baseline'}));assert.equal(f.posts().length,0)});
test('an obsolete failed save cannot unlock a newer save',async t=>{const f=await fixture(t);await f.read(0);await f.edit('first');await f.save();await f.response(0);await f.escape();await f.edit('second');await f.save();await f.act(async()=>f.requests[1].reject(new Error('Old failure')));await f.save();assert.equal(f.requests.length,3);assert.equal(f.w.document.body.textContent.includes('Old failure'),false);await f.response(2);await f.response(3,{ok:true});assert.ok(f.w.document.body.textContent.includes('second'))});
test('current authentication failure retains draft and permits retry',async t=>{const f=await fixture(t);await f.read(0);await f.edit('submitted');await f.save();await f.response(0,{},401);assert.equal(f.el('file-editor').value,'submitted');assert.equal(f.posts().length,0);await f.save();await f.response(1);await f.response(2,{ok:true});assert.equal(Boolean(f.el('file-editor')),false)});
test('a verified empty file can be saved',async t=>{const f=await fixture(t);await f.read(0,'');await f.edit('new text');await f.save();await f.response(0,{ok:true,content:''});assert.equal(f.posts().length,1);await f.response(1,{ok:true});assert.ok(f.w.document.body.textContent.includes('new text'))});
for(const body of [null,{}, {ok:'true'}])test(`unverified save acknowledgement keeps draft and avoids Saved: ${JSON.stringify(body)}`,async t=>{const f=await fixture(t);await f.read(0);await f.edit('submitted');await f.save();await f.response(0);await f.response(1,body);assert.equal(f.el('file-editor')?.value,'submitted');assert.equal(f.timers.size,0);assert.ok(f.w.document.body.textContent.includes('may have been saved'));assert.equal(f.posts().length,1)});

const uncertainSave = 'Couldn’t confirm the save. The file may have been saved; check it before trying again.';
for (const failure of ['transport', 'body']) test(`unconfirmed POST ${failure} retains newer draft and original baseline without automatic retry`,async t=>{
 const f=await fixture(t);await f.read(0);await f.edit('submitted');await f.save();await f.response(0);await f.type('newer draft');
 await f.act(async()=>failure==='transport'?f.requests[1].reject(new TypeError('Failed to fetch')):f.requests[1].resolve({ok:true,status:200,json:async()=>{throw new Error('body lost')}}));
 assert.ok(f.w.document.body.textContent.includes(uncertainSave));assert.equal(f.el('file-editor').value,'newer draft');assert.equal(f.el('file-save').disabled,false);assert.equal(f.timers.size,0);assert.equal(f.w.document.body.textContent.includes('Saved'),false);assert.equal(f.posts().length,1);assert.equal(f.requests.length,2);
 await f.save();await f.response(2,{ok:true,content:'baseline'});assert.equal(f.posts().length,2,'original baseline authorizes only explicit retry');assert.equal(JSON.parse(f.posts()[1].options.body).content,'newer draft');await f.response(3,{ok:true});
});
for (const failure of ['transport','body','authentication','conflict']) test(`preflight ${failure} keeps its own error and never claims a possible save`,async t=>{
 const f=await fixture(t);await f.read(0);await f.edit('submitted');await f.save();
 if(failure==='transport')await f.act(async()=>f.requests[0].reject(new TypeError('Failed to fetch')));
 else if(failure==='body')await f.act(async()=>f.requests[0].resolve({ok:true,status:200,json:async()=>{throw new Error('body lost')}}));
 else await f.response(0,{ok:true,content:failure==='conflict'?'changed':'baseline'},failure==='authentication'?401:200);
 assert.equal(f.el('file-editor').value,'submitted');assert.equal(f.posts().length,0);assert.equal(f.timers.size,0);
});
for(const transition of ['dismiss/reedit','path','session','reopen','unmount'])for(const failure of ['transport','body'])test(`obsolete POST ${failure} after ${transition} cannot affect newer save`,async t=>{
 const f=await fixture(t);await f.read(0);await f.edit('old submitted');await f.save();await f.response(0);
 let rejectBody;
 if(failure==='body')await f.act(async()=>f.requests[1].resolve({ok:true,status:200,json:()=>new Promise((_,reject)=>{rejectBody=reject})}));
 if(transition==='unmount')await f.unmount();
 else {
  if(transition==='dismiss/reedit')await f.escape();
  else {if(transition==='reopen')await f.render(false);await f.render(true,transition==='path'?'src/b.txt':'src/a.txt',transition==='session'?'/other':'/synthetic');await f.read(1);}
  await f.edit('new submitted');await f.save();await f.response(2);await f.type('latest new draft');
 }
 await f.act(async()=>failure==='transport'?f.requests[1].reject(new TypeError('Failed to fetch')):rejectBody(new Error('body lost')));
 assert.equal(f.w.document.body.textContent.includes(uncertainSave),false);assert.equal(f.timers.size,0);
 if(transition==='unmount'){assert.equal(f.requests.length,2);return;}
 assert.equal(f.el('file-editor').value,'latest new draft');assert.equal(f.el('file-save').disabled,true);await f.save();assert.equal(f.requests.length,4,'stale finally cannot unlock newer pending POST');await f.response(3,{ok:true});assert.equal(f.el('file-editor').value,'latest new draft');assert.equal(f.el('file-save').disabled,false);assert.equal(f.timers.size,0);
});

for(const [status,body] of [[401,{}],[403,{}],[503,{}],[200,{ok:false,error:'Write refused'}]])test(`explicit POST refusal ${status} preserves the newer edit without claiming success`,async t=>{
 const f=await fixture(t);await f.read(0);await f.edit('submitted');await f.save();await f.response(0);await f.type('newer draft');await f.response(1,body,status);
 assert.equal(Boolean(f.w.document.querySelector('[role="alert"]')),true);assert.equal(f.el('file-editor').value,'newer draft');assert.equal(f.timers.size,0);assert.equal(f.w.document.body.textContent.includes('Saved'),false);assert.equal(f.requests.length,2);assert.equal(f.el('file-save').disabled,false);
});

test('server conflict after matching preflight retains exact draft and its original precondition across reopen', async t => {
 const f = await fixture(t);
 await f.read(0, 'baseline');
 await f.edit('phone edit');
 await f.save();
 await f.response(0, { ok: true, content: 'baseline' });
 assert.deepEqual(JSON.parse(f.posts()[0].options.body), {
  sessionPath: '/synthetic', path: 'src/a.txt', content: 'phone edit', expectedContent: 'baseline',
 });
 await f.type('phone edit\nnewer café 👋');
 await f.response(1, { ok: false, code: 'file_conflict', error: 'File changed on disk.' }, 409);
 assert.equal(f.el('file-editor').value, 'phone edit\nnewer café 👋');
 assert.equal(f.timers.size, 0);
 assert.equal(f.el('file-save').disabled, false);
 assert.ok(f.w.document.querySelector('button[aria-label="Discard draft and reload"]'));
 await f.type('phone edit\nnewer café 👋\nkeep typing');
 assert.ok(f.w.document.querySelector('[role="alert"]').textContent.includes('Your draft is kept'));
 await f.render(false);
 await f.render(true);
 await f.read(1, 'agent edit');
 assert.equal(f.el('file-editor').value, 'phone edit\nnewer café 👋\nkeep typing');
 assert.ok(f.w.document.querySelector('button[aria-label="Discard draft and reload"]'));
 await f.save();
 await f.response(2, { ok: true, content: 'agent edit' });
 assert.equal(f.posts().length, 1, 'reopen never silently rebases a conflicting draft');
 await f.act(async () => f.w.document.querySelector('button[aria-label="Discard draft and reload"]').click());
 await f.read(2, 'agent edit');
 assert.equal(f.el('file-editor'), null);
 assert.ok(f.w.document.body.textContent.includes('agent edit'));
 await f.edit('reviewed draft');
 await f.save();
 await f.response(3, { ok: true, content: 'agent edit' });
 assert.equal(JSON.parse(f.posts()[1].options.body).expectedContent, 'agent edit');
 await f.response(4, { ok: true });
});

test('server conflict acknowledged after dismissal cannot clear the retained file draft', async t => {
 const f = await fixture(t);
 await f.read(0, 'baseline'); await f.edit('phone draft'); await f.save(); await f.response(0);
 await f.render(false);
 await f.response(1, { ok: false, code: 'file_conflict', error: 'File changed on disk.' }, 409);
 await f.render(true); await f.read(1, 'agent edit');
 assert.equal(f.el('file-editor').value, 'phone draft');
 assert.ok(f.w.document.querySelector('[role="alert"]').textContent.includes('Your draft is kept'));
 assert.equal(f.timers.size, 0);
});
