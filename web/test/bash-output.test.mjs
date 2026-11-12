import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { parseBashOutput, bashChunks, bashTailStart, BASH_PALETTE, MAX_BASH_RUNS } from '../src/app/parts/tools/bash-output.ts';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const esc = '\x1b';
const colors = output => output.runs.map(r => [output.text.slice(r.start, r.end), r.foreground]);

test('basic/bright palette, resets, coalescing and attributes preserve source text', () => {
  for (let i = 0; i < 16; i++) {
    assert.deepEqual(colors(parseBashOutput(`${esc}[${i < 8 ? 30 + i : 90 + i - 8}mcolor`)), [['color', i]]);
  }
  assert.deepEqual(colors(parseBashOutput(`a${esc}[1;32mb${esc}[32mc\n\t界${esc}[39md${esc}[31me${esc}[mf${esc}[34mg${esc}[0mh`)),
    [['a', null], ['bc\n\t界', 2], ['d', null], ['e', 1], ['f', null], ['g', 4], ['h', null]]);
  assert.deepEqual(colors(parseBashOutput(`${esc}[32;8;5;7;44;123mvisible`)), [['visible', 2]]);
});

test('extended colour operands never become reset, basic colour or attributes', () => {
  for (const code of ['38;2;0;31;32', '38;5;31', '38;05;31', '038:02::0:31:32', '38:2::0:31:32', '38:5:31']) {
    assert.deepEqual(colors(parseBashOutput(`${esc}[32ma${esc}[${code}mb${esc}[31mc`)), [['a', 2], ['b', null], ['c', 1]]);
    assert.deepEqual(colors(parseBashOutput(`${esc}[${code};34mblue`)), [['blue', 4]]);
  }
  for (const code of ['48;2;0;31;32', '48;5;0', '48;02;255;0;0', '58;2;31;32;33', '48:2::0:31:32']) {
    assert.deepEqual(colors(parseBashOutput(`${esc}[32;${code}mgreen`)), [['green', 2]]);
  }
});

test('malformed and oversized SGR is neutral, incomplete suffixes reparse from scratch', () => {
  for (const seq of ['38;2;31', '38;5;', '38;3;31', '38;2;256;0;0', '38;2;0;;0', '48:2:1', '58:5:999', '?31', Array(34).fill('31').join(';')]) {
    assert.deepEqual(colors(parseBashOutput(`${esc}[32ma${esc}[${seq}mb`)), [['a', 2], ['b', null]], seq);
  }
  assert.equal(parseBashOutput(`prefix${esc}[31`).text, 'prefix31');
  assert.deepEqual(colors(parseBashOutput(`prefix${esc}[31mred`)), [['prefix', null], ['red', 1]]);
  assert.equal(parseBashOutput(`a${esc}[${'1'.repeat(128)}Zafter`).text, `a${'1'.repeat(128)}Zafter`);
  assert.equal(parseBashOutput(`a${esc}[31\nafter`).text, 'a31\nafter');
});

test('OSC metadata, hyperlinks and clipboard payloads have no effects; malformed envelopes are bounded', () => {
  for (const end of ['\x07', `${esc}\\`, '\x9c']) {
    assert.equal(parseBashOutput(`a${esc}]0;title${end}b${esc}]52;c;secret${end}c`).text, 'abc');
    assert.equal(parseBashOutput(`${esc}]8;;https://hostile.invalid${end}label${esc}]8;;${end}`).text, 'label');
  }
  assert.equal(parseBashOutput(`before${esc}]unterminated`).text, 'beforeunterminated');
  assert.equal(parseBashOutput(`before${esc}]payload\nafter`).text, 'beforepayload\nafter');
  assert.equal(parseBashOutput(`${esc}]${'x'.repeat(2048)}visible`).text, `${'x'.repeat(2048)}visible`);
  assert.equal(parseBashOutput(`${esc}]nested${esc}[31msecret\nnormal`).text, 'nestedsecret\nnormal');
  assert.equal(parseBashOutput('\x9b32mgreen\x9b0m\x9dtitle\x07label').text, 'greenlabel');
});

test('non-SGR controls do not emulate a terminal or insert visible control glyphs', () => {
  const raw = `a${esc}[2Kb\rc\bd\x00\x07\x7f\t\n👩🏽‍💻 e\u0301 漢字${esc}(Bend`;
  assert.equal(parseBashOutput(raw).text, 'ab\rcd\t\n👩🏽‍💻 e\u0301 漢字end');
});

test('tail, line and chunk boundaries preserve known colour and all blank logical rows', () => {
  const raw = `${esc}[32m\n\n${Array(12).fill('x'.repeat(2000)).join('\n')}\n\n`;
  const output = parseBashOutput(raw);
  const chunks = bashChunks(output.text, 8000);
  assert.equal(chunks.map(({start,end}) => output.text.slice(start,end)).join('\n'), output.text);
  assert.deepEqual(output.runs, [{start:0, end:output.text.length, foreground:2}]);
  for (const text of ['', '\na', '\n\n', 'a\n', 'a\nb\nc\nd\ne\nf\ng\n']) {
    assert.equal(text.slice(bashTailStart(text,6)), text.split('\n').slice(-6).join('\n'));
  }
  assert.equal(bashChunks('x'.repeat(65001),8000).length,1);
});

