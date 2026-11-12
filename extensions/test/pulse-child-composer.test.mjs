import assert from 'node:assert/strict';
import test from 'node:test';
import install, { fitQueueRemovalReply } from '../omp-pulse-child.ts';

function fixture(session) {
  const commands = new Map(), events = new Map(), frames = [];
  let sequence = 0;
  install({
    pi: { AgentRegistry: { global: () => ({ get: () => ({ session }) }) } },
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, spec) { commands.set(name, spec.handler); },
  });
  const ctx = { agent: { id: 'Main', kind: 'main' },
    ui: { setStatus(key, value) { frames.push({ key, data: JSON.parse(value) }); }, notify(message) { throw Error(message); } },
    sessionManager: { buildSessionContext: () => ({ mode: 'default' }) },
  };
  return { frames, event: name => events.get(name)({}, ctx), async call(name, args = {}) {
    const id = `req-${++sequence}`;
    await commands.get(name)(`${id} ${JSON.stringify(args)}`, ctx);
    return frames.find(frame => frame.key === `omp-pulse:${id}`).data;
  } };
}

test('child discovers actual loaded prompt templates with editable arguments and native first-match order', async () => {
  const f = fixture({ promptTemplates: [
    { name: 'review-project', description: 'Review the current project (project)', content: 'secret template body' },
    { name: 'review-project', description: 'shadowed duplicate' },
    { name: 'standup', description: 'Daily summary (user)' },
  ] });
  const reply = await f.call('pulse-command-templates');
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.templates, [
    { name: 'review-project', description: 'Review the current project (project)', input: { hint: 'arguments' }, source: 'prompt' },
    { name: 'standup', description: 'Daily summary (user)', input: { hint: 'arguments' }, source: 'prompt' },
  ]);
  assert.equal(JSON.stringify(reply).includes('secret template body'), false);
  assert.deepEqual((await fixture({ promptTemplates: [] }).call('pulse-command-templates')).templates, []);
  assert.equal((await fixture({}).call('pulse-command-templates')).ok, false, 'unsupported discovery is not an empty authoritative list');
});

for (const excludeFromContext of [false, true]) {
  test(`explicit shell dispatch requests native user-shell semantics (excludeFromContext=${excludeFromContext})`, async () => {
    const calls = [];
    const f = fixture({ async executeBash(command, onChunk, options) {
      calls.push({ command, options });
      onChunk?.('piped output');
      return { output: 'piped output', exitCode: 0, cancelled: false };
    } });
    const reply = await f.call('pulse-bash', { command: 'set -l answer 42; echo $answer', excludeFromContext, stream: 'stream-a' });
    assert.deepEqual(calls, [{ command: 'set -l answer 42; echo $answer', options: { excludeFromContext, useUserShell: true } }]);
    assert.equal(reply.ok, true);
    assert.equal(reply.result.output, 'piped output');
  });
}

test('child queue producer supplies stable exact IDs and removes/promotes only selected raw objects', async () => {
  const make = () => ({ role: 'user', content: [{ type: 'text', text: 'same preview' }] });
  let steering = [], followUp = [make(), make()];
  const first = followUp[0], second = followUp[1];
  let listener, mutations = 0;
  const f = fixture({ subscribe(callback) { listener = callback; return () => { listener = undefined; }; },
    promoteQueuedMessage(text) {
      const queued = this.agent.peekFollowUpQueue();
      const index = queued.findIndex(message => message.content[0]?.text === text);
      if (index < 0) return false;
      const selected = queued[index];
      followUp = [...queued.slice(0, index), ...queued.slice(index + 1)];
      selected.steering = true;
      steering = [...steering, selected];
      mutations++;
      listener?.({ type: 'queue_update' });
      return true;
    },
    agent: {
      peekSteeringQueue: () => steering, peekFollowUpQueue: () => followUp, peekLiveSteeredMessages: () => [],
      replaceQueue(queue, messages) { assert.equal(queue, 'followUp'); followUp = messages; mutations++; listener?.({ type: 'queue_update' }); },
    },
  });
  await f.event('session_start');
  const initial = f.frames.find(frame => frame.key === 'omp-pulse-queue').data;
  assert.equal(initial.followUpIds.length, 2);
  assert.equal(initial.followUpIds[0] === initial.followUpIds[1], false);
  const removed = await f.call('pulse-queue-remove', { queue: 'followUp', itemId: initial.followUpIds[1] });
  assert.equal(removed.removed, true); assert.equal(removed.text, 'same preview');
  assert.equal(followUp.length, 1); assert.equal(followUp[0] === first, true); assert.equal(followUp.includes(second), false);
  const published = f.frames.filter(frame => frame.key === 'omp-pulse-queue').at(-1).data;
  assert.equal(published.followUpIds[0], initial.followUpIds[0]);
  assert.equal((await f.call('pulse-queue-promote', { itemId: published.followUpIds[0] })).promoted, true);
  assert.equal(followUp.length, 0); assert.equal(steering[0] === first, true); assert.equal(mutations, 2);
  await f.event('session_shutdown'); assert.equal(listener, undefined);
});

test('oversized queue image receipts retain recovered text and acknowledge committed removal', () => {
  const full = { ok: true, removed: true, text: 'Keep "quoted" draft\n🧭', images: [{ type: 'image', data: 'x'.repeat(4096), mimeType: 'image/png' }] };
  const fitted = fitQueueRemovalReply(full, 'req-a', 512);
  assert.equal(fitted.ok, true); assert.equal(fitted.removed, true);
  assert.equal(fitted.text, full.text); assert.equal(fitted.images, undefined); assert.equal(fitted.imagesDropped, true);
  assert.equal(fitQueueRemovalReply(full, 'req-a', 8192).images.length, 1);
});
