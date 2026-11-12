import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from "react";
import { ArrowUpIcon, HistoryIcon, SquareIcon, SquareTerminalIcon } from "lucide-react";

import { Chip } from "@/app/ui/Chip";
import { EmptyState } from "@/app/ui/EmptyState";
import { Notice } from "@/app/ui/Notice";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import { Row, RowGroup } from "@/app/ui/Row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { readPairingToken } from "@/platform/browser-storage";
import { useStoreValue } from "@/app/store-hooks";
import { StatusDot, type StatusTone } from "@/app/ui/Status";
import type { ConnectionState, OmpStoreApi } from "@/runtime/omp-store";
import { DaemonApi, isOwnershipError } from "@/runtime/rpc-client";
import { consumeTerminalRequest, rejectTerminalRequest, useTerminalRequest, useWorkspaceHost } from "./workspace-host";
import { CARD_FORM, CARD_INPUT } from "./card-field";

const HISTORY_KEY = "omp-bash-history";
const HISTORY_LIMIT = 20;
const STOPPED_WAITING = "Stopped waiting. The command may still be running; check before running it again.";
/** Live output kept while a command runs; older text scrolls away first. */
const LIVE_LIMIT = 64 * 1024;

/** `text` appended to `live`, keeping the newest {@link LIVE_LIMIT} characters. */
export function appendLiveOutput(live: string, text: string): string {
  const next = live + text;
  return next.length > LIVE_LIMIT ? next.slice(next.length - LIVE_LIMIT) : next;
}

const CONNECTION_LINE: Record<ConnectionState, { tone: StatusTone; text: string }> = {
  open: { tone: "success", text: "Connected to your computer" },
  connecting: { tone: "warning", text: "Connecting…" },
  reconnecting: { tone: "warning", text: "Reconnecting…" },
  offline: { tone: "danger", text: "Offline. Commands can’t run" },
  error: { tone: "danger", text: "Connection problem. Commands can’t run" },
  closed: { tone: "danger", text: "Not connected. Commands can’t run" },
};

/** One quiet line saying whether a command can reach the computer. */
function ConnectionLine({ store }: { store: OmpStoreApi }): JSX.Element {
  const state = useStoreValue(store, (s) => s.connection);
  const line = CONNECTION_LINE[state];
  return (
    <p data-testid="terminal-connection" data-state={state} role="status" className="flex items-center gap-2 text-meta text-muted-foreground">
      <StatusDot tone={line.tone} />
      {line.text}
    </p>
  );
}

type BashEntry = {
  command: string;
  output: string;
  exitCode: number;
  truncated: boolean;
  cancelled: boolean;
  /** `!!cmd`: omp keeps this run out of the conversation's context. */
  excluded: boolean;
};