test('upstream truncation cannot reconstruct a missing introducer or foreground', () => {
  const source = `prefix${esc}[32m${'x'.repeat(4093)}`;
  assert.equal(parseBashOutput(source.slice(-4096)).text, `32m${'x'.repeat(4093)}`);
  assert.equal(parseBashOutput(source.slice(-4093)).runs[0].foreground === null, true);
  assert.equal(parseBashOutput(`${esc}[32m${'x'.repeat(16384)}`.slice(-16384)).runs[0].foreground === null, true);
});

test('linear workloads and hostile colour-every-character input have bounded coalesced runs', t => {
  for (const size of [4096,16384,60000,1024*1024]) {
    const raw = `${esc}[32m${'x'.repeat(size)}`;
    const start=performance.now(), result=parseBashOutput(raw), ms=performance.now()-start;
    assert.equal(result.text.length,size); assert.equal(result.runs.length,1);
    t.diagnostic(`${size} characters: ${ms.toFixed(2)}ms, ${result.runs.length} run`);
  }
  const raw = Array.from({length:100000},(_,i)=>`${esc}[${i%2 ? 31:32}mx`).join('');
  const start=performance.now(), result=parseBashOutput(raw);
  assert.equal(result.text,'x'.repeat(100000)); assert.ok(result.runs.length <= MAX_BASH_RUNS);
  assert.equal(result.runs.at(-1).foreground === null, true);
  t.diagnostic(`100,000 colour changes: ${(performance.now()-start).toFixed(2)}ms, ${result.runs.length} runs`);
  for (const introducer of [`${esc}]`, '\x9d']) {
    const raw=introducer.repeat(100000)+'useful diagnostic';
    const start=performance.now(), result=parseBashOutput(raw);
    assert.equal(result.text,'useful diagnostic');assert.equal(result.runs.length,1);
    t.diagnostic(`100,000 nested OSC candidates: ${(performance.now()-start).toFixed(2)}ms`);
  }
});

test('every fixed foreground clears 4.5:1 on the actual card surface', t => {
  const css=readFileSync(resolve(root,'web/src/styles.css'),'utf8');
  const [,L,C,H]=css.match(/--surface-1:\s*oklch\(([.\d]+) ([.\d]+) ([.\d]+)\)/);
  const a=+C*Math.cos(+H*Math.PI/180),b=+C*Math.sin(+H*Math.PI/180);
  const l=(+L+0.3963377774*a+0.2158037573*b)**3,m=(+L-0.1055613458*a-0.0638541728*b)**3,s=(+L-0.0894841775*a-1.291485548*b)**3;
  const bg=0.2126*(4.0767416621*l-3.3077115913*m+0.2309699292*s)+0.7152*(-1.2684380046*l+2.6097574011*m-0.3413193965*s)+0.0722*(-0.0041960863*l-0.7034186147*m+1.707614701*s);
  const linear=v=>(v/=255)<=0.04045?v/12.92:((v+0.055)/1.055)**2.4;
  const ratios=BASH_PALETTE.map(hex=>{
    const [r,g,b]=hex.slice(1).match(/../g).map(v=>linear(parseInt(v,16)));
    const ratio=(0.2126*r+0.7152*g+0.0722*b+0.05)/(bg+0.05);
    assert.ok(ratio>=4.5,`${hex}: ${ratio}`);return ratio;
  });
  t.diagnostic(`minimum palette contrast: ${Math.min(...ratios).toFixed(2)}:1`);
});

