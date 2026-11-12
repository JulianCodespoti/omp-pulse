import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from '../node_modules/rolldown/dist/index.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const modules = ['domain/message-provenance', 'domain/messages', 'domain/stream-display', 'domain/stream-text'];
const source = modules.map(name => `export * from ${JSON.stringify(resolve(root, `web/src/${name}.ts`))};`).join('\n');
const build = await rolldown({input: 'display-fixture', platform: 'node', plugins: [{
 name: 'display-fixture', resolveId: id => id === 'display-fixture' ? '\0display-fixture' : null,
 load: id => id === '\0display-fixture' ? source : null,
}]});
let actual;
try {
 const generated = await build.generate({format: 'esm', codeSplitting: false});
 actual = await import(`data:text/javascript;base64,${Buffer.from(generated.output[0].code).toString('base64')}`);
} finally { await build.close() }
const {entryToUiMessage: normalize, getRawAssistantText: raw, getAssistantDisplayBoundaries: boundaries,
 streamDisplaySnapshot: snapshot, appendStreamDisplay: append, replaceStreamDisplay: replace,
 mergeStreamText: merge, withRawAssistantText: sourced, withoutRawAssistantText: unsourced} = actual;
const text = value => ({type: 'text', text: value});
const ui = content => normalize({type: 'message', id: 'm1', message: {role: 'assistant', responseId: 'r1', content}}, 0);
const seed = content => { const m=ui(content); return snapshot(raw(m),m.text,boundaries(m)) };
const p = 'The final answer should appear once.', fence = '```text\nOLD\n```';
const initial = () => seed([text(p),text(fence)]);
const visible = parts => parts.filter(p => p.kind==='text').map(p => p.text).join('');
const assertState = (s, expectedRaw, expectedDisplay, anchors = s.anchors) => {
 assert.equal(s.raw,expectedRaw);assert.equal(s.text,expectedDisplay);assert.deepEqual(s.anchors,anchors);
 const displayed = s.active.reduce((value,offset,i)=>value.slice(0,offset+i)+'\n'+value.slice(offset+i),s.raw);
 assert.equal(s.text,displayed,'active boundaries account for every display-only unit');
};

test('exact k=44 preserves the body newline while raw retains server coordinates', () => {
 const s=initial(),k=s.raw.indexOf('OLD');assert.equal(k,44);
 const next=replace(s,k,'NEW\n```');
 assertState(next,p+'```text\nNEW\n```',p+'\n```text\nNEW\n```',[p.length]);
 assert.notEqual(s.text.slice(0,k)+'NEW\n```',next.text,'baseline display slicing loses the body newline');
 assert.equal(s.raw,p+fence,'input snapshot is immutable');
});

test('append and no-op keep beyond raw length preserve established repairs', () => {
 let s=append(initial(),'\ncontinued');
 assertState(s,p+fence+'\ncontinued',p+'\n'+fence+'\ncontinued');
 s=replace(s,s.raw.length+100,'!');
 assertState(s,p+fence+'\ncontinued!',p+'\n'+fence+'\ncontinued!');
});

for (const [label,k,suffix,expected,anchors] of [
 ['before anchor',p.length-1,'!```new',p.slice(0,-1)+'!```new',[]],
 ['at anchor with fence',p.length,'~~~text\nNEW\n~~~',p+'\n~~~text\nNEW\n~~~',[p.length]],
 ['inside opener',p.length+2,'`js\nNEW\n```',p+'\n```js\nNEW\n```',[p.length]],
 ['inside body',p.length+10,'NEW\n```',p+'\n```text\nOLNEW\n```',[p.length]],
 ['at zero',0,'```new','```new',[]],
 ['negative cut',-4,'plain','plain',[]],
]) test(`raw replacement ${label}`, () => {
 const next=replace(initial(),k,suffix);
 assertState(next,initial().raw.slice(0,Math.max(0,k))+suffix,expected,anchors);
});

test('known anchor survives ordinary replacement but is inactive until a later fence replacement', () => {
 let s=replace(initial(),p.length,'ordinary');
 assertState(s,p+'ordinary',p+'ordinary',[p.length]);assert.deepEqual(s.active,[]);
 s=append(s,'```later');assert.equal(s.text,p+'ordinary```later');assert.deepEqual(s.active,[]);
 s=replace(s,p.length,'```again');assertState(s,p+'```again',p+'\n```again',[p.length]);
});

test('known opener becomes incomplete, then reactivates only when append completes it', () => {
 for (const marker of ['`','~']) {
  let s=replace(initial(),p.length,marker);
  assertState(s,p+marker,p+marker);assert.equal(s.pending.length,1);
  s=append(s,marker);assertState(s,p+marker.repeat(2),p+marker.repeat(2));
  s=append(s,marker+'text\nNEW');assertState(s,p+marker.repeat(3)+'text\nNEW',p+'\n'+marker.repeat(3)+'text\nNEW');
  assert.equal(s.pending.length,0);
 }
});

