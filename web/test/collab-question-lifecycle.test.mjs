import test from 'node:test';
import assert from 'node:assert/strict';
import {readCollabQuestionFrame,collabQuestionIdentity,collabQuestionSettled} from '../src/runtime/collab-question-lifecycle.ts';
const stamp=(revision,generation='daemon-a',sessionPath='/a')=>({sessionPath,generation,revision});
const request=(reqId=7,token='daemon-a:1')=>({reqId,kind:'editor',title:'Question',pulseRoomId:'room-a',pulseQuestionToken:token});
const snapshot=(revision,requests=[],generation='daemon-a',sessionPath='/a')=>({type:'collab_ui_snapshot',complete:true,lifecycle:stamp(revision,generation,sessionPath),requests});

test('missed host end settles the exact retained question on complete reconnect snapshot',()=>{
 const opened=readCollabQuestionFrame(null,snapshot(1,[request()]),'/a');
 const identity=collabQuestionIdentity(opened,7);
 const pending=readCollabQuestionFrame(opened.cursor,snapshot(1,[request()]),'/a');
 assert.equal(collabQuestionSettled(identity,pending),false,'handoff/reconnect is not closure');
 const completed=readCollabQuestionFrame(pending.cursor,snapshot(2),'/a');
 assert.equal(collabQuestionSettled(identity,completed),true);
 assert.equal(readCollabQuestionFrame(completed.cursor,{type:'collab_ui_request',request:request(),lifecycle:stamp(1)},'/a'),null,'queued pre-snapshot request cannot resurrect the closed card');
 assert.equal(readCollabQuestionFrame(completed.cursor,snapshot(1,[request()]),'/a'),null,'older snapshot cannot overwrite current evidence');
});
test('snapshot cannot settle another daemon, session or unidentified retained answer',()=>{
 const opened=readCollabQuestionFrame(null,snapshot(1,[request()]),'/a'),identity=collabQuestionIdentity(opened,7);
 const restarted=readCollabQuestionFrame(opened.cursor,snapshot(0,[],'daemon-b'),'/a');
 assert.equal(collabQuestionSettled(identity,restarted),false,'empty restarted cache did not observe old host closure');
 assert.equal(collabQuestionSettled(undefined,restarted),false);
 assert.equal(readCollabQuestionFrame(opened.cursor,snapshot(3,[],'daemon-a','/b'),'/a'),null);
 const other=readCollabQuestionFrame(null,snapshot(3,[],'daemon-a','/b'),'/b');
 assert.equal(collabQuestionSettled(identity,other),false);
 assert.equal(readCollabQuestionFrame(opened.cursor,{type:'collab_ui_request',request:request(7,'daemon-b:4'),lifecycle:stamp(4,'daemon-b')},'/a'),null,'new generation needs its attaching authority snapshot');
});
test('room/request ID reuse has a distinct token and exact closure cannot end its replacement',()=>{
 const opened=readCollabQuestionFrame(null,snapshot(1,[request()]),'/a'),old=collabQuestionIdentity(opened,7);
 const next=readCollabQuestionFrame(opened.cursor,{type:'collab_ui_request',request:{...request(7,'daemon-a:3'),pulseRoomId:'room-b'},lifecycle:stamp(3)},'/a');
 assert.equal(collabQuestionSettled(old,next),true);
 const current=collabQuestionIdentity(next,7);
 const delayed=readCollabQuestionFrame(next.cursor,{type:'collab_ui_request_end',reqId:7,pulseQuestionToken:old.token,lifecycle:stamp(4)},'/a');
 assert.equal(collabQuestionSettled(current,delayed),false);
 const exact=readCollabQuestionFrame(delayed.cursor,{type:'collab_ui_request_end',reqId:7,pulseQuestionToken:current.token,lifecycle:stamp(5)},'/a');
 assert.equal(collabQuestionSettled(current,exact),true);
});
test('incomplete or malformed sets cannot release locks and the ordering cursor has constant space',()=>{
 for(const raw of [{...snapshot(1),complete:false},{...snapshot(1),requests:[{reqId:7}]},{...snapshot(1),requests:[request(),request()]},{...snapshot(1),lifecycle:stamp(Number.MAX_SAFE_INTEGER+1)}]) assert.equal(readCollabQuestionFrame(null,raw,'/a'),null);
 let cursor=null;
 for(let revision=0;revision<1000;revision++) cursor=readCollabQuestionFrame(cursor,snapshot(revision),'/a').cursor;
 assert.deepEqual(Object.keys(cursor).sort(),['generation','revision','sessionPath']);
 assert.equal(cursor.revision,999);
});
