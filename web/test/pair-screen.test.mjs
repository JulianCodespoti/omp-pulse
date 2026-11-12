import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const code=await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {PairScreen} from ${JSON.stringify(resolve(root,'web/src/app/PairScreen.tsx'))};
import {pairingCodeFrom,defaultDeviceName} from ${JSON.stringify(resolve(root,'web/src/app/pairing-link.ts'))};
import {AuthError,DaemonApi} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
const pairs=[],connected=[];
DaemonApi.prototype.fetchJson=(path,init)=>new Promise((resolve,reject)=>pairs.push({path,body:JSON.parse(init.body),resolve,reject}));
window.lib={pairingCodeFrom,defaultDeviceName,AuthError};
window.fixture={act,pairs,connected,mount(initialCode='',beforePair,autoConnect=false,repair=false){const r=createRoot(document.getElementById('root'));r.render(h(PairScreen,{initialCode,beforePair,autoConnect,repair,onConnected:t=>connected.push(t)}));return{unmount:()=>r.unmount()}}};
`);
async function fixture(t,{initialCode='',camera=false,beforePair,autoConnect=false,native=null,repair=false}={}){
  const dom=createDomFixture(code),w=dom.window,{act,pairs,connected}=w.fixture;
  if(native)w.OmpLocal=native;
  if(camera)Object.defineProperty(w.navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>new Promise(()=>{})}});
  let mounted,unmounted=false;await act(async()=>{mounted=w.fixture.mount(initialCode,beforePair,autoConnect,repair)});
  t.after(async()=>{try{if(!unmounted)await act(async()=>mounted.unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
  const button=text=>[...w.document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
  const setValue=(el,value)=>{const set=Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set;set.call(el,value);el.dispatchEvent(new w.Event('input',{bubbles:true}))};
  return{w,act,pairs,connected,button,text:()=>w.document.body.textContent,
    unmount:()=>act(async()=>{mounted.unmount();unmounted=true}),
    click:text=>act(async()=>{assert.ok(button(text),text);button(text).click()}),
    type:(selector,value)=>act(async()=>setValue(w.document.querySelector(selector),value)),
    submit:()=>act(async()=>w.document.querySelector('form').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true})))};
}

test('pairing links and bare codes both yield the code; anything else does not',async t=>{
  const f=await fixture(t);const {pairingCodeFrom:p,defaultDeviceName:d}=f.w.lib;
  const code='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  assert.equal(p(`https://laptop.example-tailnet.ts.net/app/#pair=${code}`),code);
  assert.equal(p(`http://10.0.0.5:7681/app/#pair=${code}&s=%2Fx.jsonl`),code);
  assert.equal(p(`  ${code}\n`),code);
  assert.equal(p('https://example.com/app/'),null);
  assert.equal(p('WIFI:S:home;T:WPA;P:secret;;'),null);
  assert.equal(p('hello there'),null);
  assert.equal(d('Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.240905.015.A2; wv) AppleWebKit/537.36'),'Pixel 9');
  assert.equal(d('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36'),'Phone');
  assert.equal(d('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'),'Browser');
});

test('first screen offers Enter code; Scan QR code only where a camera can open',async t=>{
  const plain=await fixture(t);
  assert.ok(plain.text().includes('Connect to your computer'));
  assert.equal(plain.button('Scan QR code'),undefined);
  assert.equal(plain.w.document.querySelector('#pairing-code'),null);
  await plain.click('Enter code');
  assert.ok(plain.w.document.querySelector('#pairing-code'));
  assert.equal(plain.w.document.querySelector('#pairing-code').className.includes('font-mono'),false);
  const camera=await fixture(t,{camera:true});
  assert.ok(camera.button('Scan QR code'));
});

test('the repair variant has no first-run hero, tip or Android back, and says Repair pairing',async t=>{
  const f=await fixture(t,{repair:true,native:{state:()=>'{}'}});
  assert.equal(f.w.document.querySelector('h1'),null);
  assert.equal(f.w.document.querySelector('[data-testid="pair-back"]'),null);
  assert.equal(f.text().includes('Connect to your computer'),false);
  assert.equal(f.text().includes('Pair another device'),false);
  await f.click('Enter code');
  assert.ok(f.button('Repair pairing'));
  assert.equal(f.button('Connect'),undefined);
});

