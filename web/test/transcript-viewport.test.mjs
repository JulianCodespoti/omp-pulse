import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';

// The lock decision is pure and tested without layout. The rest runs the real
// TranscriptViewport in jsdom, which has no layout either: geometry is a model
// and the ResizeObserver is driven by hand, so this pins decisions, not browser
// behaviour. Real touch, fling and scroll-anchoring behaviour still needs a
// Chromium pass.
const require=createRequire(resolve(root,'web/package.json'));
const reactPath=JSON.stringify(require.resolve('react'));
const domPath=JSON.stringify(require.resolve('react-dom/client'));

const code=await bundleDomFixture(`
 import {createElement as h,act} from ${reactPath};
 import {createRoot} from ${domPath};
 import {TranscriptViewportRoot,TranscriptViewportContent,useTranscriptViewport,decideLock} from ${JSON.stringify(resolve(root,'web/src/components/ai-elements/transcript-viewport.tsx'))};
 let viewport;
 function Probe(){viewport=useTranscriptViewport();return null}
 window.decideLock=decideLock;
 window.fixture={act,viewport:()=>viewport,
  create:()=>createRoot(document.getElementById('root')),
  render:r=>r.render(h(TranscriptViewportRoot,null,h(TranscriptViewportContent,{scrollClassName:'chat-scroll'},h(Probe)))),
 };
`);

// ---- decideLock ------------------------------------------------------------

const pure=createDomFixture(code);
after(()=>pure.close());
const FOLLOWING={kind:'following'},BY_READER={kind:'free',by:'reader'},BY_PROGRAM={kind:'free',by:'program'};
// Strings, not the returned objects: they come from another realm.
function decide(mode,event,distance){
  const next=pure.window.decideLock(mode,typeof event==='string'?{kind:event}:event,distance);
  return next.kind==='following'?'following':`free by ${next.by}`;
}

test('a reader scrolling down follows again within 24 px of the end, not beyond',()=>{
  for(const mode of [BY_READER,BY_PROGRAM]){
    const stays=`free by ${mode.by}`;
    assert.equal(decide(mode,'reader-down',0),'following');
    assert.equal(decide(mode,'reader-down',24),'following','24 px is inside');
    assert.equal(decide(mode,'reader-down',24.5),stays,'just past 24 px stays free');
    assert.equal(decide(mode,'reader-down',70),stays,'"near the end" is a UI notion, not a lock rule');
    assert.equal(decide(mode,'reader-down',5000),stays);
  }
  assert.equal(decide(FOLLOWING,'reader-down',5000),'following','nothing to undo');
});

test('a content shrink undoes a reader release but never a program release',()=>{
  assert.equal(decide(BY_PROGRAM,'shrink',0),'free by program');
  assert.equal(decide(BY_PROGRAM,'shrink',2),'free by program');
  assert.equal(decide(BY_READER,'shrink',0),'following');
  assert.equal(decide(BY_READER,'shrink',2),'following');
  assert.equal(decide(BY_READER,'shrink',2.5),'free by reader','the shrink has to leave the view at the end');
  assert.equal(decide(FOLLOWING,'shrink',900),'following');
  // Only the reader returning to the end, or follow(), undoes a program release.
  assert.equal(decide(BY_PROGRAM,'reader-down',10),'following');
  assert.equal(decide(BY_PROGRAM,'follow',5000),'following');
});

test('upward input always releases, wherever the view is',()=>{
  for(const distance of [0,1,10,24,70,5000]){
    assert.equal(decide(FOLLOWING,'reader-up',distance),'free by reader',`at ${distance}`);
    assert.notEqual(decide(BY_READER,'reader-up',distance),'following',`at ${distance}`);
    assert.notEqual(decide(BY_PROGRAM,'reader-up',distance),'following',`at ${distance}`);
  }
  assert.equal(decide(BY_PROGRAM,'reader-up',0),'free by program','a view the program freed keeps its owner');
});

test('a program release outranks a reader release and is never downgraded by one',()=>{
  assert.equal(decide(FOLLOWING,{kind:'release',by:'program'},0),'free by program');
  assert.equal(decide(BY_READER,{kind:'release',by:'program'},0),'free by program');
  assert.equal(decide(BY_PROGRAM,{kind:'release',by:'reader'},0),'free by program');
  assert.equal(decide(FOLLOWING,{kind:'release',by:'reader'},0),'free by reader');
  assert.equal(decide(BY_READER,'follow',5000),'following');
});