const require=createRequire(resolve(root,'web/package.json'));
const { compile }=require('@tailwindcss/node');
const code=await bundleDomFixture(`
import {createElement as h,act,useSyncExternalStore} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {BashTool} from ${JSON.stringify(resolve(root,'web/src/app/parts/tools/BashTool.tsx'))};
import {ToolPart} from ${JSON.stringify(resolve(root,'web/src/app/parts/ToolPart.tsx'))};
import {TranscriptActionsContext} from ${JSON.stringify(resolve(root,'web/src/app/parts/TurnNotices.tsx'))};
import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
import {OmpSessionController} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
import {entriesToTranscript} from ${JSON.stringify(resolve(root,'web/src/domain/messages.ts'))};
const calls=[];const actions={switchModel(){},editPrompt(){},stopTurn:()=>new Promise((resolve,reject)=>calls.push({resolve,reject}))};
const store=createOmpStore();const controller=Object.create(OmpSessionController.prototype);
Object.assign(controller,{store,activeSession:'/synthetic',clockShift:0,flushHandle:null,pendingDeltas:[],responseChain:null,streamText:''});
function Live(){const message=useSyncExternalStore(store.subscribe,()=>store.getState().streamingMessage);const part=message?.parts.find(p=>p.kind==='tool');return part?h(ToolPart,{part,sessionPath:'/synthetic',live:true}):null;}
let r;
// Default: the Bash detail on its own. {row:true}: the transcript row that opens it in place.
const render=(part,{row=false,...props}={})=>r.render(h(TranscriptActionsContext.Provider,{value:actions},part==='controller'?h(Live):Array.isArray(part)
  ?part.map(p=>h('section',{key:p.callId,'data-call':p.callId},h(BashTool,{part:p,live:true})))
  :h(row?ToolPart:BashTool,{part,sessionPath:'/synthetic',live:true,...props})));
window.fixture={act,render,calls,store,controller,entriesToTranscript,mount(part,props){r=createRoot(document.getElementById('root'));render(part,props);return r;}};
`,[{name:'test-import-meta',options(options){return {...options,transform:{...options.transform,define:{...options.transform?.define,'import.meta':'{}'}}}}},{name:'notice-sink',resolveId:(id,importer)=>((importer?.endsWith('/CopyButton.tsx')&&id==='../Notices')||(importer?.endsWith('/BashTool.tsx')&&id==='@/app/Notices'))?'\0notices':null,load:id=>id==='\0notices'?'export const showToast=(...args)=>window.notices.push(args);':null}]);
const bash=(overrides={})=>({kind:'tool',callId:'t1',name:'bash',state:'ok',args:{command:'  printf "test"\n\t'},output:'plain\n',...overrides});
async function fixture(t,part,props={}){
  const dom=createDomFixture(code),w=dom.window,{act,render}=w.fixture,writes=[];w.notices=[];w.Element.prototype.getAnimations=()=>[];
  Object.defineProperty(w.navigator,'clipboard',{configurable:true,value:{writeText:async text=>writes.push(text)}});
  let r,unmounted=false;await act(async()=>{r=w.fixture.mount(part,props)});
  const unmount=async()=>{if(!unmounted){unmounted=true;await act(async()=>r.unmount());}};
  t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[]);}finally{dom.close();}});
  // The row opens the call's ToolSheet (portalled, mounted on first tap).
  const sheet=()=>w.document.querySelector('[data-testid="tool-sheet"]');
  // The detail under test: the opened sheet, else the directly mounted BashTool.
  const panel=()=>sheet()??w.document.getElementById('root');
  const row=()=>w.document.querySelector('[data-testid="tool-row"]');
  return {w,act,writes,unmount,sheet,panel,row,
    render:(part,next=props)=>act(async()=>render(part,next)),
    open:()=>act(async()=>{assert.ok(row(),'tool row');row().click();}),
    region:()=>panel().querySelector('[role="region"][aria-label="Output"]'),
    toolbar:()=>panel().querySelector('[data-testid="tool-output"]')?.firstElementChild??null,
    command:()=>panel().querySelector('[data-testid="tool-command"]'),
    pre:()=>panel().querySelector('[data-bash-output]'),
    pres:()=>[...panel().querySelectorAll('[data-bash-output]')],
    stop:()=>panel().querySelector('[data-testid="stop-command"]'),
    tail:()=>w.document.querySelector('[data-testid="live-tool-output"]'),
    button:label=>[...panel().querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent===label),
    all:()=>[...panel().querySelectorAll('button')].find(b=>b.textContent.startsWith('Show all')),
  };
}
// Progressive chunks each omit their joining newline; unchunked ranges (a failed
// call's danger-coloured first line, then the rest) are contiguous slices.
function projected(f){
  const region=f.region();if(!region)return '';
  const chunks=[...region.children].filter(el=>(el.getAttribute('style')??'').includes('content-visibility'));
  if(chunks.length)return chunks.map(c=>c.querySelector('[data-bash-output]').textContent).join('\n');
  return f.pres().map(p=>p.textContent).join('');
}
// Absence as a boolean: a failing assert.equal on a DOM node would render the
// node's React fiber graph (see test-support/react-dom.mjs).
const none=(node,message)=>assert.equal(node==null,true,message);
function assertWrap(pre, wrap) {
  assert.ok(pre, 'real Bash output is mounted');
  for (const token of ['min-w-0','whitespace-pre-wrap','break-all']) assert.equal(pre.classList.contains(token),wrap,token);
  for (const token of ['min-w-max','whitespace-pre']) assert.equal(pre.classList.contains(token),!wrap,token);
}
// One Wrap choice governs the whole mono block: `$ command` head, every output range, and horizontal scroll.
function assertBlock(f, wrap) {
  for (const pre of f.pres()) assertWrap(pre, wrap);
  const command=f.command();
  if (command) {
    for (const token of ['whitespace-pre-wrap','break-all']) assert.equal(command.classList.contains(token),wrap,`command ${token}`);
    for (const token of ['min-w-max','whitespace-pre']) assert.equal(command.classList.contains(token),!wrap,`command ${token}`);
  }
  assert.equal(f.region().classList.contains('overflow-x-auto'),!wrap,'unwrapped output scrolls horizontally');
}

for(const state of ['running','ok','error'])test(`Bash wrap toggle (${state}) preserves text, colour and exact Copy`,async t=>{
  const raw=`\n\t  ${esc}[32m${'long-token_'.repeat(800)}${esc}[0m\n\nend  \n`;
  const f=await fixture(t,bash({state,output:raw})),plain=parseBashOutput(raw).text;
  const toggle=f.button('Wrap lines'),copy=f.button('Copy output');
  assert.equal(toggle.getAttribute('aria-pressed'),'false');assertBlock(f,false);
  for(const control of [toggle,copy])assert.equal(control.getAttribute('data-size'),'icon-sm','32px toolbar icon (44px hit area)');
  assert.ok(toggle.classList.contains('text-muted-foreground'));
  assert.equal(toggle.nextElementSibling===copy,true,'Wrap sits directly before Copy output');
  assert.equal(copy.parentElement.lastElementChild===copy,true,'Copy stays at the right edge of the toolbar');
  if(state==='error'){
    assert.ok(f.pres()[0].classList.contains('text-danger'),'the first line of a failure takes the danger colour');
    assert.ok(f.pres().slice(1).every(p=>p.classList.contains('text-foreground')));
  }
  for(const wrap of [true,false,true]){
    await f.act(async()=>toggle.click());
    assert.equal(toggle.getAttribute('aria-pressed'),String(wrap));assertBlock(f,wrap);
    assert.equal(projected(f),plain);
    assert.equal(f.panel().querySelector('[data-bash-color="2"]').textContent,'long-token_'.repeat(800));
    assert.ok(f.pres().at(-1).lastElementChild.classList.contains('h-[1lh]'));
  }
  await f.act(async()=>toggle.click());assertBlock(f,false);
  await f.act(async()=>copy.click());assert.deepEqual(f.writes,[raw]);
  // Replacing the same call's output resets Copy feedback, not the reader preference.
  await f.render(bash({state,output:raw+'next'}));
  await f.act(async()=>f.button('Wrap lines').click());assertBlock(f,true);
  await f.act(async()=>f.button('Copy output').click());assert.deepEqual(f.writes,[raw,raw+'next']);
  await f.act(async()=>{f.button('Wrap lines').click();f.button('Wrap lines').click();});
  assert.equal(f.button('Wrap lines').getAttribute('aria-pressed'),'true');assertBlock(f,true);
});

