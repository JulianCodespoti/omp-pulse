import { agentDiscussionReference, type AgentDiscussionReference } from "@/domain/agent-discussion";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type JSX } from "react";
import { ArrowLeftIcon, BotIcon } from "lucide-react";
import { fetchWithDeadline } from "@/runtime/request";

import { Notice } from "@/app/ui/Notice";
import { EmptyState } from "@/app/ui/EmptyState";
import { Row, RowGroup, RowSkeleton } from "@/app/ui/Row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { readPairingToken } from "@/platform/browser-storage";
import { DaemonApi, isOwnershipError } from "@/runtime/rpc-client";
import { startVisibleInterval } from "@/runtime/visible-interval";
import type { OmpSessionController } from "@/runtime/omp-session-controller";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import {
  deriveAgents,
  mergeAgentRows,
  stateFromStatus,
  type DerivedAgent,
} from "@/domain/agents-from-transcript";
import { selectActivity, selectSessionTurn } from "@/runtime/omp-store";
import { useStoreValue } from "@/app/store-hooks";
import { desktopAgentsFromSnapshot, type DesktopAgent } from "@/domain/desktop-agents";
import { agentOutcome, type AgentOutcome } from "@/domain/agent-outcome";
import { closePanels } from "@/app/nav/panels";
import { DesktopAgentList } from "./DesktopAgentList";
import { AgentConversation } from "./AgentConversation";
import { DesktopAgentReply } from "./DesktopAgentReply";
import { useBackLayer } from "@/app/back-layer";
import type { AgentTranscriptReader, AgentTranscriptSource } from "@/runtime/agent-transcript-reader";
import {
  AGENT_ROW_CLASS,
  AGENT_STATE_LABEL,
  AgentSummary,
  AgentStatusGlyph,
  AgentTile,
  agentDisplayName,
  agentMeta,
  agentRing,
  agentStateFromStatus,
  derivedAgentState,
  desktopAgentState,
} from "./agent-status";
import { cn } from "@/lib/utils";
import { formatAgo, formatDuration } from "./format";
import { useWorkspaceHost } from "./workspace-host";

type AgentsPanelProps = {
  active: boolean;
  /** The Agents page is on screen; only then does Back close an open agent. */
  focused: boolean;
  sessionPath: string;
  controller: OmpSessionController;
  jumpTo: (entryId: string) => void;
  onPrepareResponse?: (sessionPath: string, context: AgentDiscussionReference) => string | null;
};

type AgentRow = {
  id: string;
  agent?: string;
  name?: string;
  displayName?: string;
  status?: string;
  createdAt?: number;
  sessionFile?: string;
  task?: string;
  lastIntent?: string;
  currentTool?: string;
  recentOutputTail?: string;
  /** Reported by the child's progress when it tracks them; absent otherwise. */
  durationMs?: number;
  tokens?: number;
  /** The serving model's identity (`provider/id`), its window and the last turn's context size. */
  model?: string;
  contextWindow?: number;
  contextTokens?: number;
};

function getAgentId(a: unknown): string | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  for (const k of ["id", "agentId", "agent_id"]) {
    if (typeof o[k] === "string" && (o[k] as string).trim())
      return o[k] as string;
  }
  return null;
}

function getAgentName(a: AgentRow): string {
  return a.agent || a.name || a.displayName || a.id;
}

function progressLine(a: AgentRow): string {
  if (a.lastIntent) return a.lastIntent;
  if (a.currentTool) return `Using ${a.currentTool}`;
  if (a.task) return a.task;
  if (a.recentOutputTail) return a.recentOutputTail.slice(0, 80);
  return "";
}

function hubSnapshotList(data: unknown): AgentRow[] {
  if (!data || typeof data !== "object") return [];
  const o = data as Record<string, unknown>;
  const candidates: unknown[] = [];
  if (Array.isArray(o.agents)) candidates.push(...o.agents);
  if (Array.isArray(o.subagents)) candidates.push(...o.subagents);
  if (Array.isArray(o.items)) candidates.push(...o.items);
  return candidates.filter(
    (x): x is AgentRow => typeof x === "object" && x !== null,
  ) as AgentRow[];
}

export function AgentsTab({ sessionPath, active, focused }: { sessionPath: string; active: boolean; focused: boolean }): JSX.Element {
  const host = useWorkspaceHost();
  if (!host) {
    return <EmptyState icon={<BotIcon />} title="No chat open" description="Open a chat to see its agents." />;
  }
  return (
    <AgentsPanel
      active={active}
      focused={focused}
      sessionPath={sessionPath}
      controller={host.controller}
      jumpTo={host.jumpTo}
      onPrepareResponse={host.prepareAgentResponse}
    />
  );
}

