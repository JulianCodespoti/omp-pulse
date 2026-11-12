import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
 import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
 import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
 import {ThumbNav} from ${JSON.stringify(resolve(root,'web/src/app/chat/ThumbNav.tsx'))};
 const state={messages:[],sessionPath:'/synthetic',historyCursor:null,loadingEarlier:false,evictedBottom:0};
 const store={getState:()=>state,subscribe:()=>()=>{}};
 window.scrolls=0;
 window.fixture={act,mount:(atBottom,hidden=false)=>{
   window.atBottom=atBottom;
   const scroller=document.createElement('div');scroller.className='chat-scroll';
   Object.defineProperties(scroller,{scrollHeight:{value:1000},clientHeight:{value:200}});
   scroller.scrollTop=atBottom?800:100;document.body.append(scroller);window.scroller=scroller;
   const r=createRoot(document.getElementById('root'));
   const props={controller:{getStore:()=>store,jumpToLatest:async()=>{}},messageCount:0,hidden};
   window.renderNavigation=(patch={})=>{Object.assign(props,patch);r.render(h(ThumbNav,props));};
   window.renderNavigation();return r;
 }};
`,[{name:'synthetic-scroll-context',resolveId:id=>id==='@/components/ai-elements/transcript-viewport'?'\0viewport':id==='@/components/ai-elements/navigation-ownership'?'\0ownership':null,
 load:id=>id==='\0viewport'?'export const NEAR_BOTTOM_PX=70;export const useTranscriptViewport=()=>({following:window.atBottom,nearBottom:window.atBottom,follow:async()=>{window.scrolls++;window.atBottom=true;window.scroller.scrollTop=800;return true},release(){},scrollRef:{get current(){return window.scroller}}})':id==='\0ownership'?'const isActive=()=>false,setActive=()=>{};export const useNavigationOwnership=()=>({isActive,setActive})':null}]);
async function fixture(t,atBottom=false,hidden=false){const dom=createDomFixture(code),w=dom.window,{act}=w.fixture;let r;await act(async()=>{r=w.fixture.mount(atBottom,hidden)});t.after(async()=>{try{await act(async()=>r.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});return{w,act,el:id=>w.document.querySelector(`[data-testid="${id}"]`)}};

test('a sheet-owned screen hides the navigation entirely',async t=>{
  const f=await fixture(t,false,true);
  assert.equal(f.el('jump-nav'),null);
});

test('away from the live edge: one 44px round Down at the right edge, and no Up',async t=>{
  const f=await fixture(t);
  const nav=f.el('jump-nav'),down=f.el('jump-next');
  assert.equal(nav.getAttribute('aria-hidden'),'false');
  assert.ok(nav.className.includes('opacity-100')&&nav.className.includes('duration-[var(--dur-slow)]'),'fades over 200ms');
  // Centred, it sat over a message's own action row and hid its copy/read-aloud controls.
  assert.ok(nav.className.includes('justify-end')&&nav.className.includes('pr-4'),'Down sits at the right, clear of the action row');
  assert.equal(f.el('jump-prev'),null,'message stepping is gone; the Timeline goes back');
  for(const cls of ['rounded-full','bg-surface-2','size-11'])assert.ok(down.className.includes(cls),cls);
  assert.equal(down.tabIndex,0);
  assert.equal(down.getAttribute('aria-label'),'Jump to latest','no message below: down means latest');
});

test('at the live edge it stays mounted but faded, untappable and out of the tab order',async t=>{
  const f=await fixture(t,true);
  const nav=f.el('jump-nav');
  assert.equal(nav.getAttribute('aria-hidden'),'true');
  assert.ok(nav.className.includes('opacity-0'));
  assert.equal(f.el('jump-next').tabIndex,-1);
  assert.ok(!f.el('jump-next').className.includes('pointer-events-auto'),'never intercepts taps on the text below');
});

test('with no message below, a tap on down takes the reader to the live edge',async t=>{
  const f=await fixture(t);
  await f.act(async()=>f.el('jump-next').click());
  assert.ok(f.w.scrolls>=1);
});
