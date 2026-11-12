"use client";

import { MicIcon, MicOffIcon } from "lucide-react";
import { useState } from "react";
import { BottomSheet } from "../ui/Sheet";

import { Button } from "@/components/ui/button";
import type { UseDictationReturn } from "./use-dictation";

/**
 * The toolbar mic. A tap starts dictation; the recording bar then takes over
 * the toolbar (DictationBar) with Cancel, Insert and Insert and send, so the
 * button never has to double as a stop control or a hold-to-send gesture.
 */
export function VoiceButton({ dictation }: { dictation: UseDictationReturn }) {
  const { status, reason, lastError, error } = dictation;
  const [helpOpen, setHelpOpen] = useState(false);
  if (status === "unsupported") {
    const label = reason ?? "Voice input unavailable";
    return (
      <>
        <Button variant="ghost" size="icon" onClick={() => setHelpOpen(true)} aria-label="Voice input help" title={label} data-testid="voice-button" className="text-muted-foreground">
          <MicOffIcon aria-hidden />
        </Button>
        <BottomSheet open={helpOpen} onOpenChange={setHelpOpen} title="Voice input unavailable">
          <div className="space-y-3 pb-2 text-meta">
            <p>{label}</p>
            <p>Microphone recording needs a supported browser and a secure HTTPS or local connection. The connection guide explains how to reach your computer securely.</p>
            <Button type="button" variant="secondary" className="min-h-12 w-full" onClick={() => window.open("https://github.com/JulianCodespoti/omp-pulse#on-your-computer", "_blank", "noopener,noreferrer")}>Connection guide</Button>
          </div>
        </BottomSheet>
      </>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Dictate"
      title={status === "denied" ? (lastError ?? error ?? "Microphone blocked") : undefined}
      data-testid="voice-button"
      disabled={status === "requesting"}
      onClick={() => void dictation.start()}
      className="text-foreground"
    >
      <MicIcon aria-hidden strokeWidth={2} />
    </Button>
  );
}
