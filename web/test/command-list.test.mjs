import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {CommandPalette} from ${JSON.stringify(resolve(root,'web/src/app/commands/CommandPalette.tsx'))};
 import {SlashPalette} from ${JSON.stringify(resolve(root,'web/src/app/composer/SlashPalette.tsx'))};
 import {usePanels} from ${JSON.stringify(resolve(root,'web/src/app/nav/panels.ts'))};
 const commands=[
 {name:'tasks',source:'tasks',shape:'drill',description:'Manage work',subcommands:[{name:'list',description:'List the work planned for this project.',usage:'[all]'}]},
 {name:'model',aliases:['m','choose-fixture'],source:'builtin',shape:'picker',picker:'model',description:'Choose the model for this conversation and preserve the current draft.'},
 {name:'context',source:'builtin',shape:'result',description:'Inspect available context.'},
 {name:'models',source:'mcp',shape:'result',description:'Browse all provider model versions.'},
 {name:'plan',source:'tasks',shape:'prompt',description:'Plan before making changes'},
 {name:'goal',source:'tasks',shape:'prompt',description:'Track objectives'}];
 const sessions=[{path:'/synthetic/a.jsonl',id:'a',title:'Fix login',cwd:'/synthetic/projects/web',activeAt:Date.now()-60000},
  {path:'/synthetic/b.jsonl',id:'b',title:'Write docs',cwd:'/synthetic/projects/docs',activeAt:Date.now()-120000}];
 const calls={run:[],pick:[],close:[],open:[],workspace:[],search:[]};
 function Probe(){const p=usePanels();if(p.workspace)calls.workspace.push(p.workspace);return null;}
 window.fixture={act,calls,mount:(kind,text,omit=[])=>{
  const list=commands.filter(c=>!omit.includes(c.name));
  const live={model:'Muse Spark 1.3',contextPercent:63,agentWorking:false};
  const old={path:'/synthetic/old.jsonl',id:'old',title:'Ancient migration',cwd:'/synthetic/projects/legacy',activeAt:Date.now()-9e9};
  const global=kind==='global'?{sessions,currentPath:'/synthetic/b.jsonl',inChat:true,onOpenSession:p=>calls.open.push(p),searchSessions:async q=>{calls.search.push(q);return q==='ancient'?[old]:[]}}:{};
  const r=createRoot(document.getElementById('root'));r.render(kind==='inline'?h(SlashPalette,{text,commands:list,onPick:n=>calls.pick.push(n),onClose:()=>calls.close.push(false)}):
  h('div',null,h(CommandPalette,{open:true,commands:list,live,onOpenChange:v=>calls.close.push(v),onRun:(cmd,sub)=>calls.run.push([cmd.name,sub]),...global}),h(Probe)));return r;
 }};
