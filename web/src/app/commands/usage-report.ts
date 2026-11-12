/**
 * omp's own `/usage` report: provider quota and rate-limit windows ("Claude 5
 * Hour", "Premium Requests — Monthly", ...). omp prints it as plain text (the
 * daemon returns it from POST /api/command), and has no structured RPC for it,
 * so it is parsed here for display. The text is long (every
 * provider lists its models first), which is why the phone draws the limit
 * windows as bars rather than dumping it.
 *
 * Shape, per provider (src: slash-commands/builtin-session.ts `/usage`):
 *
 *   Anthropic
 *     Models with usage data
 *       anthropic/claude-opus-5
 *   - Claude 5 Hour
 *     me@example.com (Org): 2.00% used (98.0% left)  ← in use by this session
 *     [░░░░░░░░░░░░░░░░░░░░░░░░] 2%
 *     resets in 4h
 *
 * Anything that does not parse is left out; the caller falls back to the raw
 * text when nothing parses at all, so a format change degrades, not breaks.
 */
export interface UsageLimit {
  label: string;
  account: string;
  /** 0-100, from the bar line (omp rounds it) */
  percent: number;
  resets?: string;
  /** The account this session is currently billed to. */
  inUse: boolean;
}

export interface UsageProvider {
  name: string;
  limits: UsageLimit[];
}

/** The provider-limits half of the Usage sheet: in flight, failed, or parsed (raw text kept as the fallback). */
export type UsageLimitsState = "loading" | { error: string; recoveryError?: unknown } | { providers: UsageProvider[]; raw: string };

export interface AccountLimits {
  account: string;
  inUse: boolean;
  limits: UsageLimit[];
}

/** A provider's windows grouped by account, in report order, so each account is named once. */
export function groupByAccount(provider: UsageProvider): AccountLimits[] {
  const groups: AccountLimits[] = [];
  for (const limit of provider.limits) {
    let group = groups.find((g) => g.account === limit.account);
    if (!group) groups.push((group = { account: limit.account, inUse: false, limits: [] }));
    group.limits.push(limit);
    group.inUse ||= limit.inUse;
  }
  return groups;
}

export function parseUsageReport(text: string): UsageProvider[] {
  const providers: UsageProvider[] = [];
  let provider: UsageProvider | null = null;
  let limit: Partial<UsageLimit> | null = null;

  const flush = (): void => {
    if (provider && limit && typeof limit.percent === "number" && limit.label) {
      provider.limits.push({
        label: limit.label,
        account: limit.account ?? "",
        percent: limit.percent,
        resets: limit.resets,
        inUse: limit.inUse === true,
      });
    }
    limit = null;
  };

  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("```")) continue;
    // A provider heading is the only unindented line that is not a limit.
    if (!/^\s/.test(line) && !line.startsWith("-")) {
      flush();
      if (/^Usage\b/.test(line)) { provider = null; continue; }
      provider = { name: line, limits: [] };
      providers.push(provider);
      continue;
    }
    if (line.startsWith("- ")) {
      flush();
      limit = { label: line.slice(2).trim() };
      continue;
    }
    if (!limit) continue;
    const bar = /\]\s*(\d+(?:\.\d+)?)%\s*$/.exec(line);
    if (bar) { limit.percent = Math.min(100, Number(bar[1])); continue; }
    const resets = /^\s*resets in (.+)$/.exec(line);
    if (resets) { limit.resets = resets[1]!.trim(); continue; }
    // "<account>: 2.00% used (98.0% left)" or "<account>: 314.00 requests used (...)".
    const account = /^\s*(.+?):\s*[\d.]+(?:%| requests?) used/.exec(line);
    if (account) {
      limit.account = account[1]!.replace(/\s+·\s+plan:.*$/, "").trim();
      limit.inUse = /in use by this session/.test(line);
    }
  }
  flush();
  return providers.filter((p) => p.limits.length > 0);
}
