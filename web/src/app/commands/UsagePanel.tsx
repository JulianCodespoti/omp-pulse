"use client";

import type { JSX } from "react";

import { Markdown } from "@/components/markdown";
import { formatTokens, MeterBlock } from "@/app/ui/ContextMeter";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import { Row, RowGroup } from "@/app/ui/Row";
import { SheetError } from "@/app/ui/Sheet";
import type { FormatResult, FormattedSection } from "./format-result";
import { groupByAccount, type UsageLimit, type UsageLimitsState } from "./usage-report";

/**
 * One plan window as a labelled meter: window name + mono percentage on the
 * left, reset countdown on the right, and a full-width semantic bar below.
 */
function LimitWindow({ provider, limit }: { provider: string; limit: UsageLimit }): JSX.Element {
  const percent = Math.min(100, Math.max(0, limit.percent));
  const rounded = Math.round(percent);
  return (
    <MeterBlock
      label={limit.label}
      valueText={`${rounded}%`}
      detail={limit.resets ? `Resets in ${limit.resets}` : undefined}
      detailMono={false}
      percent={percent}
      ariaLabel={`${provider} ${limit.label}: ${rounded}% used`}
      testId="usage-limit"
      className="px-4 py-3"
    />
  );
}

/** The shape of two meters while omp is asked for the limits. */
function LimitsSkeleton(): JSX.Element {
  return (
    <RowGroup inset="sheet" title="Plan limits" testId="usage-limits-loading">
      <div role="status" aria-busy="true" className="divide-y divide-hairline">
        <span className="sr-only">Checking provider limits…</span>
        {[0, 1].map((i) => (
          <div key={i} aria-hidden className="flex flex-col gap-2.5 px-4 py-3.5">
            <div className="flex items-center justify-between gap-3">
              <span className="h-3.5 w-2/5 rounded-sm bg-surface-3" />
              <span className="h-3 w-1/5 rounded-sm bg-surface-3" />
            </div>
            <span className="h-1.5 w-full rounded-full bg-surface-3" />
          </div>
        ))}
      </div>
    </RowGroup>
  );
}

function Limits({ limits, onRetry }: { limits: UsageLimitsState; onRetry?: () => void }): JSX.Element | null {
  if (limits === "loading") return <LimitsSkeleton />;
  if ("error" in limits) {
    const recovery = errorRecoveryAction(limits.recoveryError ?? limits.error);
    return (
      <RowGroup inset="sheet" title="Plan limits" testId="usage-limits-error">
        <div className="px-4 py-1">
          <SheetError message={humanizeDaemonError(limits.error)} onRetry={onRetry} />
        </div>
        {recovery ? <Row title={recovery.label} chevron onClick={recovery.onClick} /> : null}
      </RowGroup>
    );
  }
  if (limits.providers.length === 0) {
    // Unparseable text is the raw fallback at the bottom; only an empty report says there is nothing.
    return limits.raw.trim() ? null : (
      <RowGroup inset="sheet" title="Plan limits">
        <Row title="No plan limits reported" />
      </RowGroup>
    );
  }
  return (
    <div data-testid="usage-limits" className="space-y-5">
      {limits.providers.map((provider) => (
        <RowGroup key={provider.name} inset="sheet" title={provider.name}>
          {groupByAccount(provider).map((group) => (
            <div key={group.account} role="group" aria-label={group.account || provider.name} className="flex min-w-0 flex-col">
              {group.account ? (
                <div className="flex min-w-0 items-center justify-between gap-2 border-b border-hairline bg-surface-3/35 px-4 py-2 text-meta text-muted-foreground">
                  <span className="min-w-0 truncate">{group.account}</span>
                  {group.inUse ? (
                    <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-hairline bg-surface-1 px-2.5 py-0.5 text-code text-foreground">
                      <span aria-hidden className="size-1.5 rounded-full bg-primary" />
                      used by this chat
                    </span>
                  ) : null}
                </div>
              ) : null}
              <div className="divide-y divide-hairline">
                {group.limits.map((limit) => (
                  <LimitWindow key={limit.label} provider={provider.name} limit={limit} />
                ))}
              </div>
            </div>
          ))}
        </RowGroup>
      ))}
    </div>
  );
}

