import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// Exercise the actual session owner, replacing only its persistence boundary.
// The fake implements conditional writes and controllable in-flight operations;
// no IndexedDB, native bridge, daemon, browser, network or model is involved.
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(resolve(tmpdir(), "pulse-attachment-owner-"));
after(() => rm(directory, { recursive: true, force: true }));
const storageSource = `
  const key = (path, namespace) => JSON.stringify([namespace, path]);
  const copy = images => images.map(image => ({ ...image }));
  export const storage = {
    rows: new Map(), loads: [], saves: [], clears: [], events: [],
    flushers: new Set(), unregistered: 0,
    beforeLoad: null, beforeSave: null, beforeClear: null,
    read(path, namespace) { return copy(this.rows.get(key(path, namespace)) ?? []); },
    seed(path, namespace, images) { this.rows.set(key(path, namespace), copy(images)); },
    async flush() { await Promise.all([...this.flushers].map(flush => flush())); },
  };
  export function sameDraftAttachments(a, b) {
    return !!a && !!b && a.length === b.length && a.every((image, index) =>
      image.data === b[index].data && image.mimeType === b[index].mimeType);
  }
  export async function loadDraftAttachments(path, namespace) {
    const call = { path, namespace, images: storage.read(path, namespace) };
    storage.loads.push(call);
    await storage.beforeLoad?.(call);
    return call.images;
  }
  export async function saveDraftAttachments(path, images, namespace, expected) {
    const call = { path, namespace, images: copy(images),
      expected: expected === undefined ? undefined : copy(expected) };
    storage.saves.push(call);
    await storage.beforeSave?.(call);
    if (expected !== undefined && !sameDraftAttachments(storage.read(path, namespace), expected)) {
      storage.events.push("conflict");
      return false;
    }
    storage.seed(path, namespace, images);
    storage.events.push("save");
    return true;
  }
  export async function clearAllDraftAttachments(namespace) {
    storage.clears.push(namespace);
    await storage.beforeClear?.(namespace);
    for (const storedKey of storage.rows.keys()) {
      if (JSON.parse(storedKey)[0] === namespace) storage.rows.delete(storedKey);
    }
    storage.events.push("clear");
  }
  export function registerDraftAttachmentFlusher(flush) {
    storage.flushers.add(flush);
    return () => { if (storage.flushers.delete(flush)) storage.unregistered++; };
  }
  let recoverySequence = 0;
  export const makeCommandId = () => "synthetic-recovery-" + ++recoverySequence;
`;
const bundle = await rolldown({
  input: "attachment-owner-test", platform: "node",
  plugins: [{
    name: "hermetic-attachment-owner",
    resolveId(id) {
      if (id === "attachment-owner-test") return "\0attachment-owner-test";
      if (id === "./offline-queue" || id === "attachment-test-storage") return "\0attachment-test-storage";
      return null;
    },
    load(id) {
      if (id === "\0attachment-test-storage") return storageSource;
      if (id === "\0attachment-owner-test") return `
        export { getAttachmentDraft, clearAttachmentDrafts } from ${JSON.stringify(resolve(root, "web/src/runtime/attachment-draft.ts"))};
        export { storage } from "attachment-test-storage";
      `;
      return null;
    },
  }],
});
const bundlePath = resolve(directory, "attachment-owner.mjs");
try { await bundle.write({ file: bundlePath, format: "esm" }); }
finally { await bundle.close(); }

const path = "/synthetic/session.jsonl";
const namespace = "synthetic-credential";
const image = (id) => ({
  data: `payload:${id}`, mimeType: "image/png", previewUrl: `blob:synthetic-${id}`,
  name: `${id}.png`, width: 1, height: 1,
});
const names = (images) => images.map(({ name }) => name);
const files = (...ids) => ids.map(id => new File([id], `${id}.png`, { type: "image/png" }));
const decoded = (...ids) => ({ images: ids.map(image) });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
let fixtureId = 0;
async function fixture(t) {
  // Each import gets its own owner registry and fake persistence state.
  const api = await import(`${pathToFileURL(bundlePath).href}?fixture=${++fixtureId}`);
  const revoked = [];
  t.mock.method(URL, "revokeObjectURL", url => revoked.push(url));
  const open = (sessionPath = path, scope = namespace) => {
    const owner = api.getAttachmentDraft(scope, sessionPath);
    const unsubscribe = owner.subscribe(() => {});
    t.after(unsubscribe);
    return { owner, unsubscribe };
  };
  return { ...api, open, revoked };
}
const ownerTest = (name, run) => test(name, { timeout: 3000 }, run);

