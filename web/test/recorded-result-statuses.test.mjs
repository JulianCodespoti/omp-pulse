import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
// Synthetic shapes from tagged OMP 18.10.4 tools/{image-gen,bash,todo}.ts.
const code = await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {entriesToTranscript,applyToolResults,mergeToolParts,parseToolImages,parseShellOutcome} from ${JSON.stringify(resolve(root,'web/src/domain/messages.ts'))};
 import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
 import {OmpSessionController} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
 import {ToolPart} from ${JSON.stringify(resolve(root,'web/src/app/parts/ToolPart.tsx'))};
 import {TodoBoard} from ${JSON.stringify(resolve(root,'web/src/app/parts/tools/TodoTool.tsx'))};
 import {RunSummary} from ${JSON.stringify(resolve(root,'web/src/app/parts/RunSummary.tsx'))};
 import {summarizeRun} from ${JSON.stringify(resolve(root,'web/src/app/parts/run-summary.ts'))};
 import {TasksTab} from ${JSON.stringify(resolve(root,'web/src/app/tools/TasksTab.tsx'))};
 import {useProvideWorkspaceHost} from ${JSON.stringify(resolve(root,'web/src/app/tools/workspace-host.ts'))};
 const controllers=[];
 window.fixture={act,entriesToTranscript,applyToolResults,mergeToolParts,parseToolImages,parseShellOutcome,summarizeRun,
  live(entries,events){const store=createOmpStore();store.getState().beginSession('/synthetic/results');store.getState().mergeMessages(entriesToTranscript(entries).messages);
   const c=new OmpSessionController(store,'synthetic-result-token','http://synthetic.invalid');c.runningAgentCount.stop();c.stopOfflineTicker();c.activeSession='/synthetic/results';controllers.push(c);
   for(const event of events)c.reduceToolExecution(event);return [...store.getState().messages,...(store.getState().streamingMessage?[store.getState().streamingMessage]:[])];},
  mount(messages,mode){const r=createRoot(document.getElementById('root'));const part=messages[0].parts.find(p=>p.kind==='tool');
   if(mode==='current'){const store=createOmpStore();store.getState().beginSession('/synthetic/results');store.getState().mergeMessages(messages);
    const host={controller:{getStore:()=>store},jumpTo(){},onBranched(){}};
    function HostedPlan(){useProvideWorkspaceHost(host);return h(TasksTab,{sessionPath:'/synthetic/results',active:false,focused:false});}
    r.render(h(HostedPlan));}
   else r.render(mode==='run'?h(RunSummary,{messages,toolsLive:false}):mode==='board'?h(TodoBoard,{phases:part.todo}):h(ToolPart,{part,live:false}));return r;},
  dispose(){for(const c of controllers)c.dispose();}
 };
