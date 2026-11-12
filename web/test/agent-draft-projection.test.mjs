import test from 'node:test';
import assert from 'node:assert/strict';
import { agentDiscussionReference } from '../src/domain/agent-discussion.ts';
import {
  appendAgentDraftReference,
  removeAgentDraftReference,
  replaceAgentDraftPrefix,
  validAgentDraftProjection,
} from '../src/domain/agent-draft-projection.ts';

// Pure string/provenance contracts: no React, browser, daemon, storage or model.
const namespace = 'synthetic-pairing';
const path = '/synthetic/main.jsonl';
const agent = (id, overrides = {}) => ({ id, name: `Agent ${id}`, source: 'rpc', ...overrides });
const first = agentDiscussionReference(agent('first'));
const second = agentDiscussionReference(agent('second', { source: 'desktop', connectionId: 'connection-a' }));
const third = agentDiscussionReference(agent('third', { createdAt: 0 }));
const append = (projection, text, reference) => appendAgentDraftReference(projection, text, namespace, path, reference);
const valid = (projection, text = projection?.text ?? '') => validAgentDraftProjection(projection, text, namespace, path);
const prepare = (prefix, references = [first, second, third]) => {
  let projection = null, text = prefix;
  for (const reference of references) {
    projection = append(projection, text, reference);
    text = projection.text;
  }
  return projection;
};

test('formatter adds the captured name without changing exact text or identity', () => {
  const name = '  Zoë 👩🏽‍💻 "quote"\\path\nsecond line\t\r\u0000  ';
  assert.deepEqual(agentDiscussionReference(agent('alpha', { name })), {
    identity: '{"id":"alpha","source":"rpc"}',
    name,
    text: `About agent ${JSON.stringify(name)} {"id":"alpha","source":"rpc"}:\n`,
  });
});

for (const [label, fields, suffix] of [
  ['omitted', {}, ''],
  ['explicit undefined', { createdAt: undefined, connectionId: undefined }, ''],
  ['zero creation time', { createdAt: 0 }, ',"createdAt":0'],
  ['creation time', { createdAt: 123.5 }, ',"createdAt":123.5'],
  ['empty connection', { connectionId: '' }, ',"connectionId":""'],
  ['connection only', { connectionId: 'bridge-a' }, ',"connectionId":"bridge-a"'],
  ['both optional identities', { createdAt: 42, connectionId: 'bridge-b' }, ',"createdAt":42,"connectionId":"bridge-b"'],
]) {
  for (const source of ['rpc', 'desktop']) test(`${source} formatter preserves ${label}`, () => {
    const reference = agentDiscussionReference(agent('a', { source, name: '', ...fields }));
    const identity = `{"id":"a","source":"${source}"${suffix}}`;
    assert.deepEqual(reference, { identity, name: '', text: `About agent "" ${identity}:\n` });
  });
}

test('identity strings retain escaped Unicode IDs and desktop connection distinctions', () => {
  const original = agent('日本語 👋\\"\n', { source: 'desktop', createdAt: 10, connectionId: 'bridge "\n🛰' });
  const reference = agentDiscussionReference(original);
  assert.equal(reference.identity, JSON.stringify({ id: original.id, source: original.source, createdAt: 10, connectionId: original.connectionId }));
  assert.equal(agentDiscussionReference({ ...original, name: 'Renamed' }).identity, reference.identity);
  assert.notEqual(agentDiscussionReference({ ...original, connectionId: 'other' }).identity, reference.identity);
  assert.notEqual(agentDiscussionReference({ ...original, createdAt: 11 }).identity, reference.identity);
  assert.notEqual(agentDiscussionReference({ ...original, source: 'rpc' }).identity, reference.identity);
});

const prefixes = [
  ['', 'empty'],
  [' ', 'single space'],
  ['\t \r\n', 'whitespace only'],
  ['\n\n', 'blank lines'],
  ['Two lines\nsecond line', 'multiline'],
  ['  café 👩🏽‍💻 日本語 e\u0301\u2028\u0000  ', 'Unicode and invisible bytes'],
  ['Keep my trailing newline\n', 'trailing newline'],
  ['Keep my separators\n\n\n', 'trailing blank lines'],
];

