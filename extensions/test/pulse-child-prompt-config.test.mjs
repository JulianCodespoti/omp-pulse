import test from 'node:test';
import assert from 'node:assert/strict';
import install from '../omp-pulse-child.ts';

function fixture() {
  const commands = new Map();
  const settings = new Map();
  let tools = ['task', 'eval'];
  let modelCalls = 0;
  const session = {
    settings: { rawValue: ({ segments }) => settings.get(segments.join('.')) },
    getEnabledToolNames: () => tools,
    scopedModels: [],
    modelRegistry: { getAvailable: () => [{ provider: 'p', id: 'base', name: 'Base' }] },
    findMentionableModel: (selector) => selector === 'p/base' || selector === 'q/scoped',
    prompt() { modelCalls++; throw new Error('metadata must not prompt'); },
  };
  install({
    pi: { AgentRegistry: { global: () => ({ get: (id) => id === 'child' ? { session } : undefined }) } },
    on() {},
    registerCommand(name, command) { commands.set(name, command); },
  });
  return {
    session, settings,
    setTools(value) { tools = value; },
    get modelCalls() { return modelCalls; },
    async request(name) {
      let reply;
      const ctx = {
        agent: { id: 'child' },
        ui: { setStatus(key, value) { assert.equal(key, 'omp-pulse:r1'); reply = JSON.parse(value); } },
      };
      await commands.get(name).handler('r1 {}', ctx);
      return reply;
    },
  };
}

test('phone metadata applies enabled keyword switches and required tools without a model turn', async () => {
  const f = fixture();
  const words = async () => (await f.request('pulse-prompt-config')).magicKeywords.map(({ word }) => word);
  assert.deepEqual(await words(), ['ultrathink', 'orchestrate', 'workflowz', 'jevify']);
  f.settings.set('magicKeywords.ultrathink', false);
  f.setTools(['eval']);
  assert.deepEqual(await words(), ['jevify']);
  f.settings.set('magicKeywords.enabled', false);
  assert.deepEqual(await words(), []);
  assert.equal(f.modelCalls, 0);
});

test('unavailable phone configuration refuses without assuming defaults', async () => {
  const f = fixture();
  delete f.session.settings;
  const reply = await f.request('pulse-prompt-config');
  assert.equal(reply.ok, false);
  assert.match(reply.error, /configuration is unavailable/);
  assert.equal('magicKeywords' in reply, false);
  assert.equal(f.modelCalls, 0);
});

test('model mention choices use scoped models before the registry and validate exact selectors', async () => {
  const f = fixture();
  assert.deepEqual((await f.request('pulse-model-mention-choices')).choices, [{ selector: 'p/base', name: 'Base', provider: 'p' }]);
  f.session.scopedModels = [{ model: { provider: 'q', id: 'scoped' } }, { model: { provider: 'q', id: 'invalid' } }];
  assert.deepEqual((await f.request('pulse-model-mention-choices')).choices, [{ selector: 'q/scoped', name: 'scoped', provider: 'q' }]);
  delete f.session.findMentionableModel;
  assert.equal((await f.request('pulse-model-mention-choices')).ok, false);
  assert.equal(f.modelCalls, 0);
});

test('phone speed tier distinguishes ultrafast from fast and stays unavailable on older owners', async () => {
  const f = fixture();
  const tier = async () => (await f.request('pulse-prompt-config')).fastModeTier;
  assert.equal(await tier(), undefined);
  f.session.isFastModeEnabled = () => true;
  assert.equal(await tier(), undefined, 'one accessor cannot distinguish tiers');
  f.session.isUltrafastModeEnabled = () => true;
  assert.equal(await tier(), 'ultrafast');
  f.session.isUltrafastModeEnabled = () => false;
  assert.equal(await tier(), 'fast');
  f.session.isFastModeEnabled = () => false;
  assert.equal(await tier(), 'off');
});