test('a link-delivered code lands on the filled form and pairs with the prefilled name',async t=>{
  const f=await fixture(t,{initialCode:'SYNTHETIC'});
  assert.equal(f.w.document.querySelector('#pairing-code').value,'SYNTHETIC');
  assert.equal(f.w.document.querySelector('#device-name').value,'Browser');
  await f.submit();
  assert.equal(f.pairs.length,1);assert.equal(JSON.stringify(f.pairs[0].body),JSON.stringify({code:'SYNTHETIC',name:'Browser'}));
  await f.act(async()=>f.pairs[0].resolve({token:'synthetic-token'}));
  assert.deepEqual(Array.from(f.connected),['synthetic-token']);
});

test('a code the phone app scanned itself pairs without a second tap, once',async t=>{
  const f=await fixture(t,{initialCode:'SCANNED-1',autoConnect:true});
  assert.equal(f.pairs.length,1);assert.equal(f.pairs[0].body.code,'SCANNED-1');
  await f.act(async()=>f.pairs[0].resolve({token:'scanned-token'}));
  assert.deepEqual(Array.from(f.connected),['scanned-token']);
  const plain=await fixture(t,{initialCode:'LINK-ONLY'});
  assert.equal(plain.pairs.length,0,'an ordinary pairing link still waits for Connect');
});

test('a pasted pairing link redeems just its code',async t=>{
  const f=await fixture(t);await f.click('Enter code');
  await f.type('#pairing-code','https://box.example.ts.net/app/#pair=abc123def');
  await f.submit();
  assert.equal(f.pairs[0].body.code,'abc123def');
});

test('a refused code shows a humane error tied to the code field',async t=>{
  const f=await fixture(t,{initialCode:'000000'});
  await f.submit();
  await f.act(async()=>f.pairs[0].reject(new f.w.lib.AuthError('Authentication failed',401)));
  const input=f.w.document.querySelector('#pairing-code'),error=f.w.document.querySelector('#pairing-code-error [role="alert"]');
  assert.ok(error,'the pairing failure is announced');
  assert.equal(input.getAttribute('aria-describedby'),'pairing-code-error');
  assert.equal(input.getAttribute('aria-invalid'),'true');
  assert.equal(error.textContent.startsWith('That code is wrong or expired. Get a new one on your computer.'),true);
  assert.ok(f.button('Pairing help'));
  await f.type('#pairing-code','111111');
  assert.equal(f.w.document.querySelector('#pairing-code-error'),null);
});

test('a network failure never shows the engine message',async t=>{
  const f=await fixture(t,{initialCode:'000000'});
  await f.submit();
  await f.act(async()=>f.pairs[0].reject(new f.w.TypeError('Failed to fetch')));
  assert.equal(f.w.document.querySelector('#pairing-code-error').textContent.startsWith('Couldn’t reach your computer.'),true);
  assert.equal(f.text().includes('Failed to fetch'),false);
});

test('a failed native acknowledgement keeps the fresh credential and retries only that acknowledgement',async t=>{
  const f=await fixture(t,{initialCode:'SPENT-ONCE',camera:true}),handoffs=[];
  f.w.OmpNative={senderRequired:()=>true};
  f.w.Capacitor={Plugins:{OmpNotify:{setToken:({token})=>new Promise((resolve,reject)=>handoffs.push({token,resolve,reject}))}}};
  await f.submit();
  await f.act(async()=>f.pairs[0].resolve({token:'fresh-synthetic-credential'}));
  assert.equal(f.w.localStorage.getItem('omp-remote-token'),'fresh-synthetic-credential');
  assert.equal(handoffs.length,1);
  await f.act(async()=>handoffs[0].reject(Error('synthetic acknowledgement failure')));
  assert.equal(f.connected.length,0);
  assert.equal(f.w.localStorage.getItem('omp-remote-token'),'fresh-synthetic-credential');
  assert.equal(f.w.document.querySelector('#pairing-code').disabled,true);
  assert.equal(f.button('Scan QR code instead').disabled,true);
  await f.submit();
  assert.equal(f.pairs.length,1,'spent pairing code is never redeemed again');
  assert.equal(handoffs.length,2);
  assert.equal(handoffs[1].token,'fresh-synthetic-credential');
  await f.act(async()=>handoffs[1].resolve({ok:true}));
  assert.deepEqual(Array.from(f.connected),['fresh-synthetic-credential']);
});

