import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';
import { parseNativeCommandArgs } from './support/native-review-command-args.mjs';

const code = await bundleDomFixture(`
import * as domain from ${JSON.stringify(resolve(root, 'web/src/domain/review-notes.ts'))};
import * as notes from ${JSON.stringify(resolve(root, 'web/src/runtime/review-notes.ts'))};
window.fixture = { ...domain, ...notes };
`);
const scope = { namespace: 'cred-synthetic-a', sessionPath: '/sessions/a.jsonl' };
const otherSession = { ...scope, sessionPath: '/sessions/b.jsonl' };
const otherCredential = { ...scope, namespace: 'cred-synthetic-b' };
const patch = "diff --git a/code.ts b/code.ts\n--- a/code.ts\n+++ b/code.ts\n@@ -4,2 +4,2 @@ function value()\n-old('value');\n+newValue('value');\n tail();\n";
const file = { path: 'code.ts', status: 'modified', additions: 1, deletions: 1, binary: false, patch, patchTruncated: false };
const note = (fields = {}) => ({ id: 'note-a', text: '  Keep  exact\nwords, apostrophes: \' and "quotes", \\backslashes\\.  ', scope: 'file', file: { ...file }, repoRoot: '/repo', branch: 'feature', ...fields });
const changes = (files = [file], fields = {}) => ({ cwd: '/repo', repoRoot: '/repo', branch: 'feature', notRepo: false, files, totals: { files: files.length, additions: 1, deletions: 1 }, truncated: false, ...fields });
const anchor = (fields = {}) => ({ newLine: 4, hunkHeader: '@@ -4,2 +4,2 @@ function value()', lineText: "newValue('value');", ...fields });
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(t, storage = []) {
  const dom = createDomFixture(code);
  dom.window.TextEncoder = TextEncoder;
  for (const [key, value] of storage) dom.window.localStorage.setItem(key, value);
  t.after(() => { assert.deepEqual(dom.blocked, []); dom.close(); });
  const entries = () => Array.from({ length: dom.window.localStorage.length }, (_, index) => {
    const key = dom.window.localStorage.key(index);
    return [key, dom.window.localStorage.getItem(key)];
  });
  return { ...dom, api: dom.window.fixture, entries };
}

test('review notes persist exact snapshots across independent lifetimes and isolate credentials and sessions', t => {
  const f = fixture(t), original = note();
  assert.deepEqual(plain(f.api.saveReviewNote(scope, original)), [original]);
  original.text = 'mutated input'; original.file.patch = 'mutated input';
  assert.deepEqual(plain(f.api.readReviewNotes(scope)), [note()]);
  const returned = f.api.readReviewNotes(scope);
  returned[0].file.patch = 'mutated read';
  assert.deepEqual(plain(f.api.readReviewNotes(scope)), [note()]);
  assert.deepEqual(plain(f.api.readReviewNotes(otherSession)), []);
  assert.deepEqual(plain(f.api.readReviewNotes(otherCredential)), []);
  f.api.saveReviewNote(otherSession, note({ text: 'Session B' }));
  f.api.saveReviewNote(otherCredential, note({ text: 'Credential B' }));
  const reload = fixture(t, f.entries());
  assert.deepEqual(plain(reload.api.readReviewNotes(scope)), [note()]);
  assert.equal(reload.api.readReviewNotes(otherSession)[0].text, 'Session B');
  assert.equal(reload.api.readReviewNotes(otherCredential)[0].text, 'Credential B');
  assert.equal(reload.api.saveReviewNote(scope, note({ text: 'Replacement' })).length, 1);
  assert.equal(reload.api.readReviewNotes(scope)[0].text, 'Replacement');
  reload.api.removeReviewNote(otherSession, 'note-a');
  assert.equal(reload.api.readReviewNotes(scope).length, 1);
  assert.equal(reload.api.readReviewNotes(otherCredential).length, 1);
});

