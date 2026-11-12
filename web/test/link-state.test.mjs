#!/usr/bin/env node
// The link verdict is what the drawers say when the computer is gone, so the
// distinctions it draws are the behaviour: a timeout and a network error mean
// "nothing answered", a gateway error with no JSON body means "the proxy is up
// and the daemon is not", the daemon's own 5xx JSON proves it is running, and a
// caller's own abort says nothing at all.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createVite } from '../node_modules/vite/dist/node/index.js';

const vite = await createVite({ root: new URL('..', import.meta.url).pathname, configFile: false, server: { middlewareMode: true, hmr: false, ws: false }, resolve: { alias: { '@': new URL('../src', import.meta.url).pathname } }, logLevel: 'error' });
const link = await vite.ssrLoadModule('/src/runtime/link-state.ts');
const response = (status, type) => ({ status, headers: new Headers(type ? { 'content-type': type } : {}) });
let failures = 0;
const check = (name, ok) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); if (!ok) failures++; };

check('a plain 200 is live', link.linkKindOfResponse(response(200, 'text/html')) === 'live');
check('a gateway error without a JSON body is the daemon being down', link.linkKindOfResponse(response(502, 'text/plain')) === 'daemon-down');
check('a gateway error with no content type is the daemon being down', link.linkKindOfResponse(response(503)) === 'daemon-down');
check("the daemon's own 503 JSON proves it is running", link.linkKindOfResponse(response(503, 'application/json')) === 'live');
check('a 401 proves the daemon answered', link.linkKindOfResponse(response(401, 'application/json')) === 'live');

const seen = [];
const stop = link.subscribeLink(() => seen.push(link.getLinkState().kind));
link.reportLinkError(new DOMException('aborted', 'AbortError'));
check("a caller's own abort says nothing about the link", link.getLinkState().kind === 'live' && seen.length === 0);
link.reportLinkError(new DOMException('timed out', 'TimeoutError'));
check('a timeout means nothing answered', link.getLinkState().kind === 'unreachable');
link.reportLinkError(new TypeError('Failed to fetch'));
check('repeated evidence does not notify again', seen.length === 1);
link.reportLinkResponse(response(502, 'text/plain'));
check('a gateway error after a timeout moves to daemon-down', link.getLinkState().kind === 'daemon-down');
link.reportLinkOk();
check('any answer is recovery', link.getLinkState().kind === 'live' && seen.join() === 'unreachable,daemon-down,live');

// The chat socket's down time must survive retries: only an open socket or no
// chat clears it, otherwise a dead link flickers between every attempt.
let chatNotified = 0;
const stopChat = link.subscribeLink(() => chatNotified++);
check('no chat socket reports no down time', link.getChatSocketDownSince() === null);
link.reportChatSocket('down');
const downSince = link.getChatSocketDownSince();
check('a down socket records the time and notifies', typeof downSince === 'number' && chatNotified === 1);
link.reportChatSocket('down');
check('a retry going down again keeps the first time and stays quiet', link.getChatSocketDownSince() === downSince && chatNotified === 1);
link.reportChatSocket('open');
check('an open socket clears the down time', link.getChatSocketDownSince() === null && chatNotified === 2);
link.reportChatSocket('down');
link.reportChatSocket('none');
check('closing the chat clears the down time', link.getChatSocketDownSince() === null && chatNotified === 4);
stopChat();

// The probe is the only request made for the link; it must name the cause and
// recover on the first answer.
let reply = 502;
const server = createServer((req, res) => {
  if (req.url !== '/api/version') { res.writeHead(404).end(); return; }
  if (reply === 0) { req.socket.destroy(); return; }
  res.writeHead(reply, { 'content-type': reply === 200 ? 'application/json' : 'text/plain' }).end(reply === 200 ? '{}' : 'Bad Gateway');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
link.setLinkOrigin(`http://127.0.0.1:${server.address().port}`);
try {
  check('a probe answered by a bare 502 names the daemon', (await link.probeLink(true)) === 'daemon-down');
  reply = 0;
  check('a probe the connection drops on says nothing answered', (await link.probeLink(true)) === 'unreachable');
  reply = 200;
  check('a probe that is answered recovers the link', (await link.probeLink(true)) === 'live');
  const gap = await link.probeLink();
  check('an unforced probe inside the gap reuses the verdict', gap === 'live');
  link.reportLinkError(new DOMException('timed out', 'TimeoutError'));
  check('an outage remembers when anything last answered, for the banner', typeof link.getLinkState().lastLiveAt === 'number');
} finally {
  stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await vite.close();
}
assert.equal(failures, 0, `${failures} link state checks failed`);