test('preservation failure keeps the entered code and never redeems it until persistence succeeds',async t=>{
  let attempts=0;
  const f=await fixture(t,{initialCode:'NOT-YET-SPENT',beforePair:async()=>{if(++attempts===1)throw Error('synthetic storage denial')}});
  await f.submit();
  assert.equal(f.pairs.length,0);
  assert.equal(f.w.document.querySelector('#pairing-code').value,'NOT-YET-SPENT');
  assert.equal(f.text().includes("Pairing hasn't changed."),true);
  await f.submit();
  assert.equal(attempts,2);
  assert.equal(f.pairs.length,1);
  assert.equal(f.pairs[0].body.code,'NOT-YET-SPENT');
});

test('cancelling while preservation is pending never redeems a code later',async t=>{
  let preserved;
  const f=await fixture(t,{initialCode:'CANCELLED',beforePair:()=>new Promise(resolve=>{preserved=resolve})});
  await f.submit();
  assert.equal(f.pairs.length,0);
  await f.unmount();
  await f.act(async()=>preserved());
  assert.equal(f.pairs.length,0);
  assert.equal(f.w.localStorage.getItem('omp-remote-token'),null);
});

for(const transition of ['cancel','new-pairing','forget'])test(`late redemption after leaving repair cannot override ${transition}`,async t=>{
  const f=await fixture(t,{initialCode:'CANCELLED-IN-FLIGHT'});
  f.w.localStorage.setItem('omp-remote-token','original-synthetic-pairing');
  await f.submit();assert.equal(f.pairs.length,1);
  await f.unmount();
  if(transition==='new-pairing')f.w.localStorage.setItem('omp-remote-token','newer-synthetic-pairing');
  if(transition==='forget')f.w.localStorage.removeItem('omp-remote-token');
  await f.act(async()=>f.pairs[0].resolve({token:'late-synthetic-pairing'}));
  assert.equal(f.w.localStorage.getItem('omp-remote-token'),transition==='forget'?null:transition==='new-pairing'?'newer-synthetic-pairing':'original-synthetic-pairing');
  assert.deepEqual(Array.from(f.connected),[]);
});

test('a native acknowledgement completing after Forget never reconnects the discarded pairing',async t=>{
  const f=await fixture(t,{initialCode:'ACK-THEN-FORGET'});let acknowledge;
  f.w.OmpNative={senderRequired:()=>true};
  f.w.Capacitor={Plugins:{OmpNotify:{setToken:()=>new Promise(resolve=>{acknowledge=resolve})}}};
  await f.submit();await f.act(async()=>f.pairs[0].resolve({token:'forgotten-synthetic-pairing'}));
  await f.unmount();f.w.localStorage.removeItem('omp-remote-token');
  await f.act(async()=>acknowledge({ok:true}));
  assert.equal(f.w.localStorage.getItem('omp-remote-token'),null);
  assert.deepEqual(Array.from(f.connected),[]);
});


function shell(installed=true){
  const calls=[];
  return {calls,state:()=>JSON.stringify({mode:'laptop',supported:true,installed}),setMode:m=>calls.push(['setMode',m]),connectLaptop:l=>{calls.push(['connectLaptop',l]);return '{"ok":true}'}};
}

test('in the Android app, Back leaves an unpaired computer: to the phone, or the first-run choice',async t=>{
  const native=shell(),f=await fixture(t,{native});
  await f.act(async()=>f.w.document.querySelector('[data-testid="pair-back"]').click());
  assert.deepEqual(native.calls,[['setMode','phone']]);
  const bare=shell(false),g=await fixture(t,{native:bare});
  await g.act(async()=>g.w.document.querySelector('[data-testid="pair-back"]').click());
  assert.deepEqual(bare.calls,[['setMode','unset']]);
  const browser=await fixture(t);
  assert.equal(browser.w.document.querySelector('[data-testid="pair-back"]'),null,'a browser has nowhere to go back to');
});

test('in the Android app an unpaired computer shows the one connect flow, not the code form',async t=>{
  const native=shell(),f=await fixture(t,{native});
  assert.ok(f.w.document.querySelector('[data-testid="connect-computer"]'));
  assert.equal(f.w.document.querySelector('#pairing-code'),null);
  const link='https://other.example-tailnet.ts.net/app/#pair=abc123def';
  await f.type('[data-testid="connect-computer-link"]',link);await f.submit();
  assert.deepEqual(native.calls,[['connectLaptop',link]]);
  assert.equal(f.pairs.length,0,'nothing redeemed here: the connect route pairs on arrival');
});

test('a code the app scanned itself is redeemed on arrival in the Android app too',async t=>{
  const native=shell(),f=await fixture(t,{native,initialCode:'SCANNED-2',autoConnect:true});
  assert.equal(f.pairs.length,1);assert.equal(f.pairs[0].body.code,'SCANNED-2');
});
