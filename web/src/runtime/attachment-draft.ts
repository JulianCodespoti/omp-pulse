import {
  clearAllDraftAttachments,
  loadDraftAttachments,
  makeCommandId,
  registerDraftAttachmentFlusher,
  sameDraftAttachments,
  saveDraftAttachments,
  type DraftAttachment,
} from "./offline-queue";
import { recoverImageReferences, type DraftImageReference } from "../domain/image-references";
import type { WithdrawnMessage } from "./withdrawn-queue";

interface Snapshot {
  images: DraftAttachment[];
  loading: boolean;
  /** A failed load must not be mistaken for an empty persisted tray. */
  restored: boolean;
  pending: number;
  sending: boolean;
  cleanupPending: boolean;
  error: string | null;
}
interface SendLease {
  generation: number;
  images: DraftAttachment[];
  committed: boolean;
  cleanup: () => boolean;
  done: Promise<boolean>;
  enqueued: Promise<void>;
  settleEnqueue: () => void;
  resolve: (cleared: boolean) => void;
  attempt?: Promise<boolean>;
}
const EMPTY_SNAPSHOT: Snapshot = { images: [], loading: true, restored: false, pending: 0, sending: false, cleanupPending: false, error: null };
const owners = new Map<string, AttachmentDraft>();
const namespaceClears = new Map<string, Promise<void>>();
class AttachmentConflictError extends Error {}
// Keep only lightweight notices after an offscreen failure. Completed trays
// themselves are evicted; errors must not grow a cache of image bytes.
const idleErrors = new Map<string, string>();
const MAX_IDLE_ERRORS = 16;
const keyFor = (namespace: string, path: string | null) => JSON.stringify([namespace, path]);
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const revoke = (images: readonly DraftAttachment[]) => {
  for (const image of images)
    if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
};

/** Same-document draft work belongs to the session, not a keyed React mount. */
export class AttachmentDraft {
  private snapshot: Snapshot = { images: [], loading: true, restored: false, pending: 0, sending: false, cleanupPending: false, error: null };
  private listeners = new Set<() => void>();
  private generation = 0;
  private revision = 0;
  private dirty = false;
  private observed: readonly DraftAttachment[] = [];
  private ready: Promise<void> = Promise.resolve();
  private intakeTail = Promise.resolve();
  private writeTail: Promise<unknown> = Promise.resolve();
  private writes = 0;
  private lease: SendLease | null = null;
  private unregister: () => void = () => {};
  private started = false;
  private textEditor: ((expected: string) => string) | null = null;
  private textRestorer: ((text: string, recoveryId: string, references: readonly DraftImageReference[]) => void) | null = null;
  private imageReferenceEditor: ((imageIds: readonly (string | undefined)[], removedId?: string) => void) | null = null;
  private removedRecoveryImages = new Set<string>();
  private captureRecoveryText: (() => void) | undefined;
  private unsavedRecoveryText: {
    text: string; recoveryId: string; references: DraftImageReference[];
    save: (text: string, recoveryId: string, references: readonly DraftImageReference[]) => void;
  }[] = [];
  private textRevision = 0;
  private disposed = false;

  constructor(readonly namespace: string, readonly path: string | null) {
    this.snapshot.error = idleErrors.get(keyFor(namespace, path)) ?? null;
    idleErrors.delete(keyFor(namespace, path));
  }

