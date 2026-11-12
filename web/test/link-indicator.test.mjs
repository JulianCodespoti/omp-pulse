#!/usr/bin/env node
// The indicator is the one place the UI learns about an outage, so its rules
// are the behaviour: a probe that got no answer is a fact (no grace), a live
// link only reads "connecting" once the chat socket has been down past the
// grace, and an open socket is never a problem on a live link.
import assert from 'node:assert/strict';
import { createServer as createVite } from '../node_modules/vite/dist/node/index.js';

const vite = await createVite({ root: new URL('..', import.meta.url).pathname, configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, resolve: { alias: { '@': new URL('../src', import.meta.url).pathname } }, logLevel: 'error' });
let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures++; };
try {
  const { linkIndicator, linkIndicatorChangesAt, LINK_GRACE_MS } = await vite.ssrLoadModule('/src/runtime/link-indicator.ts');
  const link = (kind, lastLiveAt = 500) => ({ kind, since: 0, lastLiveAt });
  const at = (kind, socketDownSince, platformOffline = false, now = 10_000) => ({ link: link(kind), socketDownSince, platformOffline, now });

  check('unreachable has no grace, even with the socket open', linkIndicator(at('unreachable', null)).kind === 'unreachable');
  check('unreachable carries when anything last answered', linkIndicator(at('unreachable', null)).lastLiveAt === 500);
  check('daemon-down has no grace', linkIndicator(at('daemon-down', 9_999)).kind === 'daemon-down');
  check('unreachable plus the platform offline hint reads offline', linkIndicator(at('unreachable', 1_000, true)).kind === 'offline');
  check('daemon-down ignores the platform offline hint', linkIndicator(at('daemon-down', null, true)).kind === 'daemon-down');
  check('an open socket on a live link is ok', linkIndicator(at('live', null)).kind === 'ok');
  check('a live link with the socket down under the grace is ok', linkIndicator(at('live', 10_000 - (LINK_GRACE_MS - 1))).kind === 'ok');
  check('a live link with the socket down past the grace is connecting', linkIndicator(at('live', 10_000 - LINK_GRACE_MS)).kind === 'connecting');
  check('a live link ignores the platform offline hint', linkIndicator(at('live', null, true)).kind === 'ok');

  check('the grace ending is the only time-driven change', linkIndicatorChangesAt(at('live', 9_000)) === 9_000 + LINK_GRACE_MS);
  check('no timer once connecting', linkIndicatorChangesAt(at('live', 1_000)) === null);
  check('no timer with the socket open', linkIndicatorChangesAt(at('live', null)) === null);
  check('no timer on an outage the link already names', linkIndicatorChangesAt(at('unreachable', 9_000)) === null);
} finally {
  await vite.close();
}
assert.equal(failures, 0, `${failures} link indicator checks failed`);
