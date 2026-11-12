import test from 'node:test';
import assert from 'node:assert/strict';
import { composerAction, findCatalogueCommand, leadsWithCommand, routeComposerText, slashCommandName } from '../src/domain/composer-route.ts';
import {
  addPromptHistory,
  parsePromptHistory,
  filterPromptHistory,
  mergePromptHistory,
  stepPromptHistory,
  resolveHistoryText,
  PROMPT_HISTORY_LIMIT,
  PROMPT_HISTORY_MAX_CHARS,
} from '../src/domain/prompt-history.ts';
import { mentionAtCaret, rankMentionEntries, applyMention, fuzzyScore } from '../src/domain/file-mention.ts';
import { availableSkills, insertSkill } from '../src/domain/skill-insertion.ts';
import { buildComposerCommands, classifyCommand } from '../src/app/commands/command-registry.ts';

// The live catalogue shape omp's get_available_commands returns.
const catalogue = [
  { name: 'session', source: 'builtin' },
  { name: 'todo', source: 'builtin' },
  { name: 'mcp', source: 'builtin' },
  { name: 'export', source: 'builtin', aliases: ['dump-html'] },
  { name: 'review-pr', source: 'skill' },
  { name: 'standup', source: 'prompt' },
  { name: 'deploy', source: 'extension' },
];

test('a builtin typed with arguments runs as a printing command', () => {
  assert.deepEqual(routeComposerText('/todo done x', catalogue), { kind: 'command', name: 'todo' });
  assert.deepEqual(routeComposerText('/session', catalogue), { kind: 'command', name: 'session' });
  assert.deepEqual(routeComposerText('  /MCP test foo', catalogue), { kind: 'command', name: 'mcp' });
  assert.deepEqual(routeComposerText('/dump-html out.html', catalogue), { kind: 'command', name: 'export' });
  assert.deepEqual(routeComposerText('/todo:done', catalogue), { kind: 'command', name: 'todo' });
});

test('skills, prompt templates, extensions and unknown names stay messages', () => {
  for (const text of ['/review-pr 12', '/standup', '/deploy prod', '/nosuch thing', 'hello', '/home/me/notes.md']) {
    assert.deepEqual(routeComposerText(text, catalogue), { kind: 'prompt' }, text);
  }
  // Without a catalogue nothing is known to be a builtin.
  assert.deepEqual(routeComposerText('/session', []), { kind: 'prompt' });
});

test('btw and goal open their sheets with the rest of the line', () => {
  assert.deepEqual(routeComposerText('/btw why is it slow', catalogue), { kind: 'side-question', question: 'why is it slow' });
  assert.deepEqual(routeComposerText('/goal ship it', catalogue), { kind: 'goal', objective: 'ship it' });
});

test('! runs a shell command into context and !! keeps it out', () => {
  assert.deepEqual(routeComposerText('!echo hi', catalogue), { kind: 'shell', command: 'echo hi', excludeFromContext: false });
  assert.deepEqual(routeComposerText(' ! ls -la ', catalogue), { kind: 'shell', command: 'ls -la', excludeFromContext: false });
  assert.deepEqual(routeComposerText('!!git status', catalogue), { kind: 'shell', command: 'git status', excludeFromContext: true });
  assert.deepEqual(routeComposerText('!', catalogue), { kind: 'prompt' });
  assert.deepEqual(routeComposerText('!!  ', catalogue), { kind: 'prompt' });
  assert.deepEqual(routeComposerText('wow!', catalogue), { kind: 'prompt' });
});

test('attached images always travel as a message', () => {
  assert.deepEqual(routeComposerText('!ls', catalogue, true), { kind: 'prompt' });
  assert.deepEqual(routeComposerText('/session', catalogue, true), { kind: 'prompt' });
});

