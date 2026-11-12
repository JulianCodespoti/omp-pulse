import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { bundleDomFixture, root } from './support/react-dom.mjs';

// plugins.ts imports ./protocol without an extension, which Node's own resolver cannot
// follow, so bundle it once and run the IIFE in this realm (plain objects stay comparable).
const code = await bundleDomFixture(`
  import * as plugins from ${JSON.stringify(resolve(root, 'web/src/domain/plugins.ts'))};
  globalThis.__pluginsDomain = plugins;
`);
vm.runInThisContext(code, { filename: 'plugins-domain-fixture.js' });
const {
  validatePluginView, parsePluginInfo, parsePluginSourceReading, PLUGIN_SLOTS, KEYED_SLOTS, PLUGIN_PERMISSIONS, argvLine,
  isKeyedSlot, boundContext, claimMatches,
} = globalThis.__pluginsDomain;

const node = (k, p = {}, c = []) => ({ k, p, c });
const chip = (text, p = {}) => node('chip', { text, ...p });
const text = (value, p = {}) => node('text', { text: value, ...p });
const col = (...children) => node('col', {}, children);
const row = (...children) => node('row', {}, children);

const accepted = (slot, raw) => {
  const result = validatePluginView(slot, raw);
  assert.equal(result.ok, true, result.error);
  return result.view;
};
const rejected = (slot, raw) => {
  const result = validatePluginView(slot, raw);
  assert.equal(result.ok, false, 'view should have been rejected');
  return result.error;
};
const nested = (depth) => (depth === 1 ? text('leaf') : col(nested(depth - 1)));

test('exposes the slots in contract order, and which are keyed', () => {
  assert.deepEqual([...PLUGIN_SLOTS], [
    'composer.status', 'composer.actions', 'drawer', 'page',
    'session.row', 'session.menu', 'transcript.tool', 'transcript.message',
  ]);
  assert.deepEqual([...KEYED_SLOTS], ['session.row', 'session.menu', 'transcript.tool', 'transcript.message']);
  assert.deepEqual([...PLUGIN_PERMISSIONS], ['session.read', 'session.compose', 'session.prompt', 'session.bash', 'session.rpc']);
  for (const slot of PLUGIN_SLOTS) assert.equal(isKeyedSlot(slot), KEYED_SLOTS.includes(slot), slot);
});

test('null and undefined mean show nothing in every slot', () => {
  for (const slot of PLUGIN_SLOTS) {
    assert.deepEqual(validatePluginView(slot, null), { ok: true, view: null });
    assert.deepEqual(validatePluginView(slot, undefined), { ok: true, view: null });
  }
});

test('views come back in the normalised { k, p, c } form', () => {
  const view = accepted('drawer', { k: 'chip', p: { text: 'cpu', tone: 'success' }, c: [text('ignored')] });
  assert.deepEqual(view, { k: 'chip', p: { text: 'cpu', tone: 'success' }, c: [] });
  assert.deepEqual(accepted('drawer', { k: 'col' }), { k: 'col', p: {}, c: [] });
});

test('composer.status accepts a chip or a row of chips only', () => {
  accepted('composer.status', chip('ok'));
  const view = accepted('composer.status', row(chip('a'), chip('b')));
  assert.equal(view.c.length, 2);
  assert.match(rejected('composer.status', node('card', { title: 'x' })), /card is not allowed in the composer\.status slot/);
  assert.match(rejected('composer.status', text('hello')), /text is not allowed/);
  assert.match(rejected('composer.status', row(text('hello'))), /composer\.status/);
});

test('drawer allows chip, text, progress, row and col but not card, kv, list, button or empty', () => {
  accepted('drawer', col(chip('a'), text('b'), node('progress', { value: 0.5 }), row(chip('c'))));
  assert.match(rejected('drawer', node('card')), /card is not allowed in the drawer slot/);
  assert.match(rejected('drawer', col(node('button', { text: 'go', actions: { click: 'go' } }))), /button is not allowed/);
  assert.match(rejected('drawer', node('empty', { title: 'none' })), /empty is not allowed/);
});