`,[{name:'fixture-import-meta',options(options){return {...options,transform:{...options.transform,define:{...options.transform?.define,'import.meta':'{}'}}}}}]);

const call=(name,id='call')=>({type:'message',id:'assistant-'+id,timestamp:'2026-10-25T10:00:00Z',message:{role:'assistant',content:[{type:'toolCall',id,name,arguments:{command:'fixture command'}}]}});
const result=(name,details,output='Recorded output',id='call',isError=false)=>({type:'message',id:'result-'+id,timestamp:'2026-10-25T10:00:01Z',message:{role:'toolResult',toolCallId:id,toolName:name,details,isError,content:[{type:'text',text:output}]}});
async function fixture(t,entries,mode='row',events) {
 const dom=createDomFixture(code),w=dom.window,f=w.fixture;w.Element.prototype.getAnimations=()=>[];
 const messages=events?f.live(entries,events):f.entriesToTranscript(entries).messages;
 let mounted;await f.act(async()=>{mounted=f.mount(messages,mode)});
 t.after(async()=>{try{await f.act(async()=>mounted.unmount());f.dispose();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 return {w,f,messages,text:()=>w.document.body.textContent,async open(){await f.act(async()=>w.document.querySelector('[data-testid="tool-row"]').click())}};
}
const png='iVBORw0KGgo=';
for(const live of [false,true])test(`generated image slots stay with every originating call (${live?'live':'history'})`,async t=>{
 const details={imageCount:2,images:[{data:png,mimeType:'image/png'},{data:'',mimeType:'image/webp'}]};
 const entries=[call('generate_image','one'),result('generate_image',details,'Generated first','one'),call('generate_image','two'),result('generate_image',details,'Generated second','two')];
 const events=live?['one','two'].map(id=>({type:'tool_execution_end',toolCallId:id,toolName:'generate_image',result:{content:[{type:'text',text:'Generated '+id}],details},isError:false})):undefined;
 const f=await fixture(t,live?entries.filter(e=>e.message.role==='assistant'):entries,'run',events);
 assert.equal(f.w.document.querySelectorAll('[data-testid="run-photo"]').length,4);
 assert.equal(f.w.document.querySelectorAll('button[aria-label^="Open image"]').length,2);
 assert.equal(f.w.document.querySelectorAll('[data-testid="image-tile"]').length,2);
 const summary=f.f.summarizeRun(f.messages);assert.deepEqual(Array.from(summary.photos,p=>p.callId),['one','one','two','two']);
 assert.equal(f.text().includes(png),false);
});

test('orphan generated results attach across pages and retain unavailable slots through assistant completion',async t=>{
 const f=await fixture(t,[call('generate_image')]);
 const transcript=f.f.entriesToTranscript([result('generate_image',{images:[{data:'blob:sha256:abcdef123456',mimeType:'image/png'},null]})]);
 const applied=f.f.applyToolResults(f.messages,transcript.orphanResults);
 assert.equal(applied.unmatched.length,0);assert.equal(applied.messages[0].parts[0].images.length,2);
 assert.equal(applied.messages[0].parts[0].images[1].src,null);
 const merged=f.f.mergeToolParts(f.f.entriesToTranscript([call('generate_image')]).messages[0],applied.messages[0]);
 assert.equal(merged.parts[0].images[0].src,'blob:sha256:abcdef123456');assert.equal(merged.parts[0].images[1].src,null);
});

test('live inline image retention is bounded without dropping failed image positions',async t=>{
 const f=await fixture(t,[call('generate_image')]);
 const images=f.f.parseToolImages('generate_image',[],{images:[{data:'x'.repeat(8*1024*1024+1)}, {data:png,mimeType:'image/png'}]});
 assert.equal(images.length,2);assert.equal(images[0].src,null);assert.equal(images[1].src,`data:image/png;base64,${png}`);
});

for(const mode of ['board','row','current'])for(const live of [false,true])test(`blocked native todo reasons survive ${live?'live':'recorded'} ${mode}`,async t=>{
 const phases=[{name:'Ship',tasks:[{content:'Release',status:'blocked',blocker:'Waiting for the signing key'},{content:'Document',status:'pending'},{content:'Build',status:'completed'}]}];
 const events=live?[{type:'tool_execution_end',toolCallId:'call',toolName:'todo',result:{content:[{type:'text',text:'Blocked'}],details:{phases}},isError:false}]:undefined;
 const f=await fixture(t,live?[call('todo')]:[call('todo'),result('todo',{phases})],mode,events);
 if(mode==='row')await f.open();// the board lives in the call's sheet
 assert.equal(f.text().includes('Blocked: Waiting for the signing key'),true);
 assert.equal(f.messages[0].parts[0].todo[0].tasks[0].status,'blocked');
 assert.equal(f.w.document.querySelectorAll('[data-status="blocked"]').length,1);
});

for(const [label,details,output,expected] of [
 ['reported code',{exitCode:23},'Command exited with code 1','exit 23'],
 ['timeout',{exitCode:137,timedOut:true},'Command timed out after 5 seconds','Timed out'],
 ['cancelled',{cancelled:true},'stopped','Cancelled'],
 ['native thrown cancellation',undefined,'partial output\n\n[Command aborted]','Cancelled'],
 ['generic failure',undefined,'could not launch command','Exit status unknown'],
 ['missing status',undefined,'Command failed: missing exit status','Exit status unknown'],
 ['stdout JSON is not a status',undefined,'{"exitCode":99,"code":1}','Exit status unknown'],
])for(const live of [false,true])test(`shell ${label} is honest in ${live?'live':'recorded'} row and detail`,async t=>{
 const entries=[call('bash'),result('bash',details,output,'call',true)];
 const events=live?[{type:'tool_execution_end',toolCallId:'call',toolName:'bash',result:{content:[{type:'text',text:output}],details},isError:true}]:undefined;
 const f=await fixture(t,live?[entries[0]]:entries,'row',events);
 assert.equal(f.w.document.querySelector('[data-testid="tool-row"]').textContent.includes(expected),true);
 await f.open();assert.equal(f.text().includes(expected),true);
 assert.equal(f.w.document.querySelector('[data-testid="tool-row"]').textContent.includes('exit 1'),false);
});