ownerTest("delayed restore and intake retain one owner across a detach and reattach", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("restored")]);
  const restore = deferred();
  f.storage.beforeLoad = () => restore.promise;
  const first = f.open();
  const counts = [];
  const intake = first.owner.addFiles(files("selected"), async (_, count) => {
    counts.push(count);
    return decoded("selected");
  }, 4);
  first.unsubscribe();
  await turn();
  const second = f.open();
  assert.equal(second.owner, first.owner);
  assert.equal(second.owner.getSnapshot().loading, true);
  assert.equal(second.owner.getSnapshot().pending, 1);
  assert.equal(second.owner.beginSend(() => true), null);
  assert.deepEqual(counts, []);
  restore.resolve();
  await intake;
  assert.deepEqual(counts, [1]);
  assert.deepEqual(names(second.owner.getSnapshot().images), ["restored.png", "selected.png"]);
  assert.deepEqual(names(f.storage.read(path, namespace)), ["restored.png", "selected.png"]);
  assert.equal(f.storage.loads.length, 1);
  assert.equal(second.owner.getSnapshot().pending, 0);
});

ownerTest("clear fences a delayed restore and a selection waiting for that restore", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("old")]);
  const restore = deferred();
  f.storage.beforeLoad = () => restore.promise;
  const { owner } = f.open();
  let decodeCalls = 0;
  const intake = owner.addFiles(files("old-selection"), async () => {
    decodeCalls++;
    return decoded("old-selection");
  }, 4);
  await turn();
  await f.clearAttachmentDrafts(namespace);
  restore.resolve();
  await intake;
  await turn();
  assert.equal(decodeCalls, 0);
  assert.deepEqual(owner.getSnapshot().images, []);
  assert.equal(owner.getSnapshot().loading, false);
  assert.equal(owner.getSnapshot().pending, 0);
  assert.deepEqual(f.storage.read(path, namespace), []);
  assert.equal(f.storage.saves.length, 0);
});

ownerTest("same-turn clear fences constructor restore before its first microtask", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("old")]);
  const deletion = deferred(), started = deferred();
  f.storage.beforeClear = () => { started.resolve(); return deletion.promise; };
  const { owner } = f.open();
  const states = [];
  t.after(owner.subscribe(() => states.push(owner.getSnapshot())));
  // Deliberately do not yield between owner creation and reset: its initial
  // restore callback has been scheduled but has not had a chance to begin.
  const clearing = f.clearAttachmentDrafts(namespace);
  await started.promise;
  await turn();
  assert.deepEqual(names(f.storage.read(path, namespace)), ["old.png"], "database deletion is still held");
  assert.equal(owner.getSnapshot().loading, true);
  assert.deepEqual(owner.getSnapshot().images, []);
  assert.equal(owner.beginSend(() => true), null);
  assert.ok(states.every(snapshot => snapshot.loading && snapshot.images.length === 0));
  deletion.resolve();
  await clearing;
  await turn();
  assert.equal(owner.getSnapshot().loading, false);
  assert.deepEqual(owner.getSnapshot().images, []);
  assert.deepEqual(f.storage.read(path, namespace), []);
  assert.ok(states.every(snapshot => snapshot.images.length === 0), "old images must never be published");
});

ownerTest("new selection after clear does not wait for old decode or accept its late images", async t => {
  const f = await fixture(t);
  const { owner } = f.open();
  await turn();
  const oldDecode = deferred();
  const oldStarted = deferred();
  const oldIntake = owner.addFiles(files("old"), () => {
    oldStarted.resolve();
    return oldDecode.promise;
  }, 4);
  await oldStarted.promise;
  await f.clearAttachmentDrafts(namespace);
  let newStarted = false;
  const newIntake = owner.addFiles(files("new"), async () => {
    newStarted = true;
    return decoded("new");
  }, 4);
  await turn();
  assert.equal(newStarted, true, "a stale decode must not hold the new generation's intake queue");
  await newIntake;
  assert.deepEqual(names(owner.getSnapshot().images), ["new.png"]);
  oldDecode.resolve(decoded("old"));
  await oldIntake;
  assert.deepEqual(names(owner.getSnapshot().images), ["new.png"]);
  assert.deepEqual(names(f.storage.read(path, namespace)), ["new.png"]);
  assert.equal(owner.getSnapshot().pending, 0);
  assert.ok(f.revoked.includes("blob:synthetic-old"));
});

