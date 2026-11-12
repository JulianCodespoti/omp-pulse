import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

// Mid-turn send modes (Steer / Queue / Stop and send) and Retry for a failed
// turn. Real components, store, outbox and
// controller send path in a synthetic DOM; the daemon request is a stub that
// records the body and stops, so nothing leaves the process.
const require = createRequire(resolve(root, 'web/package.json'));
const src = (path) => JSON.stringify(resolve(root, path));
const code = await bundleDomFixture(`
  import { createElement as h, act } from ${JSON.stringify(require.resolve('react'))};
  import { createRoot } from ${JSON.stringify(require.resolve('react-dom/client'))};
  import { Composer } from ${src('web/src/app/composer/Composer.tsx')};
  import { seedDraft } from ${src('web/src/app/composer/use-draft.ts')};
  import { MessageParts } from ${src('web/src/app/parts/MessageParts.tsx')};
  import * as sendMode from ${src('web/src/domain/send-mode.ts')};
  import { failedTurnToRetry } from ${src('web/src/domain/failed-turn.ts')};
  import { OmpSessionController } from ${src('web/src/runtime/omp-session-controller.ts')};
  import { createOmpStore, selectSessionCapability } from ${src('web/src/runtime/omp-store.ts')};
  import * as queue from ${src('web/src/runtime/offline-queue.ts')};
  window.voiceStatus = 'idle';
  const namespace = queue.offlineQueueNamespaceForCredential('synthetic-send-modes');
  queue.setOfflineQueueNamespace(namespace);
  let seq = 0;
  const mounted = [];
  const mount = (element) => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    const r = createRoot(node);
    r.render(element);
    mounted.push(r);
    return node;
  };
  window.fixture = { act, sendMode, failedTurnToRetry, createOmpStore, selectSessionCapability, queue, namespace,
    composer(props = {}) {
      const path = '/synthetic/modes-' + (++seq);
      if (props.text) seedDraft(path, props.text);
      return mount(h(Composer, { sessionPath: path, busy: false, onSend() {}, onStop() {}, ...props }));
    },
    parts(message, props = {}) {
      return mount(h(MessageParts, { message, sessionPath: '/synthetic/retry', ...props }));
    },
    controller() {
      const path = '/synthetic/send-mode-' + (++seq), store = createOmpStore(), bodies = [];
      store.getState().beginSession(path);
      const controller = Object.assign(Object.create(OmpSessionController.prototype), {
        queueNamespace: namespace, activeSession: path, generation: 1, store, recordSuccess() {},
        ensureReceiptProtocol: async () => {},
        request: async (route, init) => {
          if (route !== '/api/prompt') throw new Error('unexpected route ' + route);
          bodies.push(JSON.parse(init.body));
          throw new Error('synthetic transport stop');
        },
      });
      return { controller, store, path, bodies };
    },
    unmountAll() { for (const r of mounted.splice(0)) r.unmount(); },
  };
`, [{
  name: 'synthetic-voice-status',
  resolveId: id => id === './use-dictation' ? '\0voice-status' : null,
  load: id => id === '\0voice-status' ? `export const useDictation = () => ({
    status: window.voiceStatus, available: true, level: 0, elapsedMs: 0, remainingMs: 120000,
    start() {}, stop() {}, cancel() {}, error: null, canRetry: false, retry() {}, discardRetry() {},
  });` : null,
}]);

async function fixture(t) {
  const dom = createDomFixture(code), w = dom.window, f = w.fixture;
  w.Element.prototype.getAnimations = () => [];
  t.after(async () => {
    try { await f.act(async () => f.unmountAll()); assert.deepEqual(dom.blocked, []); } finally { dom.close(); }
  });
  const render = async (fn) => { let node; await f.act(async () => { node = fn(); }); return node; };
  return { w, f, render };
}

const modeRow = (node) => node.querySelector('[data-testid="send-mode"]');
const checked = (node, mode) => node.querySelector(`[data-testid="send-mode"] [data-value="${mode}"]`)?.getAttribute('aria-checked');
const sendButton = (node) => node.querySelector('[data-testid="composer-send-btn"]');
const stopButton = (node) => node.querySelector('[data-testid="composer-stop-btn"]');

