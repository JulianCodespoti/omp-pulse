import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
const stubs={
 '../../platform/push': `export const isPushSupported=()=>window.services.supported!==false,pushStatus=()=>window.services.permission,pushSubscriptionStatus=()=>window.services.read(),subscribePush=()=>window.services.mutate(true),unsubscribePush=()=>window.services.mutate(false);`,
 '../../platform/native-notifications': `export const hasNativeNotificationControls=()=>false,openNativeSettings=()=>{},readNativeNotificationPrefs=()=>{},readNativeNotificationStatus=()=>{},requestNativeNotificationPermission=()=>{},writeNativeNotificationPrefs=()=>{};`,
 '../Notices': `export const showToast=()=>{throw Error('Unexpected toast')};`,
};
const code=await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {NotificationsPage} from ${JSON.stringify(resolve(root,'web/src/app/settings/NotificationsPage.tsx'))};
const reads=[],mutations=[];
window.services={permission:'granted',read:()=>new Promise((resolve,reject)=>reads.push({resolve,reject})),mutate:checked=>new Promise((resolve,reject)=>mutations.push({checked,resolve,reject}))};
window.fixture={act,reads,mutations,mount(){const r=createRoot(document.getElementById('root'));const render=(open=true)=>r.render(open?h(NotificationsPage):null);render();return {render,unmount:()=>r.unmount()}}};
`,[{name:'settings-platform-isolation',resolveId(id,importer){return /\/(NotificationsPage\.tsx|use-push-notifications\.ts)$/.test(importer??'')&&id in stubs?'\0stub:'+id:null},load(id){return id.startsWith('\0stub:')?stubs[id.slice(6)]:null}}]);
async function fixture(t,{permission='granted',supported=true}={}){
 const dom=createDomFixture(code),w=dom.window,{act,reads,mutations}=w.fixture;w.Element.prototype.getAnimations=()=>[];
 w.services.permission=permission;w.services.supported=supported;
 let mounted,unmounted=false;await act(async()=>{mounted=w.fixture.mount()});
 const unmount=async()=>{if(!unmounted){unmounted=true;await act(async()=>mounted.unmount())}};
 t.after(async()=>{try{await unmount();assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 return {w,act,reads,mutations,unmount,render:v=>act(async()=>mounted.render(v)),switch:()=>w.document.querySelector('[role="switch"]'),text:()=>w.document.body.textContent,
 read:(i,value)=>act(async()=>reads[i].resolve(value)),failRead:(i,message)=>act(async()=>reads[i].reject(new Error(message))),finish:i=>act(async()=>mutations[i].resolve()),fail:(i,message)=>act(async()=>mutations[i].reject(new Error(message))),
 toggle:()=>act(async()=>w.document.querySelector('[role="switch"]').click())};
}
const checked=f=>f.switch().getAttribute('aria-checked');
const locked=f=>f.switch().hasAttribute('data-disabled');
for(const stale of [false,null])test(`initial ${stale} cannot overwrite successful enable`,async t=>{const f=await fixture(t);await f.toggle();await f.finish(0);await f.read(1,true);await f.read(0,stale);assert.equal(checked(f),'true')});
test('initial read resolving during a toggle cannot publish stale subscription',async t=>{const f=await fixture(t);await f.toggle();await f.read(0,true);assert.equal(checked(f),'false');await f.finish(0);await f.read(1,false);assert.equal(checked(f),'false')});
test('same-tick repeated taps start one device mutation',async t=>{const f=await fixture(t);await f.read(0,false);await f.act(async()=>{f.switch().click();f.switch().click()});assert.equal(f.mutations.length,1);await f.finish(0);await f.read(1,true)});
test('enable then disable preserves both device-scoped intents',async t=>{const f=await fixture(t);await f.read(0,false);await f.toggle();await f.finish(0);await f.read(1,true);await f.toggle();assert.deepEqual(Array.from(f.mutations,m=>m.checked),[true,false]);await f.finish(1);await f.read(2,false);assert.equal(checked(f),'false');assert.equal(locked(f),false)});
test('closing and reopening Settings reads afresh',async t=>{const f=await fixture(t);await f.render(false);await f.render(true);await f.read(1,true);await f.read(0,false);assert.equal(checked(f),'true')});
test('reopening clears the previous mutation error',async t=>{const f=await fixture(t);await f.read(0,true);await f.toggle();await f.fail(0,'Current failure');await f.read(1,true);assert.ok(f.text().includes('Current failure.'));await f.render(false);await f.render(true);assert.equal(f.text().includes('Current failure'),false);await f.read(2,false)});
test('pending mutation stays locked across reopening and refreshes its new view',async t=>{const f=await fixture(t);await f.read(0,false);await f.toggle();await f.render(false);await f.render(true);await f.read(1,false);assert.equal(locked(f),true);await f.toggle();assert.equal(f.mutations.length,1);await f.finish(0);await f.read(2,true);assert.equal(checked(f),'true');assert.equal(locked(f),false)});
test('old mutation error cannot surface in reopened view',async t=>{const f=await fixture(t);await f.read(0,false);await f.toggle();await f.render(false);await f.render(true);await f.read(1,false);await f.fail(0,'Old failure');await f.read(2,false);assert.equal(f.text().includes('Old failure'),false);assert.equal(locked(f),false)});
test('mutation completion while closed does not start a read',async t=>{const f=await fixture(t);await f.read(0,false);await f.toggle();await f.render(false);await f.finish(0);assert.equal(f.reads.length,1);await f.render(true);await f.read(1,true);assert.equal(checked(f),'true');assert.equal(locked(f),false)});
test('unmount prevents mutation follow-up reads',async t=>{const f=await fixture(t);await f.toggle();await f.unmount();await f.finish(0);assert.equal(f.reads.length,1)});
test('stale read rejection cannot replace newer success or error feedback',async t=>{const f=await fixture(t);await f.toggle();await f.finish(0);await f.read(1,true);await f.failRead(0,'Old read failure');assert.equal(f.text().includes('Old read failure'),false);assert.equal(checked(f),'true');assert.equal(locked(f),false)});
test('current refresh failure releases mutation lock for retry',async t=>{const f=await fixture(t);await f.read(0,false);await f.toggle();await f.finish(0);await f.failRead(1,'Current read failure');assert.ok(f.text().includes('Current read failure.'));assert.equal(locked(f),false);await f.toggle();assert.equal(f.mutations.length,2);await f.finish(1);await f.read(2,true);assert.equal(f.text().includes('Current read failure'),false);assert.equal(checked(f),'true')});
test('network failure reads as the computer being unreachable',async t=>{const f=await fixture(t);await f.failRead(0,'Failed to fetch');assert.ok(f.text().includes('Couldn’t reach your computer.'));assert.equal(f.text().includes('Failed to fetch'),false)});
test('blocked permission shows the fix once, inline, with no switch',async t=>{const f=await fixture(t,{permission:'denied'});await f.read(0,false);assert.equal(f.switch(),null);assert.equal(f.text().split('Blocked for this site').length,2);assert.ok(f.text().includes('Allow notifications for this site in your browser’s settings'));assert.equal(f.w.document.querySelector('details'),null);await f.act(async()=>[...f.w.document.querySelectorAll('button')].find(b=>b.textContent==='Check again').click());assert.equal(f.reads.length,2);await f.read(1,false)});
test('an unsupported browser says why and offers no switch',async t=>{const f=await fixture(t,{permission:'unsupported',supported:false});await f.read(0,null);assert.equal(f.switch(),null);assert.ok(f.text().includes('Needs a secure connection'))});
