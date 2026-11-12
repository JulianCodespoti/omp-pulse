import test from 'node:test';
import assert from 'node:assert/strict';
import {NO_NOTICE_PAUSE,setNoticePause,isNoticePaused} from '../src/app/notice-pause.ts';

test('each pause cause is independent and immutable',()=>{
 for(const reason of ['hover','focus','touch','hidden']) {
  const active=setNoticePause(NO_NOTICE_PAUSE,reason,true);
  assert.equal(isNoticePaused(active),true);
  assert.equal(isNoticePaused(NO_NOTICE_PAUSE),false);
  assert.equal(setNoticePause(active,reason,true),active);
  assert.equal(isNoticePaused(setNoticePause(active,reason,false)),false);
 }
});
test('leaving hover cannot resume a focused or touched notice',()=>{
 let state=setNoticePause(NO_NOTICE_PAUSE,'hover',true);
 state=setNoticePause(state,'focus',true);state=setNoticePause(state,'touch',true);
 state=setNoticePause(state,'hover',false);assert.equal(isNoticePaused(state),true);
 state=setNoticePause(state,'touch',false);assert.equal(isNoticePaused(state),true);
 state=setNoticePause(state,'focus',false);assert.equal(isNoticePaused(state),false);
});

test('touch cancellation cannot resume a hidden or focused notice', () => {
 let state = setNoticePause(NO_NOTICE_PAUSE, 'touch', true);
 state = setNoticePause(state, 'hidden', true);
 state = setNoticePause(state, 'focus', true);
 state = setNoticePause(state, 'touch', false);
 assert.equal(isNoticePaused(state), true);
 state = setNoticePause(state, 'hidden', false);
 assert.equal(isNoticePaused(state), true);
 state = setNoticePause(state, 'focus', false);
 assert.equal(isNoticePaused(state), false);
});
