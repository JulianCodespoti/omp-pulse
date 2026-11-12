import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTodo, applyTodoAction, todoActionLabel, todoActions, todoCommand, todoTargetError } from '../src/app/tools/todo-edit.ts';

const board = () => [
  { name: 'Build', tasks: [
    { content: 'Write parser', status: 'completed' },
    { content: 'Wire the sheet', status: 'in_progress' },
    { content: 'Add tests', status: 'pending' },
  ] },
  { name: 'Ship', tasks: [{ content: 'Release notes', status: 'pending' }] },
];
const statuses = (phases) => phases.flatMap((p) => p.tasks.map((t) => `${t.content}:${t.status}`));

test('each state offers only the moves omp can make from it', () => {
  assert.deepEqual(todoActions('pending'), ['start', 'done', 'drop', 'rm']);
  assert.deepEqual(todoActions('blocked'), ['start', 'done', 'drop', 'rm']);
  assert.deepEqual(todoActions('in_progress'), ['done', 'drop', 'rm']);
  assert.deepEqual(todoActions('completed'), ['start', 'rm']);
  assert.deepEqual(todoActions('abandoned'), ['start', 'rm']);
  assert.equal(todoActionLabel('start', 'completed'), 'Reopen');
  assert.equal(todoActionLabel('start', 'pending'), 'Start');
  assert.equal(todoActionLabel('rm', 'pending'), 'Remove');
});

test('start moves the single in-progress slot to the chosen task', () => {
  const next = applyTodoAction(board(), 'start', { phase: 1, task: 0 });
  assert.deepEqual(statuses(next), ['Write parser:completed', 'Wire the sheet:pending', 'Add tests:pending', 'Release notes:in_progress']);
});

test('finishing or dropping the current task starts the next pending one, as omp does', () => {
  const done = applyTodoAction(board(), 'done', { phase: 0, task: 1 });
  assert.deepEqual(statuses(done), ['Write parser:completed', 'Wire the sheet:completed', 'Add tests:in_progress', 'Release notes:pending']);
  const dropped = applyTodoAction(board(), 'drop', { phase: 0, task: 1 });
  assert.deepEqual(statuses(dropped), ['Write parser:completed', 'Wire the sheet:abandoned', 'Add tests:in_progress', 'Release notes:pending']);
  const reopened = applyTodoAction(done, 'start', { phase: 0, task: 0 });
  assert.deepEqual(statuses(reopened), ['Write parser:in_progress', 'Wire the sheet:completed', 'Add tests:pending', 'Release notes:pending']);
});

test('remove deletes the row and never touches the input board', () => {
  const before = board();
  const next = applyTodoAction(before, 'rm', { phase: 0, task: 1 });
  assert.deepEqual(statuses(next), ['Write parser:completed', 'Add tests:in_progress', 'Release notes:pending']);
  assert.deepEqual(before, board());
  assert.deepEqual(applyTodoAction(before, 'done', { phase: 5, task: 0 }), board());
});

test('append adds a pending task to the last phase, or a Todos phase on an empty board', () => {
  const next = appendTodo(board(), '  check   the  docs ');
  assert.deepEqual(next[1].tasks.at(-1), { content: 'Check the docs', status: 'pending' });
  assert.deepEqual(appendTodo([], 'first'), [{ name: 'Todos', tasks: [{ content: 'First', status: 'pending' }] }]);
  assert.deepEqual(appendTodo(board(), '   '), board());
});

test('commands quote where omp tokenizes and stay raw where it matches the remainder', () => {
  assert.equal(todoCommand('append', 'Fix "the" \\ path'), '/todo append "Fix \\"the\\" \\\\ path"');
  assert.equal(todoCommand('start', 'Wire  the sheet'), '/todo start "Wire  the sheet"');
  assert.equal(todoCommand('done', ' Wire  "the" sheet '), '/todo done Wire  "the" sheet');
  assert.equal(todoCommand('rm', 'Add tests'), '/todo rm Add tests');
});

test('blocked work remains open and acting on it clears its blocker', () => {
  const phases=[{name:'Release',tasks:[{content:'Ship',status:'blocked',blocker:'Waiting for access'},{content:'Review',status:'pending'}]}];
  for (const action of ['start','done','drop']) {
    const next=applyTodoAction(phases,action,{phase:0,task:0});
    assert.equal(next[0].tasks[0].blocker,undefined);
    assert.equal(phases[0].tasks[0].blocker,'Waiting for access');
  }
});

test('task selection refuses duplicate case-insensitive names across phases without changing either row', () => {
  const phases = board();
  phases[1].tasks.push({content:'ADD TESTS',status:'pending'});
  const before = structuredClone(phases);
  assert.equal(typeof todoTargetError(phases,{phase:1,task:1},'ADD TESTS'),'string');
  assert.equal(typeof todoTargetError(phases,{phase:0,task:2},'Add tests'),'string');
  assert.deepEqual(phases,before);
  assert.equal(todoTargetError(phases,{phase:1,task:0},'Release notes'),null);
  assert.equal(typeof todoTargetError(phases,{phase:1,task:0},'Add tests'),'string');
});

test('blank and whitespace-padded task names cannot become whole-board or fuzzy actions', () => {
  for (const content of ['', '  ', ' Add tests ']) {
    const phases=[{name:'Build',tasks:[{content,status:'pending'}]}];
    assert.equal(typeof todoTargetError(phases,{phase:0,task:0},content),'string');
  }
});
