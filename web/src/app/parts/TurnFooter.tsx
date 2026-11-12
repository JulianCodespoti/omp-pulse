"use client";

import { GaugeIcon, RotateCcwIcon, SparklesIcon, SquareIcon, TimerIcon, Volume2Icon } from "lucide-react";
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuChoice, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Metric, MetricRow } from "@/app/ui/Metric";
import { showToast } from "@/app/Notices";
import { formatTokenRate } from "@/domain/token-rate";
import { useAppearance } from "@/platform/appearance";
import { haptic } from "@/platform/haptic";
import { speak, speechAvailable, stopSpeaking, useSpeaking } from "@/platform/speech";
import { clockTime } from "@/app/clock-time";
import { cn } from "@/lib/utils";
import { AgentAvatar } from "./Bubble";
import { CopyFeedbackIcon } from "./CopyFeedbackIcon";
import { ShimmerText } from "./ShimmerText";
import { stallNotice } from "../chat/stall-notice";

import { spokenDuration, useNow } from "./duration";

function FooterCopy({ onCopy }: { onCopy: () => unknown }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? "Copied" : "Copy reply"}
      data-testid="turn-copy"
      className="text-muted-foreground"
      onClick={async () => {
        const result = await onCopy();
        if (result === false) {
          showToast("Couldn't copy. Try again or select the text.", "warn");
          return;
        }
        setCopied(true);
        haptic("light");
        if (timer.current !== null) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => { timer.current = null; setCopied(false); }, 1200);
      }}
    >
      <CopyFeedbackIcon copied={copied} />
    </Button>
  );
}

/** Read the reply aloud; the same button stops it. */
function FooterSpeak({ text }: { text: string }) {
  const speaking = useSpeaking();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={speaking ? "Stop reading aloud" : "Read reply aloud"}
      data-testid="turn-speak"
      className="text-muted-foreground"
      onClick={() => (speaking ? stopSpeaking() : speak(text))}
    >
      {speaking ? <SquareIcon aria-hidden className="size-4" /> : <Volume2Icon aria-hidden className="size-4" />}
    </Button>
  );
}

/**
 * The one home of "working" for an assistant turn, and its quiet end.
 *
 * Live: the loader, what the agent is doing now and the turn's ticking clock.
 * Done: how long it worked and how fast it wrote, as icon + figure metrics,
 * then Copy and the ⋯ menu. A user's own stop is muted state, never an error
 * colour; a failed turn's error is told by the Notice above.
 */