function AgentsPanel({
  active: open,
  focused,
  sessionPath,
  controller,
  jumpTo,
  onPrepareResponse,
}: AgentsPanelProps) {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isOwned, setIsOwned] = useState(false);

  const store = controller.getStore();
  const messages = useStoreValue(store, (s) => s.messages);
  const collabAgents = useStoreValue(store, (s) => s.collabAgents);
  const settledAgents = useStoreValue(store, (s) => s.settledAgents);
  const turnLive = useStoreValue(store, (s) => selectSessionTurn(s, sessionPath ?? "") === "running");
  // The turn's start only matters while it runs.
  const turnStartedAt = useStoreValue(store, (s) => selectSessionTurn(s, sessionPath ?? "") === "running"
    ? selectActivity(s, sessionPath ?? "")?.turnStartedAt : undefined);
  const desktopAttached = useStoreValue(store, (s) => s.collabAttached || s.sessionAuthorities?.[sessionPath ?? ""]?.owner.kind === "collab");
  const sourceIdentity = (s: ReturnType<typeof store.getState>) => {
    const authority = s.sessionAuthorities?.[sessionPath ?? ""];
    return JSON.stringify([s.connection, s.collabAttached, authority?.daemonInstanceId, authority?.bindingEpoch, authority?.owner, authority?.confidence, authority?.connection]);
  };
  const sourceKey = useStoreValue(store, sourceIdentity);

  // Preserve the pre-existing RPC control/share guard independently of stricter
  // presentation validation. Even unusable duplicate rows must not unlock RPC.
  const hasDesktopIdentity = Array.isArray(collabAgents) && collabAgents.some((raw) => {
    if (!raw || typeof raw !== "object") return false;
    const agent = raw as Record<string, unknown>;
    return typeof agent.id === "string" && Boolean(agent.id) && agent.kind !== "main";
  });

  // A callback from an earlier opening must stay obsolete after reopening the
  // same session (including action-followup calls to load). Operation tokens
  // also gate feedback and synchronously block duplicate activations.
  const listVisit = useMemo(() => ({
    sessionPath,
    sourceKey,
    pending: null as object | null,
    action: null as object | null,
    share: null as object | null,
    roster: null as AbortController | null,
    source: "pending" as "pending" | "desktop" | "rpc" | "idle" | "unavailable",
  }), [open, sessionPath, controller, sourceKey]);
  const [rosterSnapshot, setRosterSnapshot] = useState<{ visit: object; baseline: unknown[]; agents: unknown[]; connectionId: string } | null>(null);
  const rosterAgents = rosterSnapshot?.visit === listVisit && rosterSnapshot.baseline === collabAgents ? rosterSnapshot.agents : collabAgents;
  const fromCollab = useMemo(() => desktopAgentsFromSnapshot(rosterAgents), [rosterAgents]);
  const hasDesktopRows = fromCollab.length > 0;
  const desktopSource = hasDesktopIdentity || desktopAttached || listVisit.source === "desktop";
  const desktopSourceRef = useRef(desktopSource);
  useLayoutEffect(() => { desktopSourceRef.current = desktopSource; }, [desktopSource]);
  const canUseRpc = useCallback(() => {
    const state = store.getState();
    const authority = state.sessionAuthorities?.[sessionPath ?? ""];
    return state.connection === "open" && authority?.owner.kind === "child" && authority.confidence === "confirmed" && authority.connection === "connected";
  }, [store, sessionPath]);
  const currentListVisit = useRef<typeof listVisit | null>(null);
  // Rows are kept across closing and reopening the drawer and dropped only for
  // a different chat. Every opening starts a fresh visit that refetches, and
  // clearing here replayed the loading skeleton over a list the phone already
  // had. Retained rows grant nothing: actions need `listVisit.source === "rpc"`
  // and a confirmed owner, which a new visit only regains once its probe lands.
  const agentsFor = useRef(sessionPath);
  useLayoutEffect(() => {
    currentListVisit.current = open && sessionPath ? listVisit : null;
    if (agentsFor.current !== sessionPath) { agentsFor.current = sessionPath; setAgents([]); }
    setRosterSnapshot(null);
    listVisit.source = "pending";
    setError(null);
    setIsOwned(false);
    setLoading(false);
    setSharing(false);
    setShareNote(null);
    setSteerId(null);
    setSteerText("");
    setActionPending(false);
    setActionError(null);
    return () => { currentListVisit.current = null; listVisit.roster?.abort(); listVisit.roster = null; };
  }, [open, sessionPath, listVisit]);

  const [sharing, setSharing] = useState(false);
  const [shareNote, setShareNote] = useState<string | null>(null);
  const [steerId, setSteerId] = useState<string | null>(null);
  const [steerText, setSteerText] = useState("");
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * Subagents read from the WHOLE transcript by the daemon.
   *
   * `deriveAgents` can only see the messages the chat is holding — the last
   * page — so a session that spawned dozens showed none of them and the sheet
   * concluded they lived on the computer. They were in the transcript throughout.
   * Paging to them from here is not viable: measured on a live session the
   * `task` calls sat 7,600 to 10,700 entries from the end, which is 55 requests
   * at 200 an request. `/api/agents` scans the file once, which is the same
   * reason `/api/turns` exists.
   */
  const [scanned, setScanned] = useState<DerivedAgent[] | null>(null);
  const scannedFor = useRef(sessionPath);
  useEffect(() => {
    // Completed scans belong to this opening/session too: cancellation only
    // protects pending reads, leaving old rows visible if the next scan fails.
    if (scannedFor.current !== sessionPath) { scannedFor.current = sessionPath; setScanned(null); }
    if (!open || !sessionPath) return;
    let cancelled = false;
    void (async () => {
      try {
        const token = readPairingToken();
        const qs = new URLSearchParams({ session: sessionPath, limit: "200" });
        const res = await fetchWithDeadline(`/api/agents?${qs}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok || cancelled || currentListVisit.current !== listVisit) return;
        const body = (await res.json()) as {
          agents?: {
            callId?: string;
            name?: string;
            agent?: string;
            intent?: string;
            entryId?: string;
            at?: string;
          }[];
        };
        if (cancelled || currentListVisit.current !== listVisit || !Array.isArray(body.agents)) return;
        setScanned(
          body.agents.map((a) => ({
            id: a.callId ?? "",
            name: a.name ?? "task",
            intent: a.agent
              ? `${a.agent}${a.intent ? ` · ${a.intent}` : ""}`
              : (a.intent ?? undefined),
            // The scan cannot say how a past subagent ended; "ok" claims only
            // that it was started. Statuses the chat holds are laid over it.
            state: "ok" as const,
            // The scan's name is the task's own name, which omp uses as the agent's id.
            ...(a.name ? { agentId: a.name } : {}),
            startedAt:
              a.at && Number.isFinite(Date.parse(a.at))
                ? new Date(a.at)
                : undefined,
          })),
        );
      } catch {
        // Best effort: the loaded window is still derived from below.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sessionPath, listVisit]);

  const fromWindow = useMemo(
    () => deriveAgents(messages, { live: turnLive, turnStartedAt, now: Date.now(), settled: settledAgents }),
    [messages, turnLive, turnStartedAt, settledAgents],
  );
  // Recorded parent tasks are a distinct fallback, never agent transcripts.
  // The scan reaches the whole file but knows no outcomes, so each row takes
  // what the loaded window (or a completion notice) says about the same agent.
  // The scan runs once per opening, so rows spawned later exist only in the
  // window: merge rather than prefer the scan, or they hide until a reopen.
  const derived = useMemo(() => {
    if (scanned === null || scanned.length === 0) return fromWindow;
    const known = new Map<string, DerivedAgent["state"]>();
    for (const agent of fromWindow) if (agent.agentId) known.set(agent.agentId, agent.state);
    const corrected = scanned.map((agent) => {
      if (!agent.agentId) return agent;
      const settled = settledAgents[agent.agentId];
      const state = known.get(agent.agentId) ?? (settled === undefined ? undefined : stateFromStatus(settled));
      return state === undefined || state === agent.state ? agent : { ...agent, state };
    });
    return mergeAgentRows(corrected, fromWindow);
  }, [scanned, fromWindow, settledAgents]);
  const callIdToEntryId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of messages) {
      if (!m.sourceEntryId) continue;
      for (const p of m.parts) {
        if (p.kind !== "tool") continue;
        if (!map[p.callId]) map[p.callId] = m.sourceEntryId;
      }
    }
    return map;
  }, [messages]);
  // The chat owns scrolling to an entry (and fences its own late jumps).
  const handleDerivedTap = useCallback(
    (agent: Pick<DerivedAgent, "id">) => {
      const entryId = callIdToEntryId[agent.id.split(":")[0] ?? ""] ?? callIdToEntryId[agent.id];
      if (!entryId) return;
      currentListVisit.current = null;
      closePanels();
      jumpTo(entryId);
    },
    [callIdToEntryId, jumpTo],
  );
  const load = useCallback(async (quiet = false) => {
    if (currentListVisit.current !== listVisit || !listVisit.sessionPath || desktopSourceRef.current || listVisit.source !== "rpc" || !canUseRpc()) return;
    // Quiet ticks never displace a slow read. Explicit refreshes can supersede
    // it, but only the latest request may publish state or release loading.
    if (quiet && listVisit.pending) return;
    const request = {};
    listVisit.pending = request;
    const isCurrent = () => currentListVisit.current === listVisit && listVisit.pending === request && listVisit.source === "rpc" && !desktopSourceRef.current && canUseRpc();
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const api = new DaemonApi(readPairingToken());
      const raw = await api.getSubagents(listVisit.sessionPath);
      if (!isCurrent()) return;
      let list: AgentRow[] = [];
      if (raw && typeof raw === "object") {
        list = hubSnapshotList(raw);
        if (list.length === 0 && Array.isArray(raw)) list = raw as AgentRow[];
      }
      const normalized = list
        .map((a) => {
          if (!a || typeof a !== "object") return null;
          const id = getAgentId(a);
          if (!id) return null;
          const rec = a as AgentRow & { progress?: Record<string, unknown> };
          const p = rec.progress;
          const out: AgentRow = { ...a, id };
          if (p && typeof p === "object") {
            if (typeof p.lastIntent === "string") out.lastIntent = p.lastIntent;
            if (typeof p.durationMs === "number" && Number.isFinite(p.durationMs)) out.durationMs = p.durationMs;
            if (typeof p.tokens === "number" && Number.isFinite(p.tokens) && p.tokens > 0) out.tokens = p.tokens;
            // omp's progress names the model that actually served the turn
            // (identity `provider/id`; the selector adds `:thinking`), the
            // last assistant turn's context size and that model's window.
            for (const key of ["resolvedModelIdentity", "resolvedModel"] as const) {
              const value = p[key];
              if (typeof value === "string" && value.trim()) { out.model = value.trim(); break; }
            }
            for (const key of ["contextTokens", "contextWindow"] as const) {
              const value = p[key];
              if (typeof value === "number" && Number.isFinite(value) && value > 0) out[key] = value;
            }
            if (typeof p.currentTool === "string")
              out.currentTool = p.currentTool;
            if (typeof p.task === "string" && out.task == null)
              out.task = p.task as string;
            if (
              Array.isArray(p.recentOutput) &&
              (p.recentOutput as unknown[]).length
            ) {
              const arr = p.recentOutput as unknown[];
              const last = arr[arr.length - 1];
              if (typeof last === "string") out.recentOutputTail = last;
            }
          }
          return out;
        })
        .filter((x): x is AgentRow => x !== null);
      setAgents(normalized);
      setIsOwned(false);
    } catch (e) {
      if (!isCurrent()) return;
      if (isOwnershipError(e)) {
        setIsOwned(true);
        setError(null);
        setAgents([]);
      } else {
        setIsOwned(false);
        setError(humanizeDaemonError(e));
        setAgents([]);
      }
    } finally {
      if (isCurrent()) {
        listVisit.pending = null;
        setLoading(false);
      }
    }
  }, [listVisit, canUseRpc]);

  const probeRoster = useCallback(async () => {
    if (currentListVisit.current !== listVisit || !listVisit.sessionPath || listVisit.roster) return;
    const request = new AbortController();
    listVisit.roster = request;
    const baseline = store.getState().collabAgents;
    const isCurrent = () => currentListVisit.current === listVisit && listVisit.roster === request;
    setLoading(true);
    setError(null);
    try {
      const result = await new DaemonApi(readPairingToken()).getDesktopAgentRoster(listVisit.sessionPath, request.signal);
      if (!isCurrent()) return;
      // An event received while this snapshot was in flight is newer, even if
      // its roster is empty. Never restore old rows over that event.
      if (store.getState().collabAgents !== baseline) { listVisit.source = "desktop"; return; }
      if (!result || result.ok !== true || !Array.isArray(result.agents) || typeof result.connectionId !== "string" || !result.connectionId) {
        throw new Error("Your computer sent an agent list that couldn’t be read.");
      }
      listVisit.source = "desktop";
      setAgents([]);
      setIsOwned(false);
      setRosterSnapshot({ visit: listVisit, baseline, agents: result.agents, connectionId: result.connectionId });
    } catch (cause) {
      if (!isCurrent()) return;
      if (store.getState().collabAgents !== baseline) { listVisit.source = "desktop"; return; }
      const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
      // A failed read probe is never permission to boot an RPC child. Retain
      // the established RPC path only with a current, confirmed child owner.
      if (code === "host_unavailable" && canUseRpc() && !desktopSourceRef.current) {
        listVisit.source = "rpc";
        await load();
      } else if (code === "host_unavailable" && !desktopSourceRef.current && ["none", "bridge"].includes(store.getState().sessionAuthorities?.[listVisit.sessionPath]?.owner.kind ?? "")) {
        // No live roster exists for this owner, and that is normal, not a
        // fault: nothing owns an idle phone-hosted session, and a desktop omp
        // reached through the extension bridge never publishes one (only a
        // shared collab room does). Both used to put "Couldn't get agents
        // from your computer. Reconnect" on the tab. Agents the chat started
        // still show from the transcript scan and open from their retained
        // files; otherwise the empty state says so.
        listVisit.source = "idle";
      } else {
        listVisit.source = "unavailable";
        setError(code === "host_unavailable" ? "Couldn’t get agents from your computer. Reconnect, then retry." : humanizeDaemonError(cause));
      }
    } finally {
      if (isCurrent()) { listVisit.roster = null; setLoading(false); }
    }
  }, [listVisit, store, canUseRpc, load]);

  const handleShare = useCallback(async () => {
    if (currentListVisit.current !== listVisit || !listVisit.sessionPath || listVisit.share) return;
    const request = {};
    listVisit.share = request;
    const isCurrent = () => currentListVisit.current === listVisit && listVisit.share === request;
    setSharing(true);
    setShareNote(null);
    try {
      await new DaemonApi(readPairingToken()).collabAttach(listVisit.sessionPath);
      if (!isCurrent()) return;
      setShareNote("Sharing requested. Agents appear when your computer sends its list.");
      await load();
    } catch (e) {
      if (isCurrent()) setShareNote(humanizeDaemonError(e));
    } finally {
      if (isCurrent()) {
        listVisit.share = null;
        setSharing(false);
      }
    }
  }, [load, listVisit]);

  const shareCta = !desktopSource ? (
    <div className="flex flex-col gap-2">
      <Button
        className="w-full text-meta font-semibold"
        disabled={sharing}
        onClick={() => void handleShare()}
        type="button"
        variant="secondary"
      >
        {sharing ? "Asking…" : "Ask your computer to share"}
      </Button>
      {shareNote ? (
        <p className="px-4 text-meta leading-[1.45] text-muted-foreground">{shareNote}</p>
      ) : null}
    </div>
  ) : null;

  useEffect(() => {
    if (!open) {
      setError(null);
      setIsOwned(false);
      setSharing(false);
      setShareNote(null);
      setSteerId(null);
      setSteerText("");
      setActionError(null);
      return;
    }
    void probeRoster();
  }, [open, probeRoster]);

  // Depend on whether anything runs, not on the list itself: every poll
  // publishes a fresh array, which tore down and recreated the interval.
  // A live child can spawn subagents at any moment, so the list is re-read
  // slowly even while nothing runs; polling only while something ran left a
  // sheet opened while idle on "No agents" after the agent spawned some.
  const busy = agents.some((a) => a.status?.toLowerCase() === "running") || fromWindow.some((a) => a.state === "running");
  useEffect(() => {
    if (!open || isOwned || listVisit.source !== "rpc") return;
    // No hidden polling; restore the roster immediately on return.
    return startVisibleInterval(() => void load(true), busy ? 3000 : 10000, { tickOnShow: true });
  }, [open, isOwned, busy, load, listVisit]);
  // A `task` call that starts in the chat spawns its subagents now: read the
  // list at once instead of waiting for the next tick.
  const runningTasks = fromWindow.filter((a) => a.state === "running").map((a) => a.id).join("\n");
  useEffect(() => {
    if (open && listVisit.source === "rpc" && runningTasks) void load(true);
  }, [open, listVisit, runningTasks, load]);

  const handleSteerSend = useCallback(
    async (id: string) => {
      const text = steerText.trim();
      if (currentListVisit.current !== listVisit || !listVisit.sessionPath || !text || listVisit.action || isOwned || desktopSource || listVisit.source !== "rpc" || !canUseRpc()) return;
      // State alone cannot block a second activation before React commits.
      const request = {};
      listVisit.action = request;
      const isCurrent = () => currentListVisit.current === listVisit && listVisit.action === request;
      setActionPending(true);
      setActionError(null);
      try {
        await new DaemonApi(readPairingToken()).steerSubagent(listVisit.sessionPath, id, text);
        if (!isCurrent()) return;
        setSteerId(null);
        setSteerText("");
      } catch (e) {
        if (!isCurrent()) return;
        if (isOwnershipError(e)) setIsOwned(true);
        setActionError(humanizeDaemonError(e));
      } finally {
        if (isCurrent()) {
          listVisit.action = null;
          setActionPending(false);
        }
      }
    },
    [listVisit, steerText, isOwned, desktopSource, canUseRpc],
  );

  const handleStop = useCallback(
    async (id: string) => {
      if (currentListVisit.current !== listVisit || !listVisit.sessionPath || listVisit.action || isOwned || desktopSource || listVisit.source !== "rpc" || !canUseRpc()) return;
      // State alone cannot block a second activation before React commits.
      const request = {};
      listVisit.action = request;
      const isCurrent = () => currentListVisit.current === listVisit && listVisit.action === request;
      setActionPending(true);
      setActionError(null);
      try {
        await new DaemonApi(readPairingToken()).cancelSubagent(listVisit.sessionPath, id);
        if (!isCurrent()) return;
        await load();
      } catch (e) {
        if (!isCurrent()) return;
        if (isOwnershipError(e)) setIsOwned(true);
        setActionError(humanizeDaemonError(e));
      } finally {
        if (isCurrent()) {
          listVisit.action = null;
          setActionPending(false);
        }
      }
    },
    [listVisit, isOwned, desktopSource, load, canUseRpc],
  );

  type Conversation = {
    visit: typeof listVisit;
    id: string;
    source: AgentTranscriptSource;
    name: string;
    status: string;
    createdAt?: number;
    sessionFile?: string;
    connectionId?: string;
    unavailable?: boolean;
    trigger: HTMLButtonElement;
  };
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [sourceNotice, setSourceNotice] = useState<string | null>(null);
  const [lastSelection, setLastSelection] = useState<Pick<Conversation, "visit" | "id" | "source" | "createdAt"> | null>(null);
  useLayoutEffect(() => {
    // A row can be opened before the one-shot roster finishes. As soon as its
    // connection fence is known, replace that reader before an unfenced old
    // response can publish into the newly observed source.
    if (rosterSnapshot?.visit !== listVisit) return;
    setConversation((current) => current?.visit === listVisit && current.source === "desktop" && current.connectionId !== rosterSnapshot.connectionId
      ? { ...current, connectionId: rosterSnapshot.connectionId } : current);
  }, [rosterSnapshot, listVisit]);
  const readerRef = useRef<AgentTranscriptReader | null>(null);
  // Outcomes the agents' own transcripts showed this visit: the transcript scan
  // cannot tell them, so a file-source agent reads "Started" until opened.
  const [outcomes, setOutcomes] = useState<Readonly<Record<string, AgentOutcome>>>({});
  const backRef = useRef<HTMLButtonElement | null>(null);
  const rosterRef = useRef<HTMLDivElement | null>(null);
  const rosterScroll = useRef(0);
  const restoreRosterFocus = useRef(false);
  const currentAgent = conversation?.source === "desktop"
    ? fromCollab.find((agent) => agent.id === conversation.id && agent.createdAt === conversation.createdAt && (agent.hasSessionFile === false) === Boolean(conversation.unavailable))
    : conversation?.source === "file"
      ? derived.find((agent) => agent.agentId === conversation.id)
      : agents.find((agent) => agent.id === conversation?.id && agent.createdAt === conversation?.createdAt && agent.sessionFile === conversation?.sessionFile);
  const activeConversation = open && conversation?.visit === listVisit && currentAgent &&
    (conversation.source === "desktop" ? hasDesktopRows : conversation.source === "file" ? !hasDesktopRows : !desktopSource) ? conversation : null;
  const replyConversation = useRef<Conversation | null>(null);
  useLayoutEffect(() => { replyConversation.current = activeConversation; }, [activeConversation]);
  const replyEligible = currentAgent && "status" in currentAgent && ["running", "idle", "parked"].includes(currentAgent.status ?? "");
  const replyTarget = useMemo(() => {
    const authority = store.getState().sessionAuthorities?.[sessionPath];
    if (!activeConversation || activeConversation.source !== "desktop" || !activeConversation.connectionId
        || !replyEligible || activeConversation.createdAt === undefined || activeConversation.unavailable
        || !authority || !["bridge", "collab"].includes(authority.owner.kind)
        || authority.confidence !== "confirmed" || authority.connection !== "connected") return null;
    return {
      agentId: activeConversation.id,
      expectedCreatedAt: activeConversation.createdAt,
      expectedConnectionId: activeConversation.connectionId,
      daemonInstanceId: authority.daemonInstanceId,
      bindingEpoch: authority.bindingEpoch,
    };
  }, [activeConversation, sourceKey, sessionPath, store, replyEligible]);
  const replyIsCurrent = useCallback(() => {
    const state = store.getState();
    return currentListVisit.current === listVisit && replyConversation.current === activeConversation
      && state.connection === "open" && sourceIdentity(state) === listVisit.sourceKey
      && state.sessionPath === sessionPath && state.collabAgents === collabAgents
      && !state.authRejected;
  }, [listVisit, activeConversation, store, sessionPath, collabAgents]);
  const selectionPresent = lastSelection?.visit === listVisit && (lastSelection.source === "desktop"
    ? fromCollab.some((agent) => agent.id === lastSelection.id && agent.createdAt === lastSelection.createdAt)
    : lastSelection.source === "file" ? derived.some((agent) => agent.agentId === lastSelection.id)
    : !desktopSource && agents.some((agent) => agent.id === lastSelection.id && agent.createdAt === lastSelection.createdAt));
  useLayoutEffect(() => {
    if (lastSelection && !selectionPresent) setLastSelection(null);
  }, [lastSelection, selectionPresent]);

  const closeTranscript = useCallback(() => {
    readerRef.current?.dispose();
    readerRef.current = null;
    setConversation(null);
    setPrepareError(null);
  }, []);
  const backToAgents = useCallback(() => {
    restoreRosterFocus.current = true;
    closeTranscript();
  }, [closeTranscript]);
  useBackLayer(Boolean(activeConversation) && focused, { onBack: backToAgents });
  useLayoutEffect(() => {
    if (conversation && conversation.visit.sourceKey !== listVisit.sourceKey
        && conversation.visit.sessionPath === listVisit.sessionPath) {
      setSourceNotice("The session connection or ownership changed. Reopen the agent from the current list to continue reading.");
    } else setSourceNotice(null);
    closeTranscript();
    setLastSelection(null);
    return () => { readerRef.current?.dispose(); readerRef.current = null; };
  }, [listVisit, closeTranscript]);
  useLayoutEffect(() => {
    if (conversation && !activeConversation) {
      if (conversation.visit === listVisit && open) {
        setSourceNotice("This agent’s transcript identity or availability changed. Reopen it from the current list.");
      }
      closeTranscript();
    }
  }, [conversation, activeConversation, closeTranscript, listVisit, open]);
  useLayoutEffect(() => {
    const viewport = rosterRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (activeConversation) {
      if (viewport) viewport.scrollTop = 0;
      backRef.current?.focus({ preventScroll: true });
    } else if (restoreRosterFocus.current) {
      restoreRosterFocus.current = false;
      if (viewport) viewport.scrollTop = rosterScroll.current;
      const trigger = lastTrigger.current;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    }
  }, [activeConversation]);
  const lastTrigger = useRef<HTMLButtonElement | null>(null);
  const openConversation = (agent: { id: string; createdAt?: number; sessionFile?: string }, source: AgentTranscriptSource, name: string, status: string, trigger: HTMLButtonElement, unavailable = false) => {
    if (currentListVisit.current !== listVisit) return;
    readerRef.current?.dispose();
    rosterScroll.current = rosterRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')?.scrollTop ?? 0;
    lastTrigger.current = trigger;
    setLastSelection({ visit: listVisit, id: agent.id, source, createdAt: agent.createdAt });
    setSourceNotice(null);
    setPrepareError(null);
    setConversation({ visit: listVisit, id: agent.id, source, name, status, createdAt: agent.createdAt, sessionFile: source === "rpc" ? agent.sessionFile : undefined, connectionId: source === "desktop" && rosterSnapshot?.visit === listVisit ? rosterSnapshot.connectionId : undefined, unavailable, trigger });
  };
  // A drafted reference sends the user to the composer: the panel goes away.
  const leave = useCallback(() => {
    currentListVisit.current = null;
    listVisit.roster?.abort();
    listVisit.roster = null;
    restoreRosterFocus.current = false;
    setLastSelection(null);
    closeTranscript();
    closePanels();
  }, [closeTranscript, listVisit]);

  const prepareResponse = () => {
    if (!activeConversation || !sessionPath || !onPrepareResponse || currentListVisit.current !== listVisit) return;
    // React may not have committed an ownership/roster change yet. Fence the
    // tap against current store identity, not just the visible selection.
    if (activeConversation.source === "desktop" && !activeConversation.connectionId) return;
    const state = store.getState();
    if (state.sessionPath !== sessionPath || sourceIdentity(state) !== sourceKey || state.collabAgents !== collabAgents) {
      setPrepareError("The session or agent list changed. Reopen this agent and try again.");
      return;
    }
    const name = currentAgent && "displayName" in currentAgent && currentAgent.displayName ? currentAgent.displayName : currentAgent && "name" in currentAgent && currentAgent.name ? currentAgent.name : activeConversation.name;
    const context = agentDiscussionReference({ ...activeConversation, name });
    const error = onPrepareResponse(sessionPath, context);
    if (error) { setPrepareError(error); return; }
    leave();
  };

  const derivedList = hasDesktopRows ? (
    <DesktopAgentList
      agents={fromCollab}
      selectedId={lastSelection?.visit === listVisit && lastSelection.source === "desktop" && fromCollab.some((agent) => agent.id === lastSelection.id && agent.createdAt === lastSelection.createdAt) ? lastSelection.id : null}
      onOpen={(agent: DesktopAgent, trigger) => openConversation(agent, "desktop", agent.displayName ?? agent.id, AGENT_STATE_LABEL[desktopAgentState(agent.status)], trigger, agent.hasSessionFile === false)}
    />
  ) : (
    <RowGroup title="From this chat">
      {derived.map((a) => {
        const entryId = callIdToEntryId[a.id.split(":")[0] ?? ""] ?? callIdToEntryId[a.id];
        const state = (a.agentId ? outcomes[a.agentId] : undefined) ?? derivedAgentState(a.state);
        const ring = agentRing(state);
        return (
          <Row
            key={a.id}
            data-ring={ring}
            className={AGENT_ROW_CLASS}
            aria-current={a.agentId && lastSelection?.visit === listVisit && lastSelection.source === "file" && lastSelection.id === a.agentId ? "true" : undefined}
            // omp keeps every agent's own transcript beside the chat: open it,
            // live or finished. Older calls that named no agent id still jump
            // to where the chat started them.
            onClick={a.agentId
              ? (event) => openConversation({ id: a.agentId! }, "file", a.name, AGENT_STATE_LABEL[state], event.currentTarget)
              : entryId ? () => handleDerivedTap(a) : undefined}
            leading={<AgentTile kind={a.name} state={state} />}
            leadingSize="tile"
            title={<span title={a.name} className="block min-w-0 truncate font-medium">{agentDisplayName(a.name)}</span>}
            // The transcript records who was asked what, not a model or usage;
            // a task with no known outcome reads "Started", never a guess.
            subtitle={agentMeta(state, a.startedAt ? formatAgo(a.startedAt) : undefined, a.intent)}
          />
        );
      })}
    </RowGroup>
  );

  const retry = () => void (listVisit.source === "rpc" ? load() : probeRoster());
  // Skeleton only when there is nothing to show yet; a reopened drawer keeps
  // its previous rows while the new visit re-reads.
  const awaitingFirstRows = loading && !hasDesktopRows && agents.length === 0 && derived.length === 0;
  let body: React.ReactNode;
  if (hasDesktopRows) body = derivedList;
  else if (awaitingFirstRows) {
    body = (
      <div aria-busy className="-mx-4 flex flex-col" data-testid="agents-loading">
        <RowSkeleton leading="tile" subtitle />
        <RowSkeleton leading="tile" subtitle />
      </div>
    );
  } else if (isOwned) {
    body = (
      <div className="flex flex-col gap-3">
        {derived.length > 0 ? derivedList : (
          <EmptyState
            title="No agents yet"
            description="This chat hasn’t started any. Your computer can share its live list."
            icon={<BotIcon />}
          />
        )}
        {shareCta}
      </div>
    );
  } else if (error) {
    // The transcript's own list still answers the question; the failed live
    // read only matters when there is nothing else to show.
    body = derived.length ? derivedList : (
      <Notice tone="danger" title="Couldn’t load agents." action={errorRecoveryAction(error) ?? { label: "Retry", onClick: retry }}>{error}</Notice>
    );
  } else if (agents.length === 0 && derived.length === 0) {
    body = (
      <EmptyState
        title="No agents yet"
        description={listVisit.source === "desktop" ? "Your computer reports no agents for this chat." : "Agents this chat starts appear here."}
        icon={<BotIcon />}
      />
    );
  } else if (agents.length === 0) {
    body = derivedList;
  } else {
    body = (
      <RowGroup>
        {agents.map((a) => {
          const id = a.id;
          const name = getAgentName(a);
          const line = progressLine(a);
          const state = agentStateFromStatus(a.status);
          const ring = agentRing(state);
          const canControl = state === "working" && !isOwned && !desktopSource && listVisit.source === "rpc" && canUseRpc();
          const isSteering = steerId === id && canControl;
          return (
            // The row and its controls are one agent.
            <div key={id} data-ring={ring} className="border-transparent!">
              <Row
                className={AGENT_ROW_CLASS}
                data-rpc-agent={id}
                aria-label={`Open ${name} conversation`}
                aria-current={lastSelection?.visit === listVisit && lastSelection.source === "rpc" && lastSelection.id === id && lastSelection.createdAt === a.createdAt ? "true" : undefined}
                onClick={(event) => openConversation(a, "rpc", name, AGENT_STATE_LABEL[state], event.currentTarget)}
                leading={<AgentTile kind={a.agent ?? name} state={state} />}
                leadingSize="tile"
                // Ellipsis needs a shrinkable text child, not anonymous flex text.
                title={<span title={name} className="block min-w-0 truncate font-medium">{agentDisplayName(name)}</span>}
                subtitle={agentMeta(state, a.durationMs !== undefined ? formatDuration(a.durationMs) : a.createdAt ? formatAgo(a.createdAt) : undefined, line)}
              />
              {canControl ? (
                // Indented to the title: 4px margin + 12px pad + 36px tile + 12px gap.
                <div className="flex gap-1.5 pb-2 pl-16 pr-4">
                  {isSteering ? (
                    <div className="flex flex-1 items-center gap-1.5">
                      <Input
                        autoFocus
                        value={steerText}
                        onChange={(e) => setSteerText(e.target.value)}
                        placeholder="Redirect the agent…"
                        aria-label={`Redirect ${name}`}
                        disabled={actionPending}
                        className="h-11 flex-1 rounded-md border-0 bg-surface-2"
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            !e.repeat &&
                            !e.nativeEvent.isComposing &&
                            e.nativeEvent.keyCode !== 229
                          ) void handleSteerSend(id);
                          if (e.key === "Escape") {
                            setSteerId(null);
                            setSteerText("");
                          }
                        }}
                      />
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void handleSteerSend(id)}
                        disabled={!steerText.trim() || actionPending}
                        className="shrink-0"
                      >
                        Send
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={actionPending}
                        onClick={() => {
                          setSteerId(null);
                          setSteerText("");
                        }}
                        className="shrink-0"
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={actionPending}
                        onClick={() => {
                          setSteerId(id);
                          setSteerText("");
                        }}
                      >
                        Redirect
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger"
                        disabled={actionPending}
                        onClick={() => void handleStop(id)}
                      >
                        Stop agent
                      </Button>
                    </>
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </RowGroup>
    );
  }

  const conversationName = activeConversation && currentAgent
    ? ("displayName" in currentAgent && currentAgent.displayName ? currentAgent.displayName : "name" in currentAgent && currentAgent.name ? currentAgent.name : activeConversation.name)
    : null;
  const conversationState = activeConversation && currentAgent
    ? activeConversation.source === "desktop"
      ? desktopAgentState((currentAgent as DesktopAgent).status)
      : activeConversation.source === "file"
        ? outcomes[activeConversation.id] ?? derivedAgentState((currentAgent as DerivedAgent).state)
        : agentStateFromStatus((currentAgent as AgentRow).status)
    : null;

  // The roster the page shows (same precedence as `body`), summarised on top.
  const listedStates = hasDesktopRows
    ? fromCollab.map((agent) => desktopAgentState(agent.status))
    : agents.length > 0 && !(isOwned || error)
      ? agents.map((agent) => agentStateFromStatus(agent.status))
      : derived.map((agent) => derivedAgentState(agent.state));

  return (
    <div data-testid="agents-tab" className="flex min-h-0 flex-1 flex-col">
      {activeConversation && conversationState ? (
        <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-hairline pr-4">
          <Button ref={backRef} type="button" variant="ghost" size="icon" onClick={backToAgents} aria-label="Back to agents">
            <ArrowLeftIcon className="size-5" aria-hidden />
          </Button>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-ui font-medium">{conversationName}</span>
            <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
              <AgentStatusGlyph state={conversationState} />
              {AGENT_STATE_LABEL[conversationState]} · Read only
            </span>
          </span>
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="px-4 pb-6 pt-3">
          <div ref={rosterRef} hidden={Boolean(activeConversation)} data-testid="agent-roster">
            {awaitingFirstRows ? null : <AgentSummary states={listedStates} />}
            {sourceNotice ? <Notice tone="warning" className="mb-3" action={{ label: "Refresh agents", onClick: retry }} testId="agent-source-changed">{sourceNotice}</Notice> : null}
            {/* Keyed on loading so the list that replaces the skeleton fades in. */}
            <div key={awaitingFirstRows ? "loading" : "ready"} className="motion-safe:animate-fade-in">{body}</div>
          </div>
          {activeConversation && sessionPath ? (
            <AgentConversation
              sessionPath={sessionPath}
              selection={activeConversation}
              readerRef={readerRef}
              onBackToAgents={backToAgents}
              onMessages={activeConversation.source === "file" ? (messages) => {
                const outcome = agentOutcome(messages);
                const id = activeConversation.id;
                if (outcome) setOutcomes((current) => current[id] === outcome ? current : { ...current, [id]: outcome });
              } : undefined}
              live={conversationState === "working"}
              contextTokens={activeConversation.source === "rpc" ? (currentAgent as AgentRow | undefined)?.contextTokens : undefined}
            />
          ) : null}
          {!activeConversation && actionError ? (
            <Notice tone="danger" className="mt-3" action={errorRecoveryAction(actionError)}>{actionError}</Notice>
          ) : null}
        </div>
      </ScrollArea>
      {activeConversation && (onPrepareResponse || activeConversation.source === "desktop") ? (
        <div className="flex shrink-0 flex-col gap-2 border-t border-hairline px-4 pb-[max(env(safe-area-inset-bottom),12px)] pt-3">
          {replyTarget ? <DesktopAgentReply
            key={JSON.stringify([listVisit.sourceKey, sessionPath, replyTarget])}
            sessionPath={sessionPath}
            target={replyTarget}
            name={conversationName ?? activeConversation.name}
            isCurrent={replyIsCurrent}
            onBackToAgents={backToAgents}
          /> : activeConversation.source === "desktop" ? <p className="text-meta text-muted-foreground" data-testid="desktop-agent-reply-unavailable">Direct reply is unavailable for this agent or connection. Stopped work is never restarted automatically.</p> : null}
          {activeConversation.source === "desktop" && !activeConversation.connectionId ? (
            <Notice tone="warning" action={loading ? undefined : { label: "Back to agents", onClick: backToAgents }}>
              {loading ? "Waiting for your computer…" : "Couldn’t identify this agent on your computer."}
            </Notice>
          ) : null}
          {prepareError ? <Notice tone="danger" action={errorRecoveryAction(prepareError) ?? { label: "Back to agents", onClick: backToAgents }}>{prepareError}</Notice> : null}
          {onPrepareResponse ? <Button type="button" variant={replyTarget ? "secondary" : "primary"} className="w-full" onClick={prepareResponse} disabled={activeConversation.source === "desktop" && !activeConversation.connectionId} data-testid="agent-prepare-response">Discuss in main chat</Button> : null}
        </div>
      ) : null}
    </div>
  );
}
