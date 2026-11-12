import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rolldown } from '../node_modules/rolldown/dist/index.mjs';

// notification-nudge.ts imports ./browser-storage without an extension, which
// plain Node cannot resolve, so the real module is bundled first.
const root = fileURLToPath(new URL('../../', import.meta.url));
const build = await rolldown({
  input: 'nudge-fixture',
  platform: 'node',
  transform: { define: { 'import.meta.env': JSON.stringify({}) } },
  plugins: [{
    name: 'nudge-fixture',
    resolveId: (id) => (id === 'nudge-fixture' ? '\0nudge-fixture' : null),
    load: (id) => (id === '\0nudge-fixture' ? `export * from ${JSON.stringify(resolve(root, 'web/src/platform/notification-nudge.ts'))};` : null),
  }],
});
let nudge;
try {
  const generated = await build.generate({ format: 'esm', codeSplitting: false });
  nudge = await import(`data:text/javascript;base64,${Buffer.from(generated.output[0].code).toString('base64')}`);
} finally {
  await build.close();
}
const { NO_DECLINES, shouldShowNotificationNudge } = nudge;

const DAY = 24 * 60 * 60 * 1000;
const now = 1_000_000_000_000;
const base = { available: true, on: false, blocked: false, runningMs: 20_000, declines: NO_DECLINES, now };
const show = (extra = {}) => shouldShowNotificationNudge({ ...base, ...extra });

test('the ask shows when available, off, not blocked and the turn has run 20 s', () => {
  assert.equal(show(), true);
  assert.equal(show({ runningMs: 19_999 }), false);
});

test('it never shows when unavailable, already on, or blocked', () => {
  assert.equal(show({ available: false }), false);
  assert.equal(show({ on: true }), false);
  assert.equal(show({ blocked: true }), false);
});

test('one decline silences it for 14 days', () => {
  assert.equal(show({ declines: { count: 1, lastAt: now - 13 * DAY } }), false);
  assert.equal(show({ declines: { count: 1, lastAt: now - 14 * DAY } }), true);
});

test('a second decline silences it for good', () => {
  assert.equal(show({ declines: { count: 2, lastAt: now - 400 * DAY } }), false);
});

test('a decline stamped in the future (clock set back) does not silence it forever', () => {
  assert.equal(show({ declines: { count: 1, lastAt: now + 30 * DAY } }), true);
});
