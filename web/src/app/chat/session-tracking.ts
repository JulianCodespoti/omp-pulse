import { useEffect, useMemo, useState } from "react";

import { readPairingToken } from "../../platform/browser-storage";
import type { OmpSessionController } from "../../runtime/omp-session-controller";
import { selectActivity, selectSessionTurn } from "../../runtime/omp-store";
import type { WorkspaceChangeTotals } from "../../runtime/api-types";
import { DaemonApi } from "../../runtime/rpc-client";
import { useStoreValue } from "../store-hooks";
import { agentCounts } from "../tools/agent-status";
import { latestTodos, todoProgress } from "../tools/todo-state";

export interface SessionTracking {
  /** A turn is running in this session. */
  working: boolean;
  /** Todo items not yet done; 0 when there is no open plan. */
  tasksLeft: number;
  tasksDone: number;
  tasksTotal: number;
  agents: { working: number; needsYou: number };
  /** Uncommitted changes; null for a clean tree, a folder outside git or an unreadable one. */
  changes: WorkspaceChangeTotals | null;
}

/**
 * What a session is tracking, for the badges on its tab row (SessionPager):
 * plan progress, subagents and uncommitted changes.
 */
export function useSessionTracking(controller: OmpSessionController, sessionPath: string | null): SessionTracking {
  const store = controller.getStore();
  const messages = useStoreValue(store, (s) => s.messages);
  const collabAgents = useStoreValue(store, (s) => s.collabAgents);
  const settledAgents = useStoreValue(store, (s) => s.settledAgents);
  const working = useStoreValue(store, (s) => selectSessionTurn(s, s.sessionPath ?? "") === "running");
  // The turn's start only matters while it runs.
  const turnStartedAt = useStoreValue(store, (s) => selectSessionTurn(s, s.sessionPath ?? "") === "running"
    ? selectActivity(s, s.sessionPath ?? "")?.turnStartedAt : undefined);
  const todo = useMemo(() => todoProgress(latestTodos(messages)), [messages]);
  // A background agent past the ghost guard's grace stops counting with no
  // store change to say so; `recheckAt` schedules that one recomputation by
  // moving `clock` (the time it fired) forward.
  const [clock, setClock] = useState(0);
  const agents = useMemo(
    () => agentCounts(collabAgents, messages, { live: working, turnStartedAt, now: Math.max(Date.now(), clock), settled: settledAgents }),
    [collabAgents, messages, working, turnStartedAt, settledAgents, clock],
  );
  useEffect(() => {
    if (agents.recheckAt === undefined) return;
    const timer = window.setTimeout(() => setClock(Date.now()), Math.max(0, agents.recheckAt - Date.now()) + 1);
    return () => window.clearTimeout(timer);
  }, [agents.recheckAt]);

  // Changes are read on entry and again when a turn ends (the moment edits
  // settle), never per streamed frame, and as a summary: the badge needs
  // counts, not megabytes of patch. Any failure, a folder outside git, a
  // read-only device or a clean tree all mean the same thing here: no badge.
  const [changes, setChanges] = useState<WorkspaceChangeTotals | null>(null);
  useEffect(() => {
    setChanges(null);
  }, [sessionPath]);
  useEffect(() => {
    if (!sessionPath || working) return;
    const abort = new AbortController();
    new DaemonApi(readPairingToken())
      .getChangesSummary(sessionPath, abort.signal)
      .then((result) => {
        if (abort.signal.aborted) return;
        setChanges(result.notRepo || result.totals.files === 0 ? null : result.totals);
      })
      .catch(() => {
        if (!abort.signal.aborted) setChanges(null);
      });
    return () => abort.abort();
  }, [sessionPath, working]);

  const open = todo !== null && todo.total > 0 && todo.done < todo.total;
  const tasksLeft = open ? todo.total - todo.done : 0;
  const tasksDone = todo?.done ?? 0;
  const tasksTotal = todo?.total ?? 0;
  // A stable object while nothing changes: SessionPager keys the chat header on it, and a fresh one per render
  // re-rendered the whole header (~60ms at 4x CPU) every time a drawer opened.
  return useMemo(
    () => ({ working, tasksLeft, tasksDone, tasksTotal, agents: { working: agents.working, needsYou: agents.needsYou }, changes }),
    [working, tasksLeft, tasksDone, tasksTotal, agents.working, agents.needsYou, changes],
  );
}
