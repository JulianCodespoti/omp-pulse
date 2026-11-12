import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';

// jsdom has no layout: offsetHeight is a model. This pins the rule only.
const code=await bundleDomFixture(`
 import {retainMinHeight} from ${JSON.stringify(resolve(root,'web/src/app/chat/retain-min-height.ts'))};
 window.retainMinHeight=retainMinHeight;
`);

test('min-height grows with the reply, never shrinks, and stops once released',t=>{
  const dom=createDomFixture(code),w=dom.window;
  t.after(()=>dom.close());
  let notify=null;
  w.ResizeObserver=class{constructor(cb){notify=cb}observe(){}disconnect(){notify=null}};
  const el=w.document.createElement('div');
  let h=100;
  Object.defineProperty(el,'offsetHeight',{get:()=>h});
  const stop=w.retainMinHeight(el);
  const resize=v=>{h=v;notify?.([])};
  resize(100);assert.equal(el.style.minHeight,'100px');
  resize(240);assert.equal(el.style.minHeight,'240px');
  resize(150);assert.equal(el.style.minHeight,'240px');
  stop();assert.equal(notify,null);
});