// ---- The viewport in jsdom -------------------------------------------------

// A ResizeObserver the test fires by hand.
function observers(w){
  const all=[];
  w.ResizeObserver=class{constructor(callback){this.callback=callback;this.targets=[];all.push(this)}observe(target){this.targets.push(target)}unobserve(){}disconnect(){this.targets=[]}};
  return{fire(target,height){for(const o of all)if(o.targets.includes(target))o.callback([{target,borderBoxSize:[{blockSize:height}]}])}};
}

// What is still scheduled, so an unmount can be shown to leave nothing behind.
// Timers with no delay are React's own scheduling stub and are not counted.
function track(w){
  const frames=new Set(),timers=new Set(),listeners=[];
  const raf=w.requestAnimationFrame.bind(w),caf=w.cancelAnimationFrame.bind(w),st=w.setTimeout.bind(w),ct=w.clearTimeout.bind(w);
  w.requestAnimationFrame=callback=>{const id=raf(time=>{frames.delete(id);callback(time)});frames.add(id);return id};
  w.cancelAnimationFrame=id=>{frames.delete(id);caf(id)};
  w.setTimeout=(callback,ms,...args)=>{const id=st(()=>{timers.delete(id);callback(...args)},ms);if(ms>0)timers.add(id);return id};
  w.clearTimeout=id=>{timers.delete(id);ct(id)};
  const proto=w.EventTarget.prototype,add=proto.addEventListener,remove=proto.removeEventListener;
  const capture=options=>typeof options==='object'&&options!==null?Boolean(options.capture):Boolean(options);
  proto.addEventListener=function(type,listener,options){listeners.push({target:this,type,listener,capture:capture(options)});return add.call(this,type,listener,options)};
  proto.removeEventListener=function(type,listener,options){
    const at=listeners.findIndex(e=>e.target===this&&e.type===type&&e.listener===listener&&e.capture===capture(options));
    if(at>=0)listeners.splice(at,1);
    return remove.call(this,type,listener,options);
  };
  return{frames,timers,listeners};
}

async function open(t,{scrollTop=0,scrollHeight=2000,clientHeight=600}={}){
  const dom=createDomFixture(code),w=dom.window,{act}=w.fixture;
  const ro=observers(w);
  const r=w.fixture.create();
  const pending=track(w);
  await act(async()=>w.fixture.render(r));
  const scroller=w.document.querySelector('.chat-scroll'),content=scroller.firstElementChild;
  const geometry={scrollHeight,clientHeight};
  Object.defineProperties(scroller,{scrollHeight:{get:()=>geometry.scrollHeight},clientHeight:{get:()=>geometry.clientHeight}});
  scroller.scrollTo=()=>{};
  scroller.scrollTop=scrollTop;
  let mounted=true;
  const unmount=async()=>{if(mounted){mounted=false;await act(async()=>r.unmount())}};
  t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  const frames=ms=>new Promise(done=>w.setTimeout(done,ms));
  return{w,act,scroller,content,geometry,ro,pending,unmount,frames,viewport:()=>w.fixture.viewport(),
    // The reader's scroll event: the browser reports it after the position changed.
    scrollEvent:top=>act(async()=>{scroller.scrollTop=top;scroller.dispatchEvent(new w.Event('scroll'));await frames(15)})};
}

function touch(w,target,type,y,x=100,touches=type==='touchend'?[]:[{clientX:x,clientY:y}]){
  const event=new w.Event(type,{bubbles:true,cancelable:true});
  event.touches=touches;
  target.dispatchEvent(event);
}

// A row inside the content whose place follows the scroll position, like a real one.
function stubRow(f){
  const row=f.w.document.createElement('div');
  f.content.append(row);
  let shift=0;
  row.getBoundingClientRect=()=>({top:300+shift-f.scroller.scrollTop});
  return{row,layoutGrowsAbove(px){shift+=px;f.geometry.scrollHeight+=px}};
}

function nestedScroller(f){
  const nested=f.w.document.createElement('div');
  nested.style.overflowY='auto';
  Object.defineProperties(nested,{scrollHeight:{value:500},clientHeight:{value:100}});
  const leaf=f.w.document.createElement('span');
  nested.append(leaf);
  f.content.append(nested);
  return leaf;
}

