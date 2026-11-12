"use client";

import { useEffect } from "react";
import type { JSX } from "react";
import { InboxIcon } from "lucide-react";

import { Markdown } from "@/components/markdown";
import { showToast } from "@/app/Notices";
import { ContextMeter } from "@/app/ui/ContextMeter";
import { BottomSheet, SheetGroup } from "@/app/ui/Sheet";
import { EmptyState } from "@/app/ui/EmptyState";
import { Notice } from "@/app/ui/Notice";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import { Row, RowGroup } from "@/app/ui/Row";
import { formatCommandResult } from "./format-result";
import { parseContextReport, type ContextReport } from "./context-report";
import type { UsageLimitsState } from "./usage-report";
import { UsagePanel } from "./UsagePanel";
import { cn } from "@/lib/utils";

export interface CommandResult {
  command: string;
  title: string;
  ok: boolean;
  data?: unknown;
  message?: string;
  /** Original failure, kept separate from the display copy for recovery routing. */
  recoveryError?: unknown;
  /** Plain text a slash command printed (omp's `command_output`). */
  output?: string;
  /** omp's native `/usage` quota windows: loading, failed, or parsed (with the raw text as a fallback). */
  limits?: UsageLimitsState;
  /** Where the figures came from — shown as a quiet footer in the sheet. */
  provenance?: "live" | "derived";
}

/** Bar colour by how close a /context share is to the cap. */
function limitFill(percent: number): string {
  return percent >= 90 ? "bg-danger" : percent >= 70 ? "bg-attention" : "bg-primary";
}

const tokenCount = new Intl.NumberFormat("en-US");

/** omp's `/context` breakdown: the used share as the hero, one row per category. */
function ContextBreakdown({ report }: { report: ContextReport }) {
  return (
    <div data-testid="context-breakdown" className="space-y-4">
      <div className="space-y-2.5 rounded-xl bg-surface-2 px-4 py-4">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-large-title font-semibold tabular-nums">{report.percent}%</span>
          <span className="text-meta tabular-nums text-muted-foreground">of {tokenCount.format(report.contextWindow)} tokens</span>
        </div>
        <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={report.percent} aria-label={`Context usage ${report.percent} percent`} className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
          <div className={cn("h-full rounded-full", limitFill(report.percent))} style={{ width: `${Math.min(100, Math.max(0, report.percent))}%` }} />
        </div>
      </div>
      {report.categories.length > 0 ? (
        <SheetGroup>
          {report.categories.map((category) => (
            <div key={category.label} data-testid="context-category" className="space-y-2 px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 text-ui text-foreground">{category.label}</span>
                <span className="shrink-0 text-ui tabular-nums text-muted-foreground">{tokenCount.format(category.tokens)}</span>
              </div>
              <div aria-hidden className="h-1 w-full overflow-hidden rounded-full bg-surface-3">
                <div className={cn("h-full rounded-full", category.label === "Free" ? "bg-muted-foreground/40" : "bg-primary")} style={{ width: `${Math.min(100, Math.max(0, category.percent))}%` }} />
              </div>
            </div>
          ))}
        </SheetGroup>
      ) : null}
      {report.notes.length > 0 ? (
        <p className="whitespace-pre-wrap break-words px-4 text-caption text-muted-foreground">{report.notes.join("\n")}</p>
      ) : null}
    </div>
  );
}

// A command that declined because there was nothing to do (compacting a
// short session) is not a failure; showing it as a red error alarmed people
// over a no-op.
const REFUSAL = /^nothing to\b|too small|already\b|no changes\b/i;

function refusalText(message: string): string {
  if (/nothing to compact/i.test(message)) return "Nothing to compact yet: the session is still small.";
  return message;
}

// Rows the context progress card already shows; listing them again in the
// table said every figure twice.
const PROGRESS_LABELS: Record<string, true> = {
  Used: true,
  "Used tokens": true,
  Usage: true,
  "Context used": true,
  "Context window": true,
};