export function TurnFooter({
  running,
  startedAt,
  endedAt,
  currentStep,
  stopped,
  error,
  tokensPerSecond,
  onCopy,
  speakText,
  durationShown,
  menu,
  onTryAgain,
  onTryAnotherModel,
  tryAgainDisabled,
  action,
  activityAt,
  stepShown = false,
}: {
  running: boolean;
  startedAt?: number;
  endedAt?: number;
  currentStep?: string;
  stopped?: boolean;
  error?: boolean;
  /** The turn's generation speed, when measured. */
  tokensPerSecond?: number | null;
  /** Return false when the copy failed; the footer then explains instead of confirming. */
  onCopy?: () => unknown;
  /** The reply's text; with it (and speech support) the footer offers Read aloud beside Copy. */
  speakText?: string;
  /** The turn's "Worked for" chip above the reply already says how long it took. */
  durationShown?: boolean;
  menu?: ReactNode;
  /** Re-run the turn from its prompt (the newest settled reply only). */
  onTryAgain?: () => void;
  /** Re-run the same turn on a model the reader picks first; shown in the Try again menu. */
  onTryAnotherModel?: () => void;
  tryAgainDisabled?: boolean;
  /** A live-only text action beside the step (e.g. cancelling a retry wait). */
  action?: { label: string; onClick: () => void };
  /** Live: when the turn last showed any sign of life; a long silence escalates the step line. */
  activityAt?: () => number;
  /** Live: a work group above already shows the step, so only the loader and the clock remain. */
  stepShown?: boolean;
}) {
  const now = useNow(running && (startedAt !== undefined || activityAt !== undefined));
  const { turnFooter, messageStyle } = useAppearance();
  const compact = turnFooter === "compact";
  const bubbles = messageStyle === "bubbles";
  if (running) {
    const elapsed = startedAt !== undefined ? spokenDuration(now - startedAt) : null;
    // `now` can predate the last activity between ticks; a negative idle is no stall.
    const stall = activityAt ? stallNotice(now - activityAt()) : null;
    const stepText = stall ?? currentStep;
    return (
      <div className="flex min-h-8 min-w-0 items-center gap-2 text-meta text-muted-foreground" data-testid="turn-footer" data-state="running">
        {bubbles ? (
          // A chat partner typing: ChatGPT's dot in a bubble.
          <>
          <AgentAvatar />
          <span aria-hidden data-testid="typing-bubble" className="flex h-8 shrink-0 items-center rounded-[calc(1.125rem*var(--radius-scale,1))] rounded-tl-md bg-surface-2 px-3">
            <LoadingDot />
          </span>
          </>
        ) : (
          <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center"><LoadingDot /></span>
        )}
        {/* ChatGPT's RotatingShimmerText: each new step crossfades in over 0.18s and shimmers. */}
        {stepShown && !stall ? <span className="flex-1" /> : (
          <span key={stepText || ""} className="min-w-0 flex-1 truncate animate-[status-in_180ms_ease-in-out] motion-reduce:animate-none" aria-live="off">
            <ShimmerText>{stepText || "Working…"}</ShimmerText>
          </span>
        )}
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            className="relative shrink-0 rounded-sm px-1 font-medium text-primary-text outline-none after:absolute after:-inset-x-2 after:-inset-y-3 after:content-[''] active:opacity-85 focus-visible:ring-2 focus-visible:ring-ring"
          >
            {action.label}
          </button>
        ) : null}
        {elapsed ? <Metric icon={TimerIcon} value={elapsed} label="Elapsed" live className="shrink-0" testId="turn-elapsed" /> : null}
      </div>
    );
  }
  const took = !durationShown && startedAt !== undefined && endedAt !== undefined ? spokenDuration(endedAt - startedAt) : null;
  const duration = took
    ? stopped ? `Stopped after ${took}` : error ? `Failed after ${took}` : `Worked for ${took}`
    : stopped && !durationShown ? "Stopped" : null;
  return (
    <div className={cn("-ml-2 flex min-h-8 min-w-0 items-center gap-1 text-meta text-muted-foreground", bubbles && "ml-6")} data-testid="turn-footer" data-state={stopped ? "stopped" : error ? "error" : "done"}>
      {bubbles && endedAt !== undefined ? (
        <span className="shrink-0 pl-2 tabular-nums" data-testid="turn-time">{clockTime(endedAt)}</span>
      ) : null}
      {/* Compact keeps Copy and ⋯: the menu is the reliable way into a reply's actions. */}
      {!compact && (duration || tokensPerSecond) ? (
        <MetricRow className="min-w-0 pl-2 pr-1">
          {duration ? <Metric icon={TimerIcon} value={duration} label="Duration" testId="turn-duration" /> : null}
          {tokensPerSecond ? <Metric icon={GaugeIcon} value={formatTokenRate(tokensPerSecond)} label="Speed" testId="turn-speed" /> : null}
        </MetricRow>
      ) : null}
      {onCopy ? <FooterCopy onCopy={onCopy} /> : null}
      {speakText && speechAvailable() ? <FooterSpeak text={speakText} /> : null}
      {onTryAgain ? (
        <DropdownMenu>
          {/* A menu, not a redo: the reader can re-run on another model from here. */}
          <DropdownMenuTrigger
            disabled={tryAgainDisabled}
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Try again"
                data-testid="turn-try-again"
                className="text-muted-foreground"
              />
            }
          >
            <RotateCcwIcon aria-hidden className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="start" sideOffset={8} data-testid="turn-try-again-menu">
            <DropdownMenuChoice data-testid="turn-try-again-same" icon={<RotateCcwIcon className="size-5" />} title="Try again" onClick={onTryAgain} />
            {onTryAnotherModel ? (
              <DropdownMenuChoice data-testid="turn-try-again-model" icon={<SparklesIcon className="size-5" />} title="Try with another model…" onClick={onTryAnotherModel} />
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {menu}
    </div>
  );
}

/** ChatGPT's LoadingDot: 8px, foreground, breathing 1 ↔ 1.25 every 0.625s. */
function LoadingDot(): JSX.Element {
  return <span data-testid="loading-dot" className="block size-2 rounded-full bg-foreground animate-[loading-dot_625ms_ease-in-out_infinite_alternate] motion-reduce:animate-none" />;
}
