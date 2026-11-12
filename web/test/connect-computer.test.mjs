import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {ConnectComputer} from ${JSON.stringify(resolve(root,'web/src/app/ConnectComputer.tsx'))};
window.fixture={act,mount(bridge){const r=createRoot(document.getElementById('root'));r.render(h(ConnectComputer,{bridge}));return{unmount:()=>r.unmount()}}};
`);
// A shell bridge that records what the page asked of it.
function bridge(){
  const calls=[];
  return {calls,setMode:mode=>calls.push(['setMode',mode]),connectLaptop:link=>{calls.push(['connectLaptop',link]);return JSON.stringify({ok:true})}};
}
async function fixture(t,b){
  const dom=createDomFixture(code),w=dom.window,{act}=w.fixture;
  let mounted;await act(async()=>{mounted=w.fixture.mount(b)});
  t.after(async()=>{try{await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  const input=()=>w.document.querySelector('[data-testid="connect-computer-link"]');
  const setValue=(el,value)=>{const set=Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set;set.call(el,value);el.dispatchEvent(new w.Event('input',{bubbles:true}))};
  return{w,
    enter:value=>act(async()=>{setValue(input(),value);input().form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}))}),
    text:()=>w.document.body.textContent};
}
const LINK='https://box.example-tailnet.ts.net/app/#pair=abc123def';

test('a pasted pairing link connects and pairs in one native step',async t=>{
  const b=bridge(),f=await fixture(t,b);
  await f.enter(LINK);
  assert.deepEqual(b.calls,[['connectLaptop',LINK]]);
});

test('an address without a code is refused: there is no address-only route',async t=>{
  const b=bridge(),f=await fixture(t,b);
  await f.enter('https://box.example-tailnet.ts.net/app/');
  assert.deepEqual(b.calls,[]);
  assert.ok(f.text().includes('isn\u2019t a pairing link'));
});
