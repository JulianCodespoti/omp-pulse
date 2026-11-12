import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerQueueAccess } from '../pulse-queue.ts';

function fixture() {
  const queues={steering:[],followUp:[],live:[]},changes=[],observers=[],drained=[],rawText=new WeakMap();
  const nativeCalls={retry:0,schedule:0};
  const owner={agent:{
    peekSteeringQueue:()=>queues.steering,
    peekFollowUpQueue:()=>queues.followUp,
    peekLiveSteeredMessages:()=>queues.live,
    replaceQueue(queue,messages){queues[queue]=messages;changes.push(queue)},
    moveFollowUpsToSteering(remaining,promoted){queues.followUp=remaining;queues.steering.push(...promoted);changes.push('promote');for(const observe of observers)observe()},
  }};
  // Pinned AgentSession.promoteQueuedMessage delegation, including both
  // matcher passes, one move, retry unblocking and idle drain scheduling.
  owner.promoteQueuedMessage=function(text){
    const followUp=this.agent.peekFollowUpQueue();
    const user=message=>message.attribution!=='agent'&&(message.role==='user'||(message.role==='custom'&&message.attribution==='user'&&message.display!==false));
    const chip=message=>message.details?.__queueChipText??(typeof message.content==='string'?message.content:message.content.find(part=>part.type==='text')?.text||'[Image]');
    let index=followUp.findIndex(message=>user(message)&&rawText.get(message)===text);
    if(index<0)index=followUp.findIndex(message=>user(message)&&chip(message)===text);
    if(index<0)return false;
    let start=index;
    const hiddenTypes={'ultrathink-notice':true,'orchestrate-notice':true,'workflow-notice':true,'jevify-notice':true,'image-attachment-description':true,'video-attachment':true,'image-attachment':true};
    while(start>0&&followUp[start-1].role==='custom'&&followUp[start-1].attribution==='user'&&followUp[start-1].display===false&&Object.hasOwn(hiddenTypes,followUp[start-1].customType))start--;
    const promoted=followUp.slice(start,index+1),message=promoted.at(-1),remaining=followUp.slice();
    remaining.splice(start,index-start+1);
    if(message.role==='user')message.steering=true;
    this.agent.moveFollowUpsToSteering(remaining,promoted);
    nativeCalls.retry++;nativeCalls.schedule++;
    queueMicrotask(()=>{drained.push(...queues.steering);queues.steering=[]});
    return true;
  };
  return {queues,changes,owner,rawText,nativeCalls,observers,drained,access:new OwnerQueueAccess()};
}
const user=(text,image)=>({role:'user',content:[{type:'text',text},...(image?[{type:'image',data:image,mimeType:'image/png'}]:[])]});
const companion=type=>({role:'custom',attribution:'user',display:false,customType:type,content:'hidden'});

