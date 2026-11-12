import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const stubs = {
  '../platform/push': 'export const isPushSupported=()=>false,pushStatus=()=>"unsupported",pushSubscriptionStatus=async()=>false,subscribePush=async()=>{},unsubscribePush=async()=>{};',
  '../runtime/rpc-client': 'export class DaemonApi {async fetchJson(){return {releaseId:"fixture"}}}',
  './DeviceAccess': 'export const DeviceAccess=()=>null,PairAnotherDevice=()=>null;',
  './HealthPanel': 'export const HealthPanel=()=>null,HealthDetails=()=>null;',
  './Notices': 'export const showToast=()=>{};',
  // The Providers page asks its own computer whether this device may add a provider.
  '../../runtime/rpc-client': 'const log=n=>{(window.providerCalls??=[]).push(n)};export class DaemonApi{async deviceRole(){log("role");return window.deviceRole??"read"}async listProviders(){log("list");return [{id:"anthropic",label:"Claude",signedIn:false}]}async startProviderLogin(){log("start")}async providerLoginState(){return {running:false,exitCode:null,output:""}}async sendProviderLoginInput(){log("send")}async cancelProviderLogin(){}}',
};
const code = await bundleDomFixture(`
import {createElement as h,Fragment,useState,act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {SettingsScreen} from ${JSON.stringify(resolve(root,'web/src/app/SettingsScreen.tsx'))};
import {PushedScreen} from ${JSON.stringify(resolve(root,'web/src/app/nav/PushedScreen.tsx'))};
import {BottomSheet} from ${JSON.stringify(resolve(root,'web/src/app/ui/Sheet.tsx'))};
import {openSettingsPage,openProjects,openWorkspace,closeSettings,closeProjects,resetPanels,usePanels} from ${JSON.stringify(resolve(root,'web/src/app/nav/panels.ts'))};
import {handleNativeBack} from ${JSON.stringify(resolve(root,'web/src/platform/native-back.ts'))};
const calls={prepare:0,login:0,providers:0,connected:0};
let runtime={supported:true,mode:'phone',phase:'ready',installed:true,progress:100,appUrl:null,laptopUrl:null,downloadBytes:0,ompVersion:'fixture'};
const store={getState:()=>({sessionPath:null,sessions:[],sessionsUpdatedAt:0}),subscribe:()=>()=>{}};
const controller={prepareForUpdate:async()=>{},getStore:()=>store};
function Editor(){const [text,setText]=useState('original draft');const [open,setOpen]=useState(true);return h(BottomSheet,{open,onOpenChange:setOpen,title:'Retained editor'},h('input',{'aria-label':'Retained draft',value:text,onChange:e=>setText(e.target.value)}))}
function Host(){const panels=usePanels();calls.workspace=panels.workspace;return h(Fragment,null,
 h(PushedScreen,{open:panels.projects,covered:panels.settings,onClose:closeProjects,title:'Projects',testId:'projects-layer'},h(Editor)),
 h(PushedScreen,{open:panels.settings,onClose:closeSettings,title:'Settings',testId:'settings-layer'},h(SettingsScreen,{controller,request:panels.settingsRequest,onClose:closeSettings,onConnected:()=>calls.connected++,onOpenSession:()=>{throw Error('Unexpected session navigation')}})))}
window.fixture={act,calls,open:openSettingsPage,projects:()=>openProjects(),workspace:openWorkspace,back:()=>handleNativeBack('commit'),runtime,
 mount(mode){resetPanels();runtime.mode=mode;window.OmpLocal=mode==='web'?undefined:{state:()=>JSON.stringify(runtime),access:()=>"{}",providers:()=>{calls.providers++;return JSON.stringify([{id:'anthropic',label:'Claude'}])},loginState:()=>JSON.stringify({running:false,exitCode:null,output:''}),loginStart:()=>calls.login++,loginInput:()=>{throw Error('Unexpected credential submission')},loginCancel:()=>{},grant:()=>{throw Error('Unexpected permission request')},prepare:()=>{calls.prepare++;runtime.phase='starting';runtime.error=null},setMode:()=>{throw Error('Unexpected host switch')}};const r=createRoot(document.getElementById('root'));r.render(h(Host));return ()=>r.unmount()}}
`, [{name:'recovery-settings-isolation',resolveId(id,importer){return (importer?.endsWith('/SettingsScreen.tsx')||importer?.endsWith('/ProvidersPage.tsx'))&&id in stubs?'\0stub:'+id:null},load(id){return id.startsWith('\0stub:')?stubs[id.slice(6)]:null}}]);