export function CommandResultSheet({
  result,
  onOpenChange,
  onRetry,
  onRetryLimits,
}: {
  result: CommandResult | null;
  onOpenChange: (v: boolean) => void;
  onRetry?: () => void;
  /** Re-asks omp for the provider limits of a Usage result. */
  onRetryLimits?: () => void;
}): JSX.Element {
  // A command that declined because there was nothing to do is a passing
  // remark, not a destination: say it in a toast and never open the sheet.
  const refusal = result && !result.ok && result.message && REFUSAL.test(result.message) ? refusalText(result.message) : null;
  useEffect(() => {
    if (!refusal) return;
    showToast(refusal, "info");
    onOpenChange(false);
    // Keyed on the result, not the callback: a parent re-render must not
    // repeat the toast.
  }, [result]);
  const open = result !== null && refusal === null;
  // Callers often title with the raw `/command`; the sheet reads it as a word.
  const rawTitle = result?.title ?? result?.command ?? "Result";
  const bare = rawTitle.replace(/^\/+/, "");
  const title = rawTitle.startsWith("/") ? bare.charAt(0).toUpperCase() + bare.slice(1) : rawTitle;

  let content: React.ReactNode;
  if (!result || refusal) {
    content = null;
  } else if (!result.ok) {
    content = (
      <Notice
        tone="danger"
        action={errorRecoveryAction(result.recoveryError ?? result.message) ?? (onRetry ? { label: "Retry", onClick: onRetry } : undefined)}
        testId="command-error"
      >
        {humanizeDaemonError(result.message ?? "")}
      </Notice>
    );
  } else if (result.output !== undefined) {
    // What a command printed. Reports often arrive fenced; fenced text is
    // already preformatted, plain text keeps its own line breaks. omp's
    // `/context` table is redrawn as rows; any other text with bar glyphs is
    // a terminal table and only lines up in a monospace face.
    const context = result.command === "/context" ? parseContextReport(result.output) : null;
    content = context ? (
      <ContextBreakdown report={context} />
    ) : /^\s*```/.test(result.output) ? (
      <div data-testid="command-output" className="overflow-hidden rounded-xl bg-surface-2">
        <Markdown>{result.output}</Markdown>
      </div>
    ) : /[█░▓▒]/.test(result.output) ? (
      <pre data-testid="command-output" className="overflow-x-auto rounded-xl bg-surface-2 px-4 py-3.5 font-mono text-meta text-foreground">{result.output}</pre>
    ) : (
      <p data-testid="command-output" className="whitespace-pre-wrap break-words rounded-xl bg-surface-2 px-4 py-3.5 text-ui text-foreground">{result.output}</p>
    );
  } else {
    const formatted = formatCommandResult(result.command, result.data);
    const hasProgress = !!formatted.progress;
    const rows = hasProgress ? formatted.rows.filter((r) => !PROGRESS_LABELS[r.label]) : formatted.rows;
    const sections = (hasProgress
      ? formatted.sections?.map((s) => ({ ...s, rows: s.rows.filter((r) => !PROGRESS_LABELS[r.label]) }))
      : formatted.sections
    )?.filter((s) => s.rows.length > 0);

    const hasSections = !!sections && sections.length > 0;
    const hasRows = rows.length > 0;
    const hasJson = !!formatted.rawJson && !formatted.rows.length && !hasProgress;

    const kv = (list: { label: string; value: React.ReactNode }[], title?: string) => (
      <RowGroup title={title}>
        {list.map((r) => (
          <Row
            key={r.label}
            title={r.label}
            trailing={<span className="text-ui tabular-nums text-muted-foreground">{r.value}</span>}
          />
        ))}
      </RowGroup>
    );
    const p = formatted.progress;

    content = formatted.usage || result.limits ? (
      <UsagePanel formatted={formatted} limits={result.limits} provenance={result.provenance} onRetryLimits={onRetryLimits} />
    ) : (
      <div className="space-y-6">
        {p ? (
          <section aria-label="Context" className="space-y-2">
            <h3 className="text-meta font-medium text-muted-foreground">Context</h3>
            <ContextMeter
              size="full"
              percent={p.percent}
              usedTokens={p.max > 0 ? p.used : undefined}
              windowTokens={p.max > 0 ? p.max : undefined}
              testId="usage-context"
            />
            {p.tint === "red" || p.tint === "amber" ? (
              <p className="text-meta text-muted-foreground">
                {p.tint === "red" ? "Context is almost full. Compaction may run soon." : "Context is getting full."}
              </p>
            ) : null}
          </section>
        ) : null}

        {hasSections ? (
          sections!.map((sec) => <div key={sec.title}>{kv(sec.rows, sec.title)}</div>)
        ) : hasRows ? (
          kv(rows)
        ) : null}

        {hasJson ? <Markdown>{`\`\`\`json\n${formatted.rawJson}\n\`\`\``}</Markdown> : null}

        {!hasRows && !hasSections && !hasProgress && !hasJson ? (
          <EmptyState icon={<InboxIcon />} title="No data returned." className="py-2" />
        ) : null}
      </div>
    );
  }

  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      testId="command-result-sheet"
    >
      {content}
    </BottomSheet>
  );
}
