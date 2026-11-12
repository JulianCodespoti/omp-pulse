import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY_EXTENSION_DIALOGS,
  askDraftComplete,
  askResponse,
  clearExtensionDialogs,
  closeExtensionDialog,
  expireExtensionDialogs,
  markExtensionDialogDelivery,
  reduceExtensionDialogSnapshot,
  reduceExtensionUiRequest,
  setAskCustom,
  toggleAskOption,
} from '../src/runtime/extension-dialogs.ts';

// The dialog list a phone-driven session's own omp child is blocked on. The
// daemon replays every open request on attach, so the reducer must be
// idempotent and must never resurrect a dialog the phone already answered.
const confirm = {type: 'extension_ui_request', id: 'c1', method: 'confirm', title: 'Run it?', message: 'rm -rf build'};
const select = {type: 'extension_ui_request', id: 's1', method: 'select', title: 'Allow?', options: ['Approve', 'Deny'], optionDetails: [{description: 'Run once'}, {}], timeout: 30000};
const ask = {type: 'extension_ui_request', id: 'a1', method: 'ask', questions: [
  {id: 'db', question: 'Which database?', options: [{label: 'Postgres'}, {label: 'SQLite', description: 'Single file'}], recommended: 1},
  {id: 'extras', question: 'Extras?', multi: true, options: [{label: 'Auth'}, {label: 'Cache'}]},
]};
const ids = state => state.pending.map(dialog => dialog.id).join(',');

test('blocking requests are added once; fire-and-forget ones are ignored', () => {
  let state = EMPTY_EXTENSION_DIALOGS;
  for (const frame of [confirm, select, ask, {type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'hi'}, {type: 'extension_ui_request', id: 'u1', method: 'open_url', url: 'https://x'}]) {
    state = reduceExtensionUiRequest(state, frame, 1000);
  }
  assert.equal(ids(state), 'c1,s1,a1');
  const s1 = state.pending[1];
  assert.equal(s1.options[0].description, 'Run once');
  assert.equal(s1.options[1].description, undefined);
  assert.equal(s1.expiresAt, 31000);
  // The attach replay repeats every open request: same list, same order.
  const replayed = [confirm, select, ask].reduce((s, frame) => reduceExtensionUiRequest(s, frame, 2000), state);
  assert.equal(ids(replayed), 'c1,s1,a1');
});

test('cancel closes the target, and a late replay cannot bring it back', () => {
  let state = [confirm, select].reduce((s, frame) => reduceExtensionUiRequest(s, frame, 0), EMPTY_EXTENSION_DIALOGS);
  state = reduceExtensionUiRequest(state, {type: 'extension_ui_request', id: 'x9', method: 'cancel', targetId: 's1'}, 0);
  assert.equal(ids(state), 'c1');
  state = reduceExtensionUiRequest(state, select, 0);
  assert.equal(ids(state), 'c1');
});

test('an answered dialog stays gone across a reconnect replay', () => {
  let state = reduceExtensionUiRequest(EMPTY_EXTENSION_DIALOGS, confirm, 0);
  state = closeExtensionDialog(state, 'c1');
  // Socket drops: open dialogs are forgotten until the daemon replays them.
  state = clearExtensionDialogs(state);
  state = reduceExtensionUiRequest(state, confirm, 0);
  state = reduceExtensionUiRequest(state, ask, 0);
  assert.equal(ids(state), 'a1');
});

test('timed dialogs expire, and a replay with no time left is not shown', () => {
  let state = reduceExtensionUiRequest(EMPTY_EXTENSION_DIALOGS, select, 1000);
  assert.equal(ids(expireExtensionDialogs(state, 30999)), 's1');
  state = expireExtensionDialogs(state, 31000);
  assert.equal(ids(state), '');
  assert.equal(ids(reduceExtensionUiRequest(EMPTY_EXTENSION_DIALOGS, {...select, id: 's2', timeout: 0}, 0)), '');
});

test('ask drafts produce the answers omp validates', () => {
  const state = reduceExtensionUiRequest(EMPTY_EXTENSION_DIALOGS, ask, 0);
  const dialog = state.pending[0];
  const [db, extras] = dialog.questions;
  assert.equal(db.recommended, 1);
  let draft = {selected: {}, custom: {}};
  draft = toggleAskOption(draft, db, 'Postgres');
  draft = toggleAskOption(draft, db, 'SQLite');
  draft = toggleAskOption(draft, extras, 'Auth');
  draft = toggleAskOption(draft, extras, 'Cache');
  draft = setAskCustom(draft, extras, ' rate limits ');
  assert.equal(JSON.stringify(askResponse(dialog, draft)), JSON.stringify({answers: [
    {id: 'db', selectedOptions: ['SQLite']},
    {id: 'extras', selectedOptions: ['Auth', 'Cache'], customInput: 'rate limits'},
  ]}));
  // Typing on a single-select question replaces the picked option.
  draft = setAskCustom(draft, db, 'MySQL');
  assert.equal(JSON.stringify(askResponse(dialog, draft).answers[0]), JSON.stringify({id: 'db', selectedOptions: [], customInput: 'MySQL'}));
});