test('Steer | Queue appears only for a running turn with something to send', async t => {
  const { f, render } = await fixture(t);
  const idle = await render(() => f.composer({ text: 'typed while idle' }));
  assert.equal(modeRow(idle), null, 'idle composer is unchanged');
  const empty = await render(() => f.composer({ busy: true }));
  assert.equal(modeRow(empty), null, 'running with nothing typed shows no choice');
  const running = await render(() => f.composer({ busy: true, text: 'redirect please' }));
  assert.ok(modeRow(running));
  assert.equal(checked(running, 'steer'), 'true', 'Steer is the default, matching the TUI');
  assert.equal(checked(running, 'queue'), 'false');
  const remembered = await render(() => f.composer({ busy: true, text: 'later', sendMode: 'queue' }));
  assert.equal(checked(remembered, 'queue'), 'true');
  const collab = await render(() => f.composer({ busy: true, text: 'steer only', canQueue: false }));
  assert.equal(modeRow(collab), null, 'an owner that always steers hides the choice');
});

test('Steer | Queue arrives with focus, not on the first keystroke', async t => {
  const { f, render } = await fixture(t);
  const node = await render(() => f.composer({ busy: true }));
  assert.equal(modeRow(node), null);
  await f.act(async () => node.querySelector('textarea').focus());
  assert.ok(modeRow(node), 'focusing the field while a turn runs shows the choice');
  assert.deepEqual([...modeRow(node).querySelectorAll('[data-value]')].map(b => b.textContent), ['Send now', 'After this reply']);
});

test('tapping a segment reports the choice without sending', async t => {
  const { f, render } = await fixture(t);
  const changes = [], sends = [];
  const node = await render(() => f.composer({ busy: true, text: 'hold this', onSendModeChange: m => changes.push(m), onSend: () => sends.push(1) }));
  await f.act(async () => node.querySelector('[data-testid="send-mode"] [data-value="queue"]').click());
  assert.deepEqual(changes, ['queue']);
  assert.equal(sends.length, 0);
});

test('the one action slot morphs between Send and an accent (never danger) Stop', async t => {
  const { f, render } = await fixture(t);
  const idleEmpty = await render(() => f.composer());
  assert.equal(sendButton(idleEmpty).disabled, true, 'an empty idle box shows a disabled Send, never a gap');
  assert.equal(sendButton(idleEmpty).dataset.variant, 'secondary', 'disabled Send is grey, not dim violet');
  assert.equal(stopButton(idleEmpty), null);
  const runningEmpty = await render(() => f.composer({ busy: true }));
  assert.equal(sendButton(runningEmpty), null, 'running with nothing typed: Stop owns the slot');
  // ChatGPT-style: the same round accent circle, a square glyph instead of the arrow.
  assert.equal(stopButton(runningEmpty).dataset.variant, 'primary', 'stop takes the accent circle');
  assert.notEqual(stopButton(runningEmpty).dataset.variant, 'destructive', 'stopping is not destructive');
  const runningText = await render(() => f.composer({ busy: true, text: 'redirect please' }));
  assert.equal(stopButton(runningText).dataset.variant, 'secondary', 'with a draft Stop is compact and beside Send');
  assert.equal(sendButton(runningText).dataset.variant, 'primary');
  const noSend = await render(() => f.composer({ busy: true, text: 'typed', sendAllowed: false }));
  assert.ok(stopButton(noSend), 'a draft that cannot be sent never hides Stop');
});

test('Stop reports its pending state without hiding a sendable draft', async t => {
  const { f, render } = await fixture(t);
  const node = await render(() => f.composer({ busy: true, text: 'Keep this draft', stopping: true }));
  assert.ok(sendButton(node));
  assert.equal(stopButton(node).disabled, true);
  assert.equal(stopButton(node).getAttribute('aria-busy'), 'true');
  assert.equal(stopButton(node).getAttribute('aria-label'), 'Stopping');
});

test('Send and Stop prevent pointer focus transfer', async t => {
  const { f, render } = await fixture(t);
  const node = await render(() => f.composer({ busy: true, text: 'Keep typing' }));
  for (const button of [sendButton(node), stopButton(node)]) {
    await f.act(async () => {
      const event = new button.ownerDocument.defaultView.Event('pointerdown', {bubbles: true, cancelable: true});
      button.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
      button.dispatchEvent(new button.ownerDocument.defaultView.Event('pointercancel', {bubbles: true}));
    });
  }
});

