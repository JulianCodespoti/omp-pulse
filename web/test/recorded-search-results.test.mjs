import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
// Synthetic payloads follow pinned OMP 18.10.4 tools/grep.ts and
// web/search/index.ts executeSearch/formatForLLM, including absent isError.
const code = await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {entriesToTranscript,applyToolResults,mergeToolParts} from ${JSON.stringify(resolve(root,'web/src/domain/messages.ts'))};
 import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
 import {OmpSessionController} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
 import {ToolPart} from ${JSON.stringify(resolve(root,'web/src/app/parts/ToolPart.tsx'))};
 let controller;
 window.fixture={act,prepare(call,result,mode){
   const pending=entriesToTranscript([call]).messages;
   if(mode==='live'){
     const store=createOmpStore();store.getState().beginSession('/synthetic/search');store.getState().mergeMessages(pending);
     controller=new OmpSessionController(store,'synthetic-search-token','http://synthetic.invalid');
     controller.runningAgentCount.stop();controller.stopOfflineTicker();controller.activeSession='/synthetic/search';
     controller.reduceToolExecution({type:'tool_execution_end',toolCallId:'search',toolName:result.message.toolName,result:{content:result.message.content,details:result.message.details}});
     return [...store.getState().messages,...(store.getState().streamingMessage?[store.getState().streamingMessage]:[])];
   }
   if(mode==='paged')return applyToolResults(pending,entriesToTranscript([result]).orphanResults).messages;
   const recorded=entriesToTranscript([call,result]).messages;
   return mode==='merged'?[mergeToolParts(pending[0],recorded[0])]:recorded;
 },mount(messages){const r=createRoot(document.getElementById('root'));r.render(h(ToolPart,{part:messages[0].parts[0],live:false}));return r;},dispose(){controller?.dispose();}};
