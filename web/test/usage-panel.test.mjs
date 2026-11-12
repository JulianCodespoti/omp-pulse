import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const require = createRequire(resolve(root, 'web/package.json'));
const code = await bundleDomFixture(`
import {createElement as h, act} from ${JSON.stringify(require.resolve('react'))};
import {createRoot} from ${JSON.stringify(require.resolve('react-dom/client'))};
import {CommandResultSheet} from ${JSON.stringify(resolve(root, 'web/src/app/commands/CommandResultSheet.tsx'))};
import {formatCommandResult} from ${JSON.stringify(resolve(root, 'web/src/app/commands/format-result.ts'))};
import {groupByAccount, parseUsageReport} from ${JSON.stringify(resolve(root, 'web/src/app/commands/usage-report.ts'))};
import {sessionUsageReport} from ${JSON.stringify(resolve(root, 'web/src/domain/session-stats.ts'))};
window.fixture = {act, formatCommandResult, groupByAccount, parseUsageReport, sessionUsageReport,
  mount(props){const r=createRoot(document.getElementById('root'));r.render(h(CommandResultSheet,props));return r;}};
`);

const STATS = {
  userMessages: 34, assistantMessages: 51, toolCalls: 12, totalMessages: 97,
  tokens: { input: 412000, output: 38200, cacheRead: 1900000, cacheWrite: 96000, total: 2446200 },
  cost: 4.82, contextUsage: { tokens: 68000, contextWindow: 200000, percent: 34 },
};
const REPORT = [
  'Anthropic', '  Models with usage data', '    anthropic/claude-opus-5',
  '- Claude 5 Hour', '  me@example.com (Org): 2.00% used (98.0% left)  ← in use by this session', '  [░░░░] 2%', '  resets in 4h',
  '- Claude 7 Day', '  me@example.com (Org): 41.00% used (59.0% left)', '  [██░░] 41%', '  resets in 3d',
  'GitHub Copilot',
  '- Premium Requests — Monthly', '  octo@example.com: 314.00 requests used (31.4% left)', '  [███░] 69%', '  resets in 9d',
].join('\n');

async function fixture(t, props) {
  const dom = createDomFixture(code), w = dom.window, { act } = w.fixture;
  w.HTMLElement.prototype.scrollIntoView = () => {};
  w.Element.prototype.getAnimations = () => [];
  let mounted;
  await act(async () => { mounted = w.fixture.mount({ onOpenChange() {}, ...props }); });
  t.after(async () => { try { await act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); } });
  const q = (id) => w.document.querySelector(`[data-testid="${id}"]`);
  return { w, act, q, all: (id) => [...w.document.querySelectorAll(`[data-testid="${id}"]`)], text: () => w.document.body.textContent };
}
// The Pulse envelope sessionUsageReport builds: native stats plus whole-file spend.
async function open(t, { spend = 12, stats = STATS, limits, props } = {}) {
  const data = { kind: 'pulse-session-usage', stats, ...(spend === undefined ? {} : { sessionSpend: spend }) };
  return fixture(t, { result: { command: '/usage', title: 'Usage', ok: true, provenance: 'live', data, limits }, ...props });
}

test('one cost figure: the whole conversation, with the current context only as a footnote when it differs', async (t) => {
  const dom = createDomFixture(code);
  t.after(() => dom.close());
  const { formatCommandResult: format, sessionUsageReport: report } = dom.window.fixture;
  const cost = (spend, context) => JSON.parse(JSON.stringify(format('/usage', report({ ...STATS, cost: context }, spend)).usage.cost));
  assert.deepEqual(cost(12, 3), { value: '$12.00', scope: 'Whole conversation. $3.00 of it is in the current context.' });
  // The file tally lags a live turn: a smaller tally than the active context is stale, never the headline.
  assert.deepEqual(cost(0, 4.82), { value: '$4.82', scope: 'Whole conversation.' });
  assert.deepEqual(cost(undefined, 1.5), { value: '$1.50', scope: 'Current context only' });
  assert.equal(cost(undefined, undefined).value, 'Not available');
  assert.equal(cost(0, undefined).value, '$0.00', 'a known zero is not unknown');
  const f = await open(t, { spend: 12, stats: { ...STATS, cost: 3 } });
  assert.equal(f.all('usage-cost').length, 1);
  assert.match(f.q('usage-cost').textContent, /Cost/);
  assert.match(f.q('usage-cost').textContent, /\$12\.00/);
  assert.ok(!/Session spend|Current context cost/.test(f.text()), 'the old two-figure jargon is gone');
  assert.equal(f.q('usage-context').getAttribute('aria-valuenow'), '34');
});