ownerTest("clear waits for running writes and suppresses queued old-generation saves", async t => {
  const f = await fixture(t);
  const { owner } = f.open();
  await turn();
  const write = deferred();
  const started = deferred();
  f.storage.beforeSave = () => { started.resolve(); return write.promise; };
  const intake = owner.addFiles(files("old"), async () => decoded("old"), 4);
  await started.promise;
  owner.removeImage(0); // Queue a second persistence operation behind the held write.
  const clearing = f.clearAttachmentDrafts(namespace);
  await turn();
  assert.equal(f.storage.clears.length, 0);
  assert.equal(f.storage.saves.length, 1);
  assert.deepEqual(owner.getSnapshot().images, []);
  write.resolve();
  await Promise.all([intake, clearing]);
  assert.equal(f.storage.saves.length, 1, "queued writes from the old generation must not run");
  assert.deepEqual(f.storage.events, ["save", "clear"]);
  assert.deepEqual(f.storage.read(path, namespace), []);
  assert.equal(owner.getSnapshot().pending, 0);
});

ownerTest("a removal write failing after clear cannot publish an old-generation error", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("remove")]);
  const { owner } = f.open();
  await turn();
  const write = deferred(), started = deferred();
  f.storage.beforeSave = () => { started.resolve(); return write.promise; };
  owner.removeImage(0);
  await started.promise;
  const clearing = f.clearAttachmentDrafts(namespace);
  write.reject(new Error("stale removal write failed"));
  await clearing;
  await turn();
  assert.deepEqual(f.storage.read(path, namespace), []);
  assert.deepEqual(owner.getSnapshot().images, []);
  assert.equal(owner.getSnapshot().error, null);
});

ownerTest("an owner created during namespace clear waits for the barrier before restoring", async t => {
  const f = await fixture(t);
  const otherPath = "/synthetic/other-session.jsonl";
  f.storage.seed(otherPath, namespace, [image("old-other")]);
  const { owner } = f.open();
  await turn();
  const write = deferred(), started = deferred();
  f.storage.beforeSave = () => { started.resolve(); return write.promise; };
  const intake = owner.addFiles(files("old"), async () => decoded("old"), 4);
  await started.promise;
  const clearing = f.clearAttachmentDrafts(namespace);
  const other = f.open(otherPath);
  await turn();
  assert.equal(other.owner.getSnapshot().loading, true);
  assert.deepEqual(other.owner.getSnapshot().images, []);
  assert.equal(other.owner.beginSend(() => true), null);
  write.resolve();
  await Promise.all([intake, clearing]);
  await turn();
  assert.equal(other.owner.getSnapshot().loading, false);
  assert.deepEqual(other.owner.getSnapshot().images, []);
  assert.deepEqual(f.storage.read(otherPath, namespace), []);
});

ownerTest("credential-scoped clear leaves another owner's pending work independent", async t => {
  const f = await fixture(t);
  const first = f.open();
  const other = f.open(path, "other-credential");
  await turn();
  const decoding = deferred();
  const started = deferred();
  const intake = other.owner.addFiles(files("other"), () => {
    started.resolve();
    return decoding.promise;
  }, 4);
  await started.promise;
  await f.clearAttachmentDrafts(namespace);
  assert.equal(other.owner.getSnapshot().pending, 1);
  decoding.resolve(decoded("other"));
  await intake;
  assert.deepEqual(first.owner.getSnapshot().images, []);
  assert.deepEqual(names(other.owner.getSnapshot().images), ["other.png"]);
  assert.deepEqual(names(f.storage.read(path, "other-credential")), ["other.png"]);
});

