import { ActivityIcon } from "lucide-react";
import { useState, type MouseEvent, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { UiMessage } from "@/domain/messages";

import { messageTime } from "../clock-time";
import { shortModel } from "../session-format";
import { AGENT_BUBBLE } from "./prose";

/**
 * Message style → Bubbles: the pieces a messenger gives every message. The
 * agent's avatar beside its bubble, and a tap that reveals when (and, for the
 * agent, by which model) the message was written.
 */

/** The agent's avatar: the app's pulse mark, in the accent colour. */
export function AgentAvatar({ className }: { className?: string }) {
  return (
    <span aria-hidden data-testid="agent-avatar" className={cn("flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-primary-text", className)}>
      <ActivityIcon className="size-3.5" />
    </span>
  );
}

/** What a tapped bubble reveals. */
export function messageInfo(message: UiMessage): string {
  const ms = message.createdAt?.getTime();
  const when = ms !== undefined && Number.isFinite(ms) ? messageTime(ms) : "";
  if (message.role === "user") return when ? `Sent ${when}` : "Sent";
  const output = message.usage?.output;
  return [when, message.model ? shortModel(message.model) : "", output ? `${output.toLocaleString()} tokens` : ""].filter(Boolean).join(" · ");
}

/**
 * A tap on the bubble toggles its info line. Taps that land on a link, chip
 * or button, or that end a text selection, keep their own meaning. The toggle
 * waits one task: the row's long-press handler (MessageActions) runs after
 * this one and cancels the click that ends a long-press, which must open the
 * actions sheet without also toggling the info.
 */
export function useBubbleInfo(): { open: boolean; onClick: (event: MouseEvent) => void } {
  const [open, setOpen] = useState(false);
  const onClick = (event: MouseEvent) => {
    if ((event.target as Element).closest("a,button,input,textarea,summary,[role=button]")) return;
    if (window.getSelection()?.isCollapsed === false) return;
    const native = event.nativeEvent;
    window.setTimeout(() => { if (!native.defaultPrevented) setOpen((value) => !value); }, 0);
  };
  return { open, onClick };
}

/** The info line. Always present for screen readers; shown on tap. */
export function BubbleInfo({ text, open, className }: { text: string; open: boolean; className?: string }) {
  if (!text) return null;
  return (
    <span data-testid="bubble-info" data-open={open ? "true" : undefined} className={cn(open ? "disclosure text-caption tabular-nums text-muted-foreground" : "sr-only", className)}>
      {text}
    </span>
  );
}

/** One agent text bubble with its avatar and tap-to-reveal info. */
export function AgentBubble({ message, children }: { message: UiMessage; children: ReactNode }) {
  const info = useBubbleInfo();
  return (
    <div className="my-1 flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-end gap-2">
        <AgentAvatar />
        <div className={cn(AGENT_BUBBLE, "cursor-default")} onClick={info.onClick} data-bubble-tap="" data-testid="agent-bubble">
          {children}
        </div>
      </div>
      <BubbleInfo text={messageInfo(message)} open={info.open} className="pl-8" />
    </div>
  );
}
