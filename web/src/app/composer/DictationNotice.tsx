import { useState } from "react";
import { CircleHelpIcon, DownloadIcon, MicIcon, RotateCwIcon, SettingsIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { isNativeShell } from "@/platform/native-shell";
import { getOmpLocal } from "@/platform/local-mode";
import { CopyButton } from "../parts/CopyButton";
import { ErrorNotice } from "../ui/ErrorNotice";
import { errorRecoveryAction } from "../ui/error-recovery";
import { daemonErrorCause } from "../ui/OwnedBySession";
import { BottomSheet } from "../ui/Sheet";
import type { UseDictationReturn } from "./use-dictation";

/** Recovery never sends a prompt or discards the recording kept for transcription. */
export function DictationNotice({ dictation, message, onDismiss, onRetry, className }: {
  dictation: UseDictationReturn;
  message: string;
  onDismiss: () => void;
  onRetry?: () => void;
  className?: string;
}) {
  const [help, setHelp] = useState<"microphone" | "speech" | null>(null);
  const raw = dictation.recoveryError;
  const text = raw instanceof Error ? raw.message : typeof raw === "string" ? raw : message;
  const needsSpeechSetup = /asr|parakeet|sherpa|speech.*(?:model|install)|transcrib.*(?:not installed|not configured|unavailable)|model.*(?:not installed|missing)/i.test(text);
  const retry = onRetry ?? (() => dictation.retry());
  const bridge = getOmpLocal();
  const action = dictation.status === "denied"
    ? typeof bridge?.openAppSettings === "function"
      ? { label: "Microphone settings", icon: SettingsIcon, onClick: () => bridge.openAppSettings?.() }
      : { label: "Microphone help", icon: CircleHelpIcon, onClick: () => setHelp("microphone") }
    : needsSpeechSetup ? { label: "Set up dictation", icon: DownloadIcon, onClick: () => setHelp("speech") }
      : dictation.canRetry && daemonErrorCause(raw ?? message) === "connection" ? { label: "Retry", icon: RotateCwIcon, onClick: retry }
      : errorRecoveryAction(raw ?? message) ?? (dictation.canRetry
        ? { label: "Retry", icon: RotateCwIcon, onClick: retry }
        : { label: "Record again", icon: MicIcon, onClick: () => void dictation.start() });
  return <>
    <ErrorNotice message={dictation.status === "denied" ? "Microphone access is blocked." : message} action={action} onDismiss={onDismiss} className={className} testId="dictation-error" />
    <BottomSheet open={help !== null} onOpenChange={(open) => { if (!open) setHelp(null); }} title={help === "microphone" ? "Microphone access" : "Set up dictation"}>
      <div className="space-y-3 pb-2 text-meta">
        {help === "microphone" ? <>
          <p>{isNativeShell() ? "Allow Microphone in Android app permissions." : "Allow this site to use your microphone in browser permissions."}</p>
          <details className="text-muted-foreground">
            <summary className="min-h-12 cursor-pointer py-3 focus-visible:outline-2 focus-visible:outline-ring">Permission help</summary>
            <p>{isNativeShell() ? "Open Android Settings → Apps → omp-pulse → Permissions. This version of the app cannot open that control directly." : "If device settings also block access, allow the microphone for this browser in system settings."}</p>
          </details>
          <Button type="button" className="min-h-12 w-full" onClick={() => { setHelp(null); void dictation.start(); }}>
            <MicIcon data-icon="inline-start" />
            Try microphone
          </Button>
        </> : <>
          <p>Install speech recognition on the device hosting omp-pulse—not necessarily this phone. Download: about 650 MB.</p>
          <div className="flex min-w-0 items-center gap-3">
            <code className="min-w-0 flex-1 select-text break-words font-mono [overflow-wrap:anywhere]">omp-pulse asr install</code>
            <CopyButton text="omp-pulse asr install" label="Copy setup command" className="size-[48px]" />
          </div>
          <details className="text-muted-foreground">
            <summary className="min-h-12 cursor-pointer py-3 focus-visible:outline-2 focus-visible:outline-ring">Setup details</summary>
            <p>Run the command in a terminal on that host, then return here.{dictation.canRetry ? " Retry uses your kept recording." : ""} Copying alone does not install anything.</p>
          </details>
          {dictation.canRetry ? <Button type="button" className="min-h-12 w-full" onClick={() => { setHelp(null); retry(); }}>
            <RotateCwIcon data-icon="inline-start" />
            Retry transcription
          </Button> : null}
        </>}
      </div>
    </BottomSheet>
  </>;
}