ownerTest("registered flush drains hidden intake including a second selection arriving mid-flush", async t => {
  const f = await fixture(t);
  const { owner, unsubscribe } = f.open();
  await turn();
  const firstDecode = deferred(), secondDecode = deferred();
  const firstStarted = deferred(), secondStarted = deferred();
  const first = owner.addFiles(files("first"), () => {
    firstStarted.resolve();
    return firstDecode.promise;
  }, 4);
  await firstStarted.promise;
  unsubscribe();
  await turn();
  assert.equal(f.storage.flushers.size, 1, "offscreen pending intake must retain its flusher");
  let flushed = false;
  const flushing = f.storage.flush().then(() => { flushed = true; });
  const second = owner.addFiles(files("second"), () => {
    secondStarted.resolve();
    return secondDecode.promise;
  }, 4);
  firstDecode.resolve(decoded("first"));
  await secondStarted.promise;
  assert.equal(flushed, false);
  secondDecode.resolve(decoded("second"));
  await Promise.all([first, second, flushing]);
  assert.deepEqual(names(f.storage.read(path, namespace)), ["first.png", "second.png"]);
  assert.equal(f.storage.flushers.size, 0, "durable offscreen work must release its owner");
  const reopened = f.open();
  assert.notEqual(reopened.owner, owner);
  await turn();
  assert.deepEqual(names(reopened.owner.getSnapshot().images), ["first.png", "second.png"]);
});

ownerTest("serial selections apply the cap to the current tray after an in-flight removal", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("remove"), image("keep")]);
  const { owner } = f.open();
  await turn();
  const firstDecode = deferred();
  const counts = [];
  const first = owner.addFiles(files("first", "second"), (_, count) => {
    counts.push(count);
    return firstDecode.promise;
  }, 3);
  const second = owner.addFiles(files("overflow"), async (_, count) => {
    counts.push(count);
    return decoded("overflow");
  }, 3);
  await turn();
  assert.deepEqual(counts, [2], "later selection must not overtake the earlier decode");
  owner.removeImage(0);
  firstDecode.resolve(decoded("first", "second"));
  await Promise.all([first, second]);
  assert.deepEqual(counts, [2, 3]);
  assert.deepEqual(names(owner.getSnapshot().images), ["keep.png", "first.png", "second.png"]);
  assert.deepEqual(names(f.storage.read(path, namespace)), ["keep.png", "first.png", "second.png"]);
  assert.ok(f.revoked.includes("blob:synthetic-remove"));
  assert.ok(f.revoked.includes("blob:synthetic-overflow"));
  assert.equal(owner.getSnapshot().pending, 0);
});

ownerTest("a queued save uses the latest removal rather than replaying an older tray", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("a"), image("b"), image("c")]);
  const { owner } = f.open();
  await turn();
  const write = deferred(), started = deferred();
  f.storage.beforeSave = () => { started.resolve(); return write.promise; };
  owner.removeImage(0);
  await started.promise;
  owner.removeImage(0);
  owner.removeImage(0);
  write.resolve();
  await owner.flush();
  assert.deepEqual(f.storage.saves.map(call => names(call.images)), [["b.png", "c.png"], []]);
  assert.deepEqual(owner.getSnapshot().images, []);
  assert.deepEqual(f.storage.read(path, namespace), []);
});

ownerTest("one send lease survives remount, rejects duplicates and commits only once", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("submitted")]);
  const first = f.open();
  await turn();
  let cleanupCalls = 0;
  const lease = first.owner.beginSend(() => { cleanupCalls++; return true; });
  assert.ok(lease);
  assert.deepEqual(names(lease.images), ["submitted.png"]);
  first.unsubscribe();
  await turn();
  const second = f.open();
  assert.equal(first.owner, second.owner);
  assert.equal(second.owner.getSnapshot().sending, true);
  assert.equal(second.owner.beginSend(() => true), null);
  const committed = lease.commit();
  assert.equal(lease.commit(), committed);
  assert.equal(await committed, true);
  assert.equal(await lease.commit(), true);
  assert.equal(cleanupCalls, 1);
  assert.equal(f.storage.saves.length, 1);
  assert.deepEqual(second.owner.getSnapshot().images, []);
  assert.equal(second.owner.getSnapshot().sending, false);
  assert.equal(second.owner.retryCleanup(), null);
  assert.equal(f.revoked.filter(url => url === "blob:synthetic-submitted").length, 1);
});