test('page allows every kind', () => {
  const view = accepted('page', col(
    node('card', { title: 'c' }, [text('t')]),
    node('kv', { items: [{ key: 'a', value: 'b' }] }),
    node('list', { items: [{ label: 'one' }] }),
    node('progress', { value: 0.2 }),
    node('button', { text: 'go', actions: { click: 'go' } }),
    node('empty', { title: 'nothing' }),
  ));
  assert.equal(view.c.length, 6);
});

test('an unknown kind or a non-object node is rejected', () => {
  assert.match(rejected('page', { k: 'script', p: {}, c: [] }), /unknown kind/);
  assert.match(rejected('page', 'text'), /must be an object/);
  assert.match(rejected('page', col(42)), /must be an object/);
});

test('node limits: exactly at the limit passes, one over fails', () => {
  accepted('composer.status', row(chip('1'), chip('2'), chip('3')));
  assert.match(rejected('composer.status', row(chip('1'), chip('2'), chip('3'), chip('4'))), /nodes; the limit is 4/);

  accepted('drawer', col(...Array.from({ length: 11 }, (_, i) => chip(`c${i}`))));
  assert.match(rejected('drawer', col(...Array.from({ length: 12 }, (_, i) => chip(`c${i}`)))), /nodes; the limit is 12/);

  accepted('page', col(...Array.from({ length: 299 }, (_, i) => text(`t${i}`))));
  assert.match(rejected('page', col(...Array.from({ length: 300 }, (_, i) => text(`t${i}`)))), /301 nodes; the limit is 300/);
});

test('depth limits: exactly at the limit passes, one over fails', () => {
  accepted('composer.status', row(chip('a')));
  accepted('drawer', nested(3));
  assert.match(rejected('drawer', nested(4)), /levels deep; the limit is 3/);
  accepted('page', nested(8));
  assert.match(rejected('page', nested(9)), /levels deep; the limit is 8/);
});

test('a hostile huge tree is rejected without walking all of it', () => {
  // Not `col(...children)`: spreading 200,000 arguments overflows the call stack before the validator runs.
  const huge = node('col', {}, Array.from({ length: 200000 }, () => text('x')));
  assert.match(rejected('page', huge), /nodes; the limit is 300/);
  assert.match(rejected('page', nested(5000)), /levels deep; the limit is 8/);
  assert.match(rejected('page', node('kv', { items: Array.from({ length: 1_000_000 }, () => ({ key: 'a', value: 'b' })) })), /kv\.items has 1000000 items/);
});

test('long strings are truncated to the cap with a trailing ellipsis', () => {
  const t = accepted('page', text('x'.repeat(3000)));
  assert.equal(t.p.text.length, 2000);
  assert.ok(t.p.text.endsWith('…'));
  assert.equal(t.p.text.slice(0, 1999), 'x'.repeat(1999));

  assert.equal(accepted('drawer', chip('y'.repeat(48))).p.text, 'y'.repeat(48));
  const c = accepted('drawer', chip('y'.repeat(49)));
  assert.equal(c.p.text, `${'y'.repeat(47)}…`);

  const card = accepted('page', node('card', { title: 'z'.repeat(81) }));
  assert.equal(card.p.title.length, 80);
  const empty = accepted('page', node('empty', { title: 't', description: 'd'.repeat(301) }));
  assert.equal(empty.p.description.length, 300);
  const button = accepted('page', node('button', { text: 'b'.repeat(40), actions: { click: 'go' } }));
  assert.equal(button.p.text.length, 32);
});

test('truncation never leaves half a surrogate pair before the ellipsis', () => {
  const view = accepted('drawer', chip(`${'a'.repeat(46)}😀😀`));
  assert.equal(view.p.text, `${'a'.repeat(46)}…`);
});