for (const [prefix, label] of prefixes) {
  test(`${label}: append preserves every user byte and exact joining separators`, () => {
    const projection = prepare(prefix);
    assert.equal(projection.prefix, prefix);
    assert.equal(projection.text, `${prefix}${prefix ? '\n\n' : ''}${first.text}\n\n${second.text}\n\n${third.text}`);
    assert.deepEqual(projection.references, [first, second, third]);
    assert.equal(valid(projection), projection);
  });

  for (const [index, location] of [[0, 'first'], [1, 'middle'], [2, 'last']]) {
    test(`${label}: remove ${location} block without consuming user separators`, () => {
      const projection = prepare(prefix);
      const remaining = [first, second, third].filter((_, i) => i !== index);
      const removed = removeAgentDraftReference(projection, projection.references[index].identity);
      assert.equal(removed.prefix, prefix);
      assert.deepEqual(removed.references, remaining);
      assert.equal(removed.text, `${prefix}${prefix ? '\n\n' : ''}${remaining[0].text}\n\n${remaining[1].text}`);
      assert.equal(valid(removed), removed);
      assert.equal(projection.references.length, 3, 'the input projection is unchanged');
    });
  }

  test(`${label}: removing all references returns only the unchanged prefix`, () => {
    let projection = prepare(prefix);
    for (const reference of [second, first]) projection = removeAgentDraftReference(projection, reference.identity);
    assert.deepEqual(projection.references, [third]);
    assert.equal(projection.text, `${prefix}${prefix ? '\n\n' : ''}${third.text}`);
    const rawAfterFinalRemoval = projection.prefix;
    assert.equal(removeAgentDraftReference(projection, third.identity), null);
    assert.equal(rawAfterFinalRemoval, prefix);
  });
}

test('replace prefix changes only visible prose and its necessary joining separator', () => {
  const initial = prepare('original\n');
  for (const [prefix] of prefixes) {
    const changed = replaceAgentDraftPrefix(initial, prefix);
    assert.equal(changed.prefix, prefix);
    assert.equal(changed.references, initial.references);
    assert.equal(changed.text, `${prefix}${prefix ? '\n\n' : ''}${first.text}\n\n${second.text}\n\n${third.text}`);
    assert.equal(valid(changed), changed);
  }
  assert.equal(initial.prefix, 'original\n');
});

test('same-turn append/edit/remove/re-add uses the latest canonical projection', () => {
  let projection = prepare('', [first]);
  projection = replaceAgentDraftPrefix(projection, 'new café 👋\n');
  projection = append(projection, projection.text, second);
  projection = removeAgentDraftReference(projection, first.identity);
  projection = replaceAgentDraftPrefix(projection, '');
  projection = append(projection, projection.text, first);
  assert.deepEqual(projection.references, [second, first]);
  assert.equal(projection.prefix, '');
  assert.equal(projection.text, `${second.text}\n\n${first.text}`);
  assert.equal(valid(projection), projection);
  projection = removeAgentDraftReference(projection, second.identity);
  const prefix = projection.prefix;
  assert.equal(removeAgentDraftReference(projection, first.identity), null);
  projection = append(null, prefix, third);
  assert.equal(projection.text, third.text);
  assert.deepEqual(projection.references, [third]);
});

test('caller deduplication keeps captured name/text while another connection stays distinct', () => {
  const original = agent('desktop', { source: 'desktop', name: 'Captured name', connectionId: 'one' });
  const prepareIfNew = (projection, text, value) => {
    const reference = agentDiscussionReference(value);
    return text.includes(reference.identity) ? projection : append(projection, text, reference);
  };
  let projection = prepareIfNew(null, 'draft', original);
  const captured = projection;
  projection = prepareIfNew(projection, projection.text, { ...original, name: 'Later name' });
  assert.equal(projection, captured);
  assert.equal(projection.references[0].name, 'Captured name');
  assert.ok(projection.text.includes('Captured name'));
  assert.ok(!projection.text.includes('Later name'));
  projection = prepareIfNew(projection, projection.text, { ...original, name: 'Other bridge', connectionId: 'two' });
  assert.equal(projection.references.length, 2);
  assert.notEqual(projection.references[0].identity, projection.references[1].identity);
});

test('literal identity deduplication never creates provenance for restored text', () => {
  for (const text of [first.text, `User quoted only ${first.identity}`, `literal\n\n${first.text}`]) {
    assert.ok(text.includes(first.identity));
    assert.equal(validAgentDraftProjection(null, text, namespace, path), null);
    const afterNewPreparation = append(null, text, second);
    assert.equal(afterNewPreparation.prefix, text);
    assert.deepEqual(afterNewPreparation.references, [second]);
  }
});

test('remount/expansion with missing provenance cannot rediscover generated-looking text', () => {
  const text = prepare('prefix').text;
  assert.equal(validAgentDraftProjection(null, text, namespace, path), null);
  assert.equal(validAgentDraftProjection(null, '{invalid JSON}\nAbout agent "x" {}:\n', namespace, path), null);
  const current = append(null, text, agentDiscussionReference(agent('new')));
  assert.equal(current.prefix, text);
  assert.equal(current.references.length, 1);
});