for (const outcome of ["commit", "fail"]) {
  ownerTest(`hidden-owner flush waits for an unacknowledged send lease to ${outcome}`, async t => {
    const f = await fixture(t);
    f.storage.seed(path, namespace, [image("submitted")]);
    const { owner, unsubscribe } = f.open();
    await turn();
    let cleanupCalls = 0;
    const lease = owner.beginSend(() => { cleanupCalls++; return true; });
    assert.ok(lease);
    unsubscribe();
    await turn();
    let flushed = false;
    const flushing = f.storage.flush().then(() => { flushed = true; });
    await turn();
    assert.equal(flushed, false, "explicit-update flushing must not race an unresolved enqueue");
    assert.equal(f.storage.saves.length, 0);
    if (outcome === "commit") {
      const write = deferred(), started = deferred();
      f.storage.beforeSave = () => { started.resolve(); return write.promise; };
      const committed = lease.commit();
      await started.promise;
      await turn();
      assert.equal(flushed, false, "acknowledged cleanup must also finish before reload is safe");
      write.resolve();
      assert.equal(await committed, true);
    } else {
      lease.fail("synthetic enqueue rejection");
    }
    await flushing;
    assert.equal(flushed, true);
    assert.deepEqual(names(f.storage.read(path, namespace)), outcome === "commit" ? [] : ["submitted.png"]);
    assert.equal(cleanupCalls, outcome === "commit" ? 1 : 0);
    assert.equal(f.storage.flushers.size, 0);
  });
}

ownerTest("pre-ack failure preserves current edits without restoring a removed submitted image", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("submitted")]);
  const { owner } = f.open();
  await turn();
  let cleanupCalls = 0;
  const lease = owner.beginSend(() => { cleanupCalls++; return true; });
  owner.removeImage(0);
  await owner.addFiles(files("new"), async () => decoded("new"), 4);
  lease.fail("enqueue failed");
  assert.deepEqual(names(owner.getSnapshot().images), ["new.png"]);
  assert.deepEqual(names(f.storage.read(path, namespace)), ["new.png"]);
  assert.equal(owner.getSnapshot().sending, false);
  assert.equal(owner.getSnapshot().error, "enqueue failed");
  assert.equal(await lease.commit(), false, "a failed lease must not subsequently commit");
  assert.equal(cleanupCalls, 0);
});

ownerTest("post-ack failure cannot resurrect submitted images while cleanup is delayed", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("submitted")]);
  const { owner } = f.open();
  await turn();
  const write = deferred(), started = deferred();
  f.storage.beforeSave = () => { started.resolve(); return write.promise; };
  const lease = owner.beginSend(() => true);
  const committed = lease.commit(); // Represents a durable enqueue acknowledgement.
  await started.promise;
  lease.fail("delivery status unavailable after acknowledgement");
  assert.deepEqual(owner.getSnapshot().images, []);
  assert.equal(owner.beginSend(() => true), null);
  write.resolve();
  assert.equal(await committed, true);
  lease.fail("late delivery error");
  assert.deepEqual(owner.getSnapshot().images, []);
  assert.deepEqual(f.storage.read(path, namespace), []);
  assert.equal(f.storage.saves.length, 1);
});

ownerTest("cleanup persistence failure retries the acknowledged lease without re-enqueue", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("submitted")]);
  const { owner } = f.open();
  await turn();
  let enqueueCalls = 0, cleanupCalls = 0, failSave = true;
  f.storage.beforeSave = () => { if (failSave) throw new Error("synthetic storage failure"); };
  const submit = () => {
    const lease = owner.beginSend(() => { cleanupCalls++; return true; });
    if (lease) enqueueCalls++;
    return lease;
  };
  const lease = submit();
  const committed = lease.commit();
  await turn();
  assert.equal(owner.getSnapshot().sending, false);
  assert.match(owner.getSnapshot().error, /saved.*draft.*retry/i);
  assert.deepEqual(owner.getSnapshot().images, []);
  assert.equal(cleanupCalls, 0, "text cleanup must follow successful attachment persistence");
  assert.equal(submit(), null);
  failSave = false;
  assert.equal(await owner.retryCleanup(), true);
  assert.equal(await committed, true);
  assert.equal(enqueueCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(f.storage.saves.length, 2);
  assert.deepEqual(f.storage.read(path, namespace), []);
  assert.equal(owner.getSnapshot().error, null);
});