test('progress value is clamped to 0..1 and non-finite values reject the view', () => {
  assert.equal(accepted('drawer', node('progress', { value: 5 })).p.value, 1);
  assert.equal(accepted('drawer', node('progress', { value: -2 })).p.value, 0);
  assert.equal(accepted('drawer', node('progress', { value: 0.25 })).p.value, 0.25);
  assert.match(rejected('drawer', node('progress', { value: Number.NaN })), /progress\.value/);
  assert.match(rejected('drawer', node('progress', { value: Number.POSITIVE_INFINITY })), /progress\.value/);
  assert.match(rejected('drawer', node('progress', { value: '0.5' })), /progress\.value/);
});

test('unknown props, bad tones and wrongly typed optional props are dropped', () => {
  const view = accepted('drawer', text('hi', {
    tone: 'rainbow', strong: 'yes', mono: true, style: 'color:red', onclick: 'x()',
  }));
  assert.deepEqual(view.p, { text: 'hi', mono: true });

  assert.deepEqual(accepted('drawer', col()).p, {});
  assert.deepEqual(accepted('drawer', node('col', { gap: 'huge' })).p, {});
  assert.deepEqual(accepted('drawer', node('col', { gap: 'sm' })).p, { gap: 'sm' });
  const progress = accepted('drawer', node('progress', { value: 1, label: 7, tone: 'warning' }));
  assert.deepEqual(progress.p, { value: 1, tone: 'warning' });
});

test('a required prop with the wrong type rejects the whole view', () => {
  assert.equal(rejected('drawer', col(chip(7))), 'chip.text must be a string');
  assert.equal(rejected('drawer', col(node('text', {}))), 'text.text must be a string');
  assert.equal(rejected('page', node('empty', { description: 'only' })), 'empty.title must be a string');
  assert.match(rejected('page', node('kv', { items: 'nope' })), /kv\.items must be an array/);
  assert.match(rejected('page', node('kv', { items: [{ key: 'a' }] })), /kv\.items\[0\]\.value must be a string/);
  assert.match(rejected('page', node('list', { items: [{ detail: 'x' }] })), /list\.items\[0\]\.label must be a string/);
});

test('chip and list actions need a 1 to 64 character click or are dropped', () => {
  assert.deepEqual(accepted('drawer', chip('a', { actions: { click: 'open' } })).p.actions, { click: 'open' });
  for (const actions of [{ click: '' }, { click: 'x'.repeat(65) }, { click: 3 }, {}, 'open', null]) {
    assert.equal('actions' in accepted('drawer', chip('a', { actions })).p, false);
  }
  assert.equal(accepted('drawer', chip('a', { actions: { click: 'x'.repeat(64) } })).p.actions.click.length, 64);

  const list = accepted('page', node('list', { items: [{ label: 'a' }], actions: { click: '' } }));
  assert.equal('actions' in list.p, false);
});

test('a button without a usable action is rejected', () => {
  assert.match(rejected('page', node('button', { text: 'go' })), /button\.actions\.click/);
  assert.match(rejected('page', node('button', { text: 'go', actions: { click: '' } })), /button\.actions\.click/);
  assert.match(rejected('page', node('button', { text: 'go', actions: { click: 'x'.repeat(65) } })), /button\.actions\.click/);
  const view = accepted('page', node('button', { text: 'go', variant: 'loud', actions: { click: 'go' } }));
  assert.deepEqual(view.p, { text: 'go', actions: { click: 'go' } });
  assert.equal(accepted('page', node('button', { text: 'go', variant: 'danger', actions: { click: 'go' } })).p.variant, 'danger');
});

test('kv and list item caps: at the cap passes, over it rejects', () => {
  const kvItems = (n) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, value: `v${i}` }));
  assert.equal(accepted('page', node('kv', { items: kvItems(50) })).p.items.length, 50);
  assert.match(rejected('page', node('kv', { items: kvItems(51) })), /kv\.items has 51 items; the limit is 50/);

  const listItems = (n) => Array.from({ length: n }, (_, i) => ({ label: `l${i}` }));
  assert.equal(accepted('page', node('list', { items: listItems(100) })).p.items.length, 100);
  assert.match(rejected('page', node('list', { items: listItems(101) })), /list\.items has 101 items; the limit is 100/);
});

