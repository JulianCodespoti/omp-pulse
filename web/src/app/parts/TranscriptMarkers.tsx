"use client";

import { useState } from "react";
import type { JSX } from "react";
import {
  ChevronDownIcon,
  CircleCheckIcon,
  DatabaseIcon,
  GitBranchIcon,
  InfoIcon,
  MessageCircleIcon,
  PencilIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { TimelineItem, TimelineMarkerIcon } from "@/domain/timeline";

const MARKER_ICONS = {
  model: SparklesIcon,
  compaction: DatabaseIcon,
  job: CircleCheckIcon,
  agent: MessageCircleIcon,
  branch: GitBranchIcon,
  rename: PencilIcon,
} satisfies Record<TimelineMarkerIcon, typeof InfoIcon>;

/** The date is context, not chrome: a quiet centred word, no pill, no rules. */
export function DaySeparator({ label }: { label: string }): JSX.Element {
  return (
    <div className="flex justify-center py-1" data-testid="day-separator">
      <span className="text-meta tabular-nums text-tertiary">{label}</span>
    </div>
  );
}

/**
 * A session event in plain words ("Context compacted", "Renamed to “X”"):
 * a left-aligned muted line with a 14px icon, read in the transcript's flow
 * like the rows around it. Events with a summary open it in place.
 */
export function MarkerSeparator({
  label,
  tone = "muted",
  icon,
  detail,
}: {
  label: string;
  tone?: "muted" | "warn";
  icon?: TimelineMarkerIcon;
  detail?: string;
}): JSX.Element {
  const Icon = tone === "warn" ? TriangleAlertIcon : icon ? MARKER_ICONS[icon] : InfoIcon;
  const [open, setOpen] = useState(false);
  const caption = (
    <>
      <Icon className={cn("size-4 shrink-0", tone === "warn" && "text-warning")} aria-hidden />
      <span className="min-w-0 truncate" title={label}>{label}</span>
    </>
  );
  const captionClass = "flex min-h-6 min-w-0 max-w-full items-center gap-2 text-left text-meta text-muted-foreground";
  return (
    <div className="flex min-w-0 flex-col items-start" data-testid="transcript-marker">
      {detail ? (
        // The caption stays a quiet line; a 44px hit area comes from an inset that costs no height.
        <button type="button" aria-expanded={open} data-testid="marker-detail-toggle" onClick={() => setOpen((value) => !value)} className={cn(captionClass, "relative rounded-sm outline-none after:absolute after:-inset-y-2.5 after:inset-x-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring")}>
          {caption}
          <ChevronDownIcon className={cn("size-3.5 shrink-0 transition-transform duration-[var(--dur-base)] motion-reduce:transition-none", open && "rotate-180")} aria-hidden />
        </button>
      ) : (
        <span className={captionClass}>{caption}</span>
      )}
      {detail && open ? (
        <p data-testid="marker-detail" className="disclosure mt-1 max-h-[50dvh] w-full overflow-y-auto whitespace-pre-wrap break-words pl-6 text-meta text-muted-foreground">{detail}</p>
      ) : null}
    </div>
  );
}

export function TranscriptMarkers({
  item,
}: {
  item: Extract<TimelineItem, { kind: "day" | "marker" }>;
}): JSX.Element {
  if (item.kind === "day") return <DaySeparator label={item.label} />;
  return <MarkerSeparator label={item.label} tone={item.tone} icon={item.icon} detail={item.detail} />;
}