/**
 * The Usage surface: this conversation first (context fill and one cost),
 * then plan limits per provider, then the token and message counts as a dense
 * mono grid. omp's unparseable limits text comes last, as a fallback.
 */
export function UsagePanel({
  formatted,
  limits,
  provenance,
  onRetryLimits,
}: {
  formatted: FormatResult;
  limits?: UsageLimitsState;
  provenance?: "live" | "derived";
  onRetryLimits?: () => void;
}): JSX.Element {
  const progress = formatted.progress;
  const cost = formatted.usage?.cost;
  const groups: FormattedSection[] = formatted.usage?.groups ?? (formatted.rows.length ? [{ title: "Details", rows: formatted.rows }] : []);
  const raw = limits && typeof limits === "object" && "raw" in limits && limits.providers.length === 0 ? limits.raw.trim() : "";
  const footer =
    provenance === "derived"
      ? "Counts cover only the messages loaded on this device; older messages may not be included."
      : "Counts cover the current context and restart after a compaction or branch.";

  const contextUsed = progress && progress.max > 0 ? formatTokens(progress.used) : "";
  const contextTotal = progress && progress.max > 0 ? formatTokens(progress.max) : "";
  const contextRounded = progress ? Math.round(Math.min(100, Math.max(0, progress.percent))) : 0;
  const contextDetail = contextUsed && contextTotal
    ? `${contextUsed} / ${contextTotal} · ${contextRounded}%`
    : `${contextRounded}%`;

  return (
    <div className="space-y-5">
      {progress || cost ? (
        <RowGroup inset="sheet" title="This conversation" testId="usage-summary">
          {progress ? (
            <MeterBlock
              label="Context"
              detail={contextDetail}
              percent={progress.percent}
              ariaLabel={`Context ${contextRounded}% used`}
              testId="usage-context"
              className="px-4 py-3.5"
              secondary={
                progress.tint === "red"
                  ? "Context is almost full. Compaction may run soon."
                  : progress.tint === "amber"
                    ? "Context is getting full."
                    : undefined
              }
            />
          ) : null}
          {cost ? (
            <Row
              title="Cost"
              subtitle={cost.scope || undefined}
              trailing={<span className="font-mono text-ui font-semibold tabular-nums text-foreground">{cost.value}</span>}
              testId="usage-cost"
            />
          ) : null}
        </RowGroup>
      ) : null}

      {limits ? <Limits limits={limits} onRetry={onRetryLimits} /> : null}

      {groups.length > 0 ? (
        <RowGroup inset="sheet" title="Details" footer={footer} testId="usage-details">
          {groups.map((group) => (
            <div key={group.title} className="px-4 py-3.5">
              <h3 className="pb-2.5 text-meta font-medium text-muted-foreground">{group.title}</h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                {group.rows.map((row) => (
                  <div key={row.label} className="min-w-0">
                    <dt className="text-meta text-muted-foreground">{row.label}</dt>
                    <dd className="font-mono text-ui font-medium tabular-nums text-foreground">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </RowGroup>
      ) : null}

      {raw ? (
        // omp printed limits this build cannot parse: show its text as-is,
        // never an empty code frame.
        <RowGroup inset="sheet" title="Provider limits" footer="Shown as received; this app couldn’t read its layout." testId="usage-limits">
          <div className="px-4 py-2">
            <Markdown>{/^\s*```/.test(raw) ? raw : `\`\`\`\n${raw}\n\`\`\``}</Markdown>
          </div>
        </RowGroup>
      ) : null}
    </div>
  );
}
