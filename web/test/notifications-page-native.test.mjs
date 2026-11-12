import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const require=createRequire(resolve(root,'web/package.json'));
// The real native-notifications module runs against a stubbed Capacitor
// plugin, so the page is tested through the same bridge calls the app makes.
const stubs={
 '../../platform/push': `export const isPushSupported=()=>{throw Error('browser push must stay idle in the app')},pushStatus=()=>'unsupported',pushSubscriptionStatus=()=>{throw Error('browser push must stay idle in the app')},subscribePush=()=>{},unsubscribePush=()=>{};`,
 '../Notices': `export const showToast=(...args)=>window.toasts.push(args);`,
};
const code=await bundleDomFixture(`
import {createElement as h,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {NotificationsPage,summarizeNativeNotifications} from ${JSON.stringify(resolve(root,'web/src/app/settings/NotificationsPage.tsx'))};
window.fixture={act,summarizeNativeNotifications,mount(){const r=createRoot(document.getElementById('root'));r.render(h(NotificationsPage));return ()=>r.unmount()}};
`,[{name:'native-page-isolation',resolveId(id,importer){return /\/(NotificationsPage\.tsx|use-push-notifications\.ts)$/.test(importer??'')&&id in stubs?'\0stub:'+id:null},load(id){return id.startsWith('\0stub:')?stubs[id.slice(6)]:null}}]);
const PREFS={enabled:true,agentEnd:true,needsInput:true,alerts:true,quietEnabled:false,quietStart:22*60,quietEnd:7*60,background:true};
const STATUS={permission:'granted',bubbles:'on',paired:true,listener:'connected',batteryUnrestricted:true};
async function fixture(t,{prefs={},status={},failWrites=false}={}){
 const dom=createDomFixture(code),w=dom.window,{act}=w.fixture;w.Element.prototype.getAnimations=()=>[];
 const stored={...PREFS,...prefs},calls=[];w.toasts=[];
 const record=(name,fn)=>(...args)=>{calls.push([name,...args]);return fn(...args)};
 w.Capacitor={Plugins:{OmpNotify:{
  getNotificationPrefs:record('getPrefs',async()=>({...stored})),
  setNotificationPrefs:record('setPrefs',async changes=>{if(failWrites)throw Error('refused');Object.assign(stored,changes);return {...stored}}),
  getNotificationStatus:record('getStatus',async()=>({...STATUS,...status})),
  requestPermission:record('requestPermission',async()=>({granted:true})),
  openNotificationSettings:record('openNotificationSettings',async()=>({ok:true})),
  openBubbleSettings:record('openBubbleSettings',async()=>({ok:true})),
  openBatterySettings:record('openBatterySettings',async()=>({ok:true})),
 }}};
 let unmount;await act(async()=>{unmount=w.fixture.mount()});
 t.after(async()=>{try{await act(async()=>unmount());assert.deepEqual(dom.blocked,[])}finally{dom.close()}});
 const doc=w.document;
 const byLabel=label=>doc.querySelector(`[aria-label="${label}"]`);
 const button=text=>[...doc.querySelectorAll('button')].find(b=>b.textContent.includes(text));
 return {w,act,calls,stored,toasts:w.toasts,byLabel,button,text:()=>doc.body.textContent,
  click:el=>act(async()=>el.click()),
  setTime:(label,value)=>act(async()=>{const input=byLabel(label);Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set.call(input,value);input.dispatchEvent(new w.Event('input',{bubbles:true}))}),
  on:label=>byLabel(label).getAttribute('aria-checked')==='true'};
}
test('reads every preference through the bridge and shows them',async t=>{
 const f=await fixture(t,{prefs:{agentEnd:false,quietEnabled:true,quietStart:23*60+30}});
 assert.deepEqual(f.calls.map(c=>c[0]).sort(),['getPrefs','getStatus']);
 assert.equal(f.on('Notifications'),true);assert.equal(f.on('An agent finishes'),false);assert.equal(f.on('An agent needs you'),true);
 assert.equal(f.on('Quiet hours'),true);assert.equal(f.byLabel('Quiet hours start').value,'23:30');assert.equal(f.byLabel('Quiet hours end').value,'07:00');
 assert.ok(f.text().includes('Reaching this phone'));assert.equal(f.w.document.querySelector('details'),null);
});
test('switches write only the changed preference',async t=>{
 const f=await fixture(t);
 await f.click(f.byLabel('An agent finishes'));
 await f.click(f.byLabel('Something goes wrong'));
 await f.click(f.byLabel('Notifications'));
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls.filter(c=>c[0]==='setPrefs').map(c=>c[1]))),[{agentEnd:false},{alerts:false},{enabled:false}]);
 assert.deepEqual([f.stored.agentEnd,f.stored.alerts,f.stored.enabled],[false,false,false]);
 // Event switches follow the master switch.
 assert.equal(f.byLabel('An agent needs you').hasAttribute('data-disabled'),true);
});
test('quiet hours reveal start and end, and a picked time is saved as minutes',async t=>{
 const f=await fixture(t);
 assert.equal(f.byLabel('Quiet hours start'),null);
 await f.click(f.byLabel('Quiet hours'));
 assert.deepEqual(JSON.parse(JSON.stringify(f.calls.find(c=>c[0]==='setPrefs').slice(1))),[{quietEnabled:true}]);
 await f.setTime('Quiet hours start','21:15');await f.setTime('Quiet hours end','06:45');
 assert.deepEqual([f.stored.quietStart,f.stored.quietEnd],[21*60+15,6*60+45]);
 await f.setTime('Quiet hours end','');
 assert.equal(f.stored.quietEnd,6*60+45);
});
test('a refused write toasts and puts the switch back',async t=>{
 const f=await fixture(t,{failWrites:true});
 await f.click(f.byLabel('An agent finishes'));
 assert.equal(f.toasts.length,1);assert.equal(f.on('An agent finishes'),true);
});
test('a missing permission offers the system prompt, then re-reads',async t=>{
 const f=await fixture(t,{status:{permission:'ask'}});
 assert.ok(f.text().includes('hasn’t been allowed'));
 await f.click(f.button('Allow notifications'));
 assert.ok(f.calls.some(c=>c[0]==='requestPermission'));
 assert.equal(f.calls.filter(c=>c[0]==='getStatus').length,2);
});
test('a permanently blocked permission opens Android settings',async t=>{
 const f=await fixture(t,{status:{permission:'blocked'}});
 await f.click(f.button('Open Android settings'));
 assert.ok(f.calls.some(c=>c[0]==='openNotificationSettings'));assert.equal(f.calls.some(c=>c[0]==='requestPermission'),false);
});
test('background delivery off is fixable from the status group',async t=>{
 const f=await fixture(t,{prefs:{background:false},status:{listener:'off'}});
 await f.click(f.button('Turn on background delivery'));
 assert.equal(f.stored.background,true);
 assert.equal(f.button('Turn on background delivery'),undefined);
});
test('delivery rows open the matching Android screens',async t=>{
 const f=await fixture(t,{status:{batteryUnrestricted:false}});
 assert.ok(f.text().includes('Restricted'));
 await f.click(f.button('Bubbles'));await f.click(f.button('Battery'));await f.click(f.button('Sound and vibration'));
 assert.deepEqual(f.calls.filter(c=>c[0].startsWith('open')).map(c=>c[0]),['openBubbleSettings','openBatterySettings','openNotificationSettings']);
});
test('bubbles are hidden where Android cannot show them',async t=>{
 const f=await fixture(t,{status:{bubbles:'unsupported'}});
 assert.equal(f.button('Bubbles'),undefined);
});
test('status summary names the first blocker',t=>{
 const dom=createDomFixture(code);t.after(()=>dom.close());
 const {summarizeNativeNotifications:sum}=dom.window.fixture;
 const state=(prefs,status)=>({prefs:{...PREFS,...prefs},status:{...STATUS,...status}});
 assert.equal(sum(state({},{})).reaching,true);
 assert.equal(sum(state({},{paired:false})).fix,undefined);
 assert.equal(sum(state({enabled:false},{permission:'blocked'})).fix.run,'settings');
 assert.equal(sum(state({background:false},{batteryUnrestricted:false})).fix.run,'background');
 assert.equal(sum(state({},{batteryUnrestricted:false})).fix.run,'battery');
 assert.equal(sum(state({},{listener:'connecting'})).fix,undefined);
 assert.equal(sum(state({},{listener:'connecting'})).reaching,false);
});