test('Bash wrap choice is local to each mounted tool and follows its keyed call',async t=>{
  const first=bash(),second=bash({callId:'t2',output:'second output'}),f=await fixture(t,[first,second]);
  const section=id=>f.w.document.querySelector(`[data-call="${id}"]`);
  const toggle=id=>section(id).querySelector('button[aria-label="Wrap lines"]');
  await f.act(async()=>toggle('t1').click());
  assert.equal(toggle('t1').getAttribute('aria-pressed'),'true');assert.equal(toggle('t2').getAttribute('aria-pressed'),'false');
  await f.render([second,{...first,output:'replacement'}]);
  assertWrap(section('t1').querySelector('[data-bash-output]'),true);assertWrap(section('t2').querySelector('[data-bash-output]'),false);
  await f.render([second,bash({callId:'t3'})]);
  assert.equal(toggle('t3').getAttribute('aria-pressed'),'false');assertWrap(section('t3').querySelector('[data-bash-output]'),false);
});

test('Bash wrap choice survives an empty replacement; empty output shows only the command',async t=>{
  const f=await fixture(t,bash({state:'running',output:''}));
  none(f.pre());assert.equal(f.command().textContent,'$   printf "test"\n\t');
  none(f.button('Copy output'));assert.ok(f.button('Copy command'));
  assert.equal(f.button('Wrap lines').getAttribute('aria-pressed'),'false');
  await f.render(bash({state:'running',output:'partial'}));
  assert.ok(f.button('Copy output'));none(f.button('Copy command'),'one Copy per block');
  await f.act(async()=>f.button('Wrap lines').click());
  await f.render(bash({state:'running',output:''}));
  none(f.pre());none(f.button('Copy output'));assertBlock(f,true);
  await f.act(async()=>f.button('Copy command').click());assert.deepEqual(f.writes,['  printf "test"\n\t']);
  await f.render(bash({output:'complete'}));
  assert.equal(f.button('Wrap lines').getAttribute('aria-pressed'),'true');assertBlock(f,true);
});

for(const state of ['ok','error'])test(`Bash wrap choice (${state}) survives clamping, progressive chunks, Show less and replacement`,async t=>{
  const raw=`${esc}[32m\n\n${('x'.repeat(7999)+'\n\n').repeat(9)}\n\n`,plain=parseBashOutput(raw).text;
  const f=await fixture(t,bash({state,output:raw})),clamped=projected(f),frames=new Map();let id=0;
  f.w.requestAnimationFrame=cb=>(frames.set(++id,cb),id);f.w.cancelAnimationFrame=id=>frames.delete(id);
  const drain=async()=>{while(frames.size){const callbacks=[...frames.values()];frames.clear();await f.act(async()=>callbacks.forEach(cb=>cb(16)));}};
  assert.ok(clamped.length<plain.length);assert.ok(plain.startsWith(clamped));assertBlock(f,false);
  await f.act(async()=>f.button('Wrap lines').click());assertBlock(f,true);assert.equal(projected(f),clamped);
  await f.act(async()=>f.all().click());assert.equal(f.pres().length,1);assertBlock(f,true);
  const pending=[...frames.keys()];
  await f.act(async()=>f.button('Wrap lines').click());assertBlock(f,false);
  assert.ok(pending.every(id=>frames.has(id)),'wrap does not cancel existing expansion frames');
  assert.equal(f.pres().length,1,'wrap does not advance progressive loading');
  await drain();assert.equal(projected(f),plain);assertBlock(f,false);
  await f.act(async()=>f.button('Wrap lines').click());assertBlock(f,true);
  await f.act(async()=>f.button('Show less').click());assertBlock(f,true);assert.equal(projected(f),clamped);
  await f.act(async()=>f.all().click());await drain();assertBlock(f,true);assert.equal(projected(f),plain);
  await f.render(bash({state,output:raw.replaceAll('[32m','[31m')}));assertBlock(f,true);await drain();
  assert.equal(projected(f),plain);
  for(const pre of f.pres())assert.ok(pre.querySelector('[data-bash-color="1"]'));
  await f.act(async()=>f.button('Copy output').click());assert.deepEqual(f.writes,[raw.replaceAll('[32m','[31m')]);
});

