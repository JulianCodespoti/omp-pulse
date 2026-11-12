#!/usr/bin/env node
// Real Chromium locks and IndexedDB transactions; no daemon or model calls.
// node e2e/browser/verify-outbox-storage.mjs
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "../../web/node_modules/vite/dist/node/index.js";
import { loadPuppeteer, chromium } from "../lib/env.mjs";

const puppeteer = await loadPuppeteer();

const server = await createServer({
  root: fileURLToPath(new URL("../../web/", import.meta.url)),
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0 },
});
let browser;
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await puppeteer.launch({
    executablePath: chromium(),
    headless: true,
    args: ["--no-sandbox"],
  });
  async function scenario(name, run) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const peer = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      // A module response is inert as a document: no app, pairing or API calls.
      await Promise.all([page, peer].map((p) => p.goto(`${base}/src/runtime/offline-queue.ts`)));
      await run(page, peer);
      assert.deepEqual(errors, [], "no unhandled background hydration errors");
      console.log(`PASS ${name}`);
    } finally {
      await context.close();
    }
  }
  const load = (page) => page.evaluate(async () => {
    window.queue = await import("/src/runtime/offline-queue.ts");
  });
  const attempt = (page, id) => page.evaluate(async (commandId) => {
    try {
      await window.queue.enqueue({ commandId, sessionPath: "/isolated", text: commandId });
      return "saved";
    } catch (error) {
      return error.code;
    }
  }, id);
  const rawCommands = (page) => page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("omp-pulse-outbox", 5);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction("commands-v3").objectStore("commands-v3").getAll();
        request.onsuccess = () => resolve(request.result.map((record) => record.commandId).sort());
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  });

  await scenario("blocked upgrade rejects, late open cannot save, same-document retry persists once", async (page, peer) => {
    await peer.evaluate(async () => {
      window.oldDb = await new Promise((resolve, reject) => {
        const request = indexedDB.open("omp-pulse-outbox", 2);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    });
    await load(page);
    assert.equal(await attempt(page, "blocked"), "offline_outbox_unavailable");
    assert.equal(await page.evaluate(() => localStorage.getItem("omp-pulse-queue-v3:anonymous")), null,
      "a failed open must not split the outbox into fallback storage");
    await peer.evaluate(() => window.oldDb.close());
    assert.equal(await attempt(page, "retry"), "saved");
    assert.deepEqual(await rawCommands(page), ["retry"]);
  });

  await scenario("cross-document and local lock waiters cancel without late saves", async (page, peer) => {
    await load(page);
    assert.equal(await attempt(page, "seed"), "saved");
    await peer.evaluate(() => new Promise((resolve) => {
      void navigator.locks.request("omp-pulse-outbox:anonymous", () => {
        resolve();
        return new Promise((release) => { window.releaseLock = release; });
      });
    }));
    const started = Date.now();
    const outcomes = await Promise.all([attempt(page, "blocked-a"), attempt(page, "blocked-b")]);
    assert.deepEqual(outcomes, ["offline_outbox_unavailable", "offline_outbox_unavailable"]);
    assert.ok(Date.now() - started < 15_000, "acquisition must settle within its deadline");
    await peer.evaluate(() => window.releaseLock());
    assert.equal(await attempt(page, "retry"), "saved");
    assert.deepEqual(await rawCommands(page), ["retry", "seed"]);
    assert.deepEqual(await page.evaluate(async () => (await navigator.locks.query()).pending), []);
  });

  await scenario("blocked attachment write aborts and retries without losing prior photos", async (page, peer) => {
    await load(page);
    await page.evaluate(async () => {
      window.photo = { data: "aGVsbG8=", mimeType: "image/png", previewUrl: "data:image/png;base64,aGVsbG8=", name: "kept.png", width: 1, height: 1 };
      await window.queue.saveDraftAttachments("/kept", [window.photo]);
    });
    await peer.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("omp-pulse-outbox", 5);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve) => {
        const tx = db.transaction("draft-attachments-v3", "readwrite");
        let keepAlive = true;
        window.releaseTransaction = () => { keepAlive = false; };
        tx.oncomplete = () => db.close();
        const pump = () => {
          const request = tx.objectStore("draft-attachments-v3").get("keep-alive");
          request.onsuccess = () => { resolve(); if (keepAlive) pump(); };
        };
        pump();
      });
    });
    const outcome = await page.evaluate(async () => {
      try { await window.queue.saveDraftAttachments("/blocked", [window.photo]); return "saved"; }
      catch (error) { return error.code; }
    });
    assert.equal(outcome, "offline_outbox_unavailable");
    await peer.evaluate(() => window.releaseTransaction());
    assert.deepEqual(await page.evaluate(() => window.queue.loadDraftAttachments("/blocked")), []);
    assert.deepEqual(await page.evaluate(() => window.queue.loadDraftAttachments("/kept")),
      await page.evaluate(() => [window.photo]));
    await page.evaluate(() => window.queue.saveDraftAttachments("/blocked", [window.photo]));
    assert.deepEqual(await page.evaluate(() => window.queue.loadDraftAttachments("/blocked")),
      await page.evaluate(() => [window.photo]));
  });

  await scenario("timed-out active transaction rolls back its writes before reporting failure", async (page) => {
    await load(page);
    const result = await page.evaluate(async () => {
      const original = { data: "b2xk", mimeType: "image/png", previewUrl: "data:image/png;base64,b2xk", name: "old.png", width: 1, height: 1 };
      await window.queue.saveDraftAttachments("/rollback", [original]);
      const put = IDBObjectStore.prototype.put;
      // Keep a real write transaction alive AFTER its put succeeds. The deadline
      // must abort the transaction, not merely stop awaiting its result.
      IDBObjectStore.prototype.put = function (...args) {
        const request = put.apply(this, args);
        if (this.name === "draft-attachments-v3") {
          const store = this;
          const pump = () => { store.get("keep-alive").onsuccess = pump; };
          request.addEventListener("success", pump);
        }
        return request;
      };
      let errorCode;
      try { await window.queue.saveDraftAttachments("/rollback", [{ ...original, data: "bmV3" }]); }
      catch (error) { errorCode = error.code; }
      finally { IDBObjectStore.prototype.put = put; }
      const after = await window.queue.loadDraftAttachments("/rollback");
      await window.queue.saveDraftAttachments("/retry", [original]);
      return { errorCode, after, retry: await window.queue.loadDraftAttachments("/retry"), original };
    });
    assert.equal(result.errorCode, "offline_outbox_unavailable");
    assert.deepEqual(result.after, [result.original]);
    assert.deepEqual(result.retry, [result.original]);
  });

  await scenario("versionchange invalidates the cached closed handle for later saves", async (page, peer) => {
    await load(page);
    assert.equal(await attempt(page, "seed"), "saved");
    await peer.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("omp-pulse-outbox");
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    }));
    assert.equal(await attempt(page, "after-storage-clear"), "saved");
    assert.deepEqual(await rawCommands(page), ["after-storage-clear"]);
  });
  console.log("All 5 storage recovery scenarios passed");
} finally {
  await browser?.close();
  await server.close();
}
