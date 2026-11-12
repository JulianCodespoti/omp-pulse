import test from 'node:test';
import assert from 'node:assert/strict';
import { magicKeywordMatches, maskKeywordNonProse } from '../src/domain/magic-keywords.ts';

const keywords = [
  {id:'ultrathink',word:'ultrathink',hue:[0,330]},
  {id:'workflow',word:'workflowz',hue:[30,150]},
];
const words = text => magicKeywordMatches(text, keywords).map(match => text.slice(match.start, match.end));

test('OMP standalone keywords are case-sensitive and preserve punctuation boundaries', () => {
  for (const text of ['ultrathink','(ultrathink)','"ultrathink"','ultrathink.','ultrathink:','😀ultrathink','ultrathink😀','ultrathink\nworkflowz']) {
    assert.ok(words(text).length > 0, text);
  }
  for (const text of ['Ultrathink','ULTRATHINK','ultrathinking','myultrathink','éultrathink','ultrathink中','2ultrathink','ultrathink_','_ultrathink','/ultrathink','ultrathink/','\\ultrathink','ultrathink\\','-ultrathink','ultrathink-','.ultrathink','::ultrathink','ultrathink.ts','ultrathink()']) {
    assert.deepEqual(words(text), [], text);
  }
  assert.deepEqual(words(':ultrathink ultrathink.! ultrathink. workflowz'), ['ultrathink','ultrathink','ultrathink','workflowz']);
});

test('OMP masks code fences, exact-length inline backticks and balanced XML before matching', () => {
  const hidden = [
    '`ultrathink`','``ultrathink``','```\nultrathink\n```','~~~txt\nultrathink\n~~~',
    '  ```txt\nultrathink\n  ```','```\nultrathink',
    '<note>ultrathink</note>','<NOTE a="x>y">ultrathink<note>workflowz</note></NOTE>',
    '<!-- ultrathink -->','<!-- ultrathink','<img alt="ultrathink"/>',
  ];
  for (const text of hidden) assert.deepEqual(words(text), [], text);
  assert.deepEqual(words('`unclosed ultrathink'), ['ultrathink']);
  assert.deepEqual(words('<note>ultrathink'), ['ultrathink'], 'unclosed element masks its tag, not all following prose');
  assert.deepEqual(words('`ultrathink`` workflowz` ultrathink'), ['ultrathink']);
  const text = '😀\n<note>ultrathink\nworkflowz</note>\nultrathink';
  assert.equal(maskKeywordNonProse(text).length, text.length);
  const matches = magicKeywordMatches(text, keywords);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].start, text.lastIndexOf('ultrathink'));
});

test('effective keyword metadata is authoritative, including workflow id versus word', () => {
  const text = 'ultrathink workflow workflowz orchestrate jevify';
  assert.deepEqual(magicKeywordMatches(text, []).map(match => match.keyword.id), []);
  assert.deepEqual(magicKeywordMatches(text, [keywords[1]]).map(match => match.keyword.id), ['workflow']);
});