ownerTest("text-cleanup failure retains the acknowledged lease for one coalesced retry", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("submitted")]);
  const { owner } = f.open();
  await turn();
  let cleanupCalls = 0, allowCleanup = false;
  const lease = owner.beginSend(() => { cleanupCalls++; return allowCleanup; });
  const committed = lease.commit();
  await turn();
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(f.storage.read(path, namespace), []);
  assert.deepEqual(owner.getSnapshot().images, []);
  assert.match(owner.getSnapshot().error, /saved.*draft.*retry/i);
  assert.equal(owner.beginSend(() => true), null);
  allowCleanup = true;
  const retry = owner.retryCleanup();
  assert.equal(owner.retryCleanup(), retry);
  assert.equal(await retry, true);
  assert.equal(await committed, true);
  assert.equal(cleanupCalls, 2);
  assert.equal(f.storage.saves.length, 1, "already-cleared images need no second persistence write");
});

ownerTest("foreign CAS conflict keeps unsaved intake and never falls back to an unconditional write", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("observed")]);
  const { owner } = f.open();
  await turn();
  f.storage.seed(path, namespace, [image("foreign")]);
  await owner.addFiles(files("local"), async () => decoded("local"), 4);
  assert.deepEqual(names(owner.getSnapshot().images), ["observed.png", "local.png"]);
  assert.match(owner.getSnapshot().error, /another window/i);
  await assert.rejects(owner.flush(), /another window/i);
  assert.deepEqual(names(f.storage.read(path, namespace)), ["foreign.png"]);
  assert.equal(f.storage.saves.length, 2);
  for (const call of f.storage.saves) assert.deepEqual(names(call.expected), ["observed.png"]);
});

ownerTest("foreign CAS conflict releases an acknowledged lease without overwriting the foreign draft", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("submitted")]);
  const { owner } = f.open();
  await turn();
  let cleanupCalls = 0;
  const lease = owner.beginSend(() => { cleanupCalls++; return true; });
  f.storage.seed(path, namespace, [image("foreign")]);
  let settled = false;
  const committed = lease.commit().then(() => { settled = true; });
  await turn();
  assert.equal(settled, true, "a CAS miss must not strand a consumed send lease");
  await committed;
  assert.equal(owner.retryCleanup(), null);
  assert.equal(owner.getSnapshot().sending, false);
  assert.match(owner.getSnapshot().error, /another window|conflict/i);
  assert.deepEqual(owner.getSnapshot().images, []);
  assert.deepEqual(names(f.storage.read(path, namespace)), ["foreign.png"]);
  assert.equal(f.storage.saves.length, 1);
  for (const call of f.storage.saves) {
    assert.deepEqual(call.images, []);
    assert.deepEqual(names(call.expected), ["submitted.png"]);
  }
  const nextLease = owner.beginSend(() => true);
  assert.ok(nextLease);
  nextLease.fail("fixture releases unused next lease");
  assert.ok(cleanupCalls <= 1, "conflict handling must never replay submitted-text cleanup");
});

ownerTest("cleanup CAS conflict keeps newer local intake dirty and the foreign stored tray intact", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("submitted")]);
  const { owner } = f.open();
  await turn();
  const write = deferred(), started = deferred();
  f.storage.beforeSave = call => {
    if (call.images.length === 0) { started.resolve(); return write.promise; }
  };
  const lease = owner.beginSend(() => true);
  f.storage.seed(path, namespace, [image("foreign")]);
  const committed = lease.commit();
  await started.promise;
  const intake = owner.addFiles(files("new"), async () => decoded("new"), 4);
  await turn();
  assert.deepEqual(names(owner.getSnapshot().images), ["new.png"]);
  write.resolve();
  await Promise.all([committed, intake]);
  assert.equal(owner.retryCleanup(), null);
  assert.deepEqual(names(owner.getSnapshot().images), ["new.png"]);
  assert.deepEqual(names(f.storage.read(path, namespace)), ["foreign.png"]);
  await assert.rejects(owner.flush(), /another window|conflict/i);
  assert.deepEqual(names(f.storage.read(path, namespace)), ["foreign.png"]);
  for (const call of f.storage.saves) assert.notEqual(call.expected, undefined);
  const nextLease = owner.beginSend(() => true);
  assert.ok(nextLease);
  assert.deepEqual(names(nextLease.images), ["new.png"]);
  nextLease.fail("fixture releases unused next lease");
});

