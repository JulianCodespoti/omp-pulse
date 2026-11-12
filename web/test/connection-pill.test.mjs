import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const code = await bundleDomFixture(`
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionPill, pillContent } from ${JSON.stringify(resolve(root, "web/src/app/chat/ConnectionPill.tsx"))};
window.fixture = { act, pillContent, probes: [], settings: [], retries: 0, mount() {
  const root = createRoot(document.getElementById('root'));
  return { render: (indicator, staleHistory = false) => root.render(h(ConnectionPill, {
    indicator, staleHistory, onRetry: () => window.fixture.retries++,
  })), unmount: () => root.unmount() };
} };
`, [{
  name: "connection-effects",
  resolveId(id, importer) {
    if (!importer?.endsWith('/ConnectionPill.tsx')) return null;
    if (id === '../../runtime/link-state') return '\0probe';
    if (id === '../nav/panels') return '\0settings';
    if (id === '../../platform/local-mode') return '\0phone';
    return null;
  },
  load(id) {
    if (id === '\0probe') return `export const probeLink = force => new Promise(resolve => window.fixture.probes.push({ force, resolve }));`;
    if (id === '\0settings') return `export const openSettingsPage = page => window.fixture.settings.push(page);`;
    if (id === '\0phone') return `export const isPhoneMode = () => false;`;
    return null;
  },
}]);

async function fixture(t) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  let now = 10_000, sequence = 0;
  w.Date.now = () => now;
  const timers = new Map(), nativeSet = w.setTimeout.bind(w), nativeClear = w.clearTimeout.bind(w);
  w.setTimeout = (fn, delay, ...args) => {
    if (delay !== 1500) return nativeSet(fn, delay, ...args);
    const id = --sequence;
    timers.set(id, { at: now + delay, fn: () => fn(...args) });
    return id;
  };
  w.clearTimeout = id => timers.delete(id) || nativeClear(id);
  let mounted;
  await f.act(async () => { mounted = f.mount(); mounted.render({ kind: 'ok' }); });
  t.after(async () => { await f.act(async () => mounted.unmount()); dom.close(); });
  return {
    w, f, act: f.act,
    pill: () => w.document.querySelector('[data-testid="chat-offline-hint"]'),
    render: (kind, saved = false) => f.act(async () => mounted.render({ kind, lastLiveAt: null }, saved)),
    advance: async ms => {
      now += ms;
      await f.act(async () => {
        for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
      });
    },
  };
}

test('content decisions cover link states, saved history and recovery', async t => {
  const { f } = await fixture(t);
  const table = [
    ['ok', false, false, null],
    ['ok', true, false, ['info', true, false, 'Showing a saved copy']],
    ['ok', false, true, ['success', false, false, 'Back online']],
    ['ok', true, true, ['success', false, false, 'Back online · saved copy']],
    ['connecting', false, false, ['info', false, false, 'Connecting…']],
    ['unreachable', false, false, ['warn', true, true, 'Can’t reach studio']],
    ['offline', false, false, ['warn', true, true, 'You’re offline']],
    ['daemon-down', false, false, ['warn', true, true, 'studio is on, but omp-pulse isn’t running']],
  ];
  for (const [kind, saved, recovered, expected] of table) {
    const content = f.pillContent({ kind }, saved, recovered, 'studio.home', false);
    if (expected === null) assert.equal(content, null);
    else assert.deepEqual([content.tone, content.retry, content.opensSettings, content.text], expected);
  }
  for (const kind of ['connecting', 'unreachable', 'offline', 'daemon-down']) {
    const plain = f.pillContent({ kind }, false, false, 'localhost', false);
    const saved = f.pillContent({ kind }, true, false, 'localhost', false);
    assert.equal(saved.text, `${plain.text} · saved copy`);
    const phone = f.pillContent({ kind }, false, false, 'localhost', true);
    assert.equal(phone.text.includes('your computer'), false);
  }
  assert.equal(f.pillContent({ kind: 'unreachable' }, false, false, 'localhost', false).text, 'Can’t reach your computer');
  assert.equal(f.pillContent({ kind: 'connecting' }, false, false, 'localhost', false).icon, 'spinner');
});

test('long outage changes in place to recovery for 1.5 seconds', async t => {
  const f = await fixture(t);
  await f.render('unreachable');
  const pill = f.pill();
  await f.advance(2000);
  await f.render('offline');
  assert.equal(f.pill() === pill, true);
  await f.advance(1000);
  await f.render('ok');
  assert.equal(f.pill() === pill, true);
  assert.equal(f.pill().textContent, 'Back online');
  await f.advance(1499);
  assert.equal(f.pill() !== null, true);
  await f.advance(1);
  assert.equal(f.pill(), null);
});

test('a connecting step cannot consume an outage recovery before it settles', async t => {
  const f = await fixture(t);
  await f.render('offline');
  await f.advance(3100);
  await f.render('ok');
  assert.equal(f.pill().textContent, 'Back online');
  await f.advance(100);
  await f.render('connecting');
  await f.advance(2000);
  await f.render('ok');
  assert.equal(f.pill() !== null, true);
  assert.equal(f.pill().textContent, 'Back online');
  await f.advance(1500);
  assert.equal(f.pill(), null);
});

test('short outages and connecting-only blips do not announce recovery', async t => {
  const f = await fixture(t);
  await f.render('unreachable');
  await f.advance(2999);
  await f.render('ok');
  assert.equal(f.pill(), null);
  await f.render('connecting');
  await f.advance(5000);
  await f.render('ok');
  assert.equal(f.pill(), null);
});

test('Retry is single-flight and text opens computer settings without retrying', async t => {
  const f = await fixture(t);
  await f.render('unreachable');
  const pill = f.pill();
  await f.act(async () => pill.click());
  assert.equal(f.f.settings.join(','), 'computer');
  assert.equal(f.f.probes.length, 0);
  const retry = f.w.document.querySelector('[data-testid="chat-offline-retry"]');
  await f.act(async () => { retry.click(); retry.click(); });
  assert.equal(f.f.probes.length, 1);
  assert.equal(f.f.probes[0].force, true);
  assert.equal(retry.textContent, 'Retrying…');
  assert.equal(f.f.retries, 0);
  assert.equal(f.pill() === pill, true);
  await f.act(async () => f.f.probes[0].resolve('unreachable'));
  assert.equal(f.f.retries, 1);
  assert.equal(retry.textContent, 'Retry');
  assert.equal(f.pill() === pill, true);
});