test('a draft with an agent reference never reaches the shell or a command', () => {
  const referenced = '!git status\n\nAbout agent "$(rm -rf ~)" 0123:\n';
  assert.deepEqual(routeComposerText(referenced, catalogue, false, true), { kind: 'prompt' });
  assert.deepEqual(routeComposerText('!!ls', catalogue, false, true), { kind: 'prompt' });
  assert.deepEqual(routeComposerText('/session', catalogue, false, true), { kind: 'prompt' });
  assert.deepEqual(routeComposerText('/btw why', catalogue, false, true), { kind: 'prompt' });
  // Without a reference the same text is still a shell command.
  assert.equal(routeComposerText(referenced, catalogue).kind, 'shell');
});

test('the composer guard treats a leading ! like a leading /', () => {
  for (const text of ['!git status', '  !!ls', '/todo', ' /plan']) assert.equal(leadsWithCommand(text), true, text);
  for (const text of ['', 'hello', 'wow!', 'see /tmp']) assert.equal(leadsWithCommand(text), false, text);
});

test('slash names stop at whitespace and colon and reject paths', () => {
  assert.equal(slashCommandName('/Todo done'), 'todo');
  assert.equal(slashCommandName('/model:opus'), 'model');
  assert.equal(slashCommandName('/usr/bin/env'), null);
  assert.equal(slashCommandName('hi /todo'), null);
});

test('history keeps the newest first, moves repeats to the front, and stays bounded', () => {
  let list = [];
  list = addPromptHistory(list, 'first', 1);
  list = addPromptHistory(list, 'second', 2);
  list = addPromptHistory(list, '  first  ', 3);
  assert.deepEqual(list.map((e) => e.text), ['first', 'second']);
  assert.equal(list[0].at, 3);
  assert.deepEqual(addPromptHistory(list, '   ', 4), list);
  assert.deepEqual(addPromptHistory(list, 'x'.repeat(PROMPT_HISTORY_MAX_CHARS + 1), 5), list);
  for (let i = 0; i < PROMPT_HISTORY_LIMIT + 50; i++) list = addPromptHistory(list, `p${i}`, 10 + i);
  assert.equal(list.length, PROMPT_HISTORY_LIMIT);
  assert.equal(list[0].text, `p${PROMPT_HISTORY_LIMIT + 49}`);
});

test('stored history is validated and deduplicated on read', () => {
  assert.deepEqual(parsePromptHistory(null), []);
  assert.deepEqual(parsePromptHistory('not json'), []);
  assert.deepEqual(parsePromptHistory('{"text":"a"}'), []);
  const parsed = parsePromptHistory(JSON.stringify([{ text: 'a', at: 1 }, { text: 'a', at: 2 }, { text: 3 }, null, { text: 'b' }]));
  assert.deepEqual(parsed, [{ text: 'a', at: 1 }, { text: 'b', at: 0 }]);
  assert.equal(parsePromptHistory(JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ text: `t${i}`, at: i })))).length, PROMPT_HISTORY_LIMIT);
});

test('history search and merge with transcript hits', () => {
  const local = [{ text: 'Fix the login bug', at: 2 }, { text: 'run tests', at: 1 }];
  assert.deepEqual(filterPromptHistory(local, 'LOGIN').map((e) => e.text), ['Fix the login bug']);
  assert.equal(filterPromptHistory(local, ' ').length, 2);
  const long = 'L'.repeat(198);
  const merged = mergePromptHistory(local, [
    { path: '/s/a.jsonl', line: 'Fix the login bug', role: 'user', offset: 10 },
    { path: '/s/a.jsonl', line: 'Sure, fixing it', role: 'assistant', offset: 20 },
    { path: '/s/b.jsonl', line: 'Deploy to staging', role: 'user', offset: 30, title: 'Ops' },
    { path: '/s/c.jsonl', line: `${long}…`, role: 'user', offset: 40 },
  ]);
  assert.deepEqual(merged.map((m) => [m.text.slice(0, 20), m.origin]), [
    ['Fix the login bug', 'device'],
    ['run tests', 'device'],
    ['Deploy to staging', 'transcript'],
    ['L'.repeat(20), 'transcript'],
  ]);
  assert.deepEqual(merged[2].session, { path: '/s/b.jsonl', offset: 30, title: 'Ops' });
  assert.equal(merged[3].truncated, true);
  // A common abbreviated prefix does not prove two full prompts are equal.
  const ambiguous = mergePromptHistory([{ text: `${long} and more`, at: 1 }], [{ path: '/s/c.jsonl', line: `${long}…`, role: 'user', offset: 40 }]);
  assert.equal(ambiguous.length, 2);
});