test('empty multi-select is deliberate submission, without making single-choice optional', () => {
  const dialog = reduceExtensionUiRequest(EMPTY_EXTENSION_DIALOGS, ask, 0).pending[0];
  let draft = { selected: {}, custom: {} };
  assert.equal(askDraftComplete(dialog, draft), false);
  draft = toggleAskOption(draft, dialog.questions[0], 'SQLite');
  assert.equal(askDraftComplete(dialog, draft), true);
  assert.equal(JSON.stringify(askResponse(dialog, draft).answers[1]), JSON.stringify({id:'extras',selectedOptions:[]}));
  draft = toggleAskOption(draft, dialog.questions[1], 'Auth');
  draft = toggleAskOption(draft, dialog.questions[1], 'Auth');
  assert.equal(askDraftComplete(dialog, draft), true);
  assert.equal(askResponse(dialog, draft).answers[1].selectedOptions.length, 0);
});

test('previews survive both structured ask and select option details unchanged', () => {
  const preview = '  before\\n    after\\n';
  const request = {...ask, questions:[{...ask.questions[0],options:[{label:'SQLite',preview}]}]};
  const dialog = reduceExtensionUiRequest(EMPTY_EXTENSION_DIALOGS, request, 0).pending[0];
  assert.equal(dialog.questions[0].options[0].preview, preview);
  const selection = reduceExtensionUiRequest(EMPTY_EXTENSION_DIALOGS, {...select,optionDetails:[{preview},{}]}, 0).pending[0];
  assert.equal(selection.options[0].preview, preview);
  assert.equal(selection.options[1].preview, undefined);
});
test('pipe handoff survives request replay without becoming callback closure',()=>{
 let state=reduceExtensionUiRequest(EMPTY_EXTENSION_DIALOGS,ask,0);
 state=markExtensionDialogDelivery(state,'a1','handoff');assert.equal(state.pending.length,1);assert.equal(state.closed.length,0);assert.equal(state.pending[0].delivery,'handoff');
 state=clearExtensionDialogs(state);state=reduceExtensionUiRequest(state,{...ask,pulseDelivery:'handoff'},0);assert.equal(state.pending[0].delivery,'handoff');
 state=reduceExtensionUiRequest(state,{method:'cancel',targetId:'a1'},0);assert.equal(state.pending.length,0);
});

test('an exact snapshot restores missing questions and authoritatively closes absent ones', () => {
  let state = reduceExtensionUiRequest(EMPTY_EXTENSION_DIALOGS, confirm, 0);
  state = reduceExtensionDialogSnapshot(state, { type: 'extension_dialog_snapshot', requests: [ask, select] }, 1000);
  assert.equal(ids(state), 'a1,s1');
  assert.equal(state.closed.includes('c1'), true);
  assert.equal(state.pending[1].expiresAt, 31000);
  state = reduceExtensionDialogSnapshot(state, { type: 'extension_dialog_snapshot', requests: [] }, 2000);
  assert.equal(ids(state), '');
  assert.equal(state.closed.includes('a1'), true);
  assert.equal(state.closed.includes('s1'), true);
});

test('snapshot merges unrelated recovery without rolling back newer questions, closures or answer handoff', () => {
  const before = [confirm, select].reduce((state, frame) => reduceExtensionUiRequest(state, frame, 0), EMPTY_EXTENSION_DIALOGS);
  let state = closeExtensionDialog(before, 's1');
  state = markExtensionDialogDelivery(state, 'c1', 'handoff');
  state = reduceExtensionUiRequest(state, { ...confirm, id: 'new-live', title: 'A newer question' }, 0);
  state = reduceExtensionDialogSnapshot(state, { type: 'extension_dialog_snapshot', requests: [select, ask] }, 1000, before);
  assert.equal(ids(state), 'a1,c1,new-live');
  assert.equal(state.pending.find(dialog => dialog.id === 'c1').delivery, 'handoff');
  assert.equal(state.closed.includes('s1'), true);
  assert.equal(state.closed.includes('c1'), false);
});
