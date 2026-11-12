import type { UiMessage } from "./messages";
import type { JsonObject, OmpMessage } from "./protocol";
import { isJsonObject } from "./protocol";

// Producer metadata, not a cryptographic signature. Keep it out of JSON and
// structured-clone caches; only raw normalization can establish this witness.
const source = Symbol("Responses output item");
const origin = Symbol("observed Responses lifecycle");
const alias = Symbol("recovered Responses output");
interface Item {
  scope: string;
  id: string;
  phase?: "commentary" | "final_answer";
}
interface RawItem {
  item: Item | null;
  empty: boolean;
  responseId: string | null;
  canonical: boolean;
  ambiguous?: boolean;
}
interface Bound<T> { id: string; responseKey: string | undefined; model: string | undefined; value: T }
type Sourced = UiMessage & {
  [source]?: Bound<RawItem>;
  [origin]?: Bound<object>;
  [alias]?: Bound<{ token: object; id: string; responseKey: string }>;
};
const bind = <T>(message: UiMessage, value: T): Bound<T> => ({ id: message.id, responseKey: message.responseKey, model: message.model, value });
function read<T>(message: UiMessage, bound: Bound<T> | undefined): T | null {
  return message.role === "assistant" && bound?.id === message.id && bound.responseKey === message.responseKey && bound.model === message.model ? bound.value : null;
}
const rawItem = (message: UiMessage) => read(message, (message as Sourced)[source]);
const owner = (message: UiMessage) => read(message, (message as Sourced)[origin]);
const sameItem = (a: Item, b: Item) => a.scope === b.scope && a.id === b.id;
const compatiblePhase = (a: Item, b: Item) => !a.phase || !b.phase || a.phase === b.phase;

/** Inspect raw blocks before empty blocks disappear or adjacent text coalesces. */
export function withResponseItem(message: UiMessage, raw: OmpMessage, canonical = true): UiMessage {
  if (raw.api !== "openai-responses") return withoutResponseItem(message);
  let item: Item | null = null;
  let empty = false;
  const responseId = typeof raw.responseId === "string" && raw.responseId.trim() ? raw.responseId : null;
  if (raw.role === "assistant" && raw.api === "openai-responses" &&
      typeof raw.provider === "string" && raw.provider.trim() &&
      typeof raw.model === "string" && raw.model.trim() && Array.isArray(raw.content)) {
    const text = (raw.content as unknown[]).filter((part): part is JsonObject => isJsonObject(part) && part.type === "text");
    empty = text.length === 0;
    if (text.length === 1 && typeof text[0].text === "string" && typeof text[0].textSignature === "string") {
      try {
        const signature: unknown = JSON.parse(text[0].textSignature);
        if (isJsonObject(signature) && signature.v === 1 && typeof signature.id === "string" && signature.id.trim() &&
            Object.keys(signature).every((key) => key === "v" || key === "id" || key === "phase") &&
            (signature.phase === undefined || signature.phase === "commentary" || signature.phase === "final_answer")) {
          item = { scope: JSON.stringify([raw.api, raw.provider, raw.model]), id: signature.id, phase: signature.phase };
        }
      } catch { /* Malformed JSON is never an opaque legacy item ID. */ }
    }
  }
  return { ...message, [source]: bind(message, { item, empty, responseId, canonical }) } as Sourced;
}


/** ID dedup may hide a second raw claim. Preserve that veto on the survivor. */
export function withAmbiguousResponseItem(message: UiMessage): UiMessage {
  const raw = rawItem(message);
  return { ...message, [source]: bind(message, { ...(raw ?? { item: null, empty: false, responseId: null, canonical: true }), ambiguous: true }) } as Sourced;
}

/** Explicitly strip even when a test/in-memory cache does not structured-clone. */
export function withoutResponseItem(message: UiMessage): UiMessage {
  const { [source]: _source, [origin]: _origin, [alias]: _alias, ...rest } = message as Sourced;
  return rest;
}

