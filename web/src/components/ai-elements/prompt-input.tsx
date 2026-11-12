"use client";
// Derived from Vercel AI Elements (Apache-2.0, Copyright 2023 Vercel, Inc.); modified for omp-pulse. See NOTICE in this directory.

import type { ComponentProps, KeyboardEventHandler } from "react";
import { useCallback, useState } from "react";

import { cn } from "@/lib/utils";
import { useAppearance } from "@/platform/appearance";

export type PromptInputTextareaProps = ComponentProps<"textarea">;

/**
 * The composer's editor: Enter submits the surrounding form, Shift+Enter is a
 * newline. With Appearance → Enter key "New line", Enter is a newline and
 * Ctrl/Cmd+Enter submits. The caller's onKeyDown runs first and can claim the key with
 * preventDefault (the slash palette does, to pick a command instead).
 */
export function PromptInputTextarea({
  onKeyDown,
  onCompositionStart,
  onCompositionEnd,
  className,
  ...props
}: PromptInputTextareaProps) {
  const [isComposing, setIsComposing] = useState(false);
  const enterSends = useAppearance().enterKey === "send";

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (e) => {
      // IME candidate keys belong to the input method, before any external
      // slash-command handler can consume them. Safari may report code 229.
      if (isComposing || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      // A held Enter must not fire a burst of sends.
      if (e.key === "Enter" && e.repeat && !e.shiftKey) {
        e.preventDefault();
        return;
      }
      onKeyDown?.(e);
      if (e.defaultPrevented || e.key !== "Enter" || e.shiftKey) return;
      if (!enterSends && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const { form } = e.currentTarget;
      const submitButton = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
      if (submitButton?.disabled) return;
      form?.requestSubmit();
    },
    [onKeyDown, isComposing, enterSends],
  );

  return (
    <textarea
      className={cn("field-sizing-content w-full resize-none bg-transparent outline-none", className)}
      name="message"
      // The phone keyboard's Enter key says what it will do.
      enterKeyHint={enterSends ? "send" : "enter"}
      onCompositionEnd={(event) => { setIsComposing(false); onCompositionEnd?.(event); }}
      onCompositionStart={(event) => { setIsComposing(true); onCompositionStart?.(event); }}
      onKeyDown={handleKeyDown}
      {...props}
    />
  );
}