test('changed or missing snapshots are stale rather than retargeted by a familiar path', t => {
  const f = fixture(t), line = note({ scope: 'line', line: anchor() });
  assert.equal(f.api.reviewNoteIsCurrent(line, changes()), true);
  const editing = { ...line, text: '' };
  assert.equal(f.api.reviewNoteIsCurrent(editing, changes()), true, 'currency describes the captured snapshot, not unsaved note text');
  assert.throws(() => f.api.buildAnnotatedReviewPrompt([editing], changes()), /malformed/);
  for (const fields of [
    { path: 'elsewhere.ts' }, { oldPath: 'before.ts' }, { status: 'renamed' },
    { patch: patch + '\n' }, { binary: true }, { patchTruncated: true }, { additions: 2 }, { deletions: 2 },
  ]) {
    const current = changes([{ ...file, ...fields }]);
    assert.equal(f.api.reviewNoteIsCurrent(line, current), false, JSON.stringify(fields));
    assert.throws(() => f.api.buildAnnotatedReviewPrompt([line], current), /changed or disappeared/);
  }
  for (const current of [changes([]), changes([file], { repoRoot: '/other' }), changes([file], { branch: null }), changes([file], { branch: 'other' }), changes([file], { notRepo: true })])
    assert.equal(f.api.reviewNoteIsCurrent(line, current), false);
  assert.equal(f.api.reviewNoteIsCurrent(note({ branch: null }), changes([file], { branch: null })), true);
});

test('line anchors must match exact code, hunk and old/new coordinates; metadata cannot be anchored', t => {
  const f = fixture(t);
  for (const line of [anchor(), anchor({ newLine: undefined, oldLine: 4, lineText: "old('value');" }), anchor({ oldLine: 5, newLine: 5, lineText: 'tail();' })])
    assert.equal(f.api.isReviewNote(note({ scope: 'line', line })), true);
  for (const line of [
    anchor({ newLine: 99 }), anchor({ oldLine: 4 }), anchor({ lineText: 'wrong' }),
    anchor({ lineText: "+newValue('value');" }), anchor({ hunkHeader: '@@ -1 +1 @@' }),
    anchor({ newLine: 0 }), anchor({ newLine: 1.5 }), anchor({ newLine: undefined }),
    anchor({ lineText: ' No newline at end of file' }),
  ]) {
    const invalid = note({ scope: 'line', line });
    assert.equal(f.api.isReviewNote(invalid), false, JSON.stringify(line));
    assert.throws(() => f.api.saveReviewNote(scope, invalid), /invalid/);
    assert.throws(() => f.api.buildAnnotatedReviewPrompt([invalid], changes()), /malformed/);
  }
  assert.equal(f.api.isReviewNote(note({ line: anchor() })), false);
  assert.equal(f.api.isReviewNote(note({ scope: 'line', line: anchor(), file: { ...file, binary: true } })), false);
});

test('malformed persisted data refuses reads and writes without discarding any durable bytes', t => {
  const f = fixture(t);
  f.api.saveReviewNote(scope, note());
  const key = f.entries()[0][0];
  const invalidNotes = [note({ id: '' }), note({ text: '  ' }), note({ text: 'x'.repeat(32_769) }), note({ file: { ...file, patchTruncated: 'false' } }), note({ branch: 7 }), note({ scope: 'line', line: anchor({ newLine: 9 }) })];
  const records = ['{broken', '{}', '[]', '{"version":2,"entries":[]}', ...invalidNotes.map(invalid => JSON.stringify({ version: 1, entries: [{ sessionPath: scope.sessionPath, note: invalid }] })), JSON.stringify({ version: 1, entries: [{ sessionPath: scope.sessionPath, note: note() }, { sessionPath: scope.sessionPath, note: note() }] })];
  for (const raw of records) {
    f.window.localStorage.setItem(key, raw);
    assert.throws(() => f.api.readReviewNotes(scope), /malformed|duplicate/);
    assert.throws(() => f.api.saveReviewNote(scope, note({ id: 'new' })), /malformed|duplicate/);
    assert.equal(f.window.localStorage.getItem(key), raw);
  }
  f.api.clearReviewNotes(scope.namespace);
  assert.equal(f.api.readReviewNotes(scope).length, 0);
});