ownerTest("an image arriving during delayed cleanup survives both the tray and durable writes", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("submitted")]);
  const { owner } = f.open();
  await turn();
  const write = deferred(), started = deferred();
  f.storage.beforeSave = call => {
    if (call.images.length === 0) { started.resolve(); return write.promise; }
  };
  let cleanupCalls = 0;
  const lease = owner.beginSend(() => { cleanupCalls++; return true; });
  const committed = lease.commit();
  await started.promise;
  const intake = owner.addFiles(files("new"), async () => decoded("new"), 4);
  await turn();
  assert.deepEqual(names(owner.getSnapshot().images), ["new.png"]);
  assert.equal(owner.beginSend(() => true), null);
  write.resolve();
  assert.equal(await committed, true);
  await intake;
  assert.deepEqual(names(owner.getSnapshot().images), ["new.png"]);
  assert.deepEqual(names(f.storage.read(path, namespace)), ["new.png"]);
  assert.deepEqual(f.storage.saves.map(call => names(call.images)), [[], ["new.png"]]);
  assert.deepEqual(f.storage.saves.map(call => names(call.expected)), [["submitted.png"], []]);
  assert.equal(cleanupCalls, 1);
  assert.ok(!f.revoked.includes("blob:synthetic-new"));
});

ownerTest("same-turn reattachment retains a clean owner and final detach disposes it", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("saved")]);
  const first = f.open();
  await turn();
  first.unsubscribe();
  const second = f.open();
  await turn();
  assert.equal(first.owner, second.owner);
  assert.equal(f.storage.flushers.size, 1);
  assert.equal(f.storage.unregistered, 0);
  second.unsubscribe();
  await turn();
  assert.equal(f.storage.flushers.size, 0);
  assert.equal(f.storage.unregistered, 1);
  assert.ok(f.revoked.includes("blob:synthetic-saved"));
  const reopened = f.open();
  assert.notEqual(reopened.owner, first.owner);
  await turn();
  assert.deepEqual(names(reopened.owner.getSnapshot().images), ["saved.png"]);
  assert.equal(f.storage.loads.length, 2);
});


ownerTest("flush awaiting enqueue reports cleanup storage failure instead of waiting forever", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("submitted")]);
  const { owner } = f.open();
  await turn();
  const lease = owner.beginSend(() => true);
  const flushing = assert.rejects(owner.flush(), /Message saved, but its draft/);
  await turn();
  f.storage.beforeSave = () => {throw new Error("Synthetic cleanup failure")};
  const committed = lease.commit();
  await flushing;
  assert.equal(owner.getSnapshot().cleanupPending, true);
  assert.equal(owner.getSnapshot().sending, false);
  assert.equal(owner.beginSend(() => true), null);
  f.storage.beforeSave = null;
  assert.equal(await owner.retryCleanup(), true);
  assert.equal(await committed, true);
});

ownerTest("render-time allocation stays inert until a committed subscription", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, [image("saved")]);
  const owner = f.getAttachmentDraft(namespace, path);
  await turn();
  assert.equal(f.storage.loads.length, 0);
  assert.equal(f.storage.flushers.size, 0);
  assert.equal(owner.getSnapshot().loading, true);
  t.after(owner.subscribe(() => {}));
  await turn();
  assert.equal(f.getAttachmentDraft(namespace, path), owner);
  assert.equal(f.storage.loads.length, 1);
  assert.equal(f.storage.flushers.size, 1);
  assert.deepEqual(names(owner.getSnapshot().images), ["saved.png"]);
});


ownerTest("an offscreen error-only update settles and does not retain an inert owner", async t => {
  const f = await fixture(t);
  const owner = f.getAttachmentDraft(namespace, path);
  owner.setError("Late synthetic error");
  await turn();
  assert.equal(f.storage.flushers.size, 0);
  const reopened = f.open();
  assert.notEqual(reopened.owner, owner);
  assert.equal(reopened.owner.getSnapshot().error, "Late synthetic error");
  await turn();
  let decodes = 0;
  await owner.addFiles(files("stale"), async () => {decodes++;return decoded("stale")}, 4);
  assert.equal(decodes, 0);
  assert.equal(f.storage.saves.length, 0);
});