test('empty at-cut suffix remains pending while leading LF makes its anchor inactive', () => {
 let s=replace(initial(),p.length,'');assertState(s,p,p,[p.length]);assert.equal(s.pending.length,1);
 s=append(s,'\n```text');assertState(s,p+'\n```text',p+'\n```text');assert.equal(s.pending.length,0);
 s=replace(s,p.length,'```text');assertState(s,p+'```text',p+'\n```text');
});

for (const [prefix,active] of [['\n',false],[' \n',true],['\r',true],['\t',true],['\u00a0',true],['\ufeff',true],['\u2003',true],['\u200b',false]]) {
 test(`existing trimStart predicate stays exact for ${JSON.stringify(prefix)}`, () => {
  const next=replace(initial(),p.length,prefix+'```text');
  assertState(next,p+prefix+'```text',p+(active?'\n':'')+prefix+'```text');
  assert.equal(next.active.length,active?1:0);
 });
}

test('multiple anchors translate cuts and discard only candidates after the raw prefix', () => {
 const chunks=['A','```x\none\n```','B','~~~x\ntwo\n~~~','C','```x\nthree\n```'];
 const s=seed(chunks.map(text)),a=1,b=chunks.slice(0,3).join('').length,c=chunks.slice(0,5).join('').length;
 assert.deepEqual(s.anchors,[a,b,c]);
 const body=s.raw.indexOf('two');let next=replace(s,body,'TWO\n~~~');
 assertState(next,s.raw.slice(0,body)+'TWO\n~~~','A\n'+chunks[1]+'B\n~~~x\nTWO\n~~~',[a,b]);
 next=replace(s,b,'~');assert.deepEqual(next.active,[a]);assert.deepEqual(next.anchors,[a,b]);
 next=append(next,'~~x');assertState(next,s.raw.slice(0,b)+'~~~x','A\n'+chunks[1]+'B\n~~~x',[a,b]);
});

test('UTF-16 emoji surrogate and combining-character cuts preserve exact raw units', () => {
 const prefix='🧪👩🏽‍💻 e\u0301 ',body='```text\nOLD🦄e\u0301\n```';
 const s=seed([text(prefix),text(body)]),start=s.raw.indexOf('OLD');
 let next=replace(s,start,'NEW🚀discard');
 next=replace(next,start+'NEW🚀'.length,' e\u0301');
 // A valid UTF-16 cut may fall between a base letter and its combining mark.
 next=replace(next,next.raw.length-1,'\u0308\n```');
 assertState(next,prefix+'```text\nNEW🚀 e\u0308\n```',prefix+'\n```text\nNEW🚀 e\u0308\n```');
 // A replacement retaining a high surrogate and supplying its low half also
 // follows code units rather than guessed code-point/grapheme coordinates.
 const emojiAt=next.raw.indexOf('🚀');
 next=replace(next,emojiAt+1,'\ude80\n```');
 assertState(next,prefix+'```text\nNEW🚀\n```',prefix+'\n```text\nNEW🚀\n```');
});

test('normalizer records insertion sites exposed by every kind of omitted part', () => {
 for (const omitted of [null,{}, {type:'unknown'},{type:'thinking',thinking:''},{type:'toolCall'}, {type:'text',text:7},text('')]) {
  const row=ui([text(p),omitted,text(fence)]);
  assert.deepEqual(boundaries(row),[p.length]);assert.equal(raw(row),p+fence);
  assert.equal(row.text,p+'\n'+fence);assert.equal(row.parts.length,1);
 }
});

test('retained parts do not add aggregate separators or prevent later real insertion sites', () => {
 const nonText=[{type:'thinking',thinking:'Inspecting'},{type:'toolCall',id:'t1',name:'bash'}, {type:'image',data:'AA==',mimeType:'image/png'}];
 const row=ui([text('Leading'),...nonText,text('Following'),{type:'unknown'},text(fence)]);
 const offset='LeadingFollowing'.length;
 assert.equal(raw(row),'LeadingFollowing'+fence);assert.deepEqual(boundaries(row),[offset]);
 assert.equal(row.text,'LeadingFollowing\n'+fence);
 const state=snapshot(raw(row),row.text,boundaries(row));
 let next=replace(state,state.raw.indexOf('OLD'),'NEW\n```');
 let parts=merge(row.parts,next.text);
 assert.equal(visible(parts),next.text);assert.deepEqual(parts.map(p=>p.kind),['text','thinking','tool','image','text']);
 assert.equal(parts[0],row.parts[0]);for(let i=1;i<=3;i++)assert.equal(parts[i],row.parts[i]);
 next=replace(next,3,' revised');parts=merge(parts,next.text);
 assert.equal(parts[0].text,'Lea revised');assert.equal(parts.at(-1).text,'');
 for(let i=1;i<=3;i++)assert.equal(parts[i],row.parts[i]);assert.equal(visible(parts),next.text);
 for (const part of nonText) {
  const split=ui([text(p),part,text(fence)]);assert.deepEqual(boundaries(split),[]);assert.equal(split.text,p+fence);
 }
});