`,[{name:'fixture-import-meta',options(options){return {...options,transform:{...options.transform,define:{...options.transform?.define,'import.meta':'{}'}}}}}]);

async function fixture(t,{name='grep',output,details,mode='history'}) {
 const dom=createDomFixture(code),w=dom.window,f=w.fixture,copies=[];
 w.Element.prototype.getAnimations=()=>[];
 Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>copies.push(text)}});
 const call={type:'message',id:'assistant-search',message:{role:'assistant',content:[{type:'toolCall',id:'search',name,arguments:{pattern:'needle',query:'needle'}}]}};
 const result={type:'message',id:'search-result',message:{role:'toolResult',toolCallId:'search',toolName:name,content:[{type:'text',text:output}],details}};
 const messages=f.prepare(call,result,mode);let mounted;
 await f.act(async()=>{mounted=f.mount(messages)});
 t.after(async()=>{try{await f.act(async()=>mounted.unmount());f.dispose();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const row=()=>w.document.querySelector('[data-testid="tool-row"]');
const reader=()=>w.document.querySelector('[data-testid="tool-sheet"]');
 const text=panel=>[...panel.querySelectorAll('[data-bash-output]')].map(pre=>pre.textContent).join('');
 const click=async(panel,label)=>f.act(async()=>{const b=[...panel.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')===label||b.textContent.startsWith(label));assert.ok(b,label);b.click()});
 return {w,f,messages,copies,row,reader,text,click,async open(){await f.act(async()=>row().click())}};
}
const modes=['history','live','paged','merged'];
const longOutput=Array.from({length:24},(_,i)=>`src/example.ts:${i+1} ${i===22?'no matches found':'needle'}`).join('\n')+'\n';

for(const mode of modes)test(`native match state and per-file limits survive ${mode} in the sheet`,async t=>{
 const details={matchCount:24,fileCount:1,files:['src/example.ts'],fileMatches:[{path:'src/example.ts',count:24}],truncated:true,perFileLimitReached:24};
 const f=await fixture(t,{mode,output:longOutput,details});
 assert.equal(f.messages[0].parts[0].search.perFileLimitReached,24);
 assert.equal(f.reader(),null);await f.open();
 assert.match(f.reader().textContent,/24 matches shown/);assert.match(f.reader().textContent,/Results are incomplete/);
 assert.doesNotMatch(f.reader().textContent,/No matches for/);
 assert.equal(f.text(f.reader()),longOutput);assert.match(f.reader().textContent,/24.*per-file or total cap/);
 await f.click(f.reader(),'Copy results');assert.deepEqual(f.copies,[longOutput]);
});

test('native positive match count wins even when the entire match text is an empty-result phrase',async t=>{
 const f=await fixture(t,{output:'No matches found',details:{matchCount:1,truncated:false}});
 await f.open();assert.equal(f.text(f.reader()),'No matches found');assert.match(f.reader().textContent,/1 match/);
 await f.click(f.reader(),'Copy results');assert.deepEqual(f.copies,['No matches found']);
});

test('native zero count preserves returned warnings without counting them as matches',async t=>{
 const output='No matches found\nSearched only the first 16MB of large files: huge.txt';
 const f=await fixture(t,{output,details:{matchCount:0,truncated:false}});await f.open();
 assert.match(f.reader().textContent,/No matches for/);assert.equal(f.text(f.reader()),output);
 assert.equal(f.reader().querySelector('[data-testid="search-result-summary"]')===null,true);
 await f.click(f.reader(),'Copy results');assert.deepEqual(f.copies,[output]);
});

for(const [label,details,notice] of [
 ['native internal search cap',{truncated:true},/Results are incomplete/],
 ['file cap',{fileLimitReached:20},/File limit reached \(20\)/],
 ['line cap',{linesTruncated:true},/Matching lines were shortened/],
 ['column metadata',{meta:{limits:{columnTruncated:{maxColumn:500,unit:'bytes'}}}},/Matching lines were shortened/],
 ['output metadata',{meta:{truncation:{direction:'head',truncatedBy:'bytes',totalLines:3,outputLines:1,totalBytes:999,outputBytes:12}}},/Returned output was truncated/],
])test(`native ${label} is visible independently of a warning in the text`,async t=>{
 const f=await fixture(t,{output:'src/example.ts:1 needle',details:{matchCount:1,...details}});await f.open();
 assert.match(f.reader().textContent,notice);assert.match(f.reader().textContent,/1 match shown/);
});

for(const mode of modes)for(const [provider,error] of [
 ['none','No web search model configured.'],
 ['brave','All web search providers failed: Brave: unavailable; Gemini: denied'],
])test(`native ${provider} provider failure is failed, never matches (${mode})`,async t=>{
 const output=`Error: ${error}\n${Array.from({length:23},(_,i)=>`  diagnostic ${i}`).join('\n')}\n`;
 const f=await fixture(t,{mode,name:'web_search',output,details:{response:{provider,sources:[]},error}});
 assert.equal(f.row().dataset.state,'error');assert.match(f.row().textContent,/Failed/);
 assert.ok(f.row().querySelector('[data-testid="tool-error-line"]'));
 await f.open();assert.equal(f.reader().querySelector('[data-testid="search-result-summary"]')===null,true);
 assert.ok(f.reader().querySelector('[data-bash-output]').classList.contains('text-danger'));
 assert.equal(f.text(f.reader()),output);
 await f.click(f.reader(),'Copy error');assert.deepEqual(f.copies,[output]);
});

for(const mode of modes)test(`native source and citation URLs are safe tappable links with exact copy (${mode})`,async t=>{
 const sources=[{title:'First source',url:'https://example.com/source?q=one&lang=en#section'},{title:'Other source',url:'http://example.org/path_(one)'}];
 const citation={title:'Citation',url:'https://example.net/citation'};
 const output='A literal answer mentioning no matches found.\n\n## Sources\n2 sources\n'+sources.map((s,i)=>`[${i+1}] ${s.title}\n    ${s.url}\n    literal <b>snippet</b>`).join('\n')+'\n'+Array.from({length:14},(_,i)=>`answer line ${i}`).join('\n')+`\n## Citations\n1 citation\n[1] ${citation.title}\n    ${citation.url}\n`;
 const f=await fixture(t,{mode,name:'web_search',output,details:{response:{provider:'brave',sources,citations:[citation]}}});
 await f.open();assert.match(f.reader().textContent,/2 sources/);assert.doesNotMatch(f.reader().textContent,/No matches for|\d+ matches/);
 assert.equal(f.text(f.reader()),output);
 assert.deepEqual([...f.reader().querySelectorAll('[data-bash-output] a')].map(a=>a.getAttribute('href')),[...sources.map(s=>s.url),citation.url]);
 for(const [i,a] of [...f.reader().querySelectorAll('[data-bash-output] a')].slice(0,2).entries()){assert.equal(a.getAttribute('href'),sources[i].url);assert.equal(a.textContent,sources[i].url);assert.equal(a.target,'_blank');assert.equal(a.rel,'noopener noreferrer')}
 assert.equal(f.reader().querySelector('b')===null,true,'source snippets are not HTML');
 await f.click(f.reader(),'Wrap lines');assert.equal(f.text(f.reader()),output);
 await f.click(f.reader(),'Copy results');assert.deepEqual(f.copies,[output]);
});

test('untrusted web source URLs stay literal rather than becoming executable or credentialed links',async t=>{
 const urls=['javascript:alert(1)','data:text/html,unsafe','file:///tmp/secret','intent://unsafe','//example.com/protocol-relative','https://user:secret@example.com/','https://example.com\\@evil.test','https://'];
 const sources=urls.map(url=>({title:'Untrusted source',url}));
 const output=sources.map((s,i)=>`[${i+1}] ${s.title}\n    ${s.url}`).join('\n');
 const f=await fixture(t,{name:'web_search',output,details:{response:{provider:'brave',sources}}});await f.open();
 assert.equal(f.reader().querySelectorAll('[data-bash-output] a').length,0);assert.equal(f.text(f.reader()),output);
 await f.click(f.reader(),'Copy results');assert.deepEqual(f.copies,[output]);
});

test('successful answers quoting provider failure text do not become failed searches',async t=>{
 const output='All web search providers failed is the phrase documented by this source.\n[1] Documentation\n    https://example.com/errors';
 const f=await fixture(t,{name:'web_search',output,details:{response:{provider:'brave',sources:[{title:'Documentation',url:'https://example.com/errors'}]}}});
 assert.equal(f.row().dataset.state,'ok');assert.doesNotMatch(f.row().textContent,/Failed/);await f.open();assert.match(f.reader().textContent,/1 source/);
});
