import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { bundleDomFixture, createDomFixture, root } from './support/react-dom.mjs';

const code = await bundleDomFixture(`
  import { computerName, linkAdvice, LINK_INDICATOR_LABEL } from ${JSON.stringify(resolve(root, 'web/src/app/session-format.ts'))};
  window.fixture = { computerName, linkAdvice, LINK_INDICATOR_LABEL };
`);

function fixture(t) {
  const dom = createDomFixture(code);
  t.after(() => dom.close());
  return dom.window.fixture;
}

test('an unnamed computer is capitalised at the start of a sentence and lower-case inside one', t => {
  const { computerName } = fixture(t);
  assert.equal(computerName('127.0.0.1'), 'Your computer');
  assert.equal(computerName('localhost', false, 'start'), 'Your computer');
  assert.equal(computerName('localhost', false, 'inline'), 'your computer');
  assert.equal(computerName('', true), 'This phone');
  assert.equal(computerName('', true, 'inline'), 'this phone');
  assert.equal(computerName('Studio.tail1234.ts.net', false, 'inline'), 'studio', 'a named host is never re-cased');
});

test('Tailscale is named only for a tailnet host', t => {
  const { linkAdvice } = fixture(t);
  const tailscale = 'Check that Tailscale is on and that the computer is awake.';
  const lan = 'Check that the computer is awake and on the same network.';
  assert.equal(linkAdvice('studio.tail1234.ts.net'), tailscale);
  assert.equal(linkAdvice('100.64.0.1'), tailscale);
  assert.equal(linkAdvice('100.127.255.254'), tailscale);
  assert.equal(linkAdvice('100.63.0.1'), lan, 'just below 100.64.0.0/10');
  assert.equal(linkAdvice('100.128.0.1'), lan, 'just above 100.64.0.0/10');
  assert.equal(linkAdvice('192.168.1.20'), lan);
  assert.equal(linkAdvice('studio.local'), lan);
  assert.equal(linkAdvice('127.0.0.1', true), 'Open Settings › Computer to restart it.');
});