ownerTest("queued recovery serializes after hydration and intake without applying the send cap", async t => {
  const f = await fixture(t);
  f.storage.seed(path, namespace, Array.from({ length: 7 }, (_, i) => image(`saved-${i}`)));
  const hydration = deferred();
  f.storage.beforeLoad = () => hydration.promise;
  const { owner } = f.open();
  const selected = owner.addFiles(files("selected"), async () => decoded("selected"), 8);
  let draft = "typed before hydration", calls = 0;
  const detach = owner.attachTextRestorer(payload => { calls++; draft = `${payload}\n\n${draft}`; });
  t.after(detach);
  const original = [{ data: "original A", mimeType: "image/png" }, { data: "original B", mimeType: "image/jpeg" }];
  const recovery = owner.restoreContent([{text:" queued [Image #1] and [Image #2] ",images:original}], () => assert.fail("live editor owns text"), "recovery");
  assert.equal(owner.beginSend(() => true), null);
  draft += " and typed while hydration waited";
  hydration.resolve();
  await Promise.all([selected, recovery]);
  assert.equal(draft, " queued [Image #9] and [Image #10] \n\ntyped before hydration and typed while hydration waited");
  assert.equal(calls, 1);
  assert.equal(owner.getSnapshot().images.length, 10);
  assert.deepEqual(owner.getSnapshot().images.slice(-2).map(({ data, mimeType }) => ({ data, mimeType })), original);
  assert.equal(owner.getSnapshot().images[8].width, undefined);
  assert.equal(owner.getSnapshot().images[8].height, undefined);
  assert.equal(f.storage.read(path, namespace).length, 10);
});

ownerTest("recovery persistence never replays text or images over edits made during its write", async t => {
  const f = await fixture(t), write = deferred();
  const { owner } = f.open();
  let draft = "before", calls = 0;
  const detach = owner.attachTextRestorer(payload => { calls++; draft = `${payload}\n\n${draft}`; });
  t.after(detach);
  f.storage.beforeSave = () => write.promise;
  const original = [{ data: "untouched bytes", mimeType: "image/png" }];
  const recovery = owner.restoreContent([{text:"queued",images:original}], () => {}, "stable");
  await turn();
  assert.equal(owner.getSnapshot().pending, 1);
  draft += " and still typing";
  owner.noteTextEdit();
  write.resolve();
  await recovery;
  assert.equal(draft, "queued\n\nbefore and still typing");
  assert.equal(calls, 1);
  assert.equal(f.storage.read(path, namespace)[0].data, original[0].data);
});

ownerTest("failed offscreen text recovery is retained until a mounted editor or explicit flush saves it", async t => {
  const f = await fixture(t);
  const owner = f.getAttachmentDraft(namespace, path);
  let unavailable = true, stored = "";
  const save = text => { if (unavailable) throw Error("Synthetic text storage full"); stored = text; };
  await assert.rejects(owner.restoreContent([{text:"recoverable",images:[]}], save, "text-recovery"), /storage full/);
  assert.equal(f.getAttachmentDraft(namespace, path), owner);
  assert.match(owner.getSnapshot().error, /storage full/);
  unavailable = false;
  await owner.flush();
  assert.equal(stored, "recoverable");
});

ownerTest("failed photo recovery stays visible and retrying its identity persists only one copy", async t => {
  const f = await fixture(t);
  const { owner } = f.open();
  f.storage.beforeSave = () => { throw Error("Synthetic photo storage full"); };
  const original = [{ data: "original recoverable bytes", mimeType: "image/png" }];
  await assert.rejects(owner.restoreContent([{text:"",images:original}], () => {}, "image-recovery"), /storage full/);
  assert.equal(owner.getSnapshot().images[0].data, original[0].data);
  f.storage.beforeSave = null;
  await owner.restoreContent([{text:"",images:original}], () => {}, "image-recovery");
  assert.equal(owner.getSnapshot().images.length, 1);
  assert.equal(f.storage.read(path, namespace).length, 1);
  assert.equal(owner.getSnapshot().error, null);
});
