import assert from 'node:assert/strict';
import test from 'node:test';

import { FRESH_CHAT_MS, launchTarget } from '../src/domain/launch-target.ts';

const NOW = 1_000_000_000_000;
const chat = (path, ageMs, extra = {}) => ({ path, activeAt: NOW - ageMs, running: false, needsYou: false, ...extra });

test('no chats: the new-chat home', () => {
  assert.equal(launchTarget([], NOW), null);
});

test('the most recent chat opens while it is fresh', () => {
  const chats = [chat('/old', 5 * FRESH_CHAT_MS), chat('/new', 60_000), chat('/mid', 10 * 60_000)];
  assert.equal(launchTarget(chats, NOW), '/new');
  assert.equal(launchTarget([chat('/edge', FRESH_CHAT_MS)], NOW), '/edge');
});

test('a stale most recent chat means home', () => {
  assert.equal(launchTarget([chat('/a', FRESH_CHAT_MS + 1), chat('/b', 3 * FRESH_CHAT_MS)], NOW), null);
});

test('a stale chat still opens when it is running or needs you', () => {
  const age = 10 * FRESH_CHAT_MS;
  assert.equal(launchTarget([chat('/run', age, { running: true })], NOW), '/run');
  assert.equal(launchTarget([chat('/ask', age, { needsYou: true })], NOW), '/ask');
});

test('only the most recent chat counts: an older running chat does not pull the launch', () => {
  const chats = [chat('/last', 3 * FRESH_CHAT_MS), chat('/older-running', 9 * FRESH_CHAT_MS, { running: true })];
  assert.equal(launchTarget(chats, NOW), null);
});

test('unknown activity is not fresh', () => {
  assert.equal(launchTarget([{ path: '/x', activeAt: 0, running: false, needsYou: false }], NOW), null);
});