  private start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.update({ loading: true });
    this.unregister = registerDraftAttachmentFlusher(() => this.flush());
    const generation = this.generation;
    this.ready = (namespaceClears.get(this.namespace) ?? Promise.resolve()).then(
      () => generation === this.generation ? this.restore() : undefined,
      error => {
        if (generation === this.generation) this.update({ loading: false, error: message(error) });
        this.disposeIfIdle();
      },
    );
  }

  getSnapshot = (): Snapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => {
      this.listeners.delete(listener);
      // StrictMode can detach and reattach without abandoning this draft.
      queueMicrotask(() => this.disposeIfIdle());
    };
  };
  private update(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  setError(error: string | null): void {
    if (this.disposed) return;
    this.start();
    this.update({ error });
  }
  noteTextEdit(): void { this.start(); this.textRevision++; }
  attachTextEditor(clear: (expected: string) => string): () => void {
    this.textEditor = clear;
    this.start();
    return () => {
      if (this.textEditor === clear) this.textEditor = null;
      queueMicrotask(() => this.disposeIfIdle());
    };
  }
  attachTextRestorer(
    restore: (text: string, recoveryId: string, references: readonly DraftImageReference[]) => void,
    capture?: () => void,
    editImages?: (imageIds: readonly (string | undefined)[], removedId?: string) => void,
  ): () => void {
    this.textRestorer = restore;
    this.captureRecoveryText = capture;
    this.imageReferenceEditor = editImages ?? null;
    this.start();
    try { this.settleRecoveryText(); }
    catch (error) { this.setError(message(error)); }
    return () => {
      if (this.textRestorer === restore) {
        this.textRestorer = null;
        this.captureRecoveryText = undefined;
        this.imageReferenceEditor = null;
      }
      queueMicrotask(() => this.disposeIfIdle());
    };
  }

  /** Recover original bytes without decoding, re-encoding or applying send caps.
   * Shares the intake/write tails with selection and hydration, including offscreen work. */
  async restoreContent(
    messages: readonly WithdrawnMessage[], saveText: (text: string, recoveryId: string, references: readonly DraftImageReference[]) => void,
    recoveryId: string = makeCommandId(), removedImageIds: readonly string[] = [],
  ): Promise<void> {
    if (this.disposed) throw new Error("The draft is no longer available.");
    const generation = this.generation;
    for (const id of removedImageIds) this.removedRecoveryImages.add(id);
    // Capture native/IME input before loading/pending publications rerender it.
    // Reference numbers must wait for hydration and earlier photo intakes.
    this.captureRecoveryText?.();
    this.start();
    this.update({ pending: this.snapshot.pending + 1 });
    const run = async () => {
      try {
        await this.ready;
        if (generation !== this.generation) throw new Error("Draft recovery was cancelled.");
        const images: DraftAttachment[] = [];
        const texts: string[] = [];
        const references: DraftImageReference[] = [];
        let recoveredIndex = 0, textOffset = 0;
        for (const message of messages) {
          const numbers = message.images.map(image => {
            const index = recoveredIndex++;
            const id = `${recoveryId}:${index}`;
            const existing = this.snapshot.images.findIndex(saved => saved.recoveryId === id);
            if (this.removedRecoveryImages.has(id)) return null;
            if (existing !== -1) return existing + 1;
            images.push({
              ...image, previewUrl: `data:${image.mimeType};base64,${image.data}`,
              name: `Recovered photo ${index + 1}`, recoveryId: id,
            });
            return this.snapshot.images.length + images.length;
          });
          const mapped = recoverImageReferences(message.text, numbers,
            message.images.map((_image, index) => `${recoveryId}:${recoveredIndex - message.images.length + index}`));
          references.push(...mapped.references.map(reference => ({ ...reference, start: reference.start + textOffset, end: reference.end + textOffset })));
          texts.push(mapped.text);
          textOffset += mapped.text.length + 2;
        }
        const text = texts.join("\n\n");
        let textError: unknown;
        try {
          (this.textRestorer ?? saveText)(text, recoveryId, references);
          this.unsavedRecoveryText = this.unsavedRecoveryText.filter(item => item.recoveryId !== recoveryId);
        } catch (error) {
          // Its identity prevents a retry from merging the mapped text twice.
          if (!this.unsavedRecoveryText.some(item => item.recoveryId === recoveryId))
            this.unsavedRecoveryText.push({ text, recoveryId, references, save: saveText });
          textError = error;
        }
        if (images.length) {
          this.revision++;
          this.dirty = true;
          this.update({ images: [...this.snapshot.images, ...images] });
        }
        // Retry a failed photo write even when every recovery ID is already
        // in memory; the source reservation must outlive durable persistence.
        await this.persist();
        if (textError) throw textError;
        this.update({ error: null });
      } catch (error) {
        if (generation === this.generation) this.setError(message(error));
        throw error;
      } finally {
        if (generation === this.generation) this.update({ pending: this.snapshot.pending - 1 });
        this.disposeIfIdle();
      }
    };
    const result = this.intakeTail.then(run, run);
    this.intakeTail = result.catch(() => undefined);
    await result;
  }
  /** A recovery already visible in the editor must become durable before a
   * send captures its cleanup revision, or a later flush could replay it. */
  settleRecoveryText(): void {
    while (this.unsavedRecoveryText.length) {
      const item = this.unsavedRecoveryText[0];
      (this.textRestorer ?? item.save)(item.text, item.recoveryId, item.references);
      this.unsavedRecoveryText.shift();
    }
  }
  captureTextCleanup(expected: string, clearStored: () => void, readStored: () => string): () => boolean {
    const revision = this.textRevision;
    return () => {
      if (revision !== this.textRevision) return true;
      if (this.textEditor) this.textEditor(expected);
      else clearStored();
      return readStored() !== expected || expected === "";
    };
  }

  private async restore(): Promise<void> {
    const generation = this.generation;
    try {
      const images = this.path ? await loadDraftAttachments(this.path, this.namespace) : [];
      if (generation !== this.generation) return;
      this.observed = images;
      this.update({ images, restored: true });
    } catch (error) {
      if (generation === this.generation) this.setError(message(error));
    } finally {
      if (generation === this.generation) this.update({ loading: false });
      this.disposeIfIdle();
    }
  }

  private persist(): Promise<void> {
    const generation = this.generation;
    this.writes++;
    const write = async () => {
      if (this.disposed || generation !== this.generation || !this.dirty) return;
      if (!this.path) {
        if (!this.snapshot.images.length) this.dirty = false;
        return;
      }
      // Resolve against the current tray when our turn starts. Never replay a
      // pre-decode/pre-send snapshot over a later removal or attachment.
      const images = this.snapshot.images;
      const applied = await saveDraftAttachments(this.path, images, this.namespace, this.observed);
      if (generation !== this.generation) return;
      if (!applied) {
        if (this.snapshot.images === images && images.length === 0) this.dirty = false;
        throw new AttachmentConflictError("Image draft changed in another window. Your unsaved images have been kept here.");
      }
      this.observed = images;
      if (this.snapshot.images === images) this.dirty = false;
    };
    const run = this.writeTail.then(write, write);
    this.writeTail = run.catch(() => undefined);
    return run.finally(() => { this.writes--; this.disposeIfIdle(); });
  }

  async addFiles(
    files: File[],
    decode: (files: File[], count: number) => Promise<{ images: DraftAttachment[]; error?: string }>,
    maxImages: number,
  ): Promise<void> {
    if (this.disposed) return;
    this.start();
    const generation = this.generation;
    const previous = this.intakeTail;
    this.update({ pending: this.snapshot.pending + 1 });
    const run = async () => {
      try {
        await this.ready;
        if (generation !== this.generation) return;
        const result = await decode(files, this.snapshot.images.length);
        if (generation !== this.generation) { revoke(result.images); return; }
        const accepted = result.images.slice(0, Math.max(0, maxImages - this.snapshot.images.length));
        revoke(result.images.slice(accepted.length));
        if (accepted.length) {
          this.revision++;
          this.dirty = true;
          this.update({ images: [...this.snapshot.images, ...accepted] });
          await this.persist();
        }
        if (generation === this.generation && result.error) this.setError(result.error);
      } catch (error) {
        if (generation === this.generation) this.setError(message(error));
      } finally {
        if (generation === this.generation) this.update({ pending: this.snapshot.pending - 1 });
        this.disposeIfIdle();
      }
    };
    this.intakeTail = previous.then(run, run);
    await this.intakeTail;
  }

  /** Returns what was removed, so a caller can offer Undo through `restoreImage`. */
  removeImage(index: number): DraftAttachment | null {
    if (this.disposed) return null;
    const images = [...this.snapshot.images];
    const removed = images.splice(index, 1);
    if (!removed.length) return null;
    this.captureRecoveryText?.();
    const removedId = removed[0].recoveryId;
    if (removedId) this.removedRecoveryImages.add(removedId);
    try { this.imageReferenceEditor?.(images.map(image => image.recoveryId), removedId); }
    catch (error) { this.setError(message(error)); }
    revoke(removed);
    this.revision++;
    this.dirty = true;
    this.update({ images });
    const generation = this.generation;
    void this.persist().catch(error => {
      if (generation === this.generation) this.setError(message(error));
    });
    return removed[0];
  }

  /**
   * Puts a removed photo back at its old position. Its preview is rebuilt from
   * the bytes because removal revoked the blob URL. Text that referred to the
   * photo ("Image 2") was already rewritten by the removal and is not restored.
   */
  restoreImage(index: number, image: DraftAttachment): void {
    if (this.disposed) return;
    if (image.recoveryId) this.removedRecoveryImages.delete(image.recoveryId);
    const images = [...this.snapshot.images];
    images.splice(Math.min(index, images.length), 0, { ...image, previewUrl: `data:${image.mimeType};base64,${image.data}` });
    this.revision++;
    this.dirty = true;
    this.update({ images });
    const generation = this.generation;
    void this.persist().catch(error => {
      if (generation === this.generation) this.setError(message(error));
    });
  }

  beginSend(cleanup: () => boolean) {
    this.start();
    if (this.disposed || this.snapshot.loading || this.snapshot.pending || this.lease || this.unsavedRecoveryText.length) return null;
    let resolve!: (cleared: boolean) => void, settleEnqueue!: () => void;
    const lease: SendLease = {
      generation: this.generation, images: [...this.snapshot.images], committed: false, cleanup,
      done: new Promise<boolean>(done => { resolve = done; }), resolve: cleared => resolve(cleared),
      enqueued: new Promise<void>(done => { settleEnqueue = done; }), settleEnqueue: () => settleEnqueue(),
    };
    this.lease = lease;
    this.update({ sending: true, error: null });
    return {
      images: lease.images,
      commit: () => {
        if (this.lease !== lease) return lease.done;
        if (!lease.committed) {
          lease.committed = true;
          lease.settleEnqueue();
          const submitted = new Set(lease.images);
          const images = this.snapshot.images.filter(image => !submitted.has(image));
          this.dirty ||= images.length !== this.snapshot.images.length;
          this.revision++;
          this.update({ images, cleanupPending: true });
          revoke(lease.images);
          void this.finishCleanup(lease);
        }
        return lease.done;
      },
      fail: (error: string) => {
        if (lease.generation !== this.generation) return;
        this.setError(error);
        // Before durable enqueue, the editor still owns its draft. Do not
        // restore an old snapshot over edits/removals made while enqueue ran.
        if (this.lease === lease && !lease.committed) {
          this.lease = null;
          lease.resolve(false);
          lease.settleEnqueue();
          this.update({ sending: false });
          this.disposeIfIdle();
        }
      },
    };
  }

  private finishCleanup(lease: SendLease): Promise<boolean> {
    if (lease.attempt) return lease.attempt;
    this.update({ sending: true });
    const attempt = async () => {
      try {
        let conflict: string | null = null;
        try { await this.persist(); }
        catch (error) {
          if (!(error instanceof AttachmentConflictError)) throw error;
          // Another view owns the durable tray now. Preserve it, finish only
          // this send's local cleanup, and keep newer unsaved additions here.
          conflict = error.message;
        }
        if (this.lease !== lease) return false;
        if (!lease.cleanup()) throw new Error("The submitted text draft could not be cleared.");
        this.lease = null;
        lease.resolve(true);
        this.update({ sending: false, cleanupPending: false, error: conflict });
        return true;
      } catch {
        if (this.lease === lease) this.update({ sending: false, error: "Message saved, but its draft could not be updated. Retry to finish clearing it." });
        return false;
      } finally {
        lease.attempt = undefined;
        this.disposeIfIdle();
      }
    };
    lease.attempt = attempt();
    return lease.attempt;
  }
  retryCleanup(): Promise<boolean> | null {
    return this.lease?.committed ? this.finishCleanup(this.lease) : null;
  }

  async sync(): Promise<void> {
    this.start();
    if (this.disposed || this.snapshot.loading || this.snapshot.pending || this.dirty || this.lease || !this.path) return;
    const generation = this.generation, revision = this.revision;
    try {
      const images = await loadDraftAttachments(this.path, this.namespace);
      if (generation !== this.generation || revision !== this.revision || this.dirty || this.lease || this.snapshot.pending) return;
      if (sameDraftAttachments(this.snapshot.images, images)) {
        this.update({ restored: true, error: null });
        return;
      }
      revoke(this.snapshot.images);
      this.observed = images;
      this.update({ images, restored: true, error: null });
    } catch (error) {
      if (generation === this.generation) this.setError(message(error));
    }
  }

  async flush(): Promise<void> {
    if (this.disposed) return;
    this.start();
    // A second selection can arrive during a flush. Drain through a stable
    // intake/write tail, including work whose Composer is no longer mounted.
    let intake: Promise<void>;
    do {
      intake = this.intakeTail;
      await this.ready;
      await intake;
      this.settleRecoveryText();
      if (this.lease && !this.lease.committed) await this.lease.enqueued;
      if (this.lease?.committed) {
        if (!await this.finishCleanup(this.lease)) throw new Error(this.snapshot.error ?? "Could not clear the submitted draft.");
      }
      await this.persist();
    } while (intake !== this.intakeTail);
  }

  /** Invalidate synchronously, then let the caller delete after running writes. */
  reset(barrier: Promise<void>): Promise<unknown> {
    this.generation++;
    const generation = this.generation;
    this.revision++;
    this.textRevision++;
    this.lease?.resolve(false);
    this.lease?.settleEnqueue();
    this.lease = null;
    revoke(this.snapshot.images);
    this.dirty = false;
    this.observed = [];
    this.unsavedRecoveryText = [];
    this.removedRecoveryImages.clear();
    this.intakeTail = Promise.resolve();
    this.update({ images: [], loading: true, restored: true, pending: 0, sending: false, cleanupPending: false, error: null });
    const previousWrites = this.writeTail;
    this.ready = barrier.catch(error => {
      if (generation === this.generation) this.setError(message(error));
    }).finally(() => {
      if (generation === this.generation) this.update({ loading: false });
      this.disposeIfIdle();
    });
    return previousWrites;
  }

  private disposeIfIdle(): void {
    if (this.disposed || this.listeners.size || this.textEditor || this.textRestorer || this.unsavedRecoveryText.length || this.snapshot.loading || this.snapshot.pending || this.writes || this.dirty || this.lease) return;
    this.disposed = true;
    this.unregister();
    const key = keyFor(this.namespace, this.path);
    if (owners.get(key) === this) owners.delete(key);
    if (this.snapshot.error) {
      idleErrors.delete(key);
      idleErrors.set(key, this.snapshot.error);
      if (idleErrors.size > MAX_IDLE_ERRORS) idleErrors.delete(idleErrors.keys().next().value!);
    }
    revoke(this.snapshot.images);
  }
}