test('a send carries the chosen mode while a turn runs and nothing when idle', async t => {
  const { f, render } = await fixture(t);
  const deliveries = [];
  const onSend = (_text, _images, _path, _saved, delivery) => { deliveries.push(delivery ?? 'none'); };
  const steer = await render(() => f.composer({ busy: true, text: 'steer this', onSend }));
  await f.act(async () => sendButton(steer).click());
  const queue = await render(() => f.composer({ busy: true, text: 'queue this', sendMode: 'queue', onSend }));
  await f.act(async () => sendButton(queue).click());
  const idle = await render(() => f.composer({ text: 'idle send', sendMode: 'queue', onSend }));
  await f.act(async () => sendButton(idle).click());
  assert.deepEqual(deliveries, ['steer', 'queue', 'none']);
});

test('Stop and send is offered on long-press only where the owner can interrupt', async t => {
  const { f, render } = await fixture(t);
  const child = await render(() => f.composer({ busy: true, text: 'redo', canInterrupt: true }));
  assert.equal(sendButton(child).getAttribute('aria-haspopup'), 'menu');
  const unknown = await render(() => f.composer({ busy: true, text: 'redo' }));
  assert.equal(sendButton(unknown).getAttribute('aria-haspopup'), 'menu', 'unreported keeps the option');
  const bridge = await render(() => f.composer({ busy: true, text: 'redo', canInterrupt: false }));
  assert.equal(sendButton(bridge).hasAttribute('aria-haspopup'), false);
  const idle = await render(() => f.composer({ text: 'redo', canInterrupt: true }));
  assert.equal(sendButton(idle).hasAttribute('aria-haspopup'), false, 'idle Send keeps its plain tap');
  const noStop = await render(() => f.composer({ busy: true, text: 'redo', canInterrupt: true, stopAllowed: false }));
  assert.equal(sendButton(noStop).hasAttribute('aria-haspopup'), false);
});

test('the long-press sheet sends once with interrupt', async t => {
  const { w, f, render } = await fixture(t);
  const deliveries = [];
  const node = await render(() => f.composer({ busy: true, text: 'after this', sendMode: 'queue', onSend: (_t, _i, _p, _s, delivery) => { deliveries.push(delivery); } }));
  await f.act(async () => {
    sendButton(node).dispatchEvent(new (w.PointerEvent ?? w.MouseEvent)('pointerdown', { bubbles: true, button: 0, clientX: 1, clientY: 1 }));
    await new Promise((resolve) => w.setTimeout(resolve, 560));
  });
  const option = w.document.querySelector('[data-testid="stop-and-send"]');
  assert.ok(option, 'the sheet opens on hold');
  await f.act(async () => option.click());
  assert.deepEqual(deliveries, ['interrupt']);
});

test('a send carries the mode only while a turn runs', async t => {
  const { f } = await fixture(t);
  const { deliveryForSend } = f.sendMode;
  assert.equal(deliveryForSend(false, 'queue', true), undefined);
  assert.equal(deliveryForSend(true, 'steer', null), 'steer');
  assert.equal(deliveryForSend(true, 'queue', null), 'queue');
  assert.equal(deliveryForSend(true, 'queue', false), 'steer', 'a hidden Queue never leaks into the wire');
});

test('the Steer/Queue choice survives a reload and session switches', async t => {
  const { w, f } = await fixture(t);
  w.localStorage.clear();
  const first = f.createOmpStore();
  assert.equal(first.getState().sendMode, 'steer');
  first.getState().setSendMode('queue');
  assert.equal(w.localStorage.getItem('omp-send-mode'), 'queue');
  const reloaded = f.createOmpStore();
  assert.equal(reloaded.getState().sendMode, 'queue');
  reloaded.getState().beginSession('/synthetic/other');
  reloaded.getState().clearSession();
  assert.equal(reloaded.getState().sendMode, 'queue', 'not session-scoped');
  w.localStorage.setItem('omp-send-mode', 'interrupt');
  assert.equal(f.createOmpStore().getState().sendMode, 'steer', 'interrupt is never sticky');
});