test('kv and list items are normalised: extra keys and bad tones dropped, strings capped', () => {
  const kv = accepted('page', node('kv', { items: [{ key: 'k'.repeat(90), value: 'v'.repeat(500), tone: 'nope', extra: 1 }] }));
  assert.equal(kv.p.items[0].key.length, 80);
  assert.equal(kv.p.items[0].value.length, 400);
  assert.deepEqual(Object.keys(kv.p.items[0]).sort(), ['key', 'value']);

  const list = accepted('page', node('list', { items: [{ id: 'a', label: 'L', detail: 'D', value: 'V', tone: 'error', extra: 1 }] }));
  assert.deepEqual(list.p.items, [{ id: 'a', label: 'L', detail: 'D', value: 'V', tone: 'error' }]);
});

test('a view over 65536 bytes as JSON is rejected', () => {
  const big = col(...Array.from({ length: 40 }, () => text('x'.repeat(2000))));
  assert.match(rejected('page', big), /bytes as JSON; the limit is 65536/);
  // Just under: 30 x 2000 characters plus overhead.
  accepted('page', col(...Array.from({ length: 30 }, () => text('x'.repeat(2000)))));
});

test('size is measured in bytes, not characters', () => {
  // 32 texts of 1000 three-byte characters is about 96 KB of JSON but only 32000 characters.
  const wide = col(...Array.from({ length: 32 }, () => text('€'.repeat(1000))));
  assert.match(rejected('page', wide), /bytes as JSON/);
});

test('leaf kinds drop their children and containers keep theirs', () => {
  const view = accepted('page', node('card', { title: 'c' }, [node('text', { text: 'a' }, [text('b')])]));
  assert.equal(view.c.length, 1);
  assert.deepEqual(view.c[0].c, []);
});

test('parsePluginInfo accepts a well-formed entry', () => {
  const info = parsePluginInfo({
    id: 'host-usage', name: 'Host usage', version: '0.1.0', description: '',
    status: 'needs_review', hash: 'abc', slots: ['drawer'], linked: true,
    sources: [{ id: 'load', command: ['cat', '/proc/loadavg'], intervalS: 10, timeoutS: 5 }],
    extra: 'ignored',
  });
  assert.deepEqual(info, {
    id: 'host-usage', name: 'Host usage', version: '0.1.0', description: '',
    status: 'needs_review', hash: 'abc', slots: ['drawer'], linked: true, changed: false,
    sources: [{ id: 'load', command: ['cat', '/proc/loadavg'], intervalS: 10, timeoutS: 5 }],
    permissions: [], tools: [], messages: [], options: [], optionValues: {}, actions: [], warnings: [],
  });
  assert.equal('error' in info, false);
  assert.equal(parsePluginInfo({ ...info, changed: true }).changed, true);
  assert.equal(parsePluginInfo({ ...info, changed: 'true' }).changed, false);
  assert.deepEqual(parsePluginInfo({ ...info, warnings: ['source s uses helper.sh'] }).warnings, ['source s uses helper.sh']);
  assert.equal(parsePluginInfo({ ...info, warnings: [42] }), null, 'a malformed warning list rejects the entry');

  const invalid = parsePluginInfo({
    id: 'bad', name: 'bad', version: '', description: '', status: 'invalid', hash: '',
    slots: [], sources: [], linked: false, changed: true, error: 'unknown key',
  });
  assert.equal(invalid.error, 'unknown key');
  assert.equal(invalid.changed, true);
});

test('argvLine keeps argument boundaries visible, as the CLI does', () => {
  assert.equal(argvLine(['cat', '/proc/loadavg']), 'cat /proc/loadavg');
  // One argument holding a space, and the same words as two arguments, must not read alike.
  assert.equal(argvLine(['sh', '-c', 'a b']), 'sh -c "a b"');
  assert.equal(argvLine(['sh', '-c', 'a', 'b']), 'sh -c a b');
  assert.equal(argvLine(['printf', '%s|', 'one two', 'three']), 'printf "%s|" "one two" three');
  assert.equal(argvLine(['x', '', '{arg}']), 'x "" {arg}');
  assert.equal(argvLine(['echo', 'say "hi"']), 'echo "say \\"hi\\""');
});