test('an upward drag frees the view even though streaming keeps resizing',async t=>{
  const f=await open(t,{scrollTop:1399});
  // Streaming: the content grows every frame, so scroll events land inside resize windows.
  await f.act(async()=>{f.ro.fire(f.content,2000);f.geometry.scrollHeight=2100;f.ro.fire(f.content,2100)});
  assert.equal(f.viewport().isFollowing(),true);
  await f.act(async()=>touch(f.w,f.content,'touchstart',100));
  await f.act(async()=>touch(f.w,f.content,'touchmove',105));
  assert.equal(f.viewport().isFollowing(),true,'tap jitter is not a scroll');
  await f.act(async()=>touch(f.w,f.content,'touchmove',140));
  assert.equal(f.viewport().isFollowing(),false);
  assert.equal(f.viewport().following,false);
});

test('horizontal drags and drags inside a nested scroller keep following',async t=>{
  const f=await open(t,{scrollTop:1399});
  const leaf=nestedScroller(f);
  await f.act(async()=>touch(f.w,leaf,'touchstart',100));
  await f.act(async()=>touch(f.w,leaf,'touchmove',160));
  assert.equal(f.viewport().isFollowing(),true,'a nested tool-output scroller is not the transcript');
  await f.act(async()=>touch(f.w,f.content,'touchstart',100));
  await f.act(async()=>touch(f.w,f.content,'touchmove',120,200));
  assert.equal(f.viewport().isFollowing(),true,'a sideways swipe is not a scroll up');
});

test('an upward wheel frees the view; a downward wheel and a nested scroller do not',async t=>{
  const f=await open(t,{scrollTop:1399});
  const leaf=nestedScroller(f);
  const wheel=(target,deltaY)=>f.act(async()=>target.dispatchEvent(new f.w.WheelEvent('wheel',{deltaY,bubbles:true})));
  await wheel(f.content,50);
  assert.equal(f.viewport().isFollowing(),true);
  await wheel(leaf,-50);
  assert.equal(f.viewport().isFollowing(),true,'wheeling a nested scroller is not wheeling the transcript');
  await wheel(f.content,-50);
  assert.equal(f.viewport().isFollowing(),false);
});

test('PageUp, ArrowUp, Home and Shift+Space free the view, unless typing or focused elsewhere',async t=>{
  const f=await open(t,{scrollTop:1400});
  const field=f.w.document.createElement('textarea');
  f.content.append(field);
  const outside=f.w.document.createElement('button');
  f.w.document.body.append(outside);
  const press=(target,key,init={})=>f.act(async()=>target.dispatchEvent(new f.w.KeyboardEvent('keydown',{key,bubbles:true,...init})));
  await press(field,'ArrowUp');
  assert.equal(f.viewport().isFollowing(),true,'typing in a field is not scrolling');
  await press(outside,'PageUp');
  assert.equal(f.viewport().isFollowing(),true,'focus outside the transcript is not scrolling it');
  await press(f.w.document.body,'PageDown');
  await press(f.content,' ');
  assert.equal(f.viewport().isFollowing(),true,'downward keys never free the view');
  for(const [key,init] of [['PageUp',{}],['ArrowUp',{}],['Home',{}],[' ',{shiftKey:true}]]){
    await press(f.w.document.body,key,init);
    assert.equal(f.viewport().isFollowing(),false,`${key} frees the view`);
    await f.act(async()=>{await f.viewport().follow('instant')});
    assert.equal(f.viewport().isFollowing(),true);
  }
});

test('a scroll event that moved up frees the view; the reader coming back within 24 px follows again',async t=>{
  const f=await open(t);
  await f.scrollEvent(1400);
  assert.equal(f.viewport().isFollowing(),true,'scrolling down at the end changes nothing');
  await f.scrollEvent(1000);
  assert.equal(f.viewport().isFollowing(),false);
  await f.scrollEvent(1375);
  assert.equal(f.viewport().isFollowing(),false,'25 px from the end');
  await f.scrollEvent(1376);
  assert.equal(f.viewport().isFollowing(),true,'24 px from the end');
});

test('a scroll event that moved up inside a resize window is the layout, not the reader',async t=>{
  const f=await open(t,{scrollTop:1400});
  await f.scrollEvent(1400);
  await f.act(async()=>{
    f.ro.fire(f.content,2000);
    // The content got shorter and the browser clamped scrollTop.
    f.geometry.scrollHeight=1900;
    f.scroller.scrollTop=1300;
    f.ro.fire(f.content,1900);
    f.scroller.dispatchEvent(new f.w.Event('scroll'));
    await f.frames(5);
  });
  assert.equal(f.viewport().isFollowing(),true,'a clamp is not the reader');
  await f.frames(60);
  await f.scrollEvent(1000);
  assert.equal(f.viewport().isFollowing(),false,'once the window has closed, up is the reader again');
});

