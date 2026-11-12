import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';

// Real React, real TranscriptViewport, real Conversation. Layout is stubbed:
// jsdom has none, so geometry is a model, not browser evidence. Real touch and
// scroll-anchoring behaviour still needs a Chromium pass.
const require=createRequire(resolve(root,'web/package.json'));
const reactPath=JSON.stringify(require.resolve('react'));
const domPath=JSON.stringify(require.resolve('react-dom/client'));

const conversationCode=await bundleDomFixture(`
 import {createElement as h,act,useState} from ${reactPath};
 import {createRoot} from ${domPath};
 import {useTranscriptViewport} from ${JSON.stringify(resolve(root,'web/src/components/ai-elements/transcript-viewport.tsx'))};
 import {Conversation,ConversationContent} from ${JSON.stringify(resolve(root,'web/src/components/ai-elements/conversation.tsx'))};
 let viewport;
 function Probe(){viewport=useTranscriptViewport();return null}
 function Row(){
  const [open,setOpen]=useState(false);
  return h('div',null,
   h('button',{type:'button','data-testid':'row',['aria-expanded']:open,onClick:()=>{setOpen(v=>!v);window.onToggle?.()}},'row'),
   open?h('div',{'data-testid':'panel'},'detail'):null);
 }
 window.fixture={act,viewport:()=>viewport,mount:()=>{
  const r=createRoot(document.getElementById('root'));
  r.render(h(Conversation,null,h(ConversationContent,{scrollClassName:'chat-scroll'},h(Row),h(Probe))));
  return r;
 }};
`);