test('parsePluginInfo rejects a wrong status or malformed fields', () => {
  const good = {
    id: 'a', name: 'A', version: '1', description: '', status: 'enabled', hash: 'h',
    slots: ['page'], sources: [], linked: false,
  };
  assert.notEqual(parsePluginInfo(good), null);
  assert.equal(parsePluginInfo({ ...good, status: 'running' }), null);
  assert.equal(parsePluginInfo({ ...good, status: undefined }), null);
  assert.equal(parsePluginInfo({ ...good, linked: 'no' }), null);
  assert.equal(parsePluginInfo({ ...good, slots: [1] }), null);
  assert.equal(parsePluginInfo({ ...good, hash: undefined }), null);
  assert.equal(parsePluginInfo({ ...good, sources: [{ id: 'x', command: ['a'], intervalS: 'ten', timeoutS: 5 }] }), null);
  assert.equal(parsePluginInfo({ ...good, sources: [null] }), null);
  assert.equal(parsePluginInfo(null), null);
  assert.equal(parsePluginInfo([good]), null);
});

test('parsePluginSourceReading accepts readings and rejects malformed ones', () => {
  const reading = { ok: true, text: '0.1 0.2', exitCode: 0, fetchedAtMs: 1700000000000, truncated: false };
  assert.deepEqual(parsePluginSourceReading(reading), reading);
  assert.deepEqual(
    parsePluginSourceReading({ ...reading, ok: false, exitCode: null, error: 'timed out' }),
    { ...reading, ok: false, exitCode: null, error: 'timed out' },
  );
  assert.equal(parsePluginSourceReading({ ...reading, text: 3 }), null);
  assert.equal(parsePluginSourceReading({ ...reading, fetchedAtMs: Number.NaN }), null);
  assert.equal(parsePluginSourceReading({ ...reading, exitCode: 'zero' }), null);
  assert.equal(parsePluginSourceReading(undefined), null);
});

const menu = (count, actions = { click: 'tap' }) => node('list', {
  items: Array.from({ length: count }, (_, i) => ({ id: `i${i}`, label: `Item ${i}` })),
  ...(actions === null ? {} : { actions }),
});

test('composer.actions takes one list of at most 8 items that carries a click action', () => {
  assert.equal(accepted('composer.actions', menu(8)).p.items.length, 8);
  assert.match(rejected('composer.actions', menu(9)), /list\.items has 9 items; the limit is 8/);
  assert.match(rejected('composer.actions', chip('x')), /chip is not allowed in the composer\.actions slot/);
  assert.match(rejected('composer.actions', col(menu(1))), /col is not allowed in the composer\.actions slot/);
  assert.match(rejected('composer.actions', menu(2, null)), /list\.actions\.click/);
  assert.match(rejected('composer.actions', menu(2, { click: '' })), /list\.actions\.click/);
});

test('session.menu takes one list of at most 6 items that carries a click action', () => {
  assert.equal(accepted('session.menu', menu(6)).p.items.length, 6);
  assert.match(rejected('session.menu', menu(7)), /list\.items has 7 items; the limit is 6/);
  assert.match(rejected('session.menu', node('card')), /card is not allowed in the session\.menu slot/);
  assert.match(rejected('session.menu', menu(1, null)), /list\.actions\.click/);
  assert.deepEqual(accepted('session.menu', menu(1)).p.actions, { click: 'tap' });
});

test('a menu item id is capped at 64 characters', () => {
  const long = node('list', { items: [{ id: 'x'.repeat(70), label: 'L' }], actions: { click: 'tap' } });
  const id = accepted('session.menu', long).p.items[0].id;
  assert.equal(id.length, 64);
  assert.ok(id.endsWith('…'));
  const exact = node('list', { items: [{ id: 'y'.repeat(64), label: 'L' }], actions: { click: 'tap' } });
  assert.equal(accepted('session.menu', exact).p.items[0].id, 'y'.repeat(64));
});