test('limits are grouped per provider: the account is named once and each window is a meter', async (t) => {
  const dom = createDomFixture(code);
  t.after(() => dom.close());
  const { parseUsageReport: parse, groupByAccount: group } = dom.window.fixture;
  const providers = JSON.parse(JSON.stringify(parse(REPORT)));
  assert.deepEqual(providers.map((p) => p.name), ['Anthropic', 'GitHub Copilot']);
  const accounts = JSON.parse(JSON.stringify(group(providers[0])));
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].limits.length, 2);
  assert.equal(accounts[0].inUse, true);
  const two = JSON.parse(JSON.stringify(group({ name: 'P', limits: [{ account: 'a', inUse: false, label: 'x', percent: 1 }, { account: 'b', inUse: false, label: 'y', percent: 1 }, { account: 'a', inUse: false, label: 'z', percent: 1 }] })));
  assert.deepEqual(two.map((g) => [g.account, g.limits.length]), [['a', 2], ['b', 1]]);

  const f = await open(t, { limits: { providers, raw: REPORT } });
  assert.equal(f.all('usage-limit').length, 3);
  assert.equal(f.text().split('me@example.com').length - 1, 1, 'the account appears once, not once per window');
  assert.match(f.text(), /used by this chat/);
  assert.equal(f.all('usage-limit')[0].getAttribute('aria-label'), 'Anthropic Claude 5 Hour: 2% used');
  assert.equal(f.all('usage-limit')[1].getAttribute('aria-valuenow'), '41');
  assert.match(f.text(), /Resets in 3d/);
  // Plan limits sit between the conversation summary and the dense details.
  const order = ['usage-summary', 'usage-limits', 'usage-details'].map((id) => f.q(id));
  assert.ok(order.every(Boolean));
  assert.ok(order[0].compareDocumentPosition(order[1]) & 4, 'limits follow the summary');
  assert.ok(order[1].compareDocumentPosition(order[2]) & 4, 'details follow the limits');
  assert.equal(f.q('usage-details').querySelectorAll('dt').length > 4, true, 'counts are a dense grid, not full rows');
});

test('limits loading draws meter-shaped skeletons and keeps the conversation facts', async (t) => {
  const f = await open(t, { limits: 'loading' });
  assert.ok(f.q('usage-limits-loading'));
  assert.match(f.text(), /Checking provider limits/);
  assert.ok(f.q('usage-summary') && f.q('usage-details'));
});

test('a limits failure is a Retry notice inside the limits group only', async (t) => {
  let retried = 0;
  const f = await open(t, { limits: { error: 'Your computer didn’t answer.' }, props: { onRetryLimits: () => { retried++; } } });
  assert.ok(f.q('usage-limits-error'));
  assert.match(f.q('usage-limits-error').textContent, /didn’t answer/);
  assert.ok(f.q('usage-summary') && f.q('usage-details'), 'session facts still show');
  const retry = [...f.q('usage-limits-error').querySelectorAll('button')].find((b) => /Retry/.test(b.textContent));
  assert.ok(retry);
  await f.act(async () => retry.click());
  assert.equal(retried, 1);
});

test('limits text this build cannot parse is shown last, as received', async (t) => {
  const raw = 'Something new\nthat has no windows';
  const f = await open(t, { limits: { providers: [], raw } });
  assert.equal(f.all('usage-limit').length, 0);
  assert.match(f.q('usage-limits').textContent, /Something new/);
  assert.ok(f.q('usage-details').compareDocumentPosition(f.q('usage-limits')) & 4, 'the raw text is secondary');
});
