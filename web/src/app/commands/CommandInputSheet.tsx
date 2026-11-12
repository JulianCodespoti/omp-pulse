"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { BottomSheet } from "../ui/Sheet";
import { requiresArgument, type OmpCommand } from "./command-registry";

export interface CommandInputSheetProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  command: OmpCommand | null;
  subcommand?: { name: string; description?: string; usage?: string } | null;
  onSubmit: (text: string) => void;
  /** Starts the field (the current title for a rename), selected so typing replaces it. */
  initialValue?: string;
}

/**
 * Commands whose argument has one obvious meaning get proper copy instead of
 * the generic "type an argument" prompt. A rename is a name, not a prompt.
 */
const COPY: Record<string, { title: string; placeholder: string; action: string }> = {
  rename: { title: "Rename session", placeholder: "New name", action: "Rename" },
};

export function CommandInputSheet({
  open,
  onOpenChange,
  command,
  subcommand,
  onSubmit,
  initialValue = "",
}: CommandInputSheetProps): JSX.Element {
  const [value, setValue] = useState("");
  const fieldRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const submitted = useRef(false);

  const copy = !subcommand && command ? COPY[command.name.toLowerCase()] : undefined;
  const placeholder = copy?.placeholder ?? subcommand?.usage ?? command?.hint ?? "Arguments";
  // `/todo start <task>` cannot run without its argument, but `/advisor dump
  // [raw]` is valid bare. Only block the send when omp says the argument is
  // required, or the sheet refuses commands the terminal accepts. A rename
  // always needs a name.
  const required = !!copy || requiresArgument(subcommand?.usage ?? command?.hint);
  const title =
    copy?.title ??
    (command ? (subcommand ? `/${command.name} ${subcommand.name}` : `/${command.name}`) : "Command");
  // The title already says what a known command does; repeating it is noise.
  const description = copy ? undefined : (subcommand?.description ?? command?.description ?? undefined);

  // Metadata refreshes are not a new input visit. Reset only when the actual
  // command route changes; a synchronous latch covers delayed parent closing.
  useLayoutEffect(() => {
    submitted.current = !open;
    if (open) setValue(initialValue);
    return () => { submitted.current = true; };
    // initialValue is read at the start of a visit only: a title arriving
    // mid-edit must not overwrite what the person is typing.
  }, [open, command?.name, command?.source, command?.shape, command?.rpc, subcommand?.name]);
  // Select the prefill once it is rendered (the value lands a render after
  // the visit starts), so typing replaces the old name.
  useEffect(() => {
    if (!open || !initialValue) return;
    const frame = requestAnimationFrame(() => fieldRef.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [open, initialValue]);

  const handleOpenChange = (next: boolean) => {
    if (!next) submitted.current = true;
    onOpenChange(next);
  };

  const handleSend = () => {
    if (!open || !command || submitted.current) return;
    const trimmed = value.trim();
    if (required && !trimmed) return;
    submitted.current = true;
    onSubmit(trimmed);
    onOpenChange(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!e.repeat) handleSend();
    }
  };

  const fieldClass =
    "rounded-md border-0 bg-surface-2 px-4 text-body shadow-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40";

  return (
    <BottomSheet
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      testId="command-input-sheet"
      description={description}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" type="button" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={required && !value.trim()}
            onClick={handleSend}
            type="button"
            variant="primary"
          >
            {copy?.action ?? "Send"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        {copy ? (
          <Input
            ref={fieldRef}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className={`h-11 ${fieldClass}`}
            enterKeyHint="done"
            autoFocus
          />
        ) : (
          <Textarea
            ref={fieldRef}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            rows={3}
            className={`min-h-24 resize-none py-3 ${fieldClass}`}
            autoFocus
          />
        )}
        {!required ? (
          <p className="px-4 text-meta text-muted-foreground">Optional. Leave empty to run without it.</p>
        ) : null}
      </div>
    </BottomSheet>
  );
}
