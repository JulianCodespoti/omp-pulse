import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';
const code=await bundleDomFixture(`
 import {createOmpStore} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-store.ts'))};
 import {OmpSessionController} from ${JSON.stringify(resolve(root,'web/src/runtime/omp-session-controller.ts'))};
 import {reduceExtensionUiRequest,EMPTY_EXTENSION_DIALOGS} from ${JSON.stringify(resolve(root,'web/src/runtime/extension-dialogs.ts'))};
 window.fixture={create(){
   const store=createOmpStore(),frames=[],pending=new Map();let revision=0,nextToken=0,lastQuestionEvent;
   const controller=new OmpSessionController(store,'synthetic-question-token','http://synthetic.invalid');
   controller.runningAgentCount.stop();controller.stopOfflineTicker();
   const socket=()=>({readyState:1,send:raw=>frames.push(JSON.parse(raw)),close(){this.readyState=3}});
   const host=path=>{if(!pending.has(path))pending.set(path,new Map());return pending.get(path)};
   const lifecycle=path=>({sessionPath:path,generation:'daemon-a',revision:++revision});
   const rawEvent=(event,generation=controller.generation,path=controller.activeSession)=>controller.handleEventFrame({type:'event',event},generation,path);
   const snapshot=(requests=Array.from(host(controller.activeSession).values()))=>rawEvent({type:'collab_ui_snapshot',complete:true,lifecycle:lifecycle(controller.activeSession),requests});
   const event=(event,generation=controller.generation,path=controller.activeSession)=>{
     if(event.type==='collab_ui_request'){
       if(!controller.collabQuestionCursor||controller.collabQuestionCursor.sessionPath!==path)snapshot();
       const old=host(path).get(event.request.reqId);
       const request={...event.request,pulseRoomId:'room-a',pulseQuestionToken:old?.pulseQuestionToken??('daemon-a:'+ ++nextToken)};
       host(path).set(request.reqId,request);event={...event,request,lifecycle:lifecycle(path)};lastQuestionEvent=event;
     }else if(event.type==='collab_ui_request_end'&&typeof event.reqId==='number'){
       const old=host(path).get(event.reqId);host(path).delete(event.reqId);
       event={...event,pulseQuestionToken:old?.pulseQuestionToken??null,lifecycle:lifecycle(path)};
     }else if(event.type==='ui_response_ack'){
       event={...event,pulseQuestionToken:event.pulseQuestionToken??host(path).get(event.reqId)?.pulseQuestionToken};
     }
     rawEvent(event,generation,path);
   };
   const switchTo=path=>{controller.closeSocket();controller.generation++;controller.activeSession=path;controller.collabQuestionCursor=null;controller.currentCollabQuestion=null;store.getState().beginSession(path);controller.socket=socket()};
   const request=(reqId=7,title='Question')=>event({type:'collab_ui_request',request:{reqId,kind:'editor',title}});
   switchTo('/a');request();
   return {controller,store,frames,event,rawEvent,request,switchTo,socket,snapshot,lastQuestion:()=>lastQuestionEvent,missEnd:reqId=>{host(controller.activeSession).delete(reqId);revision++},extension:id=>store.getState().setExtensionDialogs(()=>reduceExtensionUiRequest(EMPTY_EXTENSION_DIALOGS,{id,method:'input',title:'Extension question'},0))};
 }};
`,[{name:'controller-fixture-meta',transform(code,id){if(id.endsWith('/omp-session-controller.ts'))return code.replaceAll('import.meta',JSON.stringify({env:{VITE_PROTOCOL_VERSION:1,VITE_RELEASE_ID:'unit'}}));}}]);
function fixture(t){
 const dom=createDomFixture(code),w=dom.window;w.WebSocket.OPEN=1;
 const f=w.fixture.create();t.after(()=>{f.controller.dispose();assert.deepEqual(dom.blocked,[]);dom.close()});return f;
}
test('one dispatch stays sending, queued and handed off until exact host request-end',t=>{
 const f=fixture(t);f.controller.sendCollabUiResponse(7, '  exact answer  ', f.store.getState().collabRequest.pulseQuestionToken);f.controller.sendCollabUiResponse(7, 'duplicate', f.store.getState().collabRequest.pulseQuestionToken);
 assert.equal(f.frames.length,1);assert.equal(f.store.getState().collabRequest.reqId,7);assert.equal(f.store.getState().collabAnswer.phase,'sending');
 f.event({type:'ui_response_ack',reqId:7,ok:true,queued:true});assert.equal(f.store.getState().collabAnswer.phase,'queued');
 f.event({type:'ui_response_ack',reqId:7,ok:true});assert.equal(f.store.getState().collabAnswer.phase,'handoff');assert.equal(f.store.getState().collabAnswer.value,'  exact answer  ');
 f.controller.sendCollabUiResponse(7, 'duplicate', f.store.getState().collabRequest.pulseQuestionToken);assert.equal(f.frames.length,1);
 f.event({type:'collab_ui_request_end',reqId:8});f.event({type:'collab_ui_request_end'});assert.equal(f.store.getState().collabRequest.reqId,7);
 f.event({type:'collab_ui_request_end',reqId:7});assert.equal(f.store.getState().collabRequest,null);assert.equal(f.store.getState().collabAnswer,null);assert.equal(f.controller.collabAnswers.size,0);
});
test('returned refusal reason/value survives, but only exact actionable request can retry',t=>{
 const f=fixture(t);f.controller.sendCollabUiResponse(7, 'keep', f.store.getState().collabRequest.pulseQuestionToken);f.event({type:'ui_response_ack',reqId:7,ok:false,error:'view-only link',actionable:true});
 assert.equal(f.store.getState().collabAnswer.reason,'view-only link');assert.equal(f.store.getState().collabAnswer.value,'keep');
 f.controller.sendCollabUiResponse(7, 'keep', f.store.getState().collabRequest.pulseQuestionToken);assert.equal(f.frames.length,2);
 f.event({type:'ui_response_ack',reqId:7,ok:false,error:'that question is no longer waiting',actionable:false});f.controller.sendCollabUiResponse(7, 'keep', f.store.getState().collabRequest.pulseQuestionToken);assert.equal(f.frames.length,2);assert.equal(f.store.getState().collabAnswer.phase,'unavailable');
 f.request(8);f.controller.sendCollabUiResponse(7, 'stale', f.store.getState().collabRequest.pulseQuestionToken);assert.equal(f.frames.length,2);assert.equal(f.store.getState().collabAnswer,null);
 f.event({type:'ui_response_ack',reqId:7,ok:true});assert.equal(f.store.getState().collabAnswer,null,'old ack does not paint question 8');
});
test('session round-trip retains held answer and requires matching replay before one automatic handoff',t=>{
 const f=fixture(t);f.controller.socket=null;f.controller.sendCollabUiResponse(7, 'held draft', f.store.getState().collabRequest.pulseQuestionToken);assert.equal(f.store.getState().collabAnswer.phase,'held');
 const oldGeneration=f.controller.generation;f.switchTo('/b');f.request(7);assert.equal(f.store.getState().collabAnswer,null);
 f.event({type:'ui_response_ack',reqId:7,ok:false,error:'late'},oldGeneration,'/a');assert.equal(f.store.getState().collabAnswer,null);
 f.switchTo('/a');f.controller.flushHeldCollabResponse();assert.equal(f.frames.length,0,'no known current request after switching');
 f.request(7);assert.equal(f.frames.length,1);assert.equal(f.frames[0].value,'held draft');assert.equal(f.store.getState().collabAnswer.phase,'sending');
 f.request(7);assert.equal(f.frames.length,1,'replay cannot duplicate the handoff');
});
test('lost acknowledgement preserves uncertain value and never automatically resends',t=>{
 const f=fixture(t);f.controller.sendCollabUiResponse(7, 'possibly sent', f.store.getState().collabRequest.pulseQuestionToken);f.controller.closeSocket();assert.equal(f.store.getState().collabAnswer.phase,'uncertain');
 f.controller.socket=f.socket();f.request(7);f.controller.flushHeldCollabResponse();f.controller.sendCollabUiResponse(7, 'possibly sent', f.store.getState().collabRequest.pulseQuestionToken);assert.equal(f.frames.length,1);assert.equal(f.store.getState().collabAnswer.value,'possibly sent');
});
test('bounded cache refuses a new handoff without discarding any outstanding answer',t=>{
 const f=fixture(t);
 for(let id=1;id<=64;id++){f.request(id);f.controller.sendCollabUiResponse(id, String(id), f.store.getState().collabRequest.pulseQuestionToken)}
 assert.equal(f.controller.collabAnswers.size,64);assert.equal(f.frames.length,64);
 f.request(65);f.controller.sendCollabUiResponse(65, 'keep new draft', f.store.getState().collabRequest.pulseQuestionToken);assert.equal(f.frames.length,64);assert.equal(f.controller.collabAnswers.size,64);assert.equal(f.store.getState().collabAnswer.value,'keep new draft');assert.equal(f.store.getState().collabAnswer.phase,'rejected');
 f.controller.dispose();assert.equal(f.controller.collabAnswers.size,0);assert.equal(f.store.getState().collabAnswer,null);
});
test('late child HTTP completion after switch-away/back cannot close a reused request id',async t=>{
 const f=fixture(t);f.extension('same');let resolve;
 f.controller.request=()=>new Promise(r=>{resolve=r});const attempt=f.controller.answerExtensionDialog('same',{value:'old'},'/a');
 f.switchTo('/b');f.switchTo('/a');f.extension('same');resolve({ok:true,delivery:'handoff'});await attempt;
 assert.equal(f.store.getState().extensionDialogs.pending.length,1);assert.equal(f.store.getState().extensionDialogs.pending[0].id,'same');
 await assert.rejects(f.controller.answerExtensionDialog('same',{value:'wrong owner'},'/b'),/another session/);
});
test('native HTTP success marks transport handoff without retiring the callback',async t=>{
 const f=fixture(t);f.extension('native');f.controller.request=async()=>({ok:true,delivery:'handoff'});
 await f.controller.answerExtensionDialog('native',{value:'keep draft'},'/a');
 assert.equal(f.store.getState().extensionDialogs.pending.length,1);assert.equal(f.store.getState().extensionDialogs.closed.length,0);assert.equal(f.store.getState().extensionDialogs.pending[0].delivery,'handoff');
 f.event({type:'extension_ui_response_ack',id:'other',phase:'uncertain'});assert.equal(f.store.getState().extensionDialogs.pending[0].delivery,'handoff');
 f.event({type:'extension_ui_request',id:'settled',method:'cancel',targetId:'native'});assert.equal(f.store.getState().extensionDialogs.pending.length,0);
});
test('complete reconnect snapshot retires a retained answer after missed exact host end',t=>{
 const f=fixture(t),oldRequest=f.lastQuestion();
 f.controller.sendCollabUiResponse(7, 'possibly sent', f.store.getState().collabRequest.pulseQuestionToken);
 f.controller.closeSocket();assert.equal(f.store.getState().collabAnswer.phase,'uncertain');
 f.missEnd(7);f.controller.socket=f.socket();f.snapshot();
 assert.equal(f.store.getState().collabRequest,null);assert.equal(f.store.getState().collabAnswer,null);assert.equal(f.controller.collabAnswers.size,0);
 f.rawEvent(oldRequest);assert.equal(f.store.getState().collabRequest,null,'queued pre-snapshot replay cannot resurrect the card');
 assert.equal(f.frames.length,1,'settlement reconciliation never retries an uncertain value');
 f.request(8);f.controller.sendCollabUiResponse(8, 'new answer', f.store.getState().collabRequest.pulseQuestionToken);assert.equal(f.frames.length,2);
});
test('a restarted daemon empty snapshot cannot claim closure of prior-generation uncertainty',t=>{
 const f=fixture(t);f.controller.sendCollabUiResponse(7, 'retained across daemon restart', f.store.getState().collabRequest.pulseQuestionToken);f.controller.closeSocket();f.controller.socket=f.socket();
 f.rawEvent({type:'collab_ui_snapshot',complete:true,lifecycle:{sessionPath:'/a',generation:'daemon-b',revision:0},requests:[]});
 assert.equal(f.controller.collabAnswers.size,1);assert.equal(f.store.getState().collabAnswer.value,'retained across daemon restart');
 assert.equal(f.store.getState().collabAnswer.phase,'uncertain');assert.equal(f.frames.length,1);
});
test('new daemon may reuse reqId without inheriting uncertainty or receiving an old-token ACK',t=>{
 const f=fixture(t);f.controller.sendCollabUiResponse(7, 'old uncertain value', f.store.getState().collabRequest.pulseQuestionToken);
 const oldToken=f.store.getState().collabAnswer.question.token;
 f.controller.closeSocket();f.controller.socket=f.socket();
 const newToken='daemon-b:1';
 f.rawEvent({type:'collab_ui_snapshot',complete:true,lifecycle:{sessionPath:'/a',generation:'daemon-b',revision:1},requests:[{reqId:7,kind:'editor',title:'New question',pulseRoomId:'new-room',pulseQuestionToken:newToken}]});
 assert.equal(f.store.getState().collabAnswer,null);
 f.controller.sendCollabUiResponse(7, 'distinct new answer', f.store.getState().collabRequest.pulseQuestionToken);
 assert.equal(f.frames.length,2);assert.equal(f.frames[1].pulseQuestionToken,newToken);
 assert.equal(f.controller.collabAnswers.size,2,'old uncertainty survives under its full identity');
 f.rawEvent({type:'ui_response_ack',reqId:7,pulseQuestionToken:oldToken,ok:true});
 assert.equal(f.store.getState().collabAnswer.value,'distinct new answer');
 assert.equal(f.store.getState().collabAnswer.phase,'sending','old ACK cannot mutate the replacement');
 f.rawEvent({type:'ui_response_ack',reqId:7,pulseQuestionToken:newToken,ok:true});
 assert.equal(f.store.getState().collabAnswer.phase,'handoff');
});
test('64 retained drafts refuse a new identity without eviction and exact closure frees its slot',t=>{
 const f=fixture(t);
 for(let id=1;id<=64;id++){
   f.request(id);f.controller.setCollabAnswerDraft(id,'Draft '+id,f.store.getState().collabRequest.pulseQuestionToken);
 }
 assert.equal(f.controller.collabAnswers.size,64);assert.equal(f.frames.length,0);
 f.request(65);assert.equal(f.controller.canRetainCollabAnswer(),false);
 const overflowToken=f.store.getState().collabRequest.pulseQuestionToken;
 f.controller.setCollabAnswerDraft(65,'Overflow must not evict',overflowToken);
 assert.equal(f.controller.collabAnswers.size,64);
 assert.equal(Array.from(f.controller.collabAnswers.values()).some(answer=>answer.value==='Overflow must not evict'),false);
 f.request(1);assert.equal(f.store.getState().collabAnswer.value,'Draft 1');assert.equal(f.controller.canRetainCollabAnswer(),true);
 f.request(65);f.event({type:'collab_ui_request_end',reqId:1});
 assert.equal(f.controller.collabAnswers.size,63);assert.equal(f.controller.canRetainCollabAnswer(),true);
 f.controller.setCollabAnswerDraft(65,'New retained draft',overflowToken);
 assert.equal(f.controller.collabAnswers.size,64);assert.equal(f.store.getState().collabAnswer.phase,'draft');
 f.request(64);assert.equal(f.store.getState().collabAnswer.value,'Draft 64');
 assert.equal(f.frames.length,0);
});
test('captured old-token taps and draft writes cannot target a same-ID replacement',t=>{
 const f=fixture(t),oldToken=f.store.getState().collabRequest.pulseQuestionToken;
 f.controller.setCollabAnswerDraft(7,'Retained old draft',oldToken);
 const replacementToken='daemon-b:22';
 f.rawEvent({type:'collab_ui_snapshot',complete:true,lifecycle:{sessionPath:'/a',generation:'daemon-b',revision:1},requests:[{reqId:7,kind:'editor',title:'Replacement',pulseRoomId:'new-room',pulseQuestionToken:replacementToken}]});
 f.controller.setCollabAnswerDraft(7,'New draft',replacementToken);
 f.controller.setCollabAnswerDraft(7,'Stale edit',oldToken);
 f.controller.sendCollabUiResponse(7,'Stale tap',oldToken);
 assert.equal(f.frames.length,0);assert.equal(f.store.getState().collabAnswer.value,'New draft');
 assert.equal(f.store.getState().collabAnswer.phase,'draft');assert.equal(f.controller.collabAnswers.size,2);
 assert.equal(Array.from(f.controller.collabAnswers.values()).find(answer=>answer.question.token===oldToken).value,'Retained old draft');
 f.controller.sendCollabUiResponse(7,'New draft',replacementToken);
 assert.equal(f.frames.length,1);assert.equal(f.frames[0].pulseQuestionToken,replacementToken);assert.equal(f.frames[0].value,'New draft');
});
test('late exact-token ACKs cannot turn an unsent draft into a handoff or refusal',t=>{
 const f=fixture(t),token=f.store.getState().collabRequest.pulseQuestionToken;
 f.controller.setCollabAnswerDraft(7,'Not submitted',token);
 for(const ack of [{ok:true},{ok:true,queued:true},{ok:false,actionable:true,error:'late refusal'}]){
   f.event({type:'ui_response_ack',reqId:7,pulseQuestionToken:token,...ack});
   assert.equal(f.store.getState().collabAnswer.phase,'draft');assert.equal(f.store.getState().collabAnswer.value,'Not submitted');
 }
 assert.equal(f.frames.length,0);assert.equal(f.controller.collabAnswers.size,1);
});