/** Canonical replacement prose wins even when it is not a prefix of live text. */
export function isRecoveredResponse(canonical: UiMessage, live: UiMessage): boolean {
  const proof = read(live, (live as Sourced)[alias]);
  const a = rawItem(canonical)?.item, b = rawItem(live)?.item;
  return !!proof && owner(canonical) === proof.token && canonical.id === proof.id &&
    canonical.responseKey === proof.responseKey && !!a && !!b && sameItem(a, b) && compatiblePhase(a, b);
}

/** One observed lifecycle, never a history-wide deduplication index. */
export class ResponseItemRecovery {
  private token: object | null = null;
  private item: Item | null = null;
  private previousItem: Item | null = null;
  private provisional: { id: string; responseKey: string | undefined } | null = null;
  private resolved: { id: string; responseKey: string } | null = null;
  private expectedResponseId: string | null = null;
  private blocked = false;
  needsReconcile = false;

  private readonly mergeDetails: (canonical: UiMessage, provisional: UiMessage) => UiMessage;

  constructor(mergeDetails: (canonical: UiMessage, provisional: UiMessage) => UiMessage) {
    this.mergeDetails = mergeDetails;
  }

  reset(): void {
    this.token = null;
    this.item = this.previousItem = null;
    this.provisional = this.resolved = null;
    this.expectedResponseId = null;
    this.blocked = false;
    this.needsReconcile = false;
  }
  start(): void {
    const previous = this.item ?? this.previousItem;
    this.reset();
    this.previousItem = previous;
    this.token = {};
  }
  observe(message: UiMessage): UiMessage {
    if (!this.token || this.blocked) return message;
    const raw = rawItem(message);
    if (raw?.ambiguous || raw?.canonical || (raw?.responseId && !this.provisional)) {
      this.blocked = true;
      return message;
    }
    if (!raw?.item) {
      if (!raw?.empty || this.item) this.blocked = true;
      return message;
    }
    if ((this.item && (!sameItem(this.item, raw.item) || !compatiblePhase(this.item, raw.item))) ||
        (this.previousItem && sameItem(this.previousItem, raw.item))) {
      this.blocked = true;
      return message;
    }
    if (raw.responseId) {
      // A delayed full final may promote identity after idle already committed
      // the provisional. Retain its first known ID as a constraint, not as a
      // canonical claim. Only later persisted history can resolve the alias.
      if (!this.provisional || (this.expectedResponseId && this.expectedResponseId !== raw.responseId) ||
          (this.resolved && message.responseKey !== this.resolved.responseKey)) {
        this.blocked = true;
        return message;
      }
      this.expectedResponseId = raw.responseId;
      this.item = { ...raw.item, phase: this.item?.phase ?? raw.item.phase };
      return this.markLive(message);
    }
    if (this.provisional && (this.provisional.id !== message.id || this.provisional.responseKey !== message.responseKey)) {
      this.blocked = true;
      return message;
    }
    if (!this.item) this.needsReconcile = true;
    this.item = { ...raw.item, phase: this.item?.phase ?? raw.item.phase };
    this.provisional = { id: message.id, responseKey: message.responseKey };
    return this.markLive(message);
  }
  private markLive(message: UiMessage): UiMessage {
    return { ...message, [origin]: bind(message, this.token!),
      ...(this.resolved ? { [alias]: bind(message, { ...this.resolved, token: this.token! }) } : {}),
    } as Sourced;
  }
  preflight(messages: readonly UiMessage[], live: UiMessage | null): void {
    if (!this.token || this.blocked) return;
    // A duplicate-ID batch is already lossy; even a discarded signed claim
    // behind an unsigned survivor must veto before any known-ID filtering.
    if (messages.some((row) => rawItem(row)?.ambiguous)) { this.blocked = true; return; }
    if (!this.item) return;
    const claims = new Set<string>();
    const currentId = live && rawItem(live)?.responseId;
    if (currentId && this.expectedResponseId && currentId !== this.expectedResponseId) this.blocked = true;
    for (const row of messages) {
      const raw = rawItem(row);
      if (this.resolved && row.id === this.resolved.id && row.responseKey === this.resolved.responseKey &&
          (!raw?.canonical || !raw.item || !sameItem(this.item, raw.item))) this.blocked = true;
      if (!raw?.item || !sameItem(this.item, raw.item)) continue;
      if (raw.ambiguous || !compatiblePhase(this.item, raw.item) || (owner(row) && owner(row) !== this.token)) this.blocked = true;
      if (raw.responseId && this.expectedResponseId && raw.responseId !== this.expectedResponseId) this.blocked = true;
      if (raw.responseId && raw.canonical) claims.add(JSON.stringify([row.id, raw.responseId]));
      if (raw.responseId && !raw.canonical && (owner(row) !== this.token || raw.responseId !== this.expectedResponseId)) this.blocked = true;
    }
    if (claims.size > 1) this.blocked = true;
  }
  reconcile(messages: UiMessage[], live: UiMessage | null, previous: readonly UiMessage[] = messages): { messages: UiMessage[]; streamingMessage: UiMessage | null } {
    this.preflight([...previous, ...messages], live);
    this.needsReconcile = false;
    const unchanged = { messages, streamingMessage: live };
    if (!this.token || this.blocked || !this.item || !this.provisional) return unchanged;
    if (previous.filter((row) => owner(row) === this.token && !rawItem(row)?.responseId && rawItem(row)?.item).length > 1) {
      this.blocked = true;
      return unchanged;
    }
    // Preflight the whole retained+incoming window. A second claim must veto
    // before any provisional is removed, including two claims in one batch.
    const rows = [...messages, ...(live ? [live] : [])];
    const provisional = rows.filter((row) => owner(row) === this.token && !rawItem(row)?.responseId && rawItem(row)?.item);
    if (messages.filter((row) => provisional.includes(row)).length > 1) { this.blocked = true; return unchanged; }
    const provisionalIds = new Set(provisional.map((row) => row.id));
    if (provisionalIds.size > 1) { this.blocked = true; return unchanged; }
    if (provisionalIds.size === 0 && !this.resolved) return unchanged;
    const matching = rows.filter((row) => { const item = rawItem(row)?.item; return item && sameItem(this.item!, item); });
    if (matching.some((row) => owner(row) && owner(row) !== this.token)) { this.blocked = true; return unchanged; }
    const canonical = messages.filter((row) => {
      const raw = rawItem(row);
      return raw?.canonical && !raw.ambiguous && raw.responseId && raw.item && sameItem(this.item!, raw.item);
    });
    // Even duplicate entry IDs or two response IDs in the same batch are
    // ambiguous. Existing ID/response-key reconciliation is not extended here.
    if (canonical.length > 1 || matching.some((row) => !rawItem(row)?.responseId && owner(row) !== this.token)) {
      this.blocked = true;
      return unchanged;
    }
    if (canonical.length !== 1) return unchanged;
    const target = canonical[0], targetItem = rawItem(target)!.item!;
    if (!target.responseKey || !compatiblePhase(this.item, targetItem) ||
        (this.resolved && (this.resolved.responseKey !== target.responseKey || this.resolved.id !== target.id))) {
      this.blocked = true;
      return unchanged;
    }
    this.resolved = { id: target.id, responseKey: target.responseKey };
    this.expectedResponseId = rawItem(target)!.responseId;
    this.item = { ...this.item, phase: this.item.phase ?? targetItem.phase };
    // Only details already owned by this observed recovery may survive a
    // canonical replay. Never borrow prose or details from unrelated history.
    const retained = previous.filter((row) => owner(row) === this.token && row.id === target.id && row.responseKey === target.responseKey);
    const promoted = live && owner(live) === this.token && rawItem(live)?.canonical === false &&
      rawItem(live)?.responseId === this.expectedResponseId ? live : null;
    const detailed = [...retained, ...provisional].reduce((canonical, row) => this.mergeDetails(canonical, row), target);
    const merged = promoted ? this.mergeDetails(detailed, promoted) : detailed;
    const owned = { ...merged, [origin]: bind(merged, this.token) } as Sourced;
    const next = messages.filter((row) => !provisional.includes(row)).map((row) => row === target ? owned : row);
    return { messages: next, streamingMessage: live && (provisional.includes(live) || promoted !== null) ? this.markLive(live) : live };
  }
}
