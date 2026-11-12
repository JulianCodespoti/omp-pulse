import test from 'node:test';
import assert from 'node:assert/strict';
import {acknowledgeCollabAnswer, collabAnswerCanRetry, interruptCollabAnswer} from '../src/runtime/collab-answer.ts';
const sending = {sessionPath:'/a',reqId:7,value:'  exact answer  ',phase:'sending',question:{sessionPath:'/a',reqId:7,generation:'daemon-a',token:'daemon-a:1'}};

test('sending, daemon queue and transport handoff retain the exact answer without a callback receipt',()=>{
 const queued=acknowledgeCollabAnswer(sending,'/a',{reqId:7,pulseQuestionToken:'daemon-a:1',ok:true,queued:true});
 assert.equal(queued.phase,'queued');assert.equal(queued.value,sending.value);assert.equal(collabAnswerCanRetry(queued,'/a',7),false);
 const handoff=acknowledgeCollabAnswer(queued,'/a',{reqId:7,pulseQuestionToken:'daemon-a:1',ok:true});
 assert.equal(handoff.phase,'handoff');assert.equal(handoff.value,sending.value);assert.equal(collabAnswerCanRetry(handoff,'/a',7),false);
});
test('refusal retains the returned reason and retries only the same actionable question',()=>{
 const rejected=acknowledgeCollabAnswer(sending,'/a',{reqId:7,pulseQuestionToken:'daemon-a:1',ok:false,error:'view-only link',actionable:true});
 assert.equal(rejected.reason,'view-only link');assert.equal(rejected.value,sending.value);assert.equal(collabAnswerCanRetry(rejected,'/a',7),true);
 assert.equal(collabAnswerCanRetry(rejected,'/b',7),false);assert.equal(collabAnswerCanRetry(rejected,'/a',8),false);
 const ended=acknowledgeCollabAnswer(sending,'/a',{reqId:7,pulseQuestionToken:'daemon-a:1',ok:false,error:'that question is no longer waiting',actionable:false});
 assert.equal(ended.phase,'unavailable');assert.equal(collabAnswerCanRetry(ended,'/a',7),false);
});
test('stale session and request acknowledgements cannot affect another question',()=>{
 assert.equal(acknowledgeCollabAnswer(sending,'/b',{reqId:7,ok:false,error:'old'}),sending);
 assert.equal(acknowledgeCollabAnswer(sending,'/a',{reqId:8,ok:true}),sending);
});
test('socket loss after dispatch is uncertain, not an automatic retry',()=>{
 const uncertain=interruptCollabAnswer(sending);assert.equal(uncertain.phase,'uncertain');assert.equal(uncertain.value,sending.value);
 assert.equal(collabAnswerCanRetry(uncertain,'/a',7),false);
 const held={...sending,phase:'held'};assert.equal(interruptCollabAnswer(held),held);
 const queued={...sending,phase:'queued'};assert.equal(interruptCollabAnswer(queued),queued);
});
test('acknowledgements correlate the full question token, not a reused numeric reqId',()=>{
 const replacement={...sending,question:{...sending.question,generation:'daemon-b',token:'daemon-b:1'}};
 assert.equal(acknowledgeCollabAnswer(replacement,'/a',{reqId:7,pulseQuestionToken:'daemon-a:1',ok:true}),replacement);
 assert.equal(acknowledgeCollabAnswer(replacement,'/a',{reqId:7,ok:true}),replacement,'missing token is not a legacy alias');
 const acknowledged=acknowledgeCollabAnswer(replacement,'/a',{reqId:7,pulseQuestionToken:'daemon-b:1',ok:true});
 assert.equal(acknowledged.phase,'handoff');
});
test('an unsent draft ignores late ACKs even when their question token matches',()=>{
 const draft={...sending,phase:'draft'};
 for(const event of [{ok:true},{ok:true,queued:true},{ok:false,actionable:true},{ok:false,actionable:false}]){
   assert.equal(acknowledgeCollabAnswer(draft,'/a',{reqId:7,pulseQuestionToken:draft.question.token,...event}),draft);
 }
 assert.equal(interruptCollabAnswer(draft),draft);
});
