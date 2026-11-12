"use client";

import { ArrowUpIcon, CheckIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { UseDictationReturn } from "./use-dictation";

// More bars than any phone row fits: the container clips the oldest on the left.
const WAVE_BARS = 40;
const WAVE_TICK_MS = 80;

function formatElapsed(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/**
 * ChatGPT's recording waveform: thin rounded bars, newest on the right, the
 * history scrolling left. `level` changes only when the analyser reports, so a
 * fixed tick samples it: a quiet room still scrolls instead of freezing.
 */
function Waveform({ level }: { level: number }) {
  const [bars, setBars] = useState<number[]>(() => new Array<number>(WAVE_BARS).fill(0));
  const latest = useRef(level);
  latest.current = level;
  useEffect(() => {
    const timer = window.setInterval(() => setBars((previous) => [...previous.slice(1), latest.current]), WAVE_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="flex h-8 min-w-0 flex-1 items-center justify-end gap-[3px] overflow-hidden" aria-hidden>
      {bars.map((value, i) => (
        <span
          key={i}
          className="w-[3px] shrink-0 rounded-full bg-foreground"
          // sqrt lifts speech-level input (small raw values) into a visible range.
          style={{ height: `${Math.round(12 + 88 * Math.min(1, Math.sqrt(Math.max(0, value))))}%` }}
        />
      ))}
    </span>
  );
}

/**
 * Recording owns the composer's toolbar row so the state cannot be missed and
 * the three ways out are one tap each: throw it away (X), put the words in the
 * draft (check), or put them in and send (arrow). The text field above stays
 * visible and editable.
 */
export function DictationBar({ dictation, onInsert, onInsertAndSend, sendDisabled = false }: {
  dictation: UseDictationReturn;
  onInsert: () => void;
  onInsertAndSend: () => void;
  sendDisabled?: boolean;
}) {
  const { status, elapsedMs, remainingMs, level } = dictation;
  const recording = status === "recording";
  const nearLimit = recording && remainingMs > 0 && remainingMs <= 15_000;
  return (
    <div className="flex min-h-11 items-center gap-1" data-testid="dictation-bar">
      <Button
        variant="ghost"
        size="icon"
        // While transcribing the X stops the upload; the recording is kept for Retry.
        aria-label={recording ? "Cancel recording" : "Cancel transcription"}
        data-testid="dictation-cancel"
        onClick={() => dictation.cancel()}
        className="text-muted-foreground"
      >
        <XIcon aria-hidden />
      </Button>
      <div
        className="flex min-w-0 flex-1 items-center gap-2 text-ui tabular-nums text-foreground"
        role={recording ? "timer" : "status"}
        aria-live="off"
        data-testid="dictation-status"
      >
        {recording ? (
          <>
            <Waveform level={level} />
            <span className="shrink-0"><span className="sr-only">Recording </span>{formatElapsed(elapsedMs)}</span>
            {nearLimit ? (
              <span className="shrink-0 text-meta text-warning">{Math.ceil(remainingMs / 1000)}s left</span>
            ) : null}
          </>
        ) : (
          <>
            <Spinner size={16} label={null} className="text-muted-foreground" />
            <span className="truncate text-muted-foreground">
              {status === "requesting" ? "Starting microphone…" : "Transcribing…"}
            </span>
          </>
        )}
      </div>
      {recording ? (
        <>
          <Button variant="secondary" size="icon" aria-label="Insert transcript" data-testid="dictation-insert" onClick={onInsert}>
            <CheckIcon aria-hidden />
          </Button>
          <Button variant="primary" size="icon" aria-label="Insert and send" data-testid="dictation-send" disabled={sendDisabled} onClick={onInsertAndSend}>
            <ArrowUpIcon aria-hidden />
          </Button>
        </>
      ) : null}
    </div>
  );
}