test('session.row accepts a chip or a row of at most two chips', () => {
  accepted('session.row', chip('a'));
  assert.equal(accepted('session.row', row(chip('a'), chip('b'))).c.length, 2);
  assert.match(rejected('session.row', row(chip('a'), chip('b'), chip('c'))), /nodes; the limit is 3/);
  assert.match(rejected('session.row', text('hello')), /text is not allowed in the session\.row slot/);
  assert.match(rejected('session.row', row(text('hello'))), /session\.row may hold only chips/);
  assert.match(rejected('session.row', row(row())), /session\.row may hold only chips/);
});

test('transcript slots allow every kind within 120 nodes and 6 levels', () => {
  for (const slot of ['transcript.tool', 'transcript.message']) {
    accepted(slot, node('card', { title: 'c' }, [node('kv', { items: [{ key: 'a', value: 'b' }] }), node('progress', { value: 1 })]));
    accepted(slot, col(...Array.from({ length: 119 }, (_, i) => text(`t${i}`))));
    assert.match(rejected(slot, col(...Array.from({ length: 120 }, (_, i) => text(`t${i}`)))), /121 nodes; the limit is 120/);
    accepted(slot, nested(6));
    assert.match(rejected(slot, nested(7)), /levels deep; the limit is 6/);
  }
});

test('claimMatches: * is any run of characters, everything else is literal', () => {
  assert.equal(claimMatches(['schedule_*'], 'schedule_add'), true);
  assert.equal(claimMatches(['schedule_*'], 'schedule_'), true);
  assert.equal(claimMatches(['schedule_*'], 'xschedule_add'), false);
  assert.equal(claimMatches(['schedule_*'], 'schedule'), false);
  assert.equal(claimMatches(['*_add'], 'schedule_add'), true);
  assert.equal(claimMatches(['*_add'], 'schedule_added'), false);

  assert.equal(claimMatches(['a*b*c'], 'abc'), true);
  assert.equal(claimMatches(['a*b*c'], 'aXXbYYc'), true);
  assert.equal(claimMatches(['a*b*c'], 'abXbc'), true);
  assert.equal(claimMatches(['a*b*c'], 'acb'), false);
  assert.equal(claimMatches(['a*b*c'], 'abcd'), false);

  assert.equal(claimMatches(['mcp__cron__list'], 'mcp__cron__list'), true);
  assert.equal(claimMatches(['mcp__cron__list'], 'mcp__cron__list2'), false);
  assert.equal(claimMatches(['my-ext:card'], 'My-ext:card'), false);

  assert.equal(claimMatches(['*'], ''), true);
  assert.equal(claimMatches(['*'], 'anything at all'), true);
  assert.equal(claimMatches([], 'anything'), false);
  assert.equal(claimMatches(['one', 'two_*'], 'two_x'), true);
  assert.equal(claimMatches(['one', 'two_*'], 'three'), false);
});

test('claimMatches treats regex syntax in a pattern as plain text', () => {
  assert.equal(claimMatches(['a.c'], 'abc'), false);
  assert.equal(claimMatches(['a.c'], 'a.c'), true);
  assert.equal(claimMatches(['(x+)+$'], 'xxxxxxxxxxxxxxxxxxxxxxxxxxxx!'), false);
  assert.equal(claimMatches(['a*a*a*a*a*a*a*a*b'], 'a'.repeat(5000)), false);
});

const session = { id: '/s/1', title: 'Title', cwd: '/work', model: 'm1', status: 'working', activeAt: 5 };

test('boundContext copies only the documented fields', () => {
  const bound = boundContext({
    session: { ...session, token: 'secret' },
    call: { id: 'c1', name: 'bash', args: { a: 1 }, output: 'out', state: 'running', truncated: false, secret: 1 },
    message: { id: 'm1', customType: 'x:y', text: 'hi', details: { d: 1 }, truncated: false, secret: 2 },
    extra: 'dropped',
  });
  assert.deepEqual(bound, {
    session,
    call: { id: 'c1', name: 'bash', args: { a: 1 }, output: 'out', state: 'running', truncated: false },
    message: { id: 'm1', customType: 'x:y', text: 'hi', details: { d: 1 }, truncated: false },
  });
  assert.deepEqual(boundContext({ session: null }), { session: null });
  assert.deepEqual(boundContext({ session }), { session });
  assert.deepEqual(boundContext(null), { session: null });
  assert.deepEqual(boundContext('nope'), { session: null });
});

