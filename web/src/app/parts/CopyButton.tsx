"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ClipboardAttempt } from "@/platform/clipboard";
import { haptic } from "@/platform/haptic";
import { showToast } from "../Notices";
import { CopyFeedbackIcon } from "./CopyFeedbackIcon";

export function CopyButton({
  text,
  label = "Copy",
  className,
  size = "icon",
  showLabel = false,
}: {
  text: string;
  label?: string;
  className?: string;
  /** `icon-sm` inside a 32px toolbar; both keep a 44px hit area. */
  size?: "icon" | "icon-sm";
  /** Show `label` beside the icon, where two copies sit side by side and an icon alone would not say which. */
  showLabel?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [attempt] = useState(() => new ClipboardAttempt());
  const timerRef = useRef<number | null>(null);

  useLayoutEffect(() => {
    setCopied(false);
    setCopying(false);
    return () => {
      attempt.cancel();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [attempt, text]);

  const handleCopy = useCallback(async () => {
    if (attempt.busy) return;
    setCopying(true);
    setCopied(false);
    const ok = await attempt.run(text);
    // A newer text value or unmounted control owns any subsequent feedback.
    if (ok === null) return;
    setCopying(false);

    if (!ok) {
      showToast("Couldn't copy. Try again or select the text.", "warn");
      return;
    }
    setCopied(true);
    haptic("light");
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, 1200);
  }, [attempt, text]);

  return (
    <Button
      aria-label={copying ? "Copying" : copied ? "Copied" : label}
      aria-busy={copying}
      disabled={copying}
      className={cn("shrink-0", showLabel && "relative h-8 gap-1.5 px-2 text-meta font-normal after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-['']", className)}
      size={showLabel ? "sm" : size}
      type="button"
      variant="ghost"
      onClick={handleCopy}
    >
      <CopyFeedbackIcon copied={copied} />
      {showLabel ? label : null}
    </Button>
  );
}
