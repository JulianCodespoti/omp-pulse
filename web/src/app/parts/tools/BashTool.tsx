"use client";

import { useContext, useEffect, useMemo, useState } from "react";
import { SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ALERT_CANCEL, ALERT_DESTRUCTIVE, ConfirmDialog } from "@/app/ui/GroupedList";
import { haptic } from "@/platform/haptic";

import { DiffPart, looksLikeDiff } from "../DiffPart";
import { toolSummary } from "../tool-summary";
import { TranscriptActionsContext } from "../TurnNotices";
import { ArgsDetails, DetailNote, OutputBlock } from "./OutputBlock";
import { parseBashOutput } from "./bash-output";
import { commandFromArgs, shellOutcome, shellStatusLabel, toolKind, type ToolUiPart } from "./describe";

/**
 * Stop belongs to the command's own view, not to every row in the transcript.
 * omp has no per-tool-call cancel over RPC: `abort_bash` only reaches a
 * user-run `!cmd`, so a per-command abort spun while the command ran on.
 * Stopping an agent's command means stopping its turn, so this confirms and
 * then runs the chat's own Stop (same abort, same queued-message restore).
 */
function StopCommand({ running }: { running: boolean }) {
  const transcriptActions = useContext(TranscriptActionsContext);
  const [stopping, setStopping] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!running) setStopping(false);
  }, [running]);
  // Agent transcripts provide no chat Stop, so there is nothing honest to offer.
  if (!transcriptActions) return null;
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={stopping}
        data-testid="stop-command"
        onClick={() => setConfirming(true)}
      >
        {stopping ? <Spinner size={14} label={null} /> : <SquareIcon aria-hidden className="size-3.5 fill-current" />}
        {stopping ? "Stopping…" : "Stop"}
      </Button>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Stop the agent?"
        description="A command can’t be stopped on its own. This stops everything the agent is doing now."
        actions={
          <>
            <button
              type="button"
              className={ALERT_DESTRUCTIVE}
              onClick={() => {
                setConfirming(false);
                setStopping(true);
                haptic("medium");
                // A failure is reported by the chat's own Stop path.
                transcriptActions.stopTurn().catch(() => setStopping(false));
              }}
            >
              Stop agent
            </button>
            <button type="button" className={ALERT_CANCEL} onClick={() => setConfirming(false)}>
              Keep running
            </button>
          </>
        }
      />
    </>
  );
}

/** A shell call: one mono block (`$ command` + output), its exit status once, and Stop while it runs. */
export function BashTool({ part, sessionPath, live }: {
  part: ToolUiPart;
  sessionPath?: string | null;
  /** The call's turn is in flight, so a missing result means it is still running. */
  live: boolean;
}) {
  const command = commandFromArgs(part.args) || toolSummary(part.name, part.args);
  const raw = part.output ?? "";
  // The command's own bytes: structured outcomes come from `part.shell`, so
  // JSON a command printed is output, not an envelope to unwrap.
  const output = raw;
  const running = part.state === "running" && live;
  const failed = part.state === "error";
  const outcome = useMemo(() => shellOutcome(part), [part.shell, part.name, raw, failed]);
  // Keep ordinary diffs intact; coloured diffs keep raw Copy and the mono reader.
  const isDiff = useMemo(() => !failed && !!output && !parseBashOutput(output).hasControls && looksLikeDiff(output), [failed, output]);
  const canStop = running && toolKind(part.name) === "bash" && !!sessionPath;
  const status = running ? (
    <span className="flex items-center gap-1.5"><Spinner size={14} label={null} />Running</span>
  ) : part.state !== "running" ? (
    <span className={failed ? "tabular-nums text-danger" : "tabular-nums"}>{shellStatusLabel(outcome)}</span>
  ) : null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <OutputBlock
        text={isDiff ? "" : output}
        command={command}
        failed={failed}
        status={status}
        actions={canStop ? <StopCommand running={running} /> : null}
      />
      {isDiff ? <DiffPart text={output} /> : null}
      {part.pruned ? <DetailNote>Output removed from the transcript to save space.</DetailNote> : null}
      <ArgsDetails args={part.args} omit={["command", "cmd"]} />
    </div>
  );
}