test('up/down steps stop at both ends', () => {
  assert.equal(stepPromptHistory(-1, 3, 'older'), 0);
  assert.equal(stepPromptHistory(2, 3, 'older'), null);
  assert.equal(stepPromptHistory(0, 3, 'newer'), -1);
  assert.equal(stepPromptHistory(-1, 3, 'newer'), null);
  assert.equal(stepPromptHistory(-1, 0, 'older'), null);
});

test('mention token is found at the caret, after a boundary only', () => {
  assert.deepEqual(mentionAtCaret('look at @src/al', 15), { start: 8, end: 15, dir: 'src', leaf: 'al' });
  assert.deepEqual(mentionAtCaret('@', 1), { start: 0, end: 1, dir: '', leaf: '' });
  assert.deepEqual(mentionAtCaret('(@READ', 6), { start: 1, end: 6, dir: '', leaf: 'READ' });
  // The caret in the middle of a token still edits the whole token.
  assert.deepEqual(mentionAtCaret('@src/alpha.txt please', 7), { start: 0, end: 14, dir: 'src', leaf: 'al' });
  assert.equal(mentionAtCaret('mail me@example.com', 19), null);
  assert.equal(mentionAtCaret('@done now', 9), null);
  assert.equal(mentionAtCaret('@"quoted path"', 14), null);
  assert.equal(mentionAtCaret('no mention', 10), null);
});

test('mention entries rank prefix, word start, then scattered matches', () => {
  assert.equal(fuzzyScore('README.md', ''), 0);
  assert.equal(fuzzyScore('composer', 'xyz'), null);
  const entries = [
    { name: 'thread.ts', path: 'thread.ts', type: 'file' },
    { name: 'README.md', path: 'README.md', type: 'file' },
    { name: 'my_reader.ts', path: 'my_reader.ts', type: 'file' },
    { name: 'r-e-a.txt', path: 'r-e-a.txt', type: 'file' },
    { name: '.env', path: '.env', type: 'file' },
    { name: 'res', path: 'res', type: 'dir' },
  ];
  assert.deepEqual(rankMentionEntries(entries, 'rea').map((e) => e.name), ['README.md', 'my_reader.ts', 'thread.ts', 'r-e-a.txt']);
  assert.deepEqual(rankMentionEntries(entries, 're').map((e) => e.name).slice(0, 2), ['res', 'README.md']);
  assert.ok(!rankMentionEntries(entries, '').some((e) => e.name === '.env'));
  assert.deepEqual(rankMentionEntries(entries, '.e').map((e) => e.name), ['.env']);
});

test('applying a mention writes the token omp parses', () => {
  const token = mentionAtCaret('see @src/al', 11);
  assert.deepEqual(applyMention('see @src/al', token, { path: 'src/alpha.txt', type: 'file' }), { text: 'see @src/alpha.txt ', caret: 19 });
  assert.deepEqual(applyMention('see @sr', mentionAtCaret('see @sr', 7), { path: 'src', type: 'dir' }), { text: 'see @src/', caret: 9 });
  assert.deepEqual(applyMention('@a then', mentionAtCaret('@a then', 2), { path: 'a b/c.md', type: 'file' }), { text: '@"a b/c.md" then', caret: 12 });
});