test('owner capabilities gate queue and interrupt; unreported stays open', async t => {
  const { f } = await fixture(t);
  const store = f.createOmpStore();
  const authority = (capabilities) => ({ sessionState: { daemonInstanceId: 'd', revision: 1, bindingEpoch: 1, observedAt: 1,
    owner: { kind: 'bridge' }, turn: 'running', confidence: 'confirmed', connection: 'connected', activity: null, capabilities } });
  assert.equal(f.selectSessionCapability(store.getState(), '/synthetic/caps', 'queue'), null);
  store.getState().reconcileSessionState('/synthetic/caps', authority({ read: true, control: true, send: true, queue: true, interrupt: false }), 1);
  assert.equal(f.selectSessionCapability(store.getState(), '/synthetic/caps', 'queue'), true);
  assert.equal(f.selectSessionCapability(store.getState(), '/synthetic/caps', 'interrupt'), false);
});

test('the chosen delivery is stored with the durable intent and posted', async t => {
  const { f } = await fixture(t);
  const { controller, bodies, path } = f.controller();
  await f.act(async () => { await controller.sendPrompt('hold until done', [], path, undefined, 'queue'); });
  assert.equal(controller.getSavedPrompts().find(e => e.text === 'hold until done')?.delivery, 'queue');
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].delivery, 'queue');
  await f.act(async () => { await controller.sendPrompt('stop and do this', [], path, undefined, 'interrupt'); });
  assert.equal(bodies[1].delivery, 'interrupt');
  await f.act(async () => { await controller.sendPrompt('idle send', [], path); });
  assert.equal('delivery' in bodies[2], false, 'idle sends carry no mode');
});

const user = (id, text, extra = {}) => ({ id, role: 'user', text, parts: text ? [{ kind: 'text', text }] : [], ...extra });
const reply = (id, text, extra = {}) => ({ id, role: 'assistant', text, parts: text ? [{ kind: 'text', text }] : [], ...extra });
const failed = (id, errorMessage = '529 {"type":"error","error":{"message":"Overloaded"}}', extra = {}) =>
  reply(id, '', { errorMessage, stopReason: 'error', ...extra });

test('Retry targets only the newest turn that failed on its own', async t => {
  const { f } = await fixture(t);
  const pick = (messages) => {
    const target = f.failedTurnToRetry(messages);
    return target ? `${target.failedId}<-${target.prompt.id}` : null;
  };
  assert.equal(pick([user('u1', 'fix it'), failed('a1')]), 'a1<-u1');
  assert.equal(pick([user('u1', 'fix it'), reply('a0', 'working', { parts: [{ kind: 'tool', callId: 'c' }] }), failed('a1')]), 'a1<-u1', 'the turn prompt, not a tool step');
  assert.equal(pick([user('u1', 'fix it'), failed('a1', 'Request was aborted', { stopReason: 'aborted' })]), null, 'user-stopped');
  assert.equal(pick([user('u1', 'fix it'), failed('a1', 'Operation interrupted by user')]), null, 'stopped on the desktop');
  assert.equal(pick([user('u1', 'fix it'), failed('a1', undefined, { retry: { status: 'superseded', attempt: 1 } })]), null, "an attempt omp's auto-retry replaced");
  assert.equal(pick([user('u1', 'fix it'), failed('a1', 'Previous OMP process exited before completing the turn.')]), null, 'a restart offers Continue instead');
  assert.equal(pick([user('u1', 'fix it'), failed('a1', 'Refusal (cyber): This request triggered restrictions.')]), null, 'a refusal needs another model');
  assert.equal(pick([user('u1', 'one'), failed('a1'), user('u2', 'two'), reply('a2', 'done')]), null, 'older error');
  assert.equal(pick([user('u1', 'one'), failed('a1'), user('local:x', 'sent after')]), null, 'something newer is pending');
  assert.equal(pick([user('u1', 'one'), reply('a1', 'fine')]), null);
  assert.equal(pick([failed('a1')]), null, 'nothing to resend');
  assert.equal(pick([user('u1', '', { parts: [{ kind: 'image', src: 'data:image/png;base64,AA==', mimeType: 'image/png' }] }), failed('a1')]), 'a1<-u1', 'image-only prompt');
});