function loadHistory(): string[] {
  try {
    const arr: unknown = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string").slice(0, HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

/** Runs a shell command in the session folder, without asking the agent. */
export function TerminalTab({ sessionPath, active }: { sessionPath: string; active: boolean }): JSX.Element {
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [output, setOutput] = useState<BashEntry | null>(null);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [isOwned, setIsOwned] = useState(false);
  // Output of the running command so far; the reply's output replaces it.
  const [live, setLive] = useState("");
  const liveRun = useRef<string | null>(null);
  const liveView = useRef<HTMLPreElement | null>(null);
  const liveFollow = useRef(true);
  const host = useWorkspaceHost();
  const runRequest = useTerminalRequest();
  const seenIds = useRef<Set<string>>(new Set());
  const generation = useRef(0);
  const pending = useRef(false);
  const view = useRef({ sessionPath });
  view.current = { sessionPath };
  const commandRef = useRef(command);
  commandRef.current = command;
  const updateCommand = useCallback((value: string) => {
    commandRef.current = value;
    setCommand(value);
  }, []);
  const invalidate = useCallback(() => {
    generation.current++;
    pending.current = false;
    liveRun.current = null;
    setLive("");
    setRunning(false);
    setStopping(false);
  }, []);

  // A different chat runs somewhere else: nothing from the last one carries over.
  useLayoutEffect(() => {
    invalidate();
    seenIds.current.clear();
    setOutput(null);
    setIsOwned(false);
    setError(null);
    return invalidate;
  }, [sessionPath, invalidate]);

  // Another tab or chat may have added to the shared history.
  useLayoutEffect(() => {
    if (active) setHistory(loadHistory());
  }, [active]);

  // The open chat's controller carries every client's `bash_output` frames;
  // only this run's id is shown, so another chat's commands never leak in.
  const subscribeBashOutput = host?.controller.onBashOutput;
  useEffect(() => {
    if (!subscribeBashOutput) return;
    return subscribeBashOutput((runId, text) => {
      if (runId === liveRun.current) setLive((prev) => appendLiveOutput(prev, text));
    });
  }, [subscribeBashOutput]);

  // Follow new output unless the reader scrolled up to read earlier lines.
  useLayoutEffect(() => {
    const el = liveView.current;
    if (el && liveFollow.current) el.scrollTop = el.scrollHeight;
  }, [live]);

  const pushHistory = useCallback((cmd: string) => {
    setHistory((prev) => {
      const next = [cmd, ...prev.filter((c) => c !== cmd)].slice(0, HISTORY_LIMIT);
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      } catch {
        // Quota: history is a convenience.
      }
      return next;
    });
  }, []);

  const handleRun = useCallback(async (excludeFromContext = false) => {
    const submitted = commandRef.current;
    const cmd = submitted.trim();
    if (!cmd || pending.current || isOwned) return;
    const request = ++generation.current;
    pending.current = true;
    const current = () => request === generation.current && view.current.sessionPath === sessionPath;
    // Names this run's `bash_output` frames among every client's commands.
    const runId = `bash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    liveRun.current = runId;
    liveFollow.current = true;
    setLive("");
    setRunning(true);
    setError(null);
    setOutput(null);
    try {
      const res = await new DaemonApi(readPairingToken() ?? "").bash(sessionPath, cmd, excludeFromContext ? { excludeFromContext, runId } : { runId });
      if (!current()) return;
      if (res.id && seenIds.current.has(res.id)) return;
      if (res.id) seenIds.current.add(res.id);
      if (seenIds.current.size > 50) seenIds.current = new Set(Array.from(seenIds.current).slice(-20));
      setOutput({
        command: cmd,
        output: res.result?.output ?? "",
        exitCode: typeof res.result?.exitCode === "number" ? res.result.exitCode : 0,
        truncated: Boolean(res.result?.truncated),
        cancelled: Boolean(res.result?.cancelled),
        excluded: excludeFromContext,
      });
      pushHistory(cmd);
      if (commandRef.current === submitted) updateCommand("");
    } catch (e) {
      if (!current()) return;
      if ((e as Error)?.name === "AbortError") {
        setError(STOPPED_WAITING);
      } else {
        setIsOwned(isOwnershipError(e));
        setError(e);
      }
    } finally {
      if (current()) {
        pending.current = false;
        liveRun.current = null;
        setLive("");
        setRunning(false);
        setStopping(false);
      }
    }
  }, [sessionPath, isOwned, pushHistory, updateCommand]);

  // A composer `!cmd` runs once per request, exactly as if typed here and Run
  // tapped. The run starts from a task, not the effect itself: a remount during
  // mount (StrictMode, a lazy chunk resolving) re-runs the session reset above,
  // which would orphan a run already in flight, and re-sending would run the
  // command twice.
  useEffect(() => {
    if (!runRequest) return;
    if (runRequest.sessionPath !== sessionPath || !runRequest.isCurrent()) {
      rejectTerminalRequest("The conversation changed before the command started.", runRequest.id);
      return;
    }
    const timer = window.setTimeout(() => {
      if (!runRequest.isCurrent() || !active) {
        rejectTerminalRequest("The conversation changed before the command started.", runRequest.id);
        return;
      }
      if (pending.current || isOwned) {
        rejectTerminalRequest(isOwned
          ? "This conversation cannot run terminal commands here."
          : "A terminal command is already running. Your command is still in the composer.", runRequest.id);
        return;
      }
      if (!consumeTerminalRequest(runRequest.id)) return;
      updateCommand(runRequest.command);
      void handleRun(runRequest.excludeFromContext);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [runRequest, sessionPath, active, isOwned, handleRun, updateCommand]);

  const handleStop = useCallback(async () => {
    if (!pending.current || stopping) return;
    const request = generation.current;
    setStopping(true);
    try {
      // omp's `abort_bash` cancels the running user command; the run's own
      // reply then arrives marked cancelled, so the tab keeps waiting for it.
      await new DaemonApi(readPairingToken() ?? "").abortBash(sessionPath);
    } catch {
      if (request !== generation.current) return;
      // No confirmed cancel: stop waiting without claiming the command stopped.
      invalidate();
      setError(STOPPED_WAITING);
    }
  }, [sessionPath, stopping, invalidate]);

  // The command whose output is shown already heads that output.
  const recent = history.filter((h) => h !== output?.command).slice(0, 8);
  const failed = output !== null && (output.exitCode !== 0 || output.cancelled);

  return (
    <div data-testid="terminal-tab" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-4 pt-3">
        <div className={CARD_FORM}>
          <Input
            value={command}
            onChange={(e) => updateCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!e.repeat && !running && command.trim() && !isOwned) void handleRun();
              }
            }}
            placeholder="Run a command"
            aria-label="Command"
            className={cn(CARD_INPUT, "font-mono placeholder:font-sans")}
            disabled={running || isOwned}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="go"
          />
          {running ? (
            <Button variant="secondary" size="icon" onClick={() => void handleStop()} disabled={stopping} aria-label={stopping ? "Stopping command" : "Stop command"} className="shrink-0">
              {stopping ? <Spinner size={20} label={null} /> : <SquareIcon aria-hidden className="size-4" />}
            </Button>
          ) : isOwned ? null : (
            <Button
              variant={command.trim() ? "primary" : "secondary"}
              size="icon"
              onClick={() => void handleRun()}
              disabled={!command.trim()}
              aria-label="Run command"
              className="shrink-0"
              data-testid="bash-run"
            >
              <ArrowUpIcon aria-hidden className="size-5" />
            </Button>
          )}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 px-4 pb-6 pt-3">
          {host ? <ConnectionLine store={host.controller.getStore()} /> : null}
          {running ? (
            <p className="flex items-center gap-2 text-meta text-muted-foreground" aria-live="polite">
              <Spinner size={16} label={null} />
              Running…
            </p>
          ) : null}
          {running && live ? (
            <pre
              ref={liveView}
              onScroll={(e) => {
                const el = e.currentTarget;
                liveFollow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
              }}
              className="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-1 p-3 font-mono text-code text-foreground"
              data-testid="bash-live"
            >
              {live}
            </pre>
          ) : null}
          {error ? (
            error === STOPPED_WAITING ? (
              <p className="text-meta text-muted-foreground">{STOPPED_WAITING}</p>
            ) : (
              <Notice tone={isOwned ? "warning" : "danger"} action={errorRecoveryAction(error)}>{humanizeDaemonError(error)}</Notice>
            )
          ) : null}
          {output ? (
            <section className="flex min-w-0 flex-col gap-2" data-testid="bash-output">
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-code text-muted-foreground">$ {output.command}</span>
                {failed ? (
                  <Chip tone="danger">{output.cancelled ? "Cancelled" : `Exit ${output.exitCode}`}</Chip>
                ) : null}
              </div>
              <pre className="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-1 p-3 font-mono text-code text-foreground">
                {output.output || "No output"}
              </pre>
              {output.truncated ? <p className="text-meta text-muted-foreground">Output was cut short.</p> : null}
              {output.excluded ? (
                <p className="text-meta text-muted-foreground" data-testid="bash-excluded">Not added to the conversation.</p>
              ) : null}
            </section>
          ) : null}
          {recent.length > 0 ? (
            <RowGroup title="Recent">
              {recent.map((h) => (
                <Row key={h} leading={<HistoryIcon />} title={<span className="block truncate">{h}</span>} onClick={() => updateCommand(h)} />
              ))}
            </RowGroup>
          ) : null}
          {!output && !running && !error && recent.length === 0 ? (
            <EmptyState
              icon={<SquareTerminalIcon />}
              title="Run a command"
              description="Runs in this session’s folder on your computer, without asking the agent."
            />
          ) : null}
        </div>
      </ScrollArea>
    </div>
  );
}