test('a program scrollTo is not the reader: it neither frees nor re-locks',async t=>{
  const f=await open(t,{scrollTop:1400});
  await f.scrollEvent(1400);
  await f.act(async()=>f.viewport().scrollTo(300));
  await f.scrollEvent(300);
  assert.equal(f.viewport().isFollowing(),true,'moving up by a program write is not an escape');
  await f.act(async()=>f.viewport().release('program'));
  await f.act(async()=>f.viewport().scrollTo(1395));
  await f.scrollEvent(1395);
  assert.equal(f.viewport().isFollowing(),false,'arriving at the end by a program write is not the reader returning');
});

test('a smooth program scroll is ignored for lock decisions until scrollend',async t=>{
  const f=await open(t,{scrollTop:1400});
  await f.scrollEvent(1400);
  await f.act(async()=>f.viewport().scrollTo(300,{smooth:true}));
  await f.scrollEvent(1000);
  assert.equal(f.viewport().isFollowing(),true,'the animation travels up; that is not the reader');
  await f.act(async()=>f.scroller.dispatchEvent(new f.w.Event('scrollend')));
  await f.scrollEvent(900);
  assert.equal(f.viewport().isFollowing(),false,'after scrollend a move up is the reader again');
});

test('a program release stays through a content shrink; a reader release does not',async t=>{
  const f=await open(t);
  const shrinkTo=(height,top)=>f.act(async()=>{f.geometry.scrollHeight=height;f.scroller.scrollTop=top;f.ro.fire(f.content,height)});
  await f.act(async()=>f.ro.fire(f.content,2000));
  assert.equal(f.scroller.scrollTop,1400,'opening went to the end');
  await f.act(async()=>f.viewport().release('program'));
  // The browser clamps scrollTop to the new end before the observer reports.
  await shrinkTo(1900,1300);
  assert.equal(f.viewport().isFollowing(),false,'a shorter reply must not undo a program release');
  await f.act(async()=>{await f.viewport().follow('instant')});
  await f.act(async()=>f.viewport().release('reader'));
  assert.equal(f.viewport().isFollowing(),false);
  await shrinkTo(1800,1200);
  assert.equal(f.viewport().isFollowing(),true,'the reader left and the end came to them');
});

test('opening writes the end inside the first measurement and follows growth in the same callback until the reader acts',async t=>{
  const f=await open(t,{scrollTop:0});
  const seen=[];
  await f.act(async()=>{
    f.ro.fire(f.content,2000);
    seen.push(f.scroller.scrollTop);
    f.geometry.scrollHeight=2600;
    f.ro.fire(f.content,2600);
    seen.push(f.scroller.scrollTop);
    touch(f.w,f.content,'touchstart',100);
    f.geometry.scrollHeight=3200;
    f.ro.fire(f.content,3200);
    seen.push(f.scroller.scrollTop);
  });
  assert.deepEqual(seen,[1400,2000,2000],'nothing animates while opening; after the first gesture the spring takes over');
});

test('follow resolves true on arrival and false when the reader takes over',async t=>{
  const f=await open(t,{scrollTop:200});
  await f.act(async()=>f.viewport().release('program'));
  assert.equal(f.viewport().following,false);
  let arrived;
  await f.act(async()=>{arrived=await f.viewport().follow('instant')});
  assert.equal(arrived,true);
  assert.equal(f.scroller.scrollTop,1400);
  assert.equal(f.viewport().following,true);
  await f.act(async()=>f.viewport().release('program'));
  f.scroller.scrollTop=200;
  let interrupted;
  await f.act(async()=>{interrupted=f.viewport().follow('smooth');f.viewport().release('program')});
  assert.equal(await interrupted,false);
});

test('the keyboard opening keeps a following reader on the newest message',async t=>{
  const f=await open(t,{scrollTop:1400});
  await f.act(async()=>f.ro.fire(f.scroller));
  f.geometry.clientHeight=300;
  await f.act(async()=>f.ro.fire(f.scroller));
  assert.equal(f.scroller.scrollTop,1700,'pinned to the new end');
});