test('Bash wrap utilities compile to bounded-width wrapping; 32px controls keep a 44px hit area',async()=>{
  const compiler=await compile(readFileSync(resolve(root,'web/src/styles.css'),'utf8'),{base:resolve(root,'web/src'),onDependency(){}});
  const css=compiler.build(['min-w-0','min-w-max','whitespace-pre-wrap','whitespace-pre','break-all','size-8','h-8','after:-inset-1.5']);
  const rule=token=>css.match(new RegExp(`\\.${token}\\s*\\{([^}]+)\\}`))?.[1]??'';
  assert.match(rule('min-w-0'),/min-width:\s*0px;/);
  assert.match(rule('min-w-max'),/min-width:\s*max-content;/);
  assert.match(rule('whitespace-pre-wrap'),/white-space:\s*pre-wrap;/);
  assert.match(rule('whitespace-pre'),/white-space:\s*pre;/);
  assert.match(rule('break-all'),/word-break:\s*break-all;/);
  assert.match(css,/--spacing:\s*0\.25rem;/);
  // icon-sm (Wrap, Copy) is size-8 and sm (Stop) is h-8: 32px drawn; the
  // -1.5 spacing inset on ::after adds 6px per side, a 44px touch target.
  assert.match(rule('size-8'),/width:\s*calc\(var\(--spacing\) \* 8\);/);
  assert.match(rule('h-8'),/height:\s*calc\(var\(--spacing\) \* 8\);/);
  assert.match(css,/inset:\s*calc\(var\(--spacing\) \* -1\.5\);/);
});

for(const state of ['running','ok','error'])test(`${state}: same reader, scalable text, whitespace, exit status once and exact Copy`,async t=>{
  const raw=`\n\n\t界${esc}[32mPASS${esc}[0m\n\nend  \n`,part=bash({state,shell:state==='running'?undefined:{kind:'exit',code:state==='error'?1:0},output:raw});
  const f=await fixture(t,part);
  assert.equal(projected(f),'\n\n\t界PASS\n\nend  \n');
  assert.equal(f.panel().querySelector('[data-bash-color="2"]').textContent,'PASS');
  for(const pre of f.pres())for(const c of ['font-mono','text-code','whitespace-pre','min-h-[1lh]'])assert.ok(pre.classList.contains(c),c);
  assert.ok(f.pres().at(-1).lastElementChild.classList.contains('h-[1lh]'),'trailing logical blank row reserves height');
  assert.equal(f.panel().querySelector('.font-semibold') === null, true, 'source colours are not overridden by error heuristics');
  assert.equal(f.command().textContent,`$ ${part.args.command}`,'the command keeps its whitespace');
  const toolbar=f.toolbar().textContent;
  if(state==='running'){assert.match(toolbar,/Running/);assert.ok(f.stop());}
  else{none(f.stop());assert.equal(f.panel().textContent.split(`exit ${state==='error'?1:0}`).length,2,'exit status shown once');}
  await f.act(async()=>f.button('Copy output').click());
  await f.render({...part,output:''});await f.act(async()=>f.button('Copy command').click());
  assert.deepEqual(f.writes,[raw,part.args.command]);
});

test('live tail under the row carries a colour introduced before its last four lines; tapping opens the whole output in the sheet',async t=>{
  const raw=`${esc}[32m${Array.from({length:10},(_,i)=>`row ${i}`).join('\n')}`,text=parseBashOutput(raw).text;
  const f=await fixture(t,bash({state:'running',output:raw}),{row:true});
  assert.equal(f.row().dataset.state,'running');assert.match(f.row().textContent,/^Running printf "test"/,'the row carries the command');
  none(f.sheet(),'the detail mounts on the first tap');
  none(f.w.document.querySelector('button[aria-label="Wrap lines"]'),'no output actions until opened');
  const tail=f.tail().querySelector('[data-bash-output]');
  assert.equal(tail.textContent,text.split('\n').slice(-4).join('\n'));
  assert.equal(tail.querySelector('[data-bash-color="2"]').textContent,tail.textContent);
  assertWrap(tail,true);
  await f.open();assert.ok(f.sheet());
  assert.equal(projected(f),text);assertBlock(f,false);
  assert.equal(f.panel().querySelector('[data-bash-color="2"]').textContent,text);
  await f.act(async()=>f.button('Wrap lines').click());assertBlock(f,true);
  await f.act(async()=>f.button('Wrap lines').click());assertBlock(f,false);
  assert.ok(f.stop(),'Stop lives in the detail of a live command');
});

test('long output opens whole in the sheet, not cut by a Show all',async t=>{
  const raw=Array.from({length:30},(_,i)=>`line ${i}`).join('\n')+'\n';
  const f=await fixture(t,bash({output:raw}),{row:true});
  await f.open();
  assert.equal(projected(f),raw);
  none(f.all(),'under the clamp there is no Show all');
});