test('templates cannot shadow native command names or aliases, independent of discovery order', () => {
  const raw = [
    { name: 'dump-html', source: 'prompt', input: { hint: 'arguments' } },
    { name: 'export', aliases: ['dump-html'], source: 'builtin' },
    { name: 'tree', source: 'prompt', input: { hint: 'arguments' } },
    { name: 'standup', description: 'Team summary (project)', source: 'prompt', input: { hint: 'arguments' } },
  ];
  assert.equal(findCatalogueCommand(raw, 'dump-html').name, 'export');
  const commands = buildComposerCommands(raw, false);
  assert.equal(commands.filter(command => command.source === 'prompt').length, 1);
  assert.equal(findCatalogueCommand(commands, 'tree').picker, 'timeline');
  assert.equal(findCatalogueCommand(commands, 'standup').shape, 'compose');
  assert.equal(classifyCommand({ name: 'model', source: 'prompt', input: { hint: 'arguments' } }).picker, undefined, 'a template is never classified as a builtin by its name');
  assert.deepEqual(routeComposerText('/standup \"today and tomorrow\" team', commands), { kind: 'prompt' });
  assert.deepEqual(routeComposerText('/not-in-this-cached-list with arguments', commands), { kind: 'prompt' });
});

test('composer intent uses the same shell/prompt route and names output context before submission', () => {
  assert.equal(composerAction('!echo hi', catalogue).label, 'Run');
  assert.match(composerAction('!echo hi', catalogue).description, /Output enters model context/);
  assert.match(composerAction('!!echo hi', catalogue).description, /Output stays out of model context/);
  assert.match(composerAction('!echo hi', catalogue).description, /configured user shell.*no terminal PTY/);
  for (const [images, reference] of [[true, false], [false, true], [true, true]]) {
    const intent = composerAction('!!echo hi', catalogue, images, reference);
    assert.equal(intent.label, 'Send');
    assert.match(intent.description, /Nothing runs directly/);
    assert.deepEqual(routeComposerText('!!echo hi', catalogue, images, reference), { kind: 'prompt' });
  }
  assert.equal(composerAction('!!', catalogue).label, 'Send');
  assert.equal(composerAction('ordinary prose', catalogue).description, null);
});

test('skill insertion preserves all surrounding UTF-16 draft text and targets the remembered caret', () => {
  const text = 'Review 👩🏽‍💻 here\nkeep the end';
  const caret = text.indexOf('here');
  const inserted = insertSkill(text, caret, 'skill:plugin/review');
  assert.equal(inserted.text, 'Review 👩🏽‍💻 /skill:plugin/review here\nkeep the end');
  assert.equal(inserted.text.slice(inserted.caret), 'here\nkeep the end');
  assert.equal(insertSkill('wordtail', 4, '/skill:review').text, 'word /skill:review tail');
  assert.equal(insertSkill('', 0, 'skill:review').text, '/skill:review ');
  assert.deepEqual(availableSkills([{ name: 'skill:review', source: 'skill' }, { name: 'review', source: 'prompt' }]).map(command => command.name), ['skill:review']);
});

test('history always fetches original transcript text, including whitespace in short search previews', async () => {
  const item = mergePromptHistory([], [{ path: '/s/a', line: 'first second', role: 'user', offset: 42, entryId: 'entry-a' }])[0];
  const calls = [];
  const full = '  first\n\nsecond  ';
  assert.equal(await resolveHistoryText(item, async (...args) => { calls.push(args); return full; }), full);
  assert.deepEqual(calls, [['/s/a', 42, 'entry-a']]);
  assert.equal(await resolveHistoryText({ text: 'device original', origin: 'device' }, () => { throw Error('must not fetch local prompt'); }), 'device original');
});

test('history recovers Unicode previews in full but never inserts unavailable or changed-anchor snippets', async () => {
  const prefix = '🧭'.repeat(197);
  const item = mergePromptHistory([], [{ path: '/s/a', line: `${prefix}…`, role: 'user', offset: 0 }])[0];
  assert.equal(item.truncated, true);
  assert.equal(await resolveHistoryText(item, async () => `${prefix} original ending`), `${prefix} original ending`);
  for (const read of [async () => null, async () => 'a different prompt', async () => { throw Error('offline'); }]) {
    await assert.rejects(resolveHistoryText(item, read));
  }
  await assert.rejects(resolveHistoryText({ ...item, session: undefined }, async () => 'unanchored'));
});