test('boundContext coerces state and status to the allowed strings', () => {
  const bound = boundContext({
    session: { ...session, status: 'asleep', activeAt: 'soon' },
    call: { id: 'c', name: 'n', args: null, output: '', state: 'weird', truncated: false },
  });
  assert.equal(bound.session.status, 'idle');
  assert.equal(bound.session.activeAt, null);
  assert.equal(bound.call.state, 'done');
  for (const state of ['running', 'done', 'error']) {
    assert.equal(boundContext({ session: null, call: { id: 'c', name: 'n', args: 1, output: '', state, truncated: false } }).call.state, state);
  }
});

test('boundContext nulls args over 32768 bytes of JSON and keeps those at the limit', () => {
  const call = (args) => boundContext({ session: null, call: { id: 'c', name: 'n', args, output: '', state: 'done', truncated: false } }).call;
  // A string's JSON form is its length plus two quotes.
  const fits = call('a'.repeat(32766));
  assert.equal(fits.args.length, 32766);
  assert.equal(fits.truncated, false);
  const over = call('a'.repeat(32767));
  assert.equal(over.args, null);
  assert.equal(over.truncated, true);

  // Bytes, not characters: three-byte characters hit the cap with a third of the length.
  assert.equal(call('€'.repeat(10922)).args.length, 10922);
  assert.equal(call('€'.repeat(10923)).args, null);
  assert.equal(call('€'.repeat(10923)).truncated, true);
});

test('boundContext survives values that cannot be serialised', () => {
  const call = (args) => boundContext({ session: null, call: { id: 'c', name: 'n', args, output: '', state: 'done', truncated: false } }).call;
  const big = call(10n);
  assert.deepEqual([big.args, big.truncated], [null, true]);
  const throwing = call({ toJSON() { throw new Error('no'); } });
  assert.deepEqual([throwing.args, throwing.truncated], [null, true]);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.deepEqual([call(cyclic).args, call(cyclic).truncated], [null, true]);
  // Nothing to send is not a loss.
  const none = call(undefined);
  assert.deepEqual([none.args, none.truncated], [null, false]);
  // Non-JSON parts are stripped, not passed through.
  assert.deepEqual(call({ keep: 1, drop: undefined, fn() {}, when: new Date(0) }).args, { keep: 1, when: '1970-01-01T00:00:00.000Z' });
});

test('boundContext cuts output and text over 32768 characters and flags it', () => {
  const both = (output, body) => boundContext({
    session: null,
    call: { id: 'c', name: 'n', args: null, output, state: 'done', truncated: false },
    message: { id: 'm', customType: 't', text: body, details: null, truncated: false },
  });
  const fits = both('o'.repeat(32768), 't'.repeat(32768));
  assert.equal(fits.call.output.length, 32768);
  assert.equal(fits.call.truncated, false);
  assert.equal(fits.message.truncated, false);

  const over = both('o'.repeat(32769), 't'.repeat(40000));
  assert.equal(over.call.output.length, 32768);
  assert.equal(over.call.truncated, true);
  assert.equal(over.message.text.length, 32768);
  assert.equal(over.message.truncated, true);

  // A cut that would land inside an emoji drops the whole emoji.
  const emoji = both('a'.repeat(32767) + '😀', '');
  assert.equal(emoji.call.output, 'a'.repeat(32767));
});

test('boundContext nulls message details over the byte limit and keeps an incoming truncated flag', () => {
  const message = (details, truncated = false) => boundContext({
    session: null, message: { id: 'm', customType: 't', text: '', details, truncated },
  }).message;
  assert.deepEqual(message({ big: 'x'.repeat(40000) }).details, null);
  assert.equal(message({ big: 'x'.repeat(40000) }).truncated, true);
  assert.deepEqual(message({ small: 1 }).details, { small: 1 });
  assert.equal(message({ small: 1 }, true).truncated, true);
});