test('quota, access and removal failures are explicit and preserve the last durable state', t => {
  const f = fixture(t);
  f.api.saveReviewNote(scope, note());
  const durable = f.entries();
  const proto = f.window.Storage.prototype;
  const set = proto.setItem, get = proto.getItem, remove = proto.removeItem;
  proto.setItem = () => { throw new Error('synthetic quota'); };
  assert.throws(() => f.api.saveReviewNote(scope, note({ text: 'not durable' })), /Could not save/);
  assert.throws(() => f.api.removeReviewNote(scope, 'note-a'), /Could not save/);
  proto.setItem = set;
  assert.deepEqual(f.entries(), durable);
  assert.deepEqual(plain(f.api.readReviewNotes(scope)), [note()]);
  proto.getItem = () => { throw new Error('synthetic access'); };
  assert.throws(() => f.api.readReviewNotes(scope), /Could not read/);
  assert.throws(() => f.api.saveReviewNote(scope, note()), /Could not read/);
  proto.getItem = get;
  proto.removeItem = () => { throw new Error('synthetic removal'); };
  assert.throws(() => f.api.clearReviewNotes(scope.namespace), /Could not clear/);
  proto.removeItem = remove;
  assert.deepEqual(f.entries(), durable);
});

test('record and UTF-8 byte bounds reject rather than evicting or truncating saved notes', t => {
  const f = fixture(t);
  for (let index = 0; index < 100; index++) f.api.saveReviewNote(scope, note({ id: `note-${index}` }));
  const durable = f.entries();
  assert.throws(() => f.api.saveReviewNote(otherSession, note({ id: 'one-too-many' })), /100 review notes/);
  assert.deepEqual(f.entries(), durable);
  assert.equal(f.api.saveReviewNote(scope, note({ id: 'note-0', text: 'Replacement at capacity' })).length, 100);
  f.api.clearReviewNotes(scope.namespace);
  f.api.saveReviewNote(scope, note());
  const before = f.entries();
  const large = note({ id: 'huge', file: { ...file, patch: '🦀'.repeat(530_000) } });
  assert.throws(() => f.api.saveReviewNote(scope, large), /2 MiB/);
  assert.deepEqual(f.entries(), before);
  assert.throws(() => f.api.saveReviewNote(scope, note({ text: 'x'.repeat(32_769) })), /32,768/);
  assert.deepEqual(f.entries(), before);
});

test('clearing review notes removes every session for only the chosen credential', t => {
  const f = fixture(t);
  f.api.saveReviewNote(scope, note()); f.api.saveReviewNote(otherSession, note()); f.api.saveReviewNote(otherCredential, note());
  f.api.clearReviewNotes(scope.namespace);
  assert.equal(f.api.readReviewNotes(scope).length, 0);
  assert.equal(f.api.readReviewNotes(otherSession).length, 0);
  assert.equal(f.api.readReviewNotes(otherCredential).length, 1);
});

test('review preparation includes every note, exact code and deduplicated captured patches, without consuming notes', t => {
  const f = fixture(t), one = note(), two = note({ id: 'line', text: 'Second  note\nwith a newline', scope: 'line', line: anchor() });
  f.api.saveReviewNote(scope, one); f.api.saveReviewNote(scope, two);
  const prompt = f.api.buildAnnotatedReviewPrompt(f.api.readReviewNotes(scope), changes());
  assert.ok(prompt.startsWith("/review '"));
  // Quoting itself is covered by the native parser fixture below.
  assert.equal(prompt.split('diff --git a/code.ts b/code.ts').length - 1, 1);
  assert.match(prompt, /Old line: not present; new line: 4/);
  assert.match(prompt, /No HEAD commit was captured/);
  assert.equal(f.api.readReviewNotes(scope).length, 2);
  assert.throws(() => f.api.buildAnnotatedReviewPrompt([], changes()), /Add a review note/);
  assert.throws(() => f.api.buildAnnotatedReviewPrompt([one, one], changes()), /malformed/);
});