// A reader at scrollTop=200 sees the row at viewport y=100. layoutGrowsAbove is
// growth ABOVE the row (a late image, Shiki, a streaming block) that the browser
// does not compensate: it moves the row and the scroll height without moving scrollTop.
async function conversation(t,{scrollTop=200}={}){
  const dom=createDomFixture(conversationCode),w=dom.window,{act}=w.fixture;
  let r;await act(async()=>{r=w.fixture.mount()});
  const scroller=w.document.querySelector('.chat-scroll');
  let shift=0;
  Object.defineProperties(scroller,{scrollHeight:{get:()=>2000+shift},clientHeight:{value:600}});
  scroller.scrollTop=scrollTop;
  const row=w.document.querySelector('[data-testid="row"]');
  row.getBoundingClientRect=()=>({top:300+shift-scroller.scrollTop});
  t.after(async()=>{try{await act(async()=>r.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  const frames=ms=>new Promise(done=>w.setTimeout(done,ms));
  return{w,act,scroller,row,frames,viewport:()=>w.fixture.viewport(),
    layoutGrowsAbove(px,afterMs=0){if(afterMs>0)w.setTimeout(()=>{shift+=px},afterMs);else shift+=px},
    async scrollUp(){await act(async()=>w.fixture.viewport().release('reader'))},
    top:()=>row.getBoundingClientRect().top};
}

test('toggling a row while scrolled up keeps it where the reader tapped it',async t=>{
  const f=await conversation(t);
  await f.scrollUp();
  assert.equal(f.top(),100);
  // The panel mounts and layout above moves with it; more settles a few frames later.
  f.w.onToggle=()=>{f.layoutGrowsAbove(120);f.layoutGrowsAbove(30,20)};
  await f.act(async()=>{f.row.click();await f.frames(200)});
  assert.equal(f.w.document.querySelector('[data-testid="panel"]')!==null,true);
  assert.equal(f.top(),100,'row must stay at its viewport position');
  assert.equal(f.scroller.scrollTop,350);
});

test('collapsing keeps the row in place too',async t=>{
  const f=await conversation(t);
  await f.scrollUp();
  await f.act(async()=>f.row.click());
  assert.ok(f.w.document.querySelector('[data-testid="panel"]'));
  f.w.onToggle=()=>f.layoutGrowsAbove(-80);
  await f.act(async()=>{f.row.click();await f.frames(100)});
  assert.equal(f.w.document.querySelector('[data-testid="panel"]') === null, true);
  assert.equal(f.top(),100);
});

test('at the end the toggle is left to following',async t=>{
  const f=await conversation(t,{scrollTop:1399});
  assert.equal(f.viewport().isFollowing(),true);
  f.w.onToggle=()=>f.layoutGrowsAbove(120,10);
  await f.act(async()=>{f.row.click();await f.frames(100)});
  assert.equal(f.scroller.scrollTop,1399,'no reader correction while following owns the end');
});

test('within 70 px of the end a reader who is not following is left alone too',async t=>{
  const f=await conversation(t,{scrollTop:1399});
  await f.scrollUp();
  assert.equal(f.viewport().isFollowing(),false);
  assert.equal(f.viewport().distanceFromBottom(),1);
  f.w.onToggle=()=>f.layoutGrowsAbove(120,10);
  await f.act(async()=>{f.row.click();await f.frames(100)});
  assert.equal(f.scroller.scrollTop,1399,'the end is a flick away: no hold');
});

test('the reader scrolling takes the position back from the hold',async t=>{
  const f=await conversation(t);
  await f.scrollUp();
  await f.act(async()=>{f.row.click();f.w.document.dispatchEvent(new f.w.Event('wheel',{bubbles:true}))});
  f.layoutGrowsAbove(120);
  await f.act(async()=>{await f.frames(100)});
  assert.equal(f.scroller.scrollTop,200,'a hold must never fight a reader who is scrolling');
});

const pillCode=await bundleDomFixture(`
 import {createElement as h,act} from ${reactPath};
 import {createRoot} from ${domPath};
 import {ThumbNav} from ${JSON.stringify(resolve(root,'web/src/app/chat/ThumbNav.tsx'))};
 const state={messages:[],sessionPath:'/synthetic',historyCursor:null,loadingEarlier:false,evictedBottom:0};
 const store={getState:()=>state,subscribe:()=>()=>{}};
 window.fixture={act,state,mount:()=>{
  window.atBottom=false;
  const scroller=document.createElement('div');scroller.className='chat-scroll';
  Object.defineProperties(scroller,{scrollHeight:{value:1000},clientHeight:{value:200}});
  scroller.scrollTop=100;document.body.append(scroller);window.scroller=scroller;
  const r=createRoot(document.getElementById('root'));
  const props={controller:{getStore:()=>store},messageCount:0,hidden:false};
  window.render=(patch={})=>{Object.assign(props,patch);r.render(h(ThumbNav,props))};
  window.render();return r;
 }};
`,[{name:'synthetic-scroll-context',resolveId:id=>id==='@/components/ai-elements/transcript-viewport'?'\0viewport':id==='@/components/ai-elements/navigation-ownership'?'\0ownership':null,
 load:id=>id==='\0viewport'?'export const NEAR_BOTTOM_PX=70;export const useTranscriptViewport=()=>({following:window.atBottom,nearBottom:window.atBottom,follow:async()=>true,release(){},scrollRef:{get current(){return window.scroller}}})':id==='\0ownership'?'const isActive=()=>false,setActive=()=>{};export const useNavigationOwnership=()=>({isActive,setActive})':null}]);

async function pill(t){
  const dom=createDomFixture(pillCode),w=dom.window,{act}=w.fixture;
  let r;await act(async()=>{r=w.fixture.mount()});
  t.after(async()=>{try{await act(async()=>r.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  const button=()=>w.document.querySelector('[data-testid="jump-next"]');
  const nav=()=>w.document.querySelector('[data-testid="jump-nav"]');
  return{w,act,button,nav,
    label:()=>w.document.querySelector('[data-testid="latest-messages-count"]')?.textContent.trim()??'',
    arrive:count=>act(async()=>w.render({messageCount:count})),
    // A streamed token replaces the message objects without adding a message.
    stream:async tokens=>{for(let i=0;i<tokens;i++)await act(async()=>{w.fixture.state.messages=[{id:'a',role:'assistant',text:'x'.repeat(i)}];w.render()})},
    scrollTo:(atBottom,top)=>act(async()=>{w.atBottom=atBottom;w.scroller.scrollTop=top;w.render()})};
}

test('the button is a bare jump until something new arrives',async t=>{
  const p=await pill(t);
  assert.equal(p.label(),'');
  assert.equal(p.button().getAttribute('aria-label'),'Jump to latest');
  assert.equal(p.nav().getAttribute('aria-hidden'),'false');
});

test('Down waits until the end is more than half a viewport plus the composer away',async t=>{
  const p=await pill(t);
  // 1000 tall, 200 viewport, 112px composer fallback: shown beyond 212px from the end.
  await p.scrollTo(false,700);
  assert.equal(p.nav().getAttribute('aria-hidden'),'true','100px from the end is still reading the last lines');
  await p.scrollTo(false,500);
  assert.equal(p.nav().getAttribute('aria-hidden'),'false');
});

test('the count follows new messages, not streamed tokens',async t=>{
  const p=await pill(t);
  await p.arrive(1);
  assert.equal(p.label(),'1 new');
  await p.stream(25);
  assert.equal(p.label(),'1 new','25 token updates are still one message');
  await p.arrive(3);
  assert.equal(p.label(),'3 new');
  assert.equal(p.button().getAttribute('aria-label'),'Jump to latest, 3 new');
  assert.ok(p.button().className.includes('size-11'),'the 44px round target stays');
});

test('the count resets when the reader returns to the bottom',async t=>{
  const p=await pill(t);
  await p.arrive(2);
  assert.equal(p.label(),'2 new');
  await p.scrollTo(true,800);
  assert.equal(p.nav().getAttribute('aria-hidden'),'true','faded out at the live edge');
  assert.equal(p.button().tabIndex,-1);
  await p.scrollTo(false,100);
  assert.equal(p.label(),'','what was seen at the bottom is not new when the reader leaves again');
  await p.arrive(3);
  assert.equal(p.label(),'1 new');
});

test('arrivals while the reader is at the bottom are not unseen',async t=>{
  const p=await pill(t);
  await p.scrollTo(true,800);
  await p.arrive(4);
  await p.scrollTo(false,100);
  assert.equal(p.label(),'');
});