test('parsePluginInfo: slice 2 fields default to empty when absent', () => {
  const info = parsePluginInfo({
    id: 'a', name: 'A', version: '1', description: '', status: 'enabled', hash: 'h',
    slots: ['page'], sources: [], linked: false,
  });
  assert.deepEqual(
    [info.permissions, info.tools, info.messages, info.options, info.optionValues, info.actions],
    [[], [], [], [], {}, []],
  );
});

test('parsePluginInfo: slice 2 fields are read when present', () => {
  const info = parsePluginInfo({
    id: 'a', name: 'A', version: '1', description: '', status: 'enabled', hash: 'h',
    slots: ['transcript.tool', 'session.menu'], sources: [], linked: false,
    permissions: ['session.read', 'session.prompt', 'session.nuke', 'session.bash'],
    tools: ['schedule_*'], messages: ['my-ext:card'],
    options: [
      { id: 'warn_at', label: 'Warn above', type: 'choice', choices: ['70', '80'], default: '80', extra: 1 },
      { id: 'on', label: 'On', type: 'bool', choices: [], default: false },
      { id: 'note', label: 'Note', type: 'text', default: '' },
    ],
    optionValues: { warn_at: '70', on: true, note: 'x', bad: 3, worse: null, nested: { a: 1 } },
    actions: [
      { id: 'start', label: 'Start', command: ['systemctl', '{arg}'], argPattern: '[a-z]+', timeoutS: 30 },
      { id: 'stop', label: 'Stop', command: ['true'], timeoutS: 5 },
    ],
  });
  assert.deepEqual(info.permissions, ['session.read', 'session.prompt', 'session.bash']);
  assert.deepEqual(info.tools, ['schedule_*']);
  assert.deepEqual(info.messages, ['my-ext:card']);
  assert.deepEqual(info.options, [
    { id: 'warn_at', label: 'Warn above', type: 'choice', choices: ['70', '80'], default: '80' },
    { id: 'on', label: 'On', type: 'bool', choices: [], default: false },
    { id: 'note', label: 'Note', type: 'text', choices: [], default: '' },
  ]);
  assert.deepEqual(info.optionValues, { warn_at: '70', on: true, note: 'x' });
  assert.deepEqual(info.actions, [
    { id: 'start', label: 'Start', command: ['systemctl', '{arg}'], argPattern: '[a-z]+', timeoutS: 30 },
    { id: 'stop', label: 'Stop', command: ['true'], timeoutS: 5 },
  ]);
  assert.equal('argPattern' in info.actions[1], false);
});

test('parsePluginInfo: a malformed option or action makes the whole entry null', () => {
  const good = {
    id: 'a', name: 'A', version: '1', description: '', status: 'enabled', hash: 'h',
    slots: ['page'], sources: [], linked: false,
  };
  const option = { id: 'o', label: 'O', type: 'bool', choices: [], default: false };
  const action = { id: 'x', label: 'X', command: ['true'], timeoutS: 5 };
  assert.notEqual(parsePluginInfo({ ...good, options: [option], actions: [action] }), null);
  assert.equal(parsePluginInfo({ ...good, options: [{ ...option, type: 'number' }] }), null);
  assert.equal(parsePluginInfo({ ...good, options: [{ ...option, label: undefined }] }), null);
  assert.equal(parsePluginInfo({ ...good, options: [{ ...option, default: 3 }] }), null);
  assert.equal(parsePluginInfo({ ...good, options: [option, null] }), null);
  assert.equal(parsePluginInfo({ ...good, options: 'nope' }), null);
  assert.equal(parsePluginInfo({ ...good, actions: [{ ...action, command: 'true' }] }), null);
  assert.equal(parsePluginInfo({ ...good, actions: [{ ...action, timeoutS: 'soon' }] }), null);
  assert.equal(parsePluginInfo({ ...good, actions: [{ ...action, argPattern: 5 }] }), null);
  assert.equal(parsePluginInfo({ ...good, actions: [action, 'x'] }), null);
  assert.equal(parsePluginInfo({ ...good, tools: [1] }), null);
});