test('live duplicate has no held removal authority and cannot remove a waiting duplicate',()=>{
  const f=fixture(),live=user('same','live'),held=user('same','held');f.queues.live=[live];f.queues.steering=[held];
  const snapshot=f.access.snapshot(f.owner);
  assert.equal(snapshot.liveSteered,1);
  assert.equal(f.access.take(f.owner,'steering',snapshot.steeringIds[0]),undefined);
  assert.equal(f.queues.steering[0]===held,true);assert.equal(f.changes.length,0);
  const taken=f.access.take(f.owner,'steering',snapshot.steeringIds[1]);
  assert.equal(taken.images[0].data,'held');assert.equal(f.queues.live[0]===live,true);
});
test('same raw reference live and held has distinct row identities and only held authority',()=>{
  const f=fixture(),message=user('same','photo');f.queues.live=[message];f.queues.steering=[message];
  const state=f.access.snapshot(f.owner);
  assert.notEqual(state.steeringIds[0],state.steeringIds[1]);
  assert.equal(f.access.take(f.owner,'steering',state.steeringIds[0]),undefined);
  assert.equal(f.access.take(f.owner,'steering',state.steeringIds[1]).images[0].data,'photo');
  assert.equal(f.queues.live[0]===message,true);assert.equal(f.queues.steering.length,0);
  assert.deepEqual(f.changes,['steering']);
});
test('second identical held text returns its own photos and removes only its companions in one mutation',()=>{
  const f=fixture(),first=user('same','first'),second=user('same','second'),other={role:'custom',customType:'advisor',content:'keep'};
  const firstCompanion=companion('ultrathink-notice'),secondCompanion=companion('image-attachment');
  f.queues.steering=[firstCompanion,first,other,secondCompanion,second];
  const snapshot=f.access.snapshot(f.owner),id=snapshot.steeringIds[1];
  assert.notEqual(snapshot.steeringIds[0],id);
  const taken=f.access.take(f.owner,'steering',id);
  assert.equal(taken.text,'same');assert.equal(taken.images[0].data,'second');
  assert.equal(f.queues.steering.length,3);assert.equal(f.queues.steering[0]===firstCompanion,true);
  assert.equal(f.queues.steering[1]===first,true);assert.equal(f.queues.steering[2]===other,true);
  assert.deepEqual(f.changes,['steering']);assert.equal(f.access.take(f.owner,'steering',id),undefined);
});
test('delivered target cannot redirect a stale selector to an identical replacement',()=>{
  const f=fixture();f.queues.followUp=[user('same','old')];
  const id=f.access.snapshot(f.owner).followUpIds[0];f.queues.followUp=[user('same','new')];
  assert.equal(f.access.take(f.owner,'followUp',id),undefined);assert.equal(f.changes.length,0);
  assert.equal(f.queues.followUp[0].content[1].data,'new');
});
test('queue promotion targets exact duplicate and preserves its group without preprocessing',()=>{
  const f=fixture(),a=user('same','a'),b=user('same','b'),hidden=companion('video-attachment');
  f.queues.followUp=[a,hidden,b];const id=f.access.snapshot(f.owner).followUpIds[1];
  assert.equal(f.access.promote(f.owner,id),true);assert.equal(f.queues.followUp[0]===a,true);
  assert.equal(f.queues.steering[0]===hidden,true);assert.equal(f.queues.steering[1]===b,true);
  assert.equal(b.steering,true);assert.deepEqual(f.changes,['promote']);
});
test('idle promotion delegates native retry unblocking and schedules the selected message for drain',async()=>{
  const f=fixture(),message=user('idle','photo');f.queues.followUp=[message];
  const id=f.access.snapshot(f.owner).followUpIds[0];
  assert.equal(f.access.promote(f.owner,id),true);
  assert.deepEqual(f.nativeCalls,{retry:1,schedule:1});
  await Promise.resolve();
  assert.equal(f.drained.length,1);assert.equal(f.drained[0]===message,true);
  assert.equal(f.queues.steering.length,0);assert.equal(f.queues.followUp.length,0);
});
for(const selectedRawMatches of [false,true])test(`exact promotion defeats another occurrence's raw-text priority (selected raw matches: ${selectedRawMatches})`,()=>{
  const f=fixture(),other=user('different','other'),selected=user('same','selected');
  f.rawText.set(other,'same');f.rawText.set(selected,selectedRawMatches?'same':'unexpanded source');
  f.queues.followUp=[other,selected];
  const id=f.access.snapshot(f.owner).followUpIds[1];
  assert.equal(f.access.promote(f.owner,id),true);
  assert.equal(f.queues.followUp[0]===other,true);assert.equal(f.queues.steering[0]===selected,true);
  assert.deepEqual(f.changes,['promote']);
});
test('custom chip promotion selects its own occurrence after the raw matcher falls through',()=>{
  const f=fixture(),other=user('other','other'),selected={role:'custom',attribution:'user',customType:'skill-prompt',details:{__queueChipText:'/skill args'},content:'expanded'};
  f.rawText.set(other,'/skill args');f.rawText.set(selected,'/original args');f.queues.followUp=[other,selected];
  const id=f.access.snapshot(f.owner).followUpIds[1];
  assert.equal(f.access.promote(f.owner,id),true);
  assert.equal(f.queues.followUp[0]===other,true);assert.equal(f.queues.steering[0]===selected,true);
  assert.equal(Object.hasOwn(selected,'steering'),false);
});
test('queue observers see one final native mutation and the restored real public peek',()=>{
  const f=fixture(),first=user('same','first'),selected=user('same','selected');
  f.queues.followUp=[first,selected];const original=f.owner.agent.peekFollowUpQueue;
  const descriptor=Object.getOwnPropertyDescriptor(f.owner.agent,'peekFollowUpQueue');
  const id=f.access.snapshot(f.owner).followUpIds[1];let observed=0;
  f.observers.push(()=>{
    observed++;assert.equal(f.owner.agent.peekFollowUpQueue===original,true);
    const current=f.owner.agent.peekFollowUpQueue();
    assert.equal(current===f.queues.followUp,true);assert.equal(current.length,1);
    assert.equal(current[0]===first,true);assert.equal(f.queues.steering[0]===selected,true);
    assert.equal(Object.isFrozen(current),false);
  });
  assert.equal(f.access.promote(f.owner,id),true);assert.equal(observed,1);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.owner.agent,'peekFollowUpQueue'),descriptor);
});
for(const inherited of [false,true])for(const readBeforeThrow of [false,true])test(`promotion restores public peek on native throw (inherited: ${inherited}, consumed: ${readBeforeThrow})`,()=>{
  const f=fixture(),selected=user('same','selected');f.queues.followUp=[selected];
  const original=f.owner.agent.peekFollowUpQueue;
  if(inherited){delete f.owner.agent.peekFollowUpQueue;Object.setPrototypeOf(f.owner.agent,{peekFollowUpQueue:original})}
  const descriptor=Object.getOwnPropertyDescriptor(f.owner.agent,'peekFollowUpQueue');
  const id=f.access.snapshot(f.owner).followUpIds[0];
  f.owner.promoteQueuedMessage=function(){
    if(readBeforeThrow){
      const snapshot=this.agent.peekFollowUpQueue();
      assert.equal(Object.isFrozen(snapshot),true);
      assert.equal(this.agent.peekFollowUpQueue===original,true);
    }
    throw new Error('native promotion failed');
  };
  assert.throws(()=>f.access.promote(f.owner,id),/native promotion failed/);
  assert.equal(f.owner.agent.peekFollowUpQueue===original,true);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.owner.agent,'peekFollowUpQueue'),descriptor);
  assert.equal(f.queues.followUp[0]===selected,true);assert.equal(f.changes.length,0);
});
test('promotion without native drain-aware delegation is explicitly unavailable',()=>{
  const f=fixture();f.queues.followUp=[user('held','photo')];delete f.owner.promoteQueuedMessage;
  const id=f.access.snapshot(f.owner).followUpIds[0];
  assert.throws(()=>f.access.promote(f.owner,id),/unavailable/);assert.equal(f.changes.length,0);
});
test('custom prompt chip and image-only user restoration follow native semantics',()=>{
  const f=fixture();f.queues.followUp=[{role:'custom',attribution:'user',customType:'skill-prompt',details:{__queueChipText:'/skill args'},content:'expanded'},user('','image')];
  const state=f.access.snapshot(f.owner);assert.deepEqual(state.followUp,['/skill args','[Image]']);
  assert.equal(f.access.take(f.owner,'followUp',state.followUpIds[0]).text,'/skill args');
});
test('unsupported owners are explicitly unavailable instead of falling back to text',()=>{
  const access=new OwnerQueueAccess();assert.equal(access.snapshot({}),null);
  assert.throws(()=>access.take({},'steering','old'),/unavailable/);
});
for(const action of ['take','promote'])test(`${action} refuses an old selector whose raw reference was duplicated by its owner`,()=>{
  const f=fixture(),message=user('same','photo');f.queues.followUp=[message];
  const id=f.access.snapshot(f.owner).followUpIds[0];f.queues.followUp.push(message);
  const result=action==='take'?f.access.take(f.owner,'followUp',id):f.access.promote(f.owner,id);
  assert.equal(result,action==='take'?undefined:false);assert.equal(f.changes.length,0);
  assert.equal(f.queues.followUp.length,2);
});