`,[{name:'sheet-back-shell',resolveId:(id,importer)=>{
 if(importer?.endsWith('/CommandPalette.tsx')&&id==='../ui/Sheet')return '\0sheet';
 if((importer?.endsWith('/CommandPalette.tsx')||importer?.endsWith('/SlashPalette.tsx'))&&id==='../back-layer')return '\0back';return null;
},load:id=>id==='\0sheet'?`import {createElement as h} from ${JSON.stringify(require.resolve('react'))};export * from ${JSON.stringify(resolve(root,'web/src/app/ui/Sheet.tsx'))};
export const BottomSheet=({title,description,leading,subHeader,children,onOpenChange})=>h('section',{},h('h2',{},title),description?h('p',{},description):null,leading,h('button',{'data-testid':'sheet-close',onClick:()=>onOpenChange(false)},'Close'),subHeader,children);`:
 id==='\0back'?'export const useBackLayer=()=>{};':null}]);
async function fixture(t,kind='sheet',text='/mo',omit=[]){
 const dom=createDomFixture(code),w=dom.window,{act,calls}=w.fixture;let mounted;
 await act(async()=>{mounted=w.fixture.mount(kind,text,omit)});
 t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const rows=()=>Array.from(w.document.querySelectorAll('[data-testid="command-row"]'));
 return {w,act,calls,rows,row:name=>rows().find(r=>r.querySelector('[data-testid="command-name"]').textContent===name),
 type:value=>act(async()=>{const input=w.document.querySelector('input');Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new w.Event('input',{bubbles:true}))})};
}
test('full list uses flat native rows while retaining harness selector and source grouping',async t=>{
 const f=await fixture(t);assert.equal(f.w.document.querySelector('[data-slot="sheet-group"]') === null, true);assert.equal(f.rows().length,6);
 for(const row of f.rows()){assert.equal(row.tagName,'BUTTON');assert.equal(row.type,'button');assert.equal(row.dataset.slot,'row');assert.equal(row.parentElement.closest('[data-slot="row-group"]') === null, false)}
 const names=f.rows().map(r=>r.querySelector('[data-testid="command-name"]').textContent);assert.ok(names.indexOf('/model')<names.indexOf('/tasks'));assert.ok(names.indexOf('/tasks')<names.indexOf('/models'));
});
test('names aliases and full descriptions remain available with two-line visible help',async t=>{
 const f=await fixture(t);const row=f.row('/model'),desc=row.querySelector('[data-testid="command-description"]');
 assert.equal(desc.closest('.line-clamp-2') === null, false);assert.equal(desc.classList.contains('truncate'),false);assert.equal(row.querySelector('[data-testid="command-aliases"]').textContent,'/m /choose-fixture');
 assert.ok(row.getAttribute('aria-label').includes(desc.textContent));assert.ok(row.getAttribute('aria-label').includes('/m'));
});
test('live model and context details sit as the row value',async t=>{
 const f=await fixture(t);for(const [name,value]of[['/model','Muse Spark 1.3'],['/context','63%']]){
 const row=f.row(name),detail=row.querySelector('[data-testid="command-detail"]');assert.equal(detail.textContent,value);assert.equal(detail.closest('[data-slot="row-trailing"]') === null, false);assert.equal(detail.classList.contains('text-primary-text'),false);
 }
});
test('only drilled commands show a chevron and preserve exact subcommand dispatch',async t=>{
 const f=await fixture(t);const chevron=row=>row.querySelector('.lucide-chevron-right')!==null;
 assert.equal(chevron(f.row('/tasks')),true);assert.equal(chevron(f.row('/model')),false);
 // Every command leads with its source icon, on the same column as panel and action rows.
 assert.equal(f.row('/model').querySelector('[data-slot="row-leading"] svg')===null,false);
 await f.act(async()=>f.row('/tasks').click());assert.equal(f.w.document.querySelector('h2').textContent,'/tasks');assert.equal(f.row('/tasks list').querySelector('[data-testid="command-description"]').textContent,'List the work planned for this project');
 await f.act(async()=>f.row('/tasks list').click());assert.deepEqual(Array.from(f.calls.run[0]),['tasks','list']);assert.equal(f.calls.close[0],false);
});
test('search matches descriptions and aliases without changing dispatch',async t=>{
 const f=await fixture(t);await f.type('preserve');assert.equal(f.rows().length,1);assert.ok(f.row('/model'));
 await f.type('choose-fixture');assert.equal(f.rows().length,1);assert.ok(f.row('/model'));
 await f.act(async()=>f.row('/model').click());assert.deepEqual(Array.from(f.calls.run[0]),['model',undefined]);
});
test('back from a drill restores grouped commands without dismissing the sheet',async t=>{
 const f=await fixture(t);await f.act(async()=>f.row('/tasks').click());await f.act(async()=>f.w.document.querySelector('button[aria-label="Back"]').click());assert.equal(f.rows().length,6);assert.equal(f.calls.close.length,0);
});
test('no-match search keeps its existing recovery state',async t=>{
 const f=await fixture(t);await f.type('no-fixture-command');assert.equal(f.rows().length,0);assert.ok(f.w.document.body.textContent.includes('No results'));
});
test('outside a chat the palette offers actions but no panels and no injected task commands',async t=>{
 const f=await fixture(t);const groups=Array.from(f.w.document.querySelectorAll('[data-slot="row-group"] > h2')).map(n=>n.textContent);
 assert.ok(groups.includes('Actions'));assert.equal(groups.includes('Panels'),false);assert.equal(groups.includes('Sessions'),false);
 assert.deepEqual(Array.from(f.w.document.querySelectorAll('[data-testid="palette-action"]')).map(n=>n.textContent),['New session','Settings']);
});
test('in a chat the palette jumps to sessions and opens workspace panels',async t=>{
 const f=await fixture(t,'global');const groups=Array.from(f.w.document.querySelectorAll('[data-slot="row-group"] > h2')).map(n=>n.textContent);
 assert.deepEqual(groups.slice(0,3),['Sessions','Panels','Actions']);
 // The open conversation is not offered as a jump target until searched for.
 assert.deepEqual(Array.from(f.w.document.querySelectorAll('[data-testid="palette-session"]')).map(n=>n.textContent.includes('Fix login')),[true]);
 await f.act(async()=>f.w.document.querySelector('[data-testid="palette-session"]').click());assert.deepEqual(Array.from(f.calls.open),['/synthetic/a.jsonl']);assert.equal(f.calls.close[0],false);
 await f.type('files');const panel=Array.from(f.w.document.querySelectorAll('[data-testid="palette-panel"]'));assert.deepEqual(panel.map(n=>n.textContent),['Files']);
 await f.act(async()=>panel[0].click());assert.deepEqual(Array.from(f.calls.workspace).slice(-1),['files']);
});
test('a chat older than the loaded pages is found by the daemon search, once',async t=>{
 const f=await fixture(t,'global');
 await f.type('ancient');assert.equal(f.calls.search.length,0,'debounced, not per keystroke');
 await f.act(async()=>{await new Promise(r=>setTimeout(r,350))});
 assert.deepEqual(Array.from(f.calls.search),['ancient']);
 const rows=Array.from(f.w.document.querySelectorAll('[data-testid="palette-session"]'));
 assert.equal(rows.length,1);assert.ok(rows[0].textContent.includes('Ancient migration'));
 await f.act(async()=>rows[0].click());assert.deepEqual(Array.from(f.calls.open),['/synthetic/old.jsonl']);
});
test('inline menu shares the same row hierarchy and selected styling',async t=>{
 const f=await fixture(t,'inline');assert.equal(f.rows().length,2);assert.equal(f.rows()[0].getAttribute('aria-current'),'true');assert.ok(f.rows()[0].classList.contains('bg-surface-3'));
 assert.equal(f.rows()[0].querySelector('[data-testid="command-description"]').closest('.line-clamp-2') === null, false);
});
test('inline selection still dispatches the exact command',async t=>{
 const f=await fixture(t,'inline');await f.act(async()=>f.row('/models').click());assert.equal(f.calls.pick[0],'models');
});
test('uncatalogued inline names remain submit-capable rather than claiming native resolution is invalid',async t=>{
 const f=await fixture(t,'inline','/no-such-command with arguments');assert.equal(f.rows().length,0);
 assert.equal(f.w.document.querySelector('[data-testid="uncatalogued-command"]')?.textContent.includes('OMP will resolve it'),true);
 assert.equal(f.w.document.body.textContent.includes('No command named'),false);
 const event=new f.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true});
 await f.act(async()=>f.w.dispatchEvent(event));assert.equal(event.defaultPrevented,false);assert.equal(f.calls.pick.length,0);
});
// omp's /plan and /goal are TUI-only, so rpc mode omits them from the catalogue
// and cannot run them: an invented row sent "/plan" to the model as chat text.
test('palette lists only what the catalogue reports',async t=>{
 const f=await fixture(t,'sheet','/mo',['plan','goal']);assert.equal(f.rows().length,4);
 assert.equal(f.row('/plan'),undefined);assert.equal(f.row('/goal'),undefined);
});