test('review snapshots state missing, binary, truncated, renamed, deleted and untracked limitations honestly', t => {
  const f = fixture(t);
  const files = [
    { ...file, path: 'image.bin', binary: true, patch: '' },
    { ...file, path: 'capped.ts', patchTruncated: true, patch: '' },
    { ...file, path: 'after.ts', oldPath: 'before.ts', status: 'renamed' },
    { ...file, path: 'gone.ts', status: 'deleted' },
    { ...file, path: 'new.ts', status: 'untracked' },
  ];
  const prompt = f.api.buildAnnotatedReviewPrompt(files.map((file, index) => note({ id: String(index), file })), changes(files, { truncated: true }));
  for (const expected of ['response is incomplete', 'Binary file: text content is unavailable', 'No patch text was returned', 'Patch is truncated or omitted', 'Renamed from "before.ts"', 'Deleted file: old-side lines', 'Untracked file:']) assert.ok(prompt.includes(expected), expected);
});

test('prepared-draft size bounds reject oversized patches and quote expansion without silent truncation', t => {
  const f = fixture(t), huge = { ...file, patch: 'x'.repeat(65_536) };
  assert.throws(() => f.api.buildAnnotatedReviewPrompt([note({ file: huge })], changes([huge])), /65,536-character/);
  assert.throws(() => f.api.buildAnnotatedReviewPrompt([note({ text: "'".repeat(32_768) })], changes()), /65,536-character/);
});

test('native command parsing and review whitespace normalisation preserve exact notes and captured code', t => {
  const f = fixture(t);
  assert.deepEqual(parseNativeCommandArgs("'a'\"'\"'b'"), ["a'b"]);
  assert.deepEqual(parseNativeCommandArgs("'a\\\\b  c\\nd'"), ['a\\\\b  c\\nd']);
  const exact = `  apostrophe ' double " slash \\\\ backtick \` dollar $ tabs\t\t and  repeated   spaces\nnewlines\n\n🦀 end  `;
  const path = `dir/it's "quoted" \\\\ file.ts`;
  const captured = { ...file, path, oldPath: `old/'file.ts`, status: 'renamed' };
  const saved = [
    note({ text: exact, file: captured }),
    note({ id: 'line', text: `second '\n"\\\\  note`, file: captured, scope: 'line', line: anchor() }),
  ];
  const prompt = f.api.buildAnnotatedReviewPrompt(saved, changes([captured]));
  const args = parseNativeCommandArgs(prompt);
  assert.equal(args.length, 2);
  assert.equal(args[0], '/review');
  const instructions = args[1].replace(/[ \t]+$/gm, '');
  const decodedNotes = [...instructions.matchAll(/^User note \(JSON string\):\n(.+)$/gm)].map(match => JSON.parse(match[1]));
  assert.deepEqual(decodedNotes, saved.map(note => note.text));
  const decodedPatches = [...instructions.matchAll(/^Exact captured patch \(JSON string\):\n(.+)$/gm)].map(match => JSON.parse(match[1]));
  assert.deepEqual(decodedPatches, [captured.patch]);
  assert.ok(instructions.includes(JSON.stringify(path)));
  assert.ok(instructions.includes(JSON.stringify(captured.oldPath)));
  const code = instructions.match(/^Original code \(JSON string\):\n(.+)$/m);
  assert.equal(JSON.parse(code[1]), saved[1].line.lineText);
  assert.deepEqual(parseNativeCommandArgs(prompt.slice('/review '.length)), [args[1]]);
});