test('the error notice offers Retry with a 44px hit area, disabled while a turn runs', async t => {
  const { f, render } = await fixture(t);
  const message = failed('a1');
  const none = await render(() => f.parts(message));
  assert.equal(none.querySelector('[data-testid="retry-turn"]') === null, true, 'no handler, no action');
  let taps = 0;
  const offered = await render(() => f.parts(message, { onRetry: () => taps++ }));
  const notice = offered.querySelector('[data-testid="turn-error"]');
  assert.equal(notice?.getAttribute('role'), 'alert');
  assert.equal(notice.getAttribute('data-tone'), 'danger');
  // A known provider failure reads as a sentence; the raw 529 JSON stays behind Details.
  assert.equal(notice.textContent.includes("Couldn't get a reply"), true);
  assert.equal(notice.textContent.includes('The model is busy right now'), true);
  assert.equal(notice.textContent.includes('"type":"error"'), false);
  assert.equal(offered.textContent.includes('Provider error'), false);
  const retry = notice.querySelector('[data-testid="retry-turn"]');
  assert.equal(retry?.textContent, 'Retry');
  // A text action reaches 44px through its pseudo-element hit area, not its box.
  assert.equal(retry.className.includes('after:-inset-y-3'), true);
  await f.act(async () => retry.click());
  assert.equal(taps, 1);
  const details = [...notice.querySelectorAll('button')].find(b => b.textContent === 'Details');
  assert.equal(details?.getAttribute('aria-expanded'), 'false');
  assert.equal(notice.querySelector('[data-testid="turn-error-raw"]') === null, true);
  await f.act(async () => details.click());
  assert.equal(details.getAttribute('aria-expanded'), 'true');
  assert.equal(details.textContent, 'Hide details');
  assert.equal(notice.querySelector('[data-testid="turn-error-raw"]')?.textContent, message.errorMessage);
  const busy = await render(() => f.parts(message, { onRetry: () => taps++, retryDisabled: true }));
  assert.equal(busy.querySelector('[data-testid="retry-turn"]').disabled, true);
  // A turn the user stopped is not an error: the footer owns "Stopped", so no notice.
  const stopped = await render(() => f.parts(failed('a2', 'Request was aborted', { stopReason: 'aborted' }), { onRetry: () => taps++ }));
  assert.equal(stopped.querySelector('[data-testid="turn-error"]') === null, true);
  assert.equal(stopped.querySelector('[role="alert"]') === null, true);
  assert.equal(stopped.textContent, '');
});

test('Retry re-sends the failed prompt with its image once, or refuses without the image', async t => {
  const { f } = await fixture(t);
  const { controller, bodies, path } = f.controller();
  const photo = { kind: 'image', src: 'data:image/png;base64,c3ludGhldGlj', mimeType: 'image/png' };
  const handed = [], send = controller.sendPrompt;
  controller.sendPrompt = function (text, images, ...rest) { handed.push(JSON.stringify(images)); return send.call(this, text, images, ...rest); };
  await f.act(async () => { await controller.retryFailedTurn(user('u1', 'describe this', { parts: [{ kind: 'text', text: 'describe this' }, photo] }), path); });
  assert.deepEqual(handed, [JSON.stringify([{ data: 'c3ludGhldGlj', mimeType: 'image/png' }])]);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].text, 'describe this');
  // jsdom has no IndexedDB and the localStorage fallback keeps no image
  // bytes, so the body cannot show the photo; the durable intent counts it.
  const intent = controller.getSavedPrompts().find(entry => entry.text === 'describe this');
  assert.equal(intent?.imageCount, 1);
  assert.equal(intent.imageBytes > 0, true);
  assert.equal('delivery' in bodies[0], false, 'a retry starts a turn; it never steers');
  let refused = '';
  await f.act(async () => {
    await controller.retryFailedTurn(user('u2', 'and this', { parts: [{ kind: 'image', src: null, mimeType: 'image/png' }] }), path)
      .catch(error => { refused = String(error.message); });
  });
  assert.match(refused, /no longer available/);
  assert.equal(bodies.length, 1, 'text alone is never sent in place of a lost photo');
});
