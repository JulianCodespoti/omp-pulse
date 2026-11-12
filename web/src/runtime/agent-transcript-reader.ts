import { appendAgentEntries, appendAgentJsonl, emptyAgentTranscript, visibleAgentTranscript, type AgentTranscriptBuffer } from "../domain/agent-transcript";
import type { UiMessage } from "../domain/messages";
import { DaemonApi, isOwnershipError } from "./rpc-client";

/** `file`: the retained transcript omp writes beside the parent, read with no live host. */
export type AgentTranscriptSource = "desktop" | "rpc" | "file";
export type AgentTranscriptSelection = { id: string; source: AgentTranscriptSource; createdAt?: number; sessionFile?: string; connectionId?: string; unavailable?: boolean };
export type AgentTranscriptSnapshot = {
  messages: UiMessage[];
  loading: boolean;
  error: string | null;
  retryable: boolean;
  limited: boolean;
  partial: boolean;
  nextByte: number;
  /** The agent's own model and thinking level, from its settings records. */
  model?: string;
  thinkingLevel?: string;
};
export const emptyAgentTranscriptSnapshot = (): AgentTranscriptSnapshot => ({ messages: [], loading: false, error: null, retryable: false, limited: false, partial: false, nextByte: 0 });
const safeCursor = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** One reader per visible visit. It cannot publish or retry after disposal. */
export class AgentTranscriptReader {
  private disposed = false;
  private pending = false;
  private initialized = false;
  private connectionId: string | undefined;
  private abort: AbortController | null = null;
  private buffer: AgentTranscriptBuffer = emptyAgentTranscript();
  private snapshot = emptyAgentTranscriptSnapshot();

  constructor(
    private api: DaemonApi,
    private sessionPath: string,
    private selection: AgentTranscriptSelection,
    private publish: (snapshot: AgentTranscriptSnapshot) => void,
  ) { this.connectionId = selection.connectionId; }

  dispose(): void { this.disposed = true; this.abort?.abort(); }

