#!/usr/bin/env node
// Focused cross-layer transition proof for mobile reliability. This suite must
// run through e2e/with-test-daemon.sh; it mutates only that daemon's state and
// session root, and never uses the live owner token or port.
import { mkdirSync, writeFileSync, utimesSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { createServer } from "node:net";
import { openPairedPage } from "../lib/browser-pairing.mjs";
import { backToSessions, showSessionsList } from "../lib/chat-nav.mjs";
import { loadPuppeteer, chromium, testModel } from "../lib/env.mjs";

const BASE = process.env.OMP_PULSE_TEST_BASE;
const TOKEN = process.env.OMP_PULSE_TEST_TOKEN;
const SESSIONS = process.env.OMP_PULSE_TEST_SESSIONS;
const TMP = process.env.OMP_PULSE_TEST_TMP;
if (
  !BASE ||
  !TOKEN ||
  !SESSIONS ||
  !TMP ||
  !BASE.startsWith("http://127.0.0.1:") ||
  BASE.includes(":7682")
) {
  console.error(
    "run through e2e/with-test-daemon.sh (loopback isolated daemon required)",
  );
  process.exit(2);
}

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`,
  );
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ownerHeaders = {
  Authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
};
async function api(
  path,
  { method = "GET", body, headers = ownerHeaders, signal } = {},
) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: response.status, text, json };
}

// A real fixture path keeps the receipt tests out of any desktop-owned session.
const cwd = `${TMP}/reliability-transitions-cwd`;
mkdirSync(cwd, { recursive: true });
const sessionPath = `${SESSIONS}/-tmp-reliability-transitions/2026-09-05T00-00-00-000Z_${randomUUID()}.jsonl`;
mkdirSync(`${SESSIONS}/-tmp-reliability-transitions`, { recursive: true });
writeFileSync(
  sessionPath,
  `${JSON.stringify({ type: "session", id: randomUUID(), cwd, title: "Reliability transitions" })}\n`,
);
utimesSync(
  sessionPath,
  new Date(Date.now() - 60_000),
  new Date(Date.now() - 60_000),
);
const want = await testModel({ base: BASE, token: TOKEN, sessionPath });
const configured = await api("/api/rpc", { method: "POST", body: {
  sessionPath, command: "set_model",
  params: { provider: want.provider, modelId: want.id },
} });
const selected = await api("/api/rpc", { method: "POST", body: { sessionPath, command: "get_state" } });
if (configured.status !== 200 || selected.json.data?.model?.provider !== want.provider || selected.json.data?.model?.id !== want.id)
  throw new Error(`Refusing model-backed test without ${want.provider}/${want.id}`);

// Durable command identity: the same payload is idempotent, a conflicting
// payload is rejected, and a response-body loss is reconciled by receipt read.
const commandId = randomUUID();
const first = await api("/api/prompt", {
  method: "POST",
  body: { commandId, sessionPath, text: "transition duplicate probe" },
});
const duplicate = await api("/api/prompt", {
  method: "POST",
  body: { commandId, sessionPath, text: "transition duplicate probe" },
});
check(
  "duplicate same-ID delivery is idempotent",
  first.status === 200 &&
    duplicate.status === 200 &&
    first.json.receipt?.commandId === commandId &&
    duplicate.json.receipt?.commandId === commandId &&
    first.json.receipt?.sessionPath === duplicate.json.receipt?.sessionPath,
  `${first.status}/${duplicate.status} ${duplicate.text.slice(0, 180)}`,
);
const collision = await api("/api/prompt", {
  method: "POST",
  body: { commandId, sessionPath, text: "different payload must collide" },
});
check(
  "different-payload reuse of an ID is rejected",
  collision.status === 409 && collision.json.ok === false,
  `${collision.status} ${collision.text.slice(0, 180)}`,
);

const lostId = randomUUID();
const lostResponse = await fetch(`${BASE}/api/prompt`, {
  method: "POST",
  headers: ownerHeaders,
  body: JSON.stringify({
    commandId: lostId,
    sessionPath,
    text: "response body is intentionally discarded",
  }),
});
await lostResponse.body?.cancel();
await sleep(250);
const reconciled = await api(`/api/receipts/${encodeURIComponent(lostId)}`);
check(
  "lost response reconciles through the receipt endpoint",
  reconciled.status === 200 &&
    reconciled.json.ok === true &&
    reconciled.json.receipt?.commandId === lostId,
  `${reconciled.status} ${reconciled.text.slice(0, 180)}`,
);
const listedReceipts = await api(
  `/api/receipts?session=${encodeURIComponent(sessionPath)}`,
);
check(
  "receipt listing is scoped to the fixture session",
  listedReceipts.status === 200 &&
    listedReceipts.json.ok === true &&
    listedReceipts.json.receipts?.some(
      (receipt) => receipt.commandId === commandId,
    ) &&
    listedReceipts.json.receipts?.some(
      (receipt) => receipt.commandId === lostId,
    ),
  listedReceipts.text.slice(0, 220),
);

// Device access: owner mints independent read/control credentials. Pairing
// codes expose only bounded expiry metadata and are one-use.
const codeResult = await api("/api/devices/pairing-codes", {
  method: "POST",
  body: { role: "read", name: "transition-read" },
});
const expiresAt = Number(codeResult.json.expiresAt);
check(
  "pairing code has a bounded five-minute expiry",
  codeResult.status === 200 &&
    codeResult.json.ok === true &&
    typeof codeResult.json.code === "string" &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now() &&
    expiresAt <= Date.now() + 5 * 60_000 + 5_000,
  codeResult.text.slice(0, 220),
);
const pair = await api("/api/pair", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: { code: codeResult.json.code, name: "transition-read" },
});
const readToken = pair.json.token;
check(
  "pairing code redeems once for an independent device token",
  pair.status === 200 &&
    pair.json.ok === true &&
    typeof readToken === "string" &&
    pair.json.device?.role === "read",
  pair.text.slice(0, 220),
);
const replay = await api("/api/pair", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: { code: codeResult.json.code, name: "replay" },
});
check(
  "pairing code cannot be redeemed twice",
  replay.status === 401 && replay.json.ok === false,
  `${replay.status} ${replay.text}`,
);
const expiredCode = await api("/api/pair", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: { code: `expired-${randomUUID()}`, name: "expired" },
});
check(
  "expired or unknown device codes are refused",
  expiredCode.status === 401 && expiredCode.json.ok === false,
  `${expiredCode.status} ${expiredCode.text}`,
);

const readHeaders = {
  Authorization: `Bearer ${readToken}`,
  "content-type": "application/json",
};
const readDevice = await api("/api/device", { headers: readHeaders });
check(
  "paired read device can identify itself",
  readDevice.status === 200 && readDevice.json.device?.role === "read",
  readDevice.text,
);
const readPrompt = await api("/api/prompt", {
  method: "POST",
  body: {
    sessionPath,
    text: "read role must not send",
    commandId: randomUUID(),
  },
  headers: readHeaders,
});
const readBash = await api("/api/bash", {
  method: "POST",
  body: { sessionPath, command: "printf nope" },
  headers: readHeaders,
});
const readBrowse = await api("/api/browse", { headers: readHeaders });
check(
  "read-only prompt is refused",
  readPrompt.status === 403 && readPrompt.json.ok === false,
  `${readPrompt.status} ${readPrompt.text}`,
);
check(
  "read-only bash is refused",
  readBash.status === 403 && readBash.json.ok === false,
  `${readBash.status} ${readBash.text}`,
);
check(
  "read-only browse is refused",
  readBrowse.status === 403 && readBrowse.json.ok === false,
  `${readBrowse.status} ${readBrowse.text}`,
);

const current = await api("/api/devices");
check(
  "administrator device listing omits credential values",
  current.status === 200 &&
    current.json.ok === true &&
    Array.isArray(current.json.devices) &&
    current.json.devices.every(
      (device) => !("token" in device) && !("credential" in device),
    ),
  current.text.slice(0, 240),
);
const readDeviceId = pair.json.device?.id;
const revoke = await api(`/api/devices/${encodeURIComponent(readDeviceId)}`, {
  method: "DELETE",
});
check(
  "administrator can revoke the paired device",
  revoke.status === 200 && revoke.json.ok === true,
  revoke.text,
);
const revoked = await api("/api/device", { headers: readHeaders });
check(
  "revocation blocks device data reads",
  revoked.status === 401 && revoked.json.ok === false,
  `${revoked.status} ${revoked.text}`,
);
const revokedStream = await fetch(`${BASE}/api/notify/stream`, {
  headers: readHeaders,
  signal: AbortSignal.timeout(1500),
})
  .then((response) => response.status)
  .catch(() => 0);
check(
  "revocation closes an open-stream attempt",
  revokedStream === 401,
  `HTTP ${revokedStream}`,
);

// Browser-level queue transitions use the real runtime module. The network
// callback is controlled only to make overlap deterministic; no production
// success response is fabricated for the daemon paths above.
const puppeteer = await loadPuppeteer();
const portProbe = createServer();
await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
const vitePort = portProbe.address().port;
await new Promise((resolve) => portProbe.close(resolve));
const vite = spawn(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    String(vitePort),
    "--strictPort",
  ],
  {
    cwd: new URL("../../web/", import.meta.url),
    env: { ...process.env, OMP_PULSE_WEB_TARGET: BASE },
    stdio: "ignore",
  },
);
let browser;
const profile = mkdtempSync(`${tmpdir()}/omp-transitions-`);
try {
  for (let i = 0; i < 200; i++) {
    if (vite.exitCode !== null)
      throw new Error(`test Vite exited: ${vite.exitCode}`);
    try {
      if ((await fetch(`http://127.0.0.1:${vitePort}/`)).ok) break;
    } catch {}
    await sleep(100);
  }
  browser = await puppeteer.launch({
    headless: true,
    executablePath: chromium(),
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--user-data-dir=${profile}`,
    ],
  });
  const page = await browser.newPage();
  await openPairedPage(page, `http://127.0.0.1:${vitePort}/`, TOKEN, {
    waitUntil: "networkidle0",
  });
  // Cold start lands on a chat or home; reach the All chats page (search field).
  await showSessionsList(page);
  await page.waitForSelector('[data-testid="session-search"]');
  // Exercise the real Composer, including StrictMode's mount/cleanup replay.
  // An empty pre-hydration tray used to erase its durable photos on cleanup.
  const photoSession = `${SESSIONS}/-tmp-reliability-transitions/2026-09-05T00-00-00-000Z_${randomUUID()}.jsonl`;
  writeFileSync(
    photoSession,
    [
      { type: "session", id: randomUUID(), cwd },
      { type: "title", title: "Attachment restoration" },
      {
        type: "message",
        id: "photo-user",
        message: {
          role: "user",
          content: [{ type: "text", text: "Keep my draft photos" }],
        },
      },
      {
        type: "message",
        id: "photo-reply",
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Attachment history restored" }],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
  const photoFile = `${TMP}/new-photo.png`;
  writeFileSync(photoFile, Buffer.from(png, "base64"));
  const setupPhotos = async (path, data) => {
    const queue = await import("/src/runtime/offline-queue.ts");
    const namespace = queue.offlineQueueNamespaceForCredential(
      localStorage.getItem("omp-remote-token"),
    );
    await queue.saveDraftAttachments(
      path,
      [
        {
          data,
          mimeType: "image/png",
          name: "saved-photo.png",
          width: 1,
          height: 1,
          previewUrl: `data:image/png;base64,${data}`,
        },
      ],
      namespace,
    );
    const original = IDBObjectStore.prototype.get;
    sessionStorage.setItem("photo-reads-delayed", "0");
    window.__restorePhotoRead = () => {
      IDBObjectStore.prototype.get = original;
    };
    IDBObjectStore.prototype.get = function (key) {
      const request = original.call(this, key);
      if (this.name !== "draft-attachments-v3") return request;
      sessionStorage.setItem(
        "photo-reads-delayed",
        String(Number(sessionStorage.getItem("photo-reads-delayed")) + 1),
      );
      return new Proxy(request, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
        set(target, property, value) {
          if (property === "onsuccess") {
            target.onsuccess = (event) =>
              setTimeout(() => value.call(target, event), 1200);
            return true;
          }
          return Reflect.set(target, property, value, target);
        },
      });
    };
  };
  // CDP's default world is the application world. Puppeteer's evaluation
  // world can have a separate prototype/module instance; IDB alone is shared.
  const photoCdp = await page.createCDPSession();
  const photoSetup = await photoCdp.send("Runtime.evaluate", {
    expression: `(${setupPhotos})(${JSON.stringify(photoSession)},${JSON.stringify(png)})`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (photoSetup.exceptionDetails)
    throw new Error(JSON.stringify(photoSetup.exceptionDetails));
  const openPhotoSession = async () => {
    await page.waitForFunction(() =>
      [...document.querySelectorAll('[data-testid="session-row"]')].some(
        (row) => row.textContent.includes("Attachment restoration"),
      ),
    );
    await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid="session-row"]')]
        .find((row) => row.textContent.includes("Attachment restoration"))
        .click(),
    );
  };
  await openPhotoSession();
  try {
    const photoInput = await page.waitForSelector(
      'input[type="file"][multiple]',
    );
    await photoInput.uploadFile(photoFile);
    await page.waitForFunction(
      () =>
        document.querySelectorAll('button[aria-label^="Remove "]').length === 2,
    );
    check(
      "restoring photos and selecting a new photo retains both",
      await page.evaluate(
        () =>
          Number(sessionStorage.getItem("photo-reads-delayed")) > 0 &&
          !!document.querySelector('[aria-label="Remove saved-photo.png"]') &&
          !!document.querySelector('[aria-label="Remove new-photo.png"]'),
      ),
    );
  } finally {
    await photoCdp.send("Runtime.evaluate", {
      expression: "window.__restorePhotoRead()",
    });
    await photoCdp.detach();
  }
  // Exercise persistence via DOM actions; native acceptance covers touch input.
  await page.$eval('[aria-label="Remove saved-photo.png"]', el => el.click());
  await page.waitForSelector('[aria-label="Remove saved-photo.png"]', { hidden: true });
  await page.$eval('[aria-label="Remove new-photo.png"]', el => el.click());
  await page.waitForSelector('[aria-label="Remove new-photo.png"]', { hidden: true });
  await backToSessions(page);
  await page.waitForSelector('[data-testid="session-row"]');
  await openPhotoSession();
  await page.waitForSelector('[data-testid="composer-input"]');
  await page.waitForFunction(
    (path) => new URLSearchParams(location.hash.slice(1)).get("s") === path,
    {},
    photoSession,
  );
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForFunction(() =>
    document.body.innerText.includes("Attachment history restored"),
  );
  check(
    "chat reload restores history and does not resurrect deleted photos",
    await page.evaluate(
      () => !document.querySelector('button[aria-label^="Remove "]'),
    ),
  );
  await backToSessions(page);
  await page.waitForSelector('[data-testid="session-row"]');
  const queueResult = await page.evaluate(async () => {
    const queue = await import(
      `/src/runtime/offline-queue.ts?transition=${Date.now()}`
    );
    const namespace = queue.offlineQueueNamespaceForCredential(
      `transition-drain-${crypto.randomUUID()}`,
    );
    queue.setOfflineQueueNamespace(namespace);
    await queue.clearAsync(undefined, namespace);
    const first = await queue.enqueue({
      sessionPath: "/tmp/transition",
      text: "one",
      commandId: "cmd-one",
      namespace,
    });
    const second = await queue.enqueue({
      sessionPath: "/tmp/transition",
      text: "two",
      commandId: "cmd-two",
      namespace,
    });
    const sent = [];
    // The daemon's /api/prompt reply: the receipt plus its session binding
    // (src/server/http/receipts.rs); a bare receipt is not a delivery proof.
    const send = async (entry) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      sent.push(entry.id);
      return {
        ok: true,
        receipt: {
          commandId: entry.commandId,
          sessionPath: entry.sessionPath,
          state: entry.commandId === first.commandId ? "completed" : "forwarded",
          createdAt: entry.createdAt,
          updatedAt: Date.now(),
        },
        receiptBinding: { version: 1, requestedSessionPath: entry.sessionPath, canonicalSessionPath: entry.sessionPath },
      };
    };
    await Promise.all([
      queue.flush(send, { isTransient: () => true, namespace }),
      queue.flush(send, { isTransient: () => true, namespace }),
    ]);
    const persisted = await Promise.all(
      [first, second].map((entry) =>
        queue.getQueued(entry.commandId, namespace),
      ),
    );
    return {
      ids: [first.id, second.id],
      sent,
      remaining: queue.pendingAll(namespace).length,
      persisted: persisted.map(
        (entry) => entry && { commandId: entry.commandId, state: entry.state },
      ),
    };
  });
  check(
    "overlapping drains send once and completed/forwarded work leaves the outbox",
    queueResult.remaining === 0 &&
      queueResult.sent.length === 2 &&
      new Set(queueResult.sent).size === 2 &&
      new Set(queueResult.sent).size === new Set(queueResult.ids).size &&
      queueResult.persisted.length === 2 &&
      queueResult.persisted[0]?.state === "completed" &&
      queueResult.persisted[1]?.state === "forwarded",
    JSON.stringify(queueResult),
  );
  const dismissal = await page.evaluate(async () => {
    const queue = await import("/src/runtime/offline-queue.ts");
    const namespace = queue.offlineQueueNamespaceForCredential(
      `dismiss-${crypto.randomUUID()}`,
    );
    // A drain only runs for the active credential's outbox.
    queue.setOfflineQueueNamespace(namespace);
    const entry = await queue.enqueue({
      sessionPath: "/tmp/dismiss",
      text: "dismiss during handoff",
      namespace,
    });
    let started, release;
    const handoff = new Promise((resolve) => {
      started = resolve;
    });
    const response = new Promise((resolve) => {
      release = resolve;
    });
    const draining = queue.flush(
      async (current) => {
        started();
        await response;
        return {
          ok: true,
          receipt: {
            commandId: current.commandId,
            sessionPath: current.sessionPath,
            state: "completed",
            createdAt: current.createdAt,
            updatedAt: Date.now(),
          },
          receiptBinding: { version: 1, requestedSessionPath: current.sessionPath, canonicalSessionPath: current.sessionPath },
        };
      },
      { namespace },
    );
    await handoff;
    await queue.removeAsync(entry.commandId, namespace);
    release();
    await draining;
    return await queue.getQueued(entry.commandId, namespace);
  });
  check(
    "late receipt does not resurrect a dismissed command",
    dismissal === null,
  );
  const preflight = await page.evaluate(async () => {
    const queue = await import("/src/runtime/offline-queue.ts");
    const namespace = queue.offlineQueueNamespaceForCredential(
      `preflight-${crypto.randomUUID()}`,
    );
    queue.setOfflineQueueNamespace(namespace);
    const entry = await queue.enqueue({
      sessionPath: "/tmp/preflight",
      text: "retain before handoff",
      namespace,
    });
    await queue.flush(
      async () => {
        throw new queue.UndispatchedError(
          new Error("Protocol preflight unavailable"),
        );
      },
      { namespace },
    );
    const saved = await queue.getQueued(entry.commandId, namespace);
    let delivered = 0;
    await queue.flush(
      async (current) => {
        delivered++;
        return {
          ok: true,
          receipt: {
            commandId: current.commandId,
            sessionPath: current.sessionPath,
            state: "completed",
            createdAt: current.createdAt,
            updatedAt: Date.now(),
          },
          receiptBinding: { version: 1, requestedSessionPath: current.sessionPath, canonicalSessionPath: current.sessionPath },
        };
      },
      { namespace },
    );
    const completed = await queue.getQueued(entry.commandId, namespace);
    return {
      saved: saved?.state,
      completed: completed?.state,
      delivered,
      sameId: completed?.commandId === entry.commandId,
    };
  });
  check(
    "pre-handoff failure retains retryable intent with the same ID",
    preflight.saved === "saved" &&
      preflight.completed === "completed" &&
      preflight.delivered === 1 &&
      preflight.sameId,
    JSON.stringify(preflight),
  );
  const migrationContext = await browser.createBrowserContext();
  try {
    const migrationPage = await migrationContext.newPage();
    await migrationPage.goto(`http://127.0.0.1:${vitePort}/`, {
      waitUntil: "networkidle0",
    });
    const migratedCache = await migrationPage.evaluate(async () => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open("omp-pulse-offline", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("history", {
            keyPath: "sessionPath",
          });
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
      });
      const cache = await import("/src/runtime/offline-cache.ts");
      const path = "/tmp/cache-migration";
      const message = (id) => ({
        id,
        role: "assistant",
        text: id,
        parts: [{ kind: "text", text: id }],
      });
      await cache.saveTail(path, [message("credential-a")], "credential:a");
      await cache.saveTail(path, [message("credential-b")], "credential:b");
      return {
        a: (await cache.loadTail(path, "credential:a"))?.messages[0]?.id,
        b: (await cache.loadTail(path, "credential:b"))?.messages[0]?.id,
      };
    });
    check(
      "v1 history upgrade preserves independent credential caches",
      migratedCache.a === "credential-a" && migratedCache.b === "credential-b",
      JSON.stringify(migratedCache),
    );
    const cacheBound = await migrationPage.evaluate(async () => {
      const cache = await import("/src/runtime/offline-cache.ts");
      for (let i = 0; i < 12; i++) {
        await cache.saveTail(
          `/tmp/bounded-${i}`,
          [
            {
              id: `bounded-${i}`,
              role: "assistant",
              text: `${i}`,
              parts: [{ kind: "text", text: `${i}` }],
            },
          ],
          "credential:bounded",
        );
      }
      const records = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          cache.loadTail(`/tmp/bounded-${i}`, "credential:bounded"),
        ),
      );
      return {
        retained: records.filter(Boolean).length,
        newest: records[11]?.messages[0]?.id,
        otherCredential: (
          await cache.loadTail("/tmp/cache-migration", "credential:b")
        )?.messages[0]?.id,
      };
    });
    check(
      "history retention bounds each credential without dropping its newest tail",
      cacheBound.retained === 8 &&
        cacheBound.newest === "bounded-11" &&
        cacheBound.otherCredential === "credential-b",
      JSON.stringify(cacheBound),
    );
    const concurrentCache = await migrationPage.evaluate(async () => {
      const cache = await import("/src/runtime/offline-cache.ts");
      const scope = "credential:concurrent-history";
      const ids = ["history-a", "history-b"];
      await Promise.all(ids.map((id) => cache.saveTail(`/tmp/${id}`, [{
        id, role: "assistant", text: id, parts: [{ kind: "text", text: id }],
      }], scope)));
      return Promise.all(ids.map(async (id) =>
        (await cache.loadTail(`/tmp/${id}`, scope))?.messages[0]?.id ?? null,
      ));
    });
    check(
      "simultaneous history saves retain both conversations",
      JSON.stringify(concurrentCache) === JSON.stringify(["history-a", "history-b"]),
      JSON.stringify(concurrentCache),
    );
    const failedSaveHistory = await migrationPage.evaluate(async () => {
      const cache = await import("/src/runtime/offline-cache.ts");
      const scope = "credential:failed-history";
      const ids = Array.from({ length: 8 }, (_, i) => `kept-${i}`);
      for (const id of ids) {
        await cache.saveTail(`/tmp/${id}`, [{
          id, role: "assistant", text: id, parts: [{ kind: "text", text: id }],
        }], scope);
      }
      await cache.saveTail("/tmp/rejected-tail", [{
        id: "rejected", role: "assistant", text: "rejected",
        parts: [{ kind: "text", text: "rejected", unclonable: () => {} }],
      }], scope);
      return Promise.all(ids.map(async (id) =>
        (await cache.loadTail(`/tmp/${id}`, scope))?.messages[0]?.id ?? null,
      ));
    });
    check(
      "failed history save rolls back eviction of previously cached conversations",
      JSON.stringify(failedSaveHistory) === JSON.stringify(
        Array.from({ length: 8 }, (_, i) => `kept-${i}`),
      ),
      JSON.stringify(failedSaveHistory),
    );
  } finally {
    await migrationContext.close();
  }
  const retryPosts = [];
  const observeRetry = (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/prompt"
    )
      retryPosts.push(request.url());
  };
  page.on("request", observeRetry);
  // A real session in this daemon's root: the receipt endpoint resolves the
  // scope before the ID, so a path outside the root is refused as invalid
  // instead of answering "no receipt".
  const unknownReceipt = await page.evaluate(async (fixturePath) => {
    const queue = await import("/src/runtime/offline-queue.ts");
    const rpc = await import("/src/runtime/rpc-client.ts");
    const namespace = queue.offlineQueueNamespaceForCredential(
      localStorage.getItem("omp-remote-token"),
    );
    const entry = await queue.enqueue({
      sessionPath: fixturePath,
      text: "Never replay after the server has lost its receipt",
      commandId: crypto.randomUUID(),
      namespace,
    });
    await queue.update(entry.commandId, { state: "uncertain" }, namespace);
    // A missing receipt is reported as an error that says nothing was resent;
    // it never comes back as a fresh send.
    let outcome;
    try {
      outcome = { state: (await rpc.sendPromptDurably(entry.sessionPath, entry.text, [], { commandId: entry.commandId })).state };
    } catch (error) {
      outcome = { error: String(error?.message ?? error) };
    }
    const persisted = await queue.getQueued(entry.commandId, namespace);
    await queue.removeAsync(entry.commandId, namespace);
    return { ...outcome, persistedState: persisted?.state };
  }, sessionPath);
  page.off("request", observeRetry);
  check(
    "missing receipt stays uncertain without redispatch",
    /no receipt/i.test(unknownReceipt.error ?? "") &&
      unknownReceipt.persistedState === "uncertain" &&
      retryPosts.length === 0,
    JSON.stringify({ ...unknownReceipt, posts: retryPosts.length }),
  );
  const namespaceResult = await page.evaluate(async () => {
    const queue = await import(
      `/src/runtime/offline-queue.ts?namespace=${Date.now()}`
    );
    const cache = await import(
      `/src/runtime/offline-cache.ts?namespace=${Date.now()}`
    );
    const draft = await import(
      `/src/app/composer/use-draft.ts?namespace=${Date.now()}`
    );
    const storage = await import(
      `/src/platform/browser-storage.ts?namespace=${Date.now()}`
    );
    const sessionPath = "/tmp/credential-transition";
    const oldCredential = `transition-old-${crypto.randomUUID()}`;
    const newCredential = `transition-new-${crypto.randomUUID()}`;
    const oldNamespace =
      queue.offlineQueueNamespaceForCredential(oldCredential);
    const newNamespace =
      queue.offlineQueueNamespaceForCredential(newCredential);
    const oldText = `old-pending-${crypto.randomUUID()}`;
    const oldImage = `old-image-${crypto.randomUUID()}`;
    const oldDraft = `old-draft-${crypto.randomUUID()}`;
    const oldCached = `old-cache-${crypto.randomUUID()}`;
    storage.writePairingToken(oldCredential);
    queue.setOfflineQueueNamespace(oldNamespace);
    cache.setOfflineCacheNamespace(oldNamespace);
    await queue.clearAsync(undefined, oldNamespace);
    await queue.clearAllDraftAttachments(oldNamespace);
    await cache.clearAllCachedHistory(oldNamespace);
    draft.clearAllDrafts(oldNamespace);
    const oldEntry = await queue.enqueue({
      sessionPath,
      text: oldText,
      commandId: `old-command-${crypto.randomUUID()}`,
      images: [{ data: oldImage, mimeType: "image/png" }],
      namespace: oldNamespace,
    });
    draft.seedDraft(sessionPath, oldDraft, oldNamespace);
    await queue.saveDraftAttachments(
      sessionPath,
      [
        {
          data: oldImage,
          mimeType: "image/png",
          previewUrl: "data:image/png;base64,old",
          name: "old.png",
          width: 1,
          height: 1,
        },
      ],
      oldNamespace,
    );
    await cache.saveTail(
      sessionPath,
      [
        {
          id: "old-cache-message",
          role: "user",
          text: oldCached,
          parts: [{ kind: "text", text: oldCached }],
        },
      ],
      oldNamespace,
    );
    const oldPersisted = {
      commandSaved:
        (await queue.getQueued(oldEntry.commandId, oldNamespace))?.state ===
        "saved",
      commandImageRetained:
        (await queue.getImages(oldEntry.commandId, oldNamespace))[0]?.data ===
        oldImage,
      draftRetained: draft.readDraft(sessionPath, oldNamespace) === oldDraft,
      attachmentRetained:
        (await queue.loadDraftAttachments(sessionPath, oldNamespace)).length ===
        1,
      cacheRetained:
        (await cache.loadTail(sessionPath, oldNamespace))?.messages.some(
          (message) => message.text === oldCached,
        ) === true,
    };
    storage.writePairingToken(newCredential);
    queue.setOfflineQueueNamespace(newNamespace);
    cache.setOfflineCacheNamespace(newNamespace);
    const sent = [];
    await queue.flush(
      (entry) => {
        sent.push(entry.commandId);
        return Promise.resolve({
          commandId: entry.commandId,
          sessionPath: entry.sessionPath,
          state: "completed",
          createdAt: entry.createdAt,
          updatedAt: Date.now(),
        });
      },
      { isTransient: () => false, namespace: newNamespace },
    );
    const currentDraftNamespace = draft.getDraftNamespace();
    const currentImages = await queue.getImages(
      oldEntry.commandId,
      newNamespace,
    );
    const currentAttachments = await queue.loadDraftAttachments(
      sessionPath,
      newNamespace,
    );
    const currentCache = await cache.loadTail(sessionPath, newNamespace);
    const currentCommand = await queue.getQueued(
      oldEntry.commandId,
      newNamespace,
    );
    const currentPending = queue.pendingAll(newNamespace);
    await queue.clearAsync(undefined, oldNamespace);
    await queue.clearAllDraftAttachments(oldNamespace);
    await cache.clearAllCachedHistory(oldNamespace);
    draft.clearAllDrafts(oldNamespace);
    return {
      namespacesDiffer: oldNamespace !== newNamespace,
      oldPersisted,
      current: {
        draftNamespaceMatches: currentDraftNamespace === newNamespace,
        pendingCount: currentPending.length,
        pendingTextLeak: currentPending.some((entry) => entry.text === oldText),
        snapshotTextLeak: queue
          .getSnapshot()
          .some((entry) => entry.text === oldText),
        commandVisible: currentCommand !== null,
        imageCount: currentImages.length,
        draftVisible:
          draft.readDraft(sessionPath, currentDraftNamespace) !== "",
        attachmentCount: currentAttachments.length,
        cacheVisible: currentCache !== null,
        sentCount: sent.length,
      },
    };
  });
  check(
    "pairing a different credential hides old pending text/images and never replays them",
    namespaceResult.namespacesDiffer &&
      namespaceResult.oldPersisted.commandSaved &&
      namespaceResult.oldPersisted.commandImageRetained &&
      namespaceResult.current.draftNamespaceMatches &&
      namespaceResult.current.pendingCount === 0 &&
      !namespaceResult.current.pendingTextLeak &&
      !namespaceResult.current.snapshotTextLeak &&
      !namespaceResult.current.commandVisible &&
      namespaceResult.current.imageCount === 0 &&
      namespaceResult.current.sentCount === 0,
    JSON.stringify(namespaceResult),
  );
  check(
    "pairing a different credential isolates draft attachments and cached history",
    namespaceResult.oldPersisted.draftRetained &&
      namespaceResult.oldPersisted.attachmentRetained &&
      namespaceResult.oldPersisted.cacheRetained &&
      !namespaceResult.current.draftVisible &&
      namespaceResult.current.attachmentCount === 0 &&
      !namespaceResult.current.cacheVisible,
    JSON.stringify(namespaceResult),
  );
  const capacityResult = await page.evaluate(async () => {
    const queue = await import(
      `/src/runtime/offline-queue.ts?capacity=${Date.now()}`
    );
    await queue.clearAsync();
    const image = "x".repeat(512 * 1024);
    let error = null;
    let accepted = 0;
    for (let i = 0; i < 128; i++) {
      try {
        await queue.enqueue({
          sessionPath: "/tmp/capacity",
          text: `capacity-${i}`,
          commandId: `capacity-${i}`,
          images: [{ data: image, mimeType: "image/png" }],
        });
        accepted++;
      } catch (caught) {
        error = {
          name: caught?.name,
          message: String(caught?.message ?? caught),
        };
        break;
      }
    }
    const retained = await queue.pendingAll();
    await queue.clearAsync();
    return { accepted, error, retained: retained.length };
  });
  check(
    "full offline storage refuses new work without evicting saved drafts",
    capacityResult.error !== null &&
      capacityResult.retained === capacityResult.accepted &&
      capacityResult.retained > 0,
    JSON.stringify(capacityResult),
  );
  const storageFailureResult = await page.evaluate(async () => {
    const draft = await import(
      `/src/app/composer/use-draft.ts?storage-failure=${Date.now()}`
    );
    const storage = await import(
      `/src/platform/browser-storage.ts?storage-failure=${Date.now()}`
    );
    const seededQueue = await import(
      `/src/runtime/offline-queue.ts?storage-failure-seed=${Date.now()}`
    );
    const credential = `transition-storage-${crypto.randomUUID()}`;
    const namespace =
      seededQueue.offlineQueueNamespaceForCredential(credential);
    const sessionPath = "/tmp/storage-failure";
    const commandId = `storage-command-${crypto.randomUUID()}`;
    const intent = `unsent-intent-${crypto.randomUUID()}`;
    const previousToken = localStorage.getItem("omp-remote-token");
    storage.writePairingToken(credential);
    draft.seedDraft(sessionPath, intent, namespace);
    await seededQueue.saveDraftAttachments(
      sessionPath,
      [
        {
          data: "intent-image",
          mimeType: "image/png",
          previewUrl: "data:image/png;base64,intent",
          name: "intent.png",
          width: 1,
          height: 1,
        },
      ],
      namespace,
    );
    const originalIndexedDB = Object.getOwnPropertyDescriptor(
      globalThis,
      "indexedDB",
    );
    const originalSetItem = Storage.prototype.setItem;
    let queue;
    let writeSaved = false;
    let writeError = null;
    let missing = null;
    let pendingCount = -1;
    let overrideInstalled = false;
    try {
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value: undefined,
      });
      overrideInstalled = true;
      Storage.prototype.setItem = function () {
        throw new Error("forced offline storage write failure");
      };
      queue = await import(
        `/src/runtime/offline-queue.ts?storage-failure=${Date.now()}`
      );
      queue.setOfflineQueueNamespace(namespace);
      try {
        await queue.enqueue({
          sessionPath,
          text: intent,
          commandId,
          namespace,
        });
        writeSaved = true;
      } catch (caught) {
        writeError = {
          name: caught?.name,
          message: String(caught?.message ?? caught),
        };
      }
      missing = await queue.getQueued(commandId, namespace);
      pendingCount = queue.pendingAll(namespace).length;
    } catch (caught) {
      writeError = {
        name: caught?.name,
        message: String(caught?.message ?? caught),
      };
    } finally {
      Storage.prototype.setItem = originalSetItem;
      if (originalIndexedDB)
        Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
      else delete globalThis.indexedDB;
      if (previousToken === null) storage.clearPairingToken();
      else storage.writePairingToken(previousToken);
    }
    const retainedIntent = draft.readDraft(sessionPath, namespace) === intent;
    const retainedImages =
      (await seededQueue.loadDraftAttachments(sessionPath, namespace))
        .length === 1;
    await seededQueue.clearDraftAttachments(sessionPath, namespace);
    draft.clearAllDrafts(namespace);
    return {
      overrideInstalled,
      writeSaved,
      writeError,
      queued: missing !== null,
      pendingCount,
      retainedIntent,
      retainedImages,
    };
  });
  check(
    "offline outbox write failure throws and keeps user intent",
    storageFailureResult.overrideInstalled &&
      !storageFailureResult.writeSaved &&
      storageFailureResult.writeError?.name === "QueueStorageError" &&
      !storageFailureResult.queued &&
      storageFailureResult.pendingCount === 0 &&
      storageFailureResult.retainedIntent &&
      storageFailureResult.retainedImages,
    JSON.stringify(storageFailureResult),
  );
  // Exercise actual daemon fingerprints across a shrinking file. Synthetic
  // rows with an unchanged revision cannot represent a newly visible reply.
  const unreadPath = `${SESSIONS}/-tmp-reliability-transitions/unread-${randomUUID()}.jsonl`;
  const header = { type: "session", id: randomUUID(), cwd, title: "Unread compaction" };
  const entry = (id, text) => ({ type: "message", id, timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] } });
  const retained = entry("reply-before", "Retained answer");
  const replace = entries => writeFileSync(unreadPath, [header, ...entries].map(e => JSON.stringify(e)).join("\n") + "\n");
  const rowAfter = async predicate => {
    for (let n = 0; n < 100; n++) {
      const rows = (await api("/api/sessions")).json.sessions ?? [];
      const row = rows.find(r => r.path === unreadPath);
      if (row && predicate(row)) return row;
      await sleep(100);
    }
    throw new Error("Unread fixture listing did not converge");
  };
  replace([entry("older", "Earlier content ".repeat(1000)), retained]);
  const beforeCompact = await rowAfter(row => typeof row.revision === "string");
  replace([retained]);
  const compacted = await rowAfter(row => row.size < beforeCompact.size);
  replace([retained, entry("reply-after", "New answer")]);
  const afterReply = await rowAfter(row => row.revision !== compacted.revision);
  const unreadResult = await page.evaluate(async ({ beforeCompact, compacted, afterReply }) => {
    const truth = await import(`/src/app/session-format.ts?unread=${Date.now()}`);
    truth.markSeen(beforeCompact.path, beforeCompact.revision);
    return { compactedUnread: truth.hasUnread(compacted), replyUnread: truth.hasUnread(afterReply) };
  }, { beforeCompact, compacted, afterReply });
  check(
    "compaction preserves read identity while a new reply becomes unread",
    unreadResult.compactedUnread === false && unreadResult.replyUnread === true,
    JSON.stringify(unreadResult),
  );
} finally {
  await browser?.close();
  vite.kill("SIGTERM");
  rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
}

console.log(
  `\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`,
);
process.exit(failures === 0 ? 0 : 1);
