import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {bundleDomFixture,createDomFixture,root} from './support/react-dom.mjs';

// The real module, bundled once; errors are built inside the page so
// `instanceof`/`name` checks see the same realm the app does.
const code=await bundleDomFixture(`
import {humanizeDaemonError,humanizeReceiptError,NO_REASON_OWNED} from ${JSON.stringify(resolve(root,'web/src/app/ui/OwnedBySession.tsx'))};
import {AuthError,ForbiddenError} from ${JSON.stringify(resolve(root,'web/src/runtime/rpc-client.ts'))};
window.h=humanizeDaemonError;window.receipt=humanizeReceiptError;window.owned=NO_REASON_OWNED;
window.make={
  error:(m)=>new Error(m),
  type:(m)=>new TypeError(m),
  status:(m,status)=>Object.assign(new Error(m),{status}),
  forbidden:()=>new ForbiddenError(),
  auth:()=>new AuthError('Authentication failed',401),
  timeout:()=>new DOMException('signal timed out','TimeoutError'),
  abort:()=>new DOMException('The operation was aborted.','AbortError'),
};
`);
const dom=createDomFixture(code);const w=dom.window;
test.after(()=>{assert.deepEqual(dom.blocked,[]);dom.close()});
const h=(e)=>w.h(e);

test('network failures name the computer, whatever the engine said',()=>{
  for(const raw of ['Failed to fetch','Load failed','NetworkError when attempting to fetch resource.','Network request failed','net::ERR_INTERNET_DISCONNECTED','java.net.UnknownHostException: studio','connect ECONNREFUSED 127.0.0.1:7682'])
    assert.equal(h(w.make.type(raw)),'Couldn’t reach your computer.',raw);
  assert.equal(h('Failed to fetch'),'Couldn’t reach your computer.');
});

test('timeouts say the computer was slow',()=>{
  assert.equal(h(w.make.timeout()),'Your computer took too long to answer.');
  assert.equal(h('timeout'),'Your computer took too long to answer.');
  assert.equal(h('health probe timed out'),'Your computer took too long to answer.');
  assert.equal(h(w.make.status('',504)),'Your computer took too long to answer.');
  assert.equal(h(w.make.abort()),'The request was cancelled.');
});

test('a dead or unopenable agent process reads as the agent stopping',()=>{
  for(const raw of ['agent process exited','agent process open failure','agent process terminated (open failure)','rpc channel closed (agent process terminated)','terminated (open failure)'])
    assert.equal(h(raw),'The agent stopped unexpectedly.',raw);
  assert.equal(h('failed to spawn omp rpc child: No such file or directory (os error 2)'),'Couldn’t start the agent.');
});

test('file paths never reach the screen; a malformed session file gets one sentence',()=>{
  assert.equal(h('/home/u/.omp/sessions/a.jsonl: the session header is missing or malformed. The file was not modified.'),'This chat’s file couldn’t be read.');
  assert.equal(h('Command failed: /home/u/x/y.jsonl exploded'),'Something went wrong. Try again.');
  assert.equal(h('Wait ~5 minutes'),'Wait ~5 minutes.');
});


test('authorisation failures say what is wrong with this device',()=>{
  assert.equal(h(w.make.forbidden()),'This device doesn’t have access.');
  assert.equal(h('{"ok":false,"error":"forbidden"}'),'This device doesn’t have access.');
  assert.equal(h(w.make.auth()),'This phone is no longer paired. Pair it again.');
  assert.equal(h('unauthorized'),'This phone is no longer paired. Pair it again.');
});

test('git and session errors from /api/changes become sentences',()=>{
  assert.equal(h('git is not installed on this computer'),'Git isn’t installed on your computer.');
  assert.equal(h('git timed out'),'Git took too long to read the changes.');
  assert.equal(h("git status failed: fatal: detected dubious ownership in repository at '/srv/x'"),'Git doesn’t trust this folder. Mark it as a safe directory on your computer.');
  assert.equal(h('git rev-parse failed: fatal: not a git repository (or any of the parent directories): .git'),'This folder isn’t a git repository.');
  assert.equal(h('git diff failed: error: unable to read tree'),'Git couldn’t read this repository.');
  assert.equal(h('working directory no longer exists'),'This conversation’s folder no longer exists.');
  assert.equal(h('session has no working directory'),'This conversation has no project folder.');
  assert.equal(h('session has not started yet'),'This conversation hasn’t started yet.');
  assert.equal(h('{"ok":false,"error":"session file not found"}'),'That conversation no longer exists.');
  assert.equal(h('invalid session path'),'That conversation no longer exists.');
});

test('the fallback never echoes a stack, JSON, status line or script fault',()=>{
  const generic='Something went wrong. Try again.';
  assert.equal(h('Error: boom\n    at run (/app/assets/index.js:1:2)'),generic);
  assert.equal(h('{"ok":false}'),generic);
  assert.equal(h('{"ok":false,"detail":{"nested":true}}'),generic);
  assert.equal(h('HTTP 418'),generic);
  assert.equal(h(w.make.status('HTTP 502',502)),'Your computer ran into a problem. Try again.');
  assert.equal(h(w.make.status('device registry unavailable',500)),'Your computer ran into a problem. Try again.');
  assert.equal(h(w.make.status('index unavailable',503)),'Search is unavailable right now.');
  assert.equal(h(w.make.type("Cannot read properties of undefined (reading 'x')")),generic);
  assert.equal(h('SyntaxError: Unexpected token < in JSON at position 0'),generic);
  assert.equal(h('x'.repeat(300)),generic);
  assert.equal(h(''),generic);
  assert.equal(h(null),generic);
});

test('human daemon sentences pass through, sentence-cased and punctuated',()=>{
  assert.equal(h('invalid cwd'),'That folder isn’t on your computer anymore.');
  assert.equal(h('child pool saturated: every child is busy'),'Your computer is busy with other sessions. Try again in a moment.');
  assert.equal(h('Write refused'),'Write refused.');
  assert.equal(h('index unavailable'),'Search is unavailable right now.');
  assert.equal(h('some_code: the pool is saturated'),'The pool is saturated.');
});

test('ownership refusals keep their reason and never leak the guard line',()=>{
  assert.equal(h('session_owned_by_terminal: session file is held open by another omp process (pid 4242, /usr/bin/omp --mode rpc)'),w.owned);
  assert.equal(h('session_owned_by_terminal: held (pid 1) — auto-sharing failed: relay refused'),'This session is open on your computer, and automatic sharing failed: relay refused');
  assert.equal(w.receipt(undefined),'Command failed');
  assert.equal(w.receipt('agent process exited'),'The agent stopped unexpectedly.');
});