  async read(retry = false): Promise<void> {
    if (this.disposed || this.pending || (this.snapshot.error && !(retry && this.snapshot.retryable))) return;
    if (this.selection.unavailable) {
      this.snapshot = { ...this.snapshot, error: "This agent has no conversation transcript available.", retryable: false };
      this.publish(this.snapshot);
      return;
    }
    this.pending = true;
    this.abort = new AbortController();
    const fromByte = this.snapshot.nextByte;
    const loading = !this.initialized || retry;
    // A background poll of an established transcript changes none of these
    // fields; publishing anyway re-rendered the whole conversation every 3 s.
    if (this.snapshot.loading !== loading || this.snapshot.error !== null || this.snapshot.retryable) {
      this.snapshot = { ...this.snapshot, loading, error: null, retryable: false };
      this.publish(this.snapshot);
    }
    let restart = false;
    try {
      const source = this.selection.source;
      // Desktop and file reads share one byte-chunk contract; only desktop is connection-fenced.
      const chunked = source !== "rpc";
      const raw = source === "desktop"
        ? await this.api.getDesktopAgentTranscript(this.sessionPath, this.selection.id, fromByte, this.abort.signal, this.selection.createdAt, this.connectionId)
        : source === "file"
          ? await this.api.getAgentFileTranscript(this.sessionPath, this.selection.id, fromByte, this.abort.signal)
          : await this.api.getSubagentMessages(this.sessionPath, { subagentId: this.selection.id, fromByte }, this.abort.signal);
      if (this.disposed) return;
      if (!record(raw) || !safeCursor(raw.nextByte)) throw new Error("The agent transcript returned an invalid cursor.");
      if (this.selection.source === "rpc" && this.selection.sessionFile !== undefined && raw.sessionFile !== this.selection.sessionFile) {
        throw Object.assign(new Error("This agent’s transcript identity changed. Go back and reopen it."), { code: "agent_changed" });
      }
      if (source === "desktop" && (typeof raw.connectionId !== "string" || !raw.connectionId || (this.connectionId !== undefined && raw.connectionId !== this.connectionId))) {
        throw new Error("The agent transcript returned an invalid response.");
      }
      if (chunked && (raw.ok !== true || raw.agentId !== this.selection.id || raw.fromByte !== fromByte || typeof raw.text !== "string" || (raw.text !== "" && !raw.text.endsWith("\n")) || typeof raw.reset !== "boolean")) {
        throw new Error("The agent transcript returned an invalid response.");
      }
      if (chunked) {
        const shrank = raw.nextByte < fromByte;
        const text = raw.text as string;
        if (raw.reset !== shrank || (shrank ? text !== "" : new TextEncoder().encode(text).length !== raw.nextByte - fromByte)) {
          throw new Error("The agent transcript returned an invalid response byte range.");
        }
      }
      if (source === "desktop") this.connectionId = raw.connectionId as string;
      const reset = raw.reset === true || raw.nextByte < fromByte;
      if (chunked && reset) {
        this.initialized = false;
        this.buffer = emptyAgentTranscript();
        this.snapshot = { ...emptyAgentTranscriptSnapshot(), loading: true };
        restart = true;
      } else {
        let next: AgentTranscriptBuffer;
        if (chunked) {
          // A non-empty replay at the same cursor would duplicate a byte range.
          if (raw.nextByte === fromByte && raw.text !== "") throw new Error("The agent transcript cursor did not advance.");
          next = appendAgentJsonl(this.buffer, raw.text as string);
        } else {
          const values = raw.entries ?? raw.messages;
          if (!Array.isArray(values)) throw new Error("The agent transcript returned no message records.");
          if (!reset && values.length && raw.nextByte === fromByte) throw new Error("The agent transcript cursor did not advance.");
          next = appendAgentEntries(reset ? emptyAgentTranscript() : this.buffer, values);
        }
        // An idle poll returns the same buffer at the same cursor: the visible
        // snapshot is already current, so keep its identity and stay quiet.
        if (next === this.buffer && raw.nextByte === fromByte && this.initialized && !this.snapshot.loading) return;
        const visible = visibleAgentTranscript(next);
        this.buffer = next;
        this.initialized = true;
        this.snapshot = { ...this.snapshot, ...visible, loading: false, nextByte: raw.nextByte };
      }
      this.publish(this.snapshot);
    } catch (error) {
      if (this.disposed) return;
      const code = record(error) ? error.code : undefined;
      const message = error instanceof Error ? error.message : String(error);
      const unavailable = code === "agent_changed" || code === "transcript_unavailable" || code === "host_error" || code === "session_not_found" || isOwnershipError(error) || /Unknown subagent|no transcript available/i.test(message);
      const terminal = unavailable || code === "invalid_request" || code === "invalid_host_response" || /invalid (?:record|cursor|response)|too large|cursor did not advance|no message records/i.test(message);
      this.snapshot = { ...this.snapshot, loading: false, retryable: !terminal, error: isOwnershipError(error)
        ? "This conversation is no longer available from this owner. Session ownership changed; go back and reopen the agent."
        : code === "agent_changed" ? "This agent’s conversation is no longer available under its previous identity. Go back and reopen the current agent."
          : unavailable ? "This agent’s conversation is no longer available from its host."
          : code === "transcript_timeout" || (error instanceof Error && error.name === "TimeoutError")
            ? "The transcript request timed out. Retry to continue from the last received message."
            : code === "host_unavailable" ? "The desktop connection is unavailable or has changed. Go back and reopen this agent after reconnecting." : message };
      this.publish(this.snapshot);
    } finally {
      this.pending = false;
      this.abort = null;
    }
    // A reset reread belongs to this same visit. Bound a reset-at-zero host
    // failure rather than spinning forever on a malformed RPC implementation.
    if (restart && !this.disposed) {
      if (fromByte === 0) {
        this.snapshot = { ...this.snapshot, loading: false, error: "The host could not restart this transcript.", retryable: true };
        this.publish(this.snapshot);
      } else await this.read();
    }
  }
}