async function fixture(t, mode='phone') {
  const dom=createDomFixture(code), w=dom.window, f=w.fixture;
  w.Element.prototype.getAnimations=()=>[];
  let unmount;
  await f.act(async()=>{unmount=f.mount(mode)});
  t.after(async()=>{try{await f.act(async()=>unmount());assert.equal(dom.blocked.length,0)}finally{dom.close()}});
  const click=async(selector)=>{const node=w.document.querySelector(selector);assert.ok(node);await f.act(async()=>node.click())};
  return {w,f,click,open:page=>f.act(async()=>f.open(page)),back:()=>f.act(async()=>f.back()),page:()=>w.document.querySelector('[data-settings-page]:not([aria-hidden])')?.getAttribute('data-settings-page')};
}

test('direct provider recovery closes back to its origin without a phantom root page',async t=>{
  const x=await fixture(t);await x.open('providers');assert.equal(x.page(),'providers');
  await x.click('[data-settings-page="providers"] button[aria-label="Close settings"]');
  assert.equal(x.w.document.querySelector('[data-testid="settings-layer"]') === null,true);
  assert.equal(x.f.calls.login,0);
});

test('retargeting a settings page reuses its prior entry instead of stacking duplicates',async t=>{
  const x=await fixture(t);await x.open('providers');await x.open('appearance');assert.equal(x.page(),'appearance');
  await x.open('providers');assert.equal(x.page(),'providers');
  assert.equal(x.w.document.querySelectorAll('[data-settings-page="providers"]').length,1);
  await x.back();assert.equal(x.w.document.querySelector('[data-testid="settings-layer"]') === null,true);
});

for(const mode of ['web','laptop']) test(`${mode}: a read-only device lists providers but never starts a sign-in`,async t=>{
  const x=await fixture(t,mode);await x.open('providers');
  assert.equal(x.f.calls.providers,0);assert.equal(x.f.calls.login,0);
  assert.equal(x.w.document.body.textContent.includes('Only an admin device can add providers.'),true);
  assert.equal(Boolean(x.w.document.querySelector('[data-testid="provider-add"]')),false);
  assert.equal(x.w.providerCalls.includes('start'),false);
});

for(const mode of ['web','laptop']) test(`${mode}: an administrator signs in through the computer's daemon, not the phone bridge`,async t=>{
  const x=await fixture(t,mode);x.w.deviceRole='admin';await x.open('providers');
  assert.equal(x.w.providerCalls.includes('list'),true);
  const add=[...x.w.document.querySelectorAll('button')].find(b=>b.textContent==='Add a provider');assert.ok(add);
  assert.equal(x.f.calls.providers,0);assert.equal(x.f.calls.login,0);
});

test('recovering from a Projects page suspends its portal and restores its edited input on Back',async t=>{
  const x=await fixture(t);await x.f.act(async()=>x.f.projects());
  const input=x.w.document.querySelector('input[aria-label="Retained draft"]');assert.ok(input);
  await x.f.act(async()=>{Object.getOwnPropertyDescriptor(x.w.HTMLInputElement.prototype,'value').set.call(input,'edited draft');input.dispatchEvent(new x.w.Event('input',{bubbles:true}))});
  await x.open('providers');
  assert.equal(x.w.document.querySelector('[data-testid="projects-layer"]')?.hasAttribute('inert'),true);
  assert.equal(x.w.document.querySelector('[role="dialog"][data-open]') === null,true);
  await x.back();
  assert.equal(x.w.document.querySelector('[data-testid="settings-layer"]') === null,true);
  assert.equal(x.w.document.querySelector('input[aria-label="Retained draft"]')?.value,'edited draft');
  assert.equal(x.w.document.querySelector('[data-testid="projects-layer"]')?.hasAttribute('inert'),false);
});

test('runtime setup retry works when the failed runtime already owns phone mode',async t=>{
  const x=await fixture(t);x.f.runtime.phase='error';x.f.runtime.error='fixture start failure';
  await x.open('run-on');
  const retry=Array.from(x.w.document.querySelectorAll('button')).find(node=>node.textContent==='Retry setup');assert.ok(retry);
  await x.f.act(async()=>retry.click());
  assert.equal(x.f.calls.prepare,1);assert.equal(x.f.runtime.phase,'starting');
  assert.equal(x.w.document.body.textContent.includes('Retry setup'),false);
});

test('recovery Settings returns to the originating workspace instead of selecting Chat',async t=>{
  const x=await fixture(t);
  await x.f.act(async()=>x.f.workspace('changes'));
  await x.open('computer');
  assert.equal(x.f.calls.workspace,'changes');
  await x.back();
  assert.equal(x.w.document.querySelector('[data-testid="settings-layer"]') === null,true);
  assert.equal(x.f.calls.workspace,'changes');
});
