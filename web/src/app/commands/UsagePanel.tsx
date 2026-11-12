"use client";

import type { JSX } from "react";

import { Markdown } from "@/components/markdown";
import { ContextMeter } from "@/app/ui/ContextMeter";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import { Row, RowGroup } from "@/app/ui/Row";
import { SheetError } from "@/app/ui/Sheet";
import type { FormatResult, FormattedSection } from "./format-result";
import { groupByAccount, type UsageLimit, type UsageLimitsState } from "./usage-report";

/**
 * One plan window as a compact meter: name and reset on one line, the bar
 * under it. The bar is the shared context meter so "how full" reads the same
 * everywhere; the row itself is the labelled meter for assistive tech.
 */
function LimitWindow({ provider, limit }: { provider: string; limit: UsageLimit }): JSX.Element {
  const percent = Math.min(100, Math.max(0, limit.percent));
  return (
    <div
      role="meter"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${provider} ${limit.label}: ${Math.round(percent)}% used`}
      data-testid="usage-limit"
      className="flex flex-col gap-1.5 px-4 py-2.5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-ui text-foreground">{limit.label}</span>
        {limit.resets ? <span className="shrink-0 text-meta text-muted-foreground">Resets in {limit.resets}</span> : null}
      </div>
      <span aria-hidden className="flex">
        <ContextMeter size="full" percent={percent} />
      </span>
    </div>
  );
}

/** The shape of two meters while omp is asked for the limits. */
function LimitsSkeleton(): JSX.Element {
  return (
    <RowGroup title="Plan limits" testId="usage-limits-loading">
      <div role="status" aria-busy="true">
        <span className="sr-only">Checking provider limits…</span>
        {[0, 1].map((i) => (
          <div key={i} aria-hidden className="flex flex-col gap-2 px-4 py-3">
            <span className="h-3.5 w-2/5 rounded-sm bg-surface-2" />
            <span className="h-1.5 w-full rounded-full bg-surface-2" />
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
      <RowGroup title="Plan limits" testId="usage-limits-error">
        <div className="px-4">
          <SheetError message={humanizeDaemonError(limits.error)} onRetry={onRetry} />
        </div>
        {recovery ? <Row title={recovery.label} chevron onClick={recovery.onClick} /> : null}
      </RowGroup>
    );
  }
  if (limits.providers.length === 0) {
    // Unparseable text is the raw fallback at the bottom; only an empty report says there is nothing.
    return limits.raw.trim() ? null : (
      <RowGroup title="Plan limits">
        <Row title="No plan limits reported" />
      </RowGroup>
    );
  }
  return (
    <div data-testid="usage-limits" className="space-y-6">
      {limits.providers.map((provider) => (
        <RowGroup key={provider.name} title={provider.name}>
          {groupByAccount(provider).map((group) => (
            <div key={group.account} role="group" aria-label={group.account || provider.name} className="pb-1">
              {group.account ? (
                <p className="flex min-w-0 items-baseline gap-1.5 px-4 pt-3 text-meta text-muted-foreground">
                  <span className="min-w-0 truncate">{group.account}</span>
                  {group.inUse ? <span className="shrink-0">· used by this chat</span> : null}
                </p>
              ) : (
                <div className="pt-1" />
              )}
              {group.limits.map((limit) => (
                <LimitWindow key={limit.label} provider={provider.name} limit={limit} />
              ))}
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
 * grid. omp's unparseable limits text comes last, as a fallback.
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

  return (
    <div className="space-y-6">
      {progress || cost ? (
        <RowGroup title="This conversation" testId="usage-summary">
          {progress ? (
            <div className="flex flex-col gap-2 px-4 py-3">
              <span className="text-ui text-foreground">Context</span>
              <ContextMeter
                size="full"
                percent={progress.percent}
                usedTokens={progress.max > 0 ? progress.used : undefined}
                windowTokens={progress.max > 0 ? progress.max : undefined}
                testId="usage-context"
              />
              {progress.tint === "red" || progress.tint === "amber" ? (
                <p className="text-meta text-muted-foreground">
                  {progress.tint === "red" ? "Context is almost full. Compaction may run soon." : "Context is getting full."}
                </p>
              ) : null}
            </div>
          ) : null}
          {cost ? (
            <Row
              title="Cost"
              subtitle={cost.scope || undefined}
              trailing={<span className="text-ui font-medium tabular-nums text-foreground">{cost.value}</span>}
              testId="usage-cost"
            />
          ) : null}
        </RowGroup>
      ) : null}

      {limits ? <Limits limits={limits} onRetry={onRetryLimits} /> : null}

      {groups.length > 0 ? (
        <RowGroup title="Details" footer={footer} testId="usage-details">
          {groups.map((group) => (
            <div key={group.title} className="px-4 py-3">
              <h3 className="pb-2 text-meta font-medium text-foreground">{group.title}</h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
                {group.rows.map((row) => (
                  <div key={row.label} className="min-w-0">
                    <dt className="text-meta text-muted-foreground">{row.label}</dt>
                    <dd className="text-ui tabular-nums text-foreground">{row.value}</dd>
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
        <RowGroup title="Provider limits" footer="Shown as received; this app couldn’t read its layout." testId="usage-limits">
          <div className="px-4">
            <Markdown>{/^\s*```/.test(raw) ? raw : `\`\`\`\n${raw}\n\`\`\``}</Markdown>
          </div>
        </RowGroup>
      ) : null}
    </div>
  );
}
