import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';

// jsdom has no layout: these pin the geometry decisions, not browser behaviour.
const code=await bundleDomFixture(`
 import {sendAnchorLayout} from ${JSON.stringify(resolve(root,'web/src/app/chat/SendAnchor.tsx'))};
 window.sendAnchorLayout=sendAnchorLayout;
`);
const dom=createDomFixture(code);
test.after(()=>dom.close());
const {sendAnchorLayout}=dom.window;

test('the sent message rests under the header and the scrollable area ends one viewport below it',()=>{
  const l=sendAnchorLayout({anchorTop:5000,gap:96,viewport:700});
  assert.equal(l.scrollTop,4904);
  assert.equal(l.endMarkerTop,5604);
});

test('a chat shorter than the header clearance rests at the top',()=>{
  assert.equal(sendAnchorLayout({anchorTop:96,gap:96,viewport:700}).scrollTop,0);
  assert.equal(sendAnchorLayout({anchorTop:10,gap:96,viewport:700}).scrollTop,0);
});

// The marker is kept after the turn ends and released only when removing it
// cannot move the view (SendAnchor.releaseIfHarmless, which reads live layout),
// so there is no pure geometry rule left to pin here.
