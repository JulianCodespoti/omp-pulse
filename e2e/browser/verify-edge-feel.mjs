#!/usr/bin/env node
// Pins the measured UX defects: opening travelled 5,546 px for 730–790 ms with
// Down flashing; history pulled back 795–964 px; a dead link stayed invisible
// for 75 s and its indicator remounted nine times in 40 s. Samples real frames
// and touch input. No model calls: fixtures only; Send occurs under SIGSTOP,
// followed by SIGKILL (never SIGCONT), so the prompt cannot be processed.
// Run through e2e/with-test-daemon.sh. Exit code = number of failed checks.
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { openPairedPage } from '../lib/browser-pairing.mjs';
import { showSessionsList } from '../lib/chat-nav.mjs';
import { loadPuppeteer, chromium, startWebApp } from '../lib/env.mjs';

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
const TMP = process.env.OMP_PULSE_TEST_TMP;
const PID = Number(process.env.OMP_PULSE_TEST_DAEMON_PID);
if (!BASE || !TOKEN || !SESSIONS || !TMP || !Number.isInteger(PID) || PID <= 1) {
  console.error('run through e2e/with-test-daemon.sh'); process.exit(2);
}
if (new URL(BASE).port === '7682') { console.error('refusing the live daemon'); process.exit(2); }
let failures = 0;
const check = (name, ok, detail) => { failures += Number(!ok); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const cwd = join(TMP, 'edge-feel-cwd');
mkdirSync(cwd, { recursive: true });
const paragraph = 'The retry budget is read once per request and then decremented on every attempt, so a request that fails three times stops instead of looping. ';
// Same 150-turn shape as the audit: tall markdown answers expose reveal travel.
function buildSession() {
  const id = '019ff500-0000-7000-0000-00000000a001';
  const title = 'Edge feel fixture';
  const entries = [{ type: 'title', title }, { type: 'session', id, cwd, title }];
  let k = 0;
  const stamp = () => new Date(Date.now() - 5 * 3600000 + k * 1000).toISOString();
  for (let t = 1; t <= 150; t++) {
    entries.push({ id: `e${k++}`, type: 'message', timestamp: stamp(), message: { role: 'user', content: [{ type: 'text', text: `AUDIT TURN ${String(t).padStart(3, '0')}: what happens on attempt ${t}?` }] } });
    entries.push({ id: `e${k++}`, type: 'message', timestamp: stamp(), message: { role: 'assistant', content: [{ type: 'text', text: `Answer ${t}.\n\n${paragraph.repeat(2)}\n\n${paragraph.repeat(2)}\n\n- first point about attempt ${t}\n- second point\n- third point` }] } });
  }
  const dir = join(SESSIONS, '-tmp-edge-feel');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `2026-10-01T12-00-00-000Z_${id}.jsonl`);
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  const when = new Date(Date.now() - 60000); utimesSync(file, when, when);
  return title;
}
const title = buildSession();
const puppeteer = await loadPuppeteer();
const webApp = await startWebApp({ base: BASE, port: 5290 });
let browser;
let stopped = false;
try {
  browser = await puppeteer.launch({ headless: true, executablePath: chromium(), args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
  const cdp = await page.createCDPSession();
  let delayHistory = false;
  let landed = 0;
  const holds = [];
  page.on('response', response => { if (response.url().includes('/api/history') && /[?&]before=/.test(response.url()) && response.ok()) landed++; });
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (delayHistory && request.url().includes('/api/history') && /[?&]before=/.test(request.url())) {
      const start = Date.now();
      setTimeout(() => { holds.push(Date.now() - start); request.continue().catch(() => {}); }, 800);
    } else request.continue().catch(() => {});
  });
  await openPairedPage(page, webApp.url, TOKEN, { waitUntil: 'networkidle0' });
  await page.reload({ waitUntil: 'networkidle0' });
  await showSessionsList(page);
  await page.waitForSelector('[data-testid="session-row"]');
  // Start before tapping; hidden OpenReveal frames are not painted transcript.
  // rAF runs before ResizeObserver's same-frame pin correction. Sample in its
  // following task so an intermediate pre-layout position is not called a paint.
  await page.evaluate(() => {
    window.__edgeFrames = []; window.__edgeRun = true;
    const tick = () => setTimeout(() => {
      if (!window.__edgeRun) return;
      const el = [...document.querySelectorAll('.chat-scroll')].at(-1);
      if (el && getComputedStyle(el).opacity !== '0' && el.querySelector('[data-testid="chat-message"]')) {
        window.__edgeFrames.push({ time: performance.now(), distance: el.scrollHeight - el.scrollTop - el.clientHeight, down: !!document.querySelector('[data-testid="jump-next"][aria-hidden="false"]') });
      }
      requestAnimationFrame(tick);
    }, 0); requestAnimationFrame(tick);
  });
  await page.evaluate(title => {
    const row = [...document.querySelectorAll('[data-testid="session-row"]')].find(row => row.textContent.includes(title));
    if (!row) throw new Error('fixture row missing'); row.click();
  }, title);
  await page.waitForFunction(() => window.__edgeFrames.length > 0, { timeout: 20000 });
  await wait(1600);
  const frames = await page.evaluate(() => { window.__edgeRun = false; return window.__edgeFrames; });
  const opening = frames.filter(frame => frame.time - frames[0].time <= 1500);
  const max = Math.max(...opening.map(frame => frame.distance));
  const flashes = opening.filter(frame => frame.down).length;
  check('1 opening does not travel or flash Down', frames[0].distance <= 16 && max <= 16 && flashes === 0 && frames.at(-1).time - frames[0].time >= 1500, `first=${frames[0].distance.toFixed(1)}px max=${max.toFixed(1)}px Down=${flashes} frames=${opening.length}`);

  await wait(1000);
  landed = 0; delayHistory = true;
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('.chat-scroll')].at(-1);
    window.__historyFrames = []; window.__historyRun = true;
    const tick = () => { if (!window.__historyRun) return; window.__historyFrames.push(el.scrollHeight - el.scrollTop - el.clientHeight); requestAnimationFrame(tick); }; requestAnimationFrame(tick);
  });
  // Finger moves down: read upwards into older history, as in the audit driver.
  for (let swipe = 0; swipe < 30 && landed === 0; swipe++) {
    let y = 190;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y, id: 1 }] });
    for (let moved = 0; moved < 520; moved += 22) {
      y += 22;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y, id: 1 }] });
      await wait(8);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await wait(220);
  }
  await wait(2000);
  const history = await page.evaluate(() => { window.__historyRun = false; return window.__historyFrames; });
  const drop = Math.max(0, ...history.slice(1).map((distance, i) => history[i] - distance));
  check('2 history never pulls the reader down', landed > 0 && holds.length > 0 && drop <= 40, `older responses=${landed} holds=${holds.join(',')}ms max frame drop=${drop.toFixed(1)}px frames=${history.length}`);
  delayHistory = false;

  if (webApp.mode === 'vite') {
    console.log('SKIP 3–5: vite is not served by the daemon; requires embedded mode');
  } else {
    await wait(1500);
    process.kill(PID, 'SIGSTOP'); stopped = true;
    const start = Date.now();
    let dead = false;
    while (Date.now() - start < 40000) {
      dead = await page.evaluate(() => ['unreachable', 'offline'].includes(document.querySelector('[data-testid="chat-offline-hint"]')?.dataset.link));
      if (dead) break; await wait(100);
    }
    check('3 dead idle link shows', dead, `detected=${dead} elapsed=${Date.now() - start}ms`);
    await page.tap('[data-testid="composer-input"]');
    await page.keyboard.type('edge feel message typed while the link is dead');
    await page.tap('button[aria-label="Send"]');
    const sent = Date.now(); let status = '';
    while (Date.now() - sent < 15000) {
      status = await page.evaluate(() => [...document.querySelectorAll('[data-user-turn]')].at(-1)?.querySelector('[data-testid="send-status"]')?.textContent?.trim() || '');
      if (status === 'Waiting for connection') break; await wait(100);
    }
    check('4 dead-link send explains its wait', status === 'Waiting for connection', `status=${JSON.stringify(status)} elapsed=${Date.now() - sent}ms`);
    process.kill(PID, 'SIGKILL'); stopped = false;
    await page.evaluate(() => { const pill = document.querySelector('[data-testid="chat-offline-hint"]'); if (pill) pill.__edgeIdentity = true; });
    const steadyStart = Date.now(); let samples = 0; let missing = 0; let replaced = 0;
    while (Date.now() - steadyStart < 20000) {
      const sample = await page.evaluate(() => { const pill = document.querySelector('[data-testid="chat-offline-hint"]'); return { present: !!pill, same: pill?.__edgeIdentity === true }; });
      samples++; if (!sample.present) missing++; else if (!sample.same) replaced++;
      await wait(50);
    }
    check('5 outage indicator stays mounted', missing === 0 && replaced === 0, `samples=${samples} missing=${missing} replaced=${replaced} duration=${Date.now() - steadyStart}ms`);
  }
} catch (error) {
  check('suite completes', false, error.stack || String(error));
} finally {
  // Even an assertion/driver failure after STOP must never resume the prompt.
  if (stopped) { try { process.kill(PID, 'SIGKILL'); } catch {} }
  if (browser) await browser.close();
  webApp.stop();
}
process.exit(failures);
