import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';

// Pins DeepSeek's release rules: 326px/s flick threshold, 50% commit, a
// spring (k=1500, zeta=0.9) that settles fast without visible overshoot.
const code=await bundleDomFixture(`
 import * as motion from ${JSON.stringify(resolve(root,'web/src/app/nav/drawer-motion.ts'))};
 window.motion=motion;
`);

test('a flick decides the target in its own direction, a slow drag commits past half',t=>{
  const dom=createDomFixture(code);
  t.after(()=>dom.close());
  const {drawerTarget}=dom.window.motion,W=360;
  assert.equal(drawerTarget(100,W,0.4),W,'fast flick toward closed commits closed from a small drag');
  assert.equal(drawerTarget(300,W,-0.4),0,'reversing flick wins over a drag that was mostly closed');
  assert.equal(drawerTarget(100,W,0.3259),0,'just under 326px/s does not count as a flick');
  assert.equal(drawerTarget(100,W,0.326),W);
  assert.equal(drawerTarget(179,W,0.1),0,'slow drag under half stays open');
  assert.equal(drawerTarget(180,W,0.1),W,'slow drag at half commits');
});

test('release velocity is the least-squares slope of the last 100ms',t=>{
  const dom=createDomFixture(code);
  t.after(()=>dom.close());
  const {releaseVelocity}=dom.window.motion;
  const line=Array.from({length:8},(_,i)=>({t:1000+i*10,x:200+i*10*0.8}));
  assert.ok(Math.abs(releaseVelocity(line,1070)-0.8)<1e-9);
  // An old fast stretch and a jittery last pair must not dominate the fit.
  const noisy=[{t:800,x:0},{t:801,x:400},...line.slice(0,7),{t:1070,x:200+70*0.8+3}];
  assert.ok(Math.abs(releaseVelocity(noisy,1075)-0.8)<0.1);
  assert.equal(releaseVelocity(line,1300),0,'a finger that rested before lifting has no velocity');
  assert.equal(releaseVelocity([{t:1,x:5}],2),0);
});

test('the spring settles under 400ms with no visible overshoot, carrying release velocity',t=>{
  const dom=createDomFixture(code);
  t.after(()=>dom.close());
  const {springFrames}=dom.window.motion,W=360;
  for(const [from,to,v] of [[W,0,0],[W/2,0,-2],[W/2,0,-5],[100,W,3],[0,W,0.4],[W/2,W,0.1]]){
    const frames=Array.from(springFrames(from,to,v));
    const last=frames[frames.length-1];
    assert.equal(last.x,to,'ends exactly at the anchor');
    assert.ok(last.ms<400,`settles in ${last.ms}ms from ${from} to ${to} at ${v}px/ms`);
    const dir=Math.sign(to-from);
    const overshoot=Math.max(...frames.map(f=>(f.x-to)*dir));
    assert.ok(overshoot<1,`overshoots ${overshoot}px from ${from} to ${to} at ${v}px/ms`);
    for(let i=1;i<frames.length;i++)assert.ok(Math.abs(frames[i].x-frames[i-1].x)<25,'no jump between frames');
  }
  // The first step already moves at the release velocity: no stall at hand-off.
  const [a,b]=Array.from(springFrames(W/2,0,-3));
  assert.ok((b.x-a.x)/(b.ms-a.ms)<-2.5,'starts near 3px/ms toward the target');
});
