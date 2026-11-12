import { useLayoutEffect, useSyncExternalStore } from "react";

import type { AgentDiscussionReference } from "@/domain/agent-discussion";
import type { OmpSessionController } from "@/runtime/omp-session-controller";

/**
 * What the workspace tabs need from the open chat. The tabs are mounted by the
 * workspace panel in App.tsx, outside ChatScreen, but jumping to a transcript
 * entry, opening a branch and drafting an agent reference all act on the chat.
 * ChatScreen publishes these while it is mounted; with no chat open the tabs
 * degrade (no jump targets, no draft action) instead of failing.
 */
export interface WorkspaceHost {
  controller: OmpSessionController;
  /** Scroll the chat to a transcript entry (the caller has closed the panel). */
  jumpTo: (entryId: string) => void;
  onBranched: (sessionPath: string) => void;
  /**
   * A committed tree move changed `sessionPath` in place. `editorText` is
   * prepared text for review, never a replacement for the user's draft.
   * Re-answer commits resume OMP automatically.
   */
  onMovedHere?: (sessionPath: string, editorText?: string, askReanswerCommitted?: boolean) => void;
  /** Returns a human error, or null once the reference is in the composer. */
  prepareAgentResponse?: (sessionPath: string, context: AgentDiscussionReference) => string | null;
}

let current: WorkspaceHost | null = null;
const listeners = new Set<() => void>();

function publish(next: WorkspaceHost | null): void {
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const snapshot = () => current;

export function useWorkspaceHost(): WorkspaceHost | null {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** ChatScreen calls this once; pass a stable (memoised) host. */
export function useProvideWorkspaceHost(host: WorkspaceHost): void {
  useLayoutEffect(() => {
    publish(host);
    return () => {
      // A newer chat may already have replaced this one.
      if (current === host) {
        publish(null);
        rejectTerminalRequest("The conversation changed before the command started.");
      }
    };
  }, [host]);
}

/** A `!cmd` / `!!cmd` typed in the composer: the Terminal tab runs it once. */
export type BashRunRequest = {
  id: number; sessionPath: string; command: string; excludeFromContext: boolean;
  isCurrent: () => boolean;
};

// Held here, not passed as a prop: the composer lives in ChatScreen while the
// Terminal tab is mounted (lazily, possibly later) by the workspace panel.
let terminalRequest: BashRunRequest | null = null;
let terminalAcceptance: { resolve: () => void; reject: (error: Error) => void } | null = null;
const terminalListeners = new Set<() => void>();

function subscribeTerminal(listener: () => void): () => void {
  terminalListeners.add(listener);
  return () => terminalListeners.delete(listener);
}

const terminalSnapshot = () => terminalRequest;

export function requestTerminalRun(request: BashRunRequest): Promise<void> {
  if (terminalRequest) return Promise.reject(new Error("A terminal command is already waiting to start."));
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  terminalAcceptance = { resolve, reject };
  terminalRequest = request;
  for (const listener of terminalListeners) listener();
  return promise;
}

/** Rejection leaves the originating composer's send lease and draft uncommitted. */
export function rejectTerminalRequest(message: string, id?: number): void {
  if (!terminalRequest || (id !== undefined && terminalRequest.id !== id)) return;
  const acceptance = terminalAcceptance;
  terminalRequest = null;
  terminalAcceptance = null;
  acceptance?.reject(new Error(message));
  for (const listener of terminalListeners) listener();
}

export function useTerminalRequest(): BashRunRequest | null {
  return useSyncExternalStore(subscribeTerminal, terminalSnapshot, terminalSnapshot);
}

/**
 * The Terminal tab admitted `id` for execution. Only then may the composer
 * commit its send lease; busy/refused commands stay in their original draft.
 */
export function consumeTerminalRequest(id: number): boolean {
  if (terminalRequest?.id !== id) return false;
  const acceptance = terminalAcceptance;
  terminalRequest = null;
  terminalAcceptance = null;
  acceptance?.resolve();
  for (const listener of terminalListeners) listener();
  return true;
}