test('new md-only fences never invent anchors, including after all known anchors are discarded', () => {
 let s=seed([text(p)]);s=append(s,fence);assertState(s,p+fence,p+fence,[]);
 s=replace(initial(),2,'New'+fence);assertState(s,p.slice(0,2)+'New'+fence,p.slice(0,2)+'New'+fence,[]);
 s=append(s,'More~~~fence');assert.deepEqual(s.anchors,[]);assert.equal(s.text,s.raw);
});

test('full snapshots replace all boundary provenance with the same raw aggregate', () => {
 const aggregate='A```oneB~~~two';
 const first=seed([text('A'),text('```oneB'),text('~~~two')]);assert.deepEqual(first.anchors,[1,8]);
 const removed=seed([text(aggregate)]);assert.equal(removed.raw,first.raw);assert.deepEqual(removed.anchors,[]);
 const moved=seed([text('A```oneB'),text('~~~two')]);assert.equal(moved.raw,first.raw);assert.deepEqual(moved.anchors,[8]);
 assert.equal(append(removed,'!').text,aggregate+'!');assert.equal(append(moved,'!').text,'A```oneB\n~~~two!');
});

test('boundary metadata shares exact source identity guards and nonserialized cache stripping', () => {
 const row=ui([text(p),text(fence)]);
 for (const changed of [unsourced(row),JSON.parse(JSON.stringify(row)),structuredClone(row),
  {...row,id:'other'}, {...row,responseKey:'other'}, {...row,text:'other'}, {...row,parts:row.parts.map(p=>({...p}))}]) {
  assert.equal(raw(changed),null);assert.deepEqual(boundaries(changed),[]);
 }
 const s=replace(initial(),p.length,'`'),parts=merge(row.parts,s.text);
 const next=sourced({...row,text:s.text,parts},s.raw,s.anchors);
 assert.equal(raw(next),p+'`');assert.deepEqual(boundaries(next),[p.length]);
 assert.equal(Object.getOwnPropertySymbols(next).length,1);
 const tool={kind:'tool',callId:'t',name:'bash',args:{},state:'running'};
 assert.deepEqual(boundaries({...next,parts:[...next.parts,tool]}),[p.length]);
 assert.deepEqual(boundaries(unsourced(next)),[]);
});

test('ordinary long append path shares anchor arrays and performs no opener/prefix scan', t => {
 const long='x'.repeat(81920);let s=seed([text(long),text(fence)]);
 const anchors=s.anchors,active=s.active,pending=s.pending;
 const count=2048,chunk=' token'.repeat(10);let scans=0;
 const trim=String.prototype.trimStart;
 String.prototype.trimStart=function(){scans++;return trim.call(this)};
 try {for(let i=0;i<count;i++)s=append(s,chunk)} finally {String.prototype.trimStart=trim}
 assert.equal(scans,0);assert.equal(s.anchors,anchors);assert.equal(s.active,active);assert.equal(s.pending,pending);
 assert.equal(s.text,long+'\n'+fence+chunk.repeat(count));
 const initialRaw=long.length+fence.length,appendedUnits=count*chunk.length;
 t.diagnostic(JSON.stringify({workload:{initialRaw,appendChunks:count,chunkUtf16:chunk.length,appendedUnits},
  baseline:'pre-fix ordinary append concatenates raw/display; no normalization scan',candidate:{openerCharacterChecks:scans,anchorArrayCopies:0,fullResponseNormalizations:0},
  rejectedFullRescanAlternativeUtf16:count*initialRaw+chunk.length*count*(count+1)/2,
  limits:'Algorithmic work comparison, not browser/CPU/allocator timings'}));
});

test('pending whitespace opener consumes new chunks only and stores at most two markers', t => {
 let s=replace(initial(),p.length,'');const count=1024,chunk=' '.repeat(64);let scans=0;
 const trim=String.prototype.trimStart;
 String.prototype.trimStart=function(){scans++;return trim.call(this)};
 try {for(let i=0;i<count;i++)s=append(s,chunk)} finally {String.prototype.trimStart=trim}
 assert.equal(scans,count*chunk.length);assert.equal(s.pending.length,1);assert.equal(s.pending[0].opener,'');
 for(const char of '``') {s=append(s,char);assert.ok(s.pending[0].opener.length<=2)}
 s=append(s,'`text');assert.equal(s.pending.length,0);assert.equal(s.text,p+'\n'+chunk.repeat(count)+'```text');
 t.diagnostic(JSON.stringify({pendingAppendUtf16:count*chunk.length,openerCharacterChecks:scans,previousWhitespaceRescanned:0}));
});