test('a reader within 48 px of the end before the resize is pinned to it',async t=>{
  const f=await open(t,{scrollTop:1360});
  await f.act(async()=>f.viewport().release('reader'));
  await f.act(async()=>f.ro.fire(f.scroller));
  f.geometry.clientHeight=540;
  await f.act(async()=>f.ro.fire(f.scroller));
  assert.equal(f.scroller.scrollTop,1460);
});

test('a reader scrolled up keeps the bottom edge of what they see when the scroller resizes',async t=>{
  const f=await open(t,{scrollTop:800});
  await f.act(async()=>f.viewport().release('program'));
  await f.act(async()=>f.ro.fire(f.scroller));
  f.geometry.clientHeight=300;
  await f.act(async()=>f.ro.fire(f.scroller));
  assert.equal(f.scroller.scrollTop,1100,'the bottom edge stays at 1400: 800 + 600 before, 1100 + 300 after');
  f.geometry.clientHeight=600;
  await f.act(async()=>f.ro.fire(f.scroller));
  assert.equal(f.scroller.scrollTop,800,'and closing the keyboard puts it back');
});

test('a hold adopts a view somebody else moved instead of pulling it back',async t=>{
  const f=await open(t,{scrollTop:200});
  await f.act(async()=>f.viewport().release('reader'));
  const {row}=stubRow(f);
  f.viewport().hold(row,100,{persistent:true});
  // A fling, or native scroll anchoring, moved the view; the row went with it.
  f.scroller.scrollTop=260;
  await f.act(async()=>{await f.frames(80)});
  assert.equal(f.scroller.scrollTop,260,'writing the old offset back is the 964 px yank');
});

test('a finger on the scroller keeps a hold from writing, and what it adopts becomes the goal',async t=>{
  const f=await open(t,{scrollTop:200});
  await f.act(async()=>f.viewport().release('reader'));
  const {row,layoutGrowsAbove}=stubRow(f);
  await f.act(async()=>touch(f.w,row,'touchstart',100));
  f.viewport().hold(row,100,{persistent:true});
  layoutGrowsAbove(120);
  await f.act(async()=>{await f.frames(60)});
  assert.equal(f.scroller.scrollTop,200,'no write against a finger');
  await f.act(async()=>touch(f.w,row,'touchend',100));
  layoutGrowsAbove(40);
  await f.act(async()=>{await f.frames(60)});
  assert.equal(f.scroller.scrollTop,240,'only the drift after the finger lifted is corrected');
});

test('one hold at a time: a new hold, cancel() and follow() each end the previous one',async t=>{
  const f=await open(t,{scrollTop:200});
  await f.act(async()=>f.viewport().release('reader'));
  const {row}=stubRow(f);
  const ended=[];
  const watch=(name,hold)=>hold.done.then(()=>ended.push(name));
  watch('first',f.viewport().hold(row,100,{persistent:true}));
  const second=f.viewport().hold(row,100,{persistent:true});
  watch('second',second);
  await f.frames(1);
  assert.deepEqual(ended,['first']);
  second.cancel();
  watch('third',f.viewport().hold(row,100,{persistent:true}));
  await f.frames(1);
  assert.deepEqual(ended,['first','second']);
  await f.act(async()=>{await f.viewport().follow('instant')});
  await f.frames(1);
  assert.deepEqual(ended,['first','second','third']);
});

test('unmounting leaves no frame, timer or listener, and settles what was pending',async t=>{
  const f=await open(t,{scrollTop:200});
  const {row}=stubRow(f);
  assert.equal(f.pending.listeners.length>0,true,'the spy sees the listeners');
  let following,held;
  await f.act(async()=>{
    following=f.viewport().follow('smooth');
    f.ro.fire(f.content,2000);
    f.scroller.scrollTop=1000;
    f.scroller.dispatchEvent(new f.w.Event('scroll'));
    f.viewport().scrollTo(100,{smooth:true});
    held=f.viewport().hold(row,100,{persistent:true});
  });
  assert.equal(f.pending.frames.size>0,true);
  assert.equal(f.pending.timers.size>0,true);
  await f.unmount();
  assert.equal(f.pending.frames.size,0,'no animation frame');
  assert.equal(f.pending.timers.size,0,'no timer');
  // Focus-visible tracking from other components listens on the window for the
  // life of the page; the viewport's own targets are the scroller and document.
  const own=f.pending.listeners.filter(e=>e.target!==f.w);
  assert.equal(own.length,0,'no listener');
  assert.equal(await following,false,'a follow that never arrived is settled, not left hanging');
  await held.done;
});