test('validation rejects a missing session, another session or another namespace', () => {
  const projection = prepare('draft');
  for (const [otherNamespace, otherPath] of [[namespace, null], [namespace, '/synthetic/other.jsonl'], ['other-pairing', path]]) {
    assert.equal(validAgentDraftProjection(projection, projection.text, otherNamespace, otherPath), null);
  }
  assert.equal(valid(projection), projection, 'validation itself is pure; caller owns permanent invalidation');
});

test('changed prefix, suffix, block order, separators and raw clear all invalidate provenance', () => {
  const projection = prepare('draft\n');
  const changes = [
    '',
    'x' + projection.text,
    projection.text + 'x',
    projection.text.slice(0, -1),
    projection.text.replace('draft', 'Draft'),
    projection.text.replace('About agent', 'about agent'),
    projection.text.replace('\n\n\nAbout', '\n\nAbout'),
    `draft\n\n\n${second.text}\n\n${first.text}\n\n${third.text}`,
  ];
  for (const text of changes) assert.equal(valid(projection, text), null);
});

test('validation checks the complete suffix reconstruction rather than only the snapshot', () => {
  const projection = prepare('draft');
  const malformed = [
    { ...projection, prefix: 'wrong prefix' },
    { ...projection, references: [] },
    { ...projection, references: [second, first, third] },
    { ...projection, references: [first, second] },
    { ...projection, references: [{ ...first, text: first.text + ' ' }, second, third] },
    { ...projection, text: projection.text + ' ' },
  ];
  for (const candidate of malformed) assert.equal(valid(candidate, candidate.text), null);
});

test('failed validation stays invalid when the caller discards metadata and raw text later matches', () => {
  const original = prepare('draft');
  let projection = original;
  projection = valid(projection, 'foreign update');
  assert.equal(projection, null);
  assert.equal(validAgentDraftProjection(projection, original.text, namespace, path), null);
  const fresh = append(projection, original.text, agentDiscussionReference(agent('fresh')));
  assert.equal(fresh.prefix, original.text);
  assert.equal(fresh.references.length, 1);
});

test('appending with stale canonical or scope metadata preserves all raw bytes as editable prefix', () => {
  const old = prepare('old draft', [first]);
  for (const [text, nextNamespace, nextPath] of [
    ['foreign\n' + old.text, namespace, path],
    ['', namespace, path],
    [old.text, 'other-pairing', path],
    [old.text, namespace, '/synthetic/other.jsonl'],
  ]) {
    const current = appendAgentDraftReference(old, text, nextNamespace, nextPath, second);
    assert.equal(current.prefix, text);
    assert.deepEqual(current.references, [second]);
    assert.equal(current.text, `${text}${text ? '\n\n' : ''}${second.text}`);
    assert.equal(validAgentDraftProjection(current, current.text, nextNamespace, nextPath), current);
  }
});

test('remove compares exact identities and does not remove matching text in user prose', () => {
  const prefix = `Quoted ${second.text}Keep this literal ${second.identity}\n`;
  const projection = prepare(prefix);
  const unchanged = removeAgentDraftReference(projection, 'unknown identity');
  assert.equal(unchanged, projection);
  assert.equal(removeAgentDraftReference(projection, second.identity.slice(1)), projection);
  const removed = removeAgentDraftReference(projection, second.identity);
  assert.equal(removed.prefix, prefix);
  assert.equal(removed.text, `${prefix}\n\n${first.text}\n\n${third.text}`);
});

test('all helpers leave frozen inputs untouched and capture reference values at preparation', () => {
  const source = agentDiscussionReference(agent('mutable', { name: 'Captured' }));
  const captured = append(null, 'prose', source);
  source.name = 'Changed outside';
  source.text = 'Changed outside';
  assert.equal(captured.references[0].name, 'Captured');
  assert.equal(valid(captured), captured);
  const projection = prepare('original');
  projection.references.forEach(Object.freeze);
  Object.freeze(projection.references);
  Object.freeze(projection);
  Object.freeze(source);
  assert.equal(valid(projection), projection);
  assert.equal(replaceAgentDraftPrefix(projection, 'new').prefix, 'new');
  assert.equal(removeAgentDraftReference(projection, first.identity).references.length, 2);
  assert.equal(append(projection, projection.text, source).references.length, 4);
  assert.equal(projection.prefix, 'original');
  assert.deepEqual(projection.references, [first, second, third]);
});
