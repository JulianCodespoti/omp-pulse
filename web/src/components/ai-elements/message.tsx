"use client";
// Derived from Vercel AI Elements (Apache-2.0, Copyright 2023 Vercel, Inc.); modified for omp-pulse. See NOTICE in this directory.

import { cn } from "@/lib/utils";
import { Markdown } from "@/components/markdown";
import type { UIMessage } from "ai";
import type { HTMLAttributes } from "react";
import { memo } from "react";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: UIMessage["role"];
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full flex-col gap-2",
      from === "user" ? "is-user ml-auto max-w-[85%] justify-end" : "is-assistant max-w-full",
      className,
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    data-message-box
    className={cn(
      "flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden",
      // Neutral: the user's words are content, not an action, so the bubble
      // spends no accent. Right-aligned, at most 85% of the column.
      // Code and paths step up one surface so they stay visible on the bubble.
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-xl group-[.is-user]:bg-user-bubble group-[.is-user]:px-4 group-[.is-user]:py-2.5 group-[.is-user]:text-body group-[.is-user]:text-foreground group-[.is-user]:[&_code]:!bg-surface-3 group-[.is-user]:[&_[data-testid=path-chip]]:!bg-surface-3",
      "group-[.is-assistant]:text-foreground",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageResponseProps = {
  children?: string;
  className?: string;
  isAnimating?: boolean;
  progressive?: boolean;
  eager?: boolean;
  readableTables?: boolean;
  onOpenPath?: (path: string) => void;
};

export const MessageResponse = memo(
  ({ className, children, isAnimating, progressive, eager, readableTables, onOpenPath }: MessageResponseProps) => (
    <Markdown
      // The reading measure for wide screens; the type scale is PROSE (app/parts/prose.ts).
      className={cn("size-full max-w-[68ch]", className)}
      isAnimating={isAnimating}
      progressive={progressive}
      eager={eager}
      readableTables={readableTables}
      onOpenPath={onOpenPath}
    >
      {children ?? ""}
    </Markdown>
  ),
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.isAnimating === nextProps.isAnimating &&
    prevProps.progressive === nextProps.progressive &&
    prevProps.eager === nextProps.eager &&
    prevProps.readableTables === nextProps.readableTables &&
    prevProps.onOpenPath === nextProps.onOpenPath,
);

MessageResponse.displayName = "MessageResponse";