test('live tail is a clipped, unfocusable preview that follows the newest lines and ends with the command',async t=>{
  const tail=Array(6).fill('visible row').join('\n');
  const f=await fixture(t,bash({state:'running',output:`earlier\n${esc}[32m${tail}`}),{row:true});
  const preview=()=>f.tail();
  assert.equal(preview().getAttribute('aria-hidden'),'true','the row already announces the call');
  assert.ok(preview().classList.contains('max-h-[4lh]'));assert.ok(preview().classList.contains('overflow-hidden'));
  for(const cls of ['overflow-y-auto','overflow-auto','border'])assert.equal(preview().classList.contains(cls),false,cls);
  assert.equal(preview().hasAttribute('tabindex'),false,'not a scroll box');
  assertWrap(preview().querySelector('[data-bash-output]'),true);
  await f.render(bash({state:'running',output:`earlier\n${esc}[31m${tail}\nnew 1\nnew 2`}));
  assert.equal(preview().querySelector('[data-bash-output]').textContent,'visible row\nvisible row\nnew 1\nnew 2');
  assert.ok(preview().querySelector('[data-bash-color="1"]'));
  await f.render(bash({state:'running',output:' \n\t\n'}));none(preview(),'whitespace-only output has no tail');
  await f.render(bash({output:`done\n`}));none(preview(),'a finished command has no tail');
  assert.equal(f.row().dataset.state,'ok');
});

test('replacement, replay, shrinking, incomplete completion and tool change never inherit stale colour',async t=>{
  const f=await fixture(t,bash({state:'running',output:`${esc}[32mgreen`}));
  for(const raw of [`prefix${esc}[31`,`prefix${esc}[31mred`,`prefix${esc}[31mred`,'plain','',`${esc}[34mblue`]){
    await f.render(bash({state:'running',output:raw}));
    assert.equal(projected(f),parseBashOutput(raw).text);
    assert.equal(f.panel().querySelector('[data-bash-color="2"]') === null, true);
  }
  await f.render(bash({callId:'t2',output:'next tool'}));assert.equal(f.pre().textContent,'next tool');
  assert.equal(f.pre().querySelector('[data-bash-color]') === null, true);
});

test('500-line clamp and progressive chunks retain colour across boundaries and all blank rows',async t=>{
  const raw=`${esc}[32m\n\n${Array.from({length:600},(_,i)=>`row ${i} ${'x'.repeat(80)}`).join('\n')}\n\n`;
  const output=parseBashOutput(raw).text,f=await fixture(t,bash({output:raw})),total=output.split('\n').length;
  assert.equal(projected(f),output.split('\n').slice(0,500).join('\n'));
  assert.equal(f.all().textContent,`Show all (${total-500} more lines)`);
  const frames=new Map();let id=0;f.w.requestAnimationFrame=cb=>(frames.set(++id,cb),id);f.w.cancelAnimationFrame=id=>frames.delete(id);
  await f.act(async()=>f.all().click());assert.equal(f.pres().length,1);
  while(frames.size){const callbacks=[...frames.values()];frames.clear();await f.act(async()=>callbacks.forEach(cb=>cb(16)));}
  assert.equal(projected(f),output);
  for(const p of f.pres())assert.ok(p.querySelector('[data-bash-color="2"]'));
  await f.act(async()=>f.button('Copy output').click());assert.deepEqual(f.writes,[raw]);
  await f.act(async()=>f.button('Show less').click());assert.equal(projected(f),output.split('\n').slice(0,500).join('\n'));
});

for (const [name,raw] of [
  ['all blank logical rows', '\n'.repeat(65001)],
  ['leading, boundary and trailing blank rows', `${esc}[32m\n\n${('x'.repeat(7999)+'\n\n').repeat(9)}\n\n`],
]) test(`progressive expansion preserves ${name}, Copy and re-expansion`,async t=>{
  const f=await fixture(t,bash({output:raw})),plain=parseBashOutput(raw).text;
  await f.act(async()=>f.button('Wrap lines').click());
  const frames=new Map();let id=0;
  f.w.requestAnimationFrame=cb=>(frames.set(++id,cb),id);f.w.cancelAnimationFrame=id=>frames.delete(id);
  const expand=async()=>{
    await f.act(async()=>f.all().click());
    while(frames.size){const callbacks=[...frames.values()];frames.clear();await f.act(async()=>callbacks.forEach(cb=>cb(16)));}
    assert.equal(projected(f),plain);
    assertBlock(f,true);
    assert.equal(f.pres().reduce((sum,p)=>sum+p.textContent.split('\n').length,0),plain.split('\n').length);
  };
  await expand();await f.act(async()=>f.button('Copy output').click());assert.deepEqual(f.writes,[raw]);
  await f.act(async()=>f.button('Show less').click());assert.ok(projected(f).length<plain.length);
  await expand();
});

test('character clamp happens after complete controls, and does not split a surrogate pair',async t=>{
  const raw=`${esc}[32m${'x'.repeat(59999)}💚${esc}[0mend`,f=await fixture(t,bash({output:raw}));
  // Compare the tail, not 60k-char strings: a failure must say what was split.
  const shown=()=>{const text=f.pre().textContent;return {length:text.length,onlyX:/^x*$/.test(text),end:[...text.slice(-2)].map(c=>c.codePointAt(0).toString(16))};};
  const clamp={length:59999,onlyX:true,end:['78','78']};
  assert.deepEqual(shown(),clamp,'the clamp stops before 💚 instead of keeping its lone high surrogate');
  await f.act(async()=>f.button('Wrap lines').click());assertWrap(f.pre(),true);
  assert.deepEqual(shown(),clamp);
  await f.act(async()=>f.all().click());assert.equal(projected(f),parseBashOutput(raw).text);
  assertWrap(f.pre(),true);
});