/** Render reads are inert: a concurrent/abandoned render starts no storage work. */
export function getAttachmentDraftSnapshot(namespace: string, path: string | null): Snapshot {
  return owners.get(keyFor(namespace, path))?.getSnapshot() ?? EMPTY_SNAPSHOT;
}

export function getAttachmentDraft(namespace: string, path: string | null): AttachmentDraft {
  const key = keyFor(namespace, path);
  let owner = owners.get(key);
  if (!owner) {
    owner = new AttachmentDraft(namespace, path);
    owners.set(key, owner);
  }
  return owner;
}

/** Clear cannot race an offscreen decode or an already-started draft save. */
export async function clearAttachmentDrafts(namespace: string): Promise<void> {
  for (const key of idleErrors.keys())
    if ((JSON.parse(key) as [string, string | null])[0] === namespace) idleErrors.delete(key);
  let release!: () => void, reject!: (reason: unknown) => void;
  const previousClear = namespaceClears.get(namespace);
  const barrier = new Promise<void>((resolve, fail) => { release = resolve; reject = fail; });
  namespaceClears.set(namespace, barrier);
  void barrier.catch(() => undefined);
  const pending = Array.from(owners.values())
    .filter(owner => owner.namespace === namespace)
    .map(owner => owner.reset(barrier));
  try {
    await Promise.all([...pending, previousClear?.catch(() => undefined)]);
    await clearAllDraftAttachments(namespace);
    release();
  } catch (error) {
    reject(error);
    throw error;
  } finally {
    if (namespaceClears.get(namespace) === barrier) namespaceClears.delete(namespace);
  }
}