test('expansion frames cancel on Show less/replacement/unmount and same-sized replacement starts fresh',async t=>{
  const raw=Array(700).fill(`${esc}[32m${'x'.repeat(100)}`).join('\n'),f=await fixture(t,bash({output:raw}));
  const frames=new Map(),cancelled=[];let id=0;
  f.w.requestAnimationFrame=cb=>(frames.set(++id,cb),id);
  f.w.cancelAnimationFrame=id=>{cancelled.push(id);frames.delete(id);};
  const drain=async()=>{const callbacks=[...frames.values()];frames.clear();await f.act(async()=>callbacks.forEach(cb=>cb(16)));};
  await f.act(async()=>f.all().click());assert.ok(frames.size>=1);
  await drain();assert.equal(f.pres().length,3,'two more chunks per frame');
  let before=cancelled.length;
  await f.render(bash({output:raw.replaceAll('[32m','[31m')}));
  assert.equal(f.pres().length,1);
  assert.equal(f.panel().querySelector('[data-bash-color="2"]') === null, true);
  assert.ok(cancelled.length>before,'replacement cancels the preceding expansion frame');
  before=cancelled.length;await f.act(async()=>f.button('Show less').click());
  assert.ok(cancelled.length>before,'Show less cancels expansion');
  await drain();assert.equal(f.pres().length,1);
  await f.act(async()=>f.all().click());assert.ok(frames.size>=1);before=cancelled.length;
  await f.unmount();assert.ok(cancelled.length>before,'unmount cancels expansion');
});

test('hostile output stays inert, bounded and exact on Copy',async t=>{
  const raw=`${esc}]52;c;stolen\x07${esc}]8;;https://hostile.invalid\x07label${esc}]8;;\x07<img src=x onerror=alert(1)>${esc}[8m visible`;
  const f=await fixture(t,bash({output:raw}));
  assert.equal(f.pre().textContent,'label<img src=x onerror=alert(1)> visible');
  assert.equal(f.panel().querySelectorAll('a,img,script,style').length,0);
  await f.act(async()=>f.button('Copy output').click());assert.deepEqual(f.writes,[raw]);
  await f.render(bash({output:Array.from({length:10000},(_,i)=>`${esc}[${i%2?31:32}mx`).join('')}));
  assert.ok(f.pre().querySelectorAll('code > span').length<=MAX_BASH_RUNS);
});

test('plain diffs render as DiffPart; ANSI and failed diffs keep the mono reader and exact Copy output',async t=>{
  const diff='@@ -1 +1 @@\n-old\n+new\n',f=await fixture(t,bash({output:diff}));
  const diffPart=()=>f.panel().querySelector('[data-testid="diff-part"]');
  const blockWrap=()=>f.panel().querySelector('[data-testid="tool-output"] button[aria-label="Wrap lines"]');
  assert.ok(diffPart());assert.equal(f.pre() === null, true, 'ordinary diff uses the diff renderer');
  assert.ok(f.button('Copy diff'));none(f.button('Copy output'));assert.ok(f.button('Copy command'),'the command block keeps its own Copy');
  const diffWrap=diffPart().querySelector('button[aria-label="Wrap lines"]');
  await f.act(async()=>diffWrap.click());
  assert.equal(diffWrap.getAttribute('aria-pressed'),'true');assert.equal(blockWrap().getAttribute('aria-pressed'),'false');
  assert.ok(diffPart().querySelector('[data-testid="diff-lines"]').classList.contains('min-w-0'));
  await f.act(async()=>f.button('Copy diff').click());assert.deepEqual(f.writes,[diff]);
  const raw=`${esc}[31m${diff}${esc}[0m`;await f.render(bash({output:raw}));
  none(diffPart());none(f.button('Copy diff'));assert.equal(projected(f),diff);
  assert.equal(blockWrap().getAttribute('aria-pressed'),'false','DiffPart state is separate');
  await f.act(async()=>blockWrap().click());assertBlock(f,true);
  assert.equal(f.pre().querySelector('[data-bash-color="1"]').textContent,diff);
  await f.act(async()=>f.button('Copy output').click());assert.deepEqual(f.writes,[diff,raw]);
  await f.render(bash({state:'error',output:diff}));
  none(diffPart(),'failed diff-shaped output keeps the Bash reader');
  assertBlock(f,true);assert.equal(projected(f),diff);
  await f.act(async()=>blockWrap().click());assertBlock(f,false);
  await f.act(async()=>f.button('Copy output').click());assert.deepEqual(f.writes,[diff,raw,diff]);
});

test('Stop asks first, then stops the turn; failure allows retry; final output removes it',async t=>{
  const f=await fixture(t,bash({state:'running',output:`${esc}[32mworking`}));
  assert.equal(f.stop().textContent,'Stop');assert.equal(f.stop().getAttribute('data-size'),'sm','32px button (44px hit area)');
  // omp cannot cancel one agent command, so Stop confirms that it stops the turn.
  const choose=label=>f.act(async()=>[...f.w.document.querySelectorAll('button')].find(b=>b.textContent===label).click());
  await f.act(async()=>f.stop().click());assert.equal(f.w.fixture.calls.length,0);
  await choose('Keep running');assert.equal(f.w.fixture.calls.length,0);assert.equal(f.stop().disabled,false);
  await f.act(async()=>f.stop().click());await choose('Stop agent');
  assert.equal(f.w.fixture.calls.length,1);assert.ok(f.stop().disabled);assert.equal(f.stop().textContent,'Stopping…');
  await f.act(async()=>f.w.fixture.calls[0].reject(new Error('Synthetic stop failure')));
  assert.equal(f.stop().disabled,false);assert.equal(f.stop().textContent,'Stop');
  await f.act(async()=>f.stop().click());await choose('Stop agent');
  await f.act(async()=>f.w.fixture.calls[1].resolve());
  assert.equal(f.w.fixture.calls.length,2);assert.ok(f.stop().disabled,'success waits for the final result');
  await f.render(bash({state:'error',output:`${esc}[31mstopped`}));none(f.stop());
  assert.equal(f.toolbar().textContent.includes('exit 1'),false);assert.equal(f.pre().textContent,'stopped');
});

test('Stop is offered only for a live command with a session',async t=>{
  const f=await fixture(t,bash({state:'running',output:'working'}),{live:false});
  none(f.stop(),'an ended turn cannot stop its command');assert.doesNotMatch(f.toolbar().textContent,/Running/);
  await f.render(bash({state:'running',output:'working'}),{sessionPath:null});
  none(f.stop(),'no session to address');assert.match(f.toolbar().textContent,/Running/);
});

test('a failed command shows its exit code once, on the card header',async t=>{
  const f=await fixture(t,bash({state:'error',shell:{kind:'exit',code:2},output:'boom\n'}),{row:true});
  assert.equal(f.row().dataset.state,'error');assert.match(f.row().textContent,/exit 2$/);
  assert.equal(f.row().textContent.split('exit 2').length,2);
  await f.open();
  assert.equal(f.panel().textContent.split('exit 2').length,2,'the open card does not repeat it');
  assert.equal(projected(f),'boom\n');
});

test('a command in an agent transcript (no session) offers no Stop',async t=>{
  const f=await fixture(t,[bash({state:'running',output:'working'})]);
  none(f.stop());
});

for(const isError of [false,true])test(`real controller update/end and restored history use the same reader (error=${isError})`,async t=>{
  const f=await fixture(t,'controller'),api=f.w.fixture;
  const wire={role:'assistant',responseId:'r1',timestamp:1700000000000,content:[{type:'toolCall',id:'t1',name:'bash',arguments:{command:'fixture command'}}]};
  await f.act(async()=>api.controller.setStreamingMessage(wire));
  await f.act(async()=>api.controller.reduceToolExecution({type:'tool_execution_start',toolCallId:'t1',toolName:'bash',args:{command:'fixture command'}}));
  const raw=`${esc}[32mlive\n\n${esc}[31mfinal\n`;
  for(const partialResult of [`${esc}[32mlive${esc}[`,raw,raw])await f.act(async()=>api.controller.reduceToolExecution({type:'tool_execution_update',toolCallId:'t1',partialResult}));
  assert.equal(f.tail().querySelector('[data-bash-output]').textContent,'live\n\nfinal\n');
  await f.open();assert.equal(projected(f),'live\n\nfinal\n');await f.act(async()=>f.button('Copy output').click());
  await f.act(async()=>f.button('Wrap lines').click());assertBlock(f,true);
  for(const partialResult of [raw+'next',raw])await f.act(async()=>api.controller.reduceToolExecution({type:'tool_execution_update',toolCallId:'t1',partialResult}));
  assert.equal(f.button('Wrap lines').getAttribute('aria-pressed'),'true');assertBlock(f,true);
  await f.act(async()=>api.controller.reduceToolExecution({type:'tool_execution_end',toolCallId:'t1',result:raw,isError}));
  assert.equal(projected(f),'live\n\nfinal\n');none(f.tail());
  assert.equal(f.row().dataset.state,isError?'error':'ok');none(f.stop());
  assert.equal(f.row().textContent.includes('exit'),false,'a result that names no exit code claims none on the header; the error state carries the failure');
  assert.equal(f.button('Wrap lines').getAttribute('aria-pressed'),'true');assertBlock(f,true);
  const history=api.entriesToTranscript([{type:'message',id:'assistant',message:wire},{type:'message',id:'result',message:{role:'toolResult',toolCallId:'t1',toolName:'bash',content:[{type:'text',text:raw}],isError}}]);
  const part=history.messages[0].parts.find(p=>p.kind==='tool');assert.equal(part.state,isError?'error':'ok');
  await f.render(part,{row:true,live:false});none(f.sheet(),'a restored row stays folded until tapped');
  await f.open();
  assert.equal(f.button('Wrap lines').getAttribute('aria-pressed'),'false','restored remount defaults to unwrapped');
  assert.equal(projected(f),'live\n\nfinal\n');await f.act(async()=>f.button('Copy output').click());
  assert.deepEqual(f.writes,[raw,raw]);
});

test('real controller end cap keeps exact available raw Copy and documents lost introducer',async t=>{
  const f=await fixture(t,'controller'),api=f.w.fixture;
  const wire={role:'assistant',responseId:'r1',content:[{type:'toolCall',id:'t1',name:'bash',arguments:{command:'fixture command'}}]};
  await f.act(async()=>api.controller.setStreamingMessage(wire));
  const raw=`prefix${esc}[32m${'x'.repeat(4093)}`;
  await f.act(async()=>api.controller.reduceToolExecution({type:'tool_execution_end',toolCallId:'t1',result:raw,isError:false}));
  await f.open();assert.equal(f.pre().textContent,raw.slice(-4096));
  assert.equal(f.pre().querySelector('[data-bash-color]') === null, true);
  await f.act(async()=>f.button('Copy output').click());assert.deepEqual(f.writes,[raw.slice(-4096)]);
});
