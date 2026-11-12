// Pure formatter for RPC command results — field names copied from
// daemon rpc-types, never invented. See:
// - SessionStats in packages/coding-agent/src/session/agent-session-types.ts
// - RpcSessionState.contextUsage / ContextUsage in extensibility/extensions/types.ts

export interface FormattedRow {
  label: string;
  value: string;
}

export interface FormattedSection {
  title: string;
  rows: FormattedRow[];
}

export interface FormatResult {
  rows: FormattedRow[];
  sections?: FormattedSection[];
  progress?: {
    percent: number;
    used: number;
    max: number;
    tint: "default" | "amber" | "red";
  };
  rawJson?: string;
  /** `/usage` only: one cost figure plus the dense detail groups (the context meter is `progress`). */
  usage?: { cost: UsageCost; groups: FormattedSection[] };
}

export interface UsageCost {
  value: string;
  /** Plain words for what the figure covers. */
  scope: string;
}

const NO_COST = "Not available";

/**
 * The one cost figure. The session file holds every context the conversation
 * has had, so it contains the active context's cost: a smaller file tally is
 * stale (the daemon's row tally lags a live turn), and the larger wins. The
 * context-only cost is a footnote, and only when it differs.
 */
export function pickCost(spend: number | undefined, context: number | undefined): UsageCost {
  if (spend === undefined && context === undefined) return { value: NO_COST, scope: "" };
  if (spend === undefined) return { value: fmtCurrency(context!), scope: "Current context only" };
  const total = Math.max(spend, context ?? 0);
  const since = context !== undefined && context < total - 0.005 ? ` ${fmtCurrency(context)} of it is in the current context.` : "";
  return { value: fmtCurrency(total), scope: `Whole conversation.${since}` };
}

// Reuse formatters without doing Intl setup until a result actually needs it.
let numberFormatter: Intl.NumberFormat | undefined;
let currencyFormatter: Intl.NumberFormat | undefined;
function fmtNum(n: number): string {
  return (numberFormatter ??= new Intl.NumberFormat("en-US")).format(n);
}

function fmtCurrency(n: number): string {
  try {
    return (currencyFormatter ??= new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })).format(n);
  } catch {
    return `$${n.toFixed(2)}`;
  }
}

// ---------------------------------------------------------------------------
// DerivedStats (local fallback when RPC is owned) — shape from domain/session-stats
// Tokens accumulate; context is a snapshot from newest turn.
// ---------------------------------------------------------------------------
function isDerivedStats(data: unknown): boolean {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const rec = data as Record<string, unknown>;
  return typeof rec.turns === "number" && typeof rec.tokens === "object" && "fromNewestTurn" in rec;
}

function formatDerivedStats(data: unknown, sessionSpend?: number): FormatResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { rows: [], rawJson: (() => { try { return JSON.stringify(data, null, 2); } catch { return String(data); } })() };
  }
  const rec = data as Record<string, unknown>;
  const sections: FormattedSection[] = [];
  const flat: FormattedRow[] = [];

  // Messages — DerivedStats: turns, userMessages, assistantMessages, toolCalls
  const msgRows: FormattedRow[] = [];
  const addMsg = (label: string, v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) msgRows.push({ label, value: fmtNum(v) });
  };
  // Prefer the same labels as formatSessionStats where they overlap so the sheet feels familiar.
  addMsg("User messages", rec.userMessages);
  addMsg("Assistant messages", rec.assistantMessages);
  addMsg("Tool calls", rec.toolCalls);
  addMsg("Total turns", rec.turns);
  if (msgRows.length) {
    sections.push({ title: "Loaded messages (partial)", rows: msgRows });
    flat.push(...msgRows);
  }

  // Tokens
  const tokRaw = rec.tokens;
  const tok = typeof tokRaw === "object" && tokRaw !== null && !Array.isArray(tokRaw) ? (tokRaw as Record<string, unknown>) : null;
  if (tok) {
    const tokRows: FormattedRow[] = [];
    const addTok = (label: string, v: unknown) => {
      if (typeof v === "number" && Number.isFinite(v)) tokRows.push({ label, value: fmtNum(v) });
    };
    addTok("Input tokens", tok.input);
    addTok("Output tokens", tok.output);
    addTok("Cache read", tok.cacheRead);
    addTok("Cache write", tok.cacheWrite);
    addTok("Total tokens", tok.total);
    if (tokRows.length) {
      sections.push({ title: "Loaded tokens (partial)", rows: tokRows });
      flat.push(...tokRows);
    }
  }

  // Cost: the whole-file spend is the only figure that is not partial. Without
  // it, the loaded messages' total is shown and labelled as partial.
  const costRaw = rec.cost;
  const cost = typeof costRaw === "object" && costRaw !== null && !Array.isArray(costRaw) ? (costRaw as Record<string, unknown>) : null;
  const loadedTotal = cost && typeof cost.total === "number" && Number.isFinite(cost.total) ? cost.total : undefined;
  const headline = pickCost(sessionSpend, undefined);
  const costFigure: UsageCost = headline.value === NO_COST && loadedTotal !== undefined
    ? { value: fmtCurrency(loadedTotal), scope: "Loaded messages only" }
    : headline;
  const costRows: FormattedRow[] = [];
  // Optional breakdown — keep currency neutral $ via fmtCurrency
  if (loadedTotal !== undefined) costRows.push({ label: "Loaded messages cost (partial)", value: fmtCurrency(loadedTotal) });
  if (cost) {
    if (typeof cost.input === "number" && Number.isFinite(cost.input)) costRows.push({ label: "Loaded input cost (partial)", value: fmtCurrency(cost.input) });
    if (typeof cost.output === "number" && Number.isFinite(cost.output)) costRows.push({ label: "Loaded output cost (partial)", value: fmtCurrency(cost.output) });
    if (typeof cost.cacheRead === "number" && Number.isFinite(cost.cacheRead)) costRows.push({ label: "Loaded cache read cost (partial)", value: fmtCurrency(cost.cacheRead) });
    if (typeof cost.cacheWrite === "number" && Number.isFinite(cost.cacheWrite)) costRows.push({ label: "Loaded cache write cost (partial)", value: fmtCurrency(cost.cacheWrite) });
  }
  if (costRows.length) {
    sections.push({ title: "Cost breakdown (loaded messages)", rows: costRows });
    flat.push(...costRows);
  }

  // Context — DerivedStats.context: snapshot from newest turn (promptTokens etc.)
  // No window size is known from transcript alone, so we cannot compute a percentage — show the raw figure.
  const ctxRaw = rec.context;
  const ctx = typeof ctxRaw === "object" && ctxRaw !== null && !Array.isArray(ctxRaw) ? (ctxRaw as Record<string, unknown>) : null;
  if (ctx) {
    const ctxRows: FormattedRow[] = [];
    if (typeof ctx.promptTokens === "number" && Number.isFinite(ctx.promptTokens)) ctxRows.push({ label: "Prompt tokens", value: fmtNum(ctx.promptTokens) });
    if (typeof ctx.nonMessageTokens === "number" && Number.isFinite(ctx.nonMessageTokens)) ctxRows.push({ label: "Non-message tokens", value: fmtNum(ctx.nonMessageTokens) });
    if (typeof ctx.compactionEpoch === "number" && Number.isFinite(ctx.compactionEpoch)) ctxRows.push({ label: "Compactions", value: fmtNum(ctx.compactionEpoch) });
    if (ctxRows.length) {
      sections.push({ title: "Latest loaded context snapshot", rows: ctxRows });
      flat.push(...ctxRows);
    }
  }

  if (flat.length === 0 && costFigure.value === NO_COST) return genericFallback(data);
  return { rows: flat, sections, usage: { cost: costFigure, groups: sections } };
}


// ---------------------------------------------------------------------------
// session-stats ( /usage /stats → get_session_stats )
// Shape: SessionStats { sessionFile, sessionId, userMessages, assistantMessages,
//  toolCalls, toolResults, totalMessages, tokens:{input,output,reasoning,
//  cacheRead,cacheWrite,total}, premiumRequests, cost, contextUsage? }

function formatSessionStats(data: unknown, sessionSpend?: number): FormatResult {
  // Parse at the boundary: data is unknown from the network.
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { rows: [], rawJson: (() => { try { return JSON.stringify(data, null, 2); } catch { return String(data); } })() };
  }
  const rec = data as Record<string, unknown>;

  const sections: FormattedSection[] = [];
  const flat: FormattedRow[] = [];

  // Messages — SessionStats fields
  const msgRows: FormattedRow[] = [];
  const addMsg = (label: string, v: unknown) => {
    if (typeof v === "number" && Number.isFinite(v)) msgRows.push({ label, value: fmtNum(v) });
  };
  addMsg("User messages", rec.userMessages);
  addMsg("Assistant messages", rec.assistantMessages);
  addMsg("Tool calls", rec.toolCalls);
  addMsg("Tool results", rec.toolResults);
  addMsg("Total messages", rec.totalMessages);
  if (msgRows.length) {
    sections.push({ title: "Messages", rows: msgRows });
    flat.push(...msgRows);
  }

  // Tokens — SessionStats.tokens.{input,output,reasoning,cacheRead,cacheWrite,total}
  const tokRaw = rec.tokens;
  const tok = typeof tokRaw === "object" && tokRaw !== null && !Array.isArray(tokRaw) ? (tokRaw as Record<string, unknown>) : null;
  if (tok) {
    const tokRows: FormattedRow[] = [];
    const addTok = (label: string, v: unknown) => {
      if (typeof v === "number" && Number.isFinite(v)) tokRows.push({ label, value: fmtNum(v) });
    };
    addTok("Input tokens", tok.input);
    addTok("Output tokens", tok.output);
    addTok("Reasoning tokens", tok.reasoning);
    addTok("Cache read", tok.cacheRead);
    addTok("Cache write", tok.cacheWrite);
    addTok("Total tokens", tok.total);
    if (tokRows.length) {
      sections.push({ title: "Tokens", rows: tokRows });
      flat.push(...tokRows);
    }
  }

  // Cost: one headline figure; premium requests join the details grid.
  const contextCost = typeof rec.cost === "number" && Number.isFinite(rec.cost) ? rec.cost : undefined;
  const cost = pickCost(sessionSpend, contextCost);
  if (typeof rec.premiumRequests === "number" && Number.isFinite(rec.premiumRequests)) {
    const premium = [{ label: "Premium requests", value: fmtNum(rec.premiumRequests) }];
    sections.push({ title: "Requests", rows: premium });
    flat.push(...premium);
  }
  const groups = [...sections];

  // Context usage inside session stats
  let progress: FormatResult["progress"];
  const cuRaw = rec.contextUsage;
  const cu = typeof cuRaw === "object" && cuRaw !== null && !Array.isArray(cuRaw) ? (cuRaw as Record<string, unknown>) : null;
  if (cu) {
    const tokens = typeof cu.tokens === "number" && Number.isFinite(cu.tokens) ? cu.tokens : null;
    const win = typeof cu.contextWindow === "number" && Number.isFinite(cu.contextWindow) ? cu.contextWindow : null;
    const pct = typeof cu.percent === "number" && Number.isFinite(cu.percent) ? cu.percent : null;
    const ctxRows: FormattedRow[] = [];
    if (tokens !== null) ctxRows.push({ label: "Context used", value: fmtNum(tokens) });
    if (win !== null) ctxRows.push({ label: "Context window", value: fmtNum(win) });
    if (pct !== null) ctxRows.push({ label: "Usage", value: `${Math.round(pct)}%` });
    if (ctxRows.length) {
      sections.push({ title: "Context", rows: ctxRows });
      flat.push(...ctxRows);
    }
    if (pct !== null) {
      const tint = pct > 90 ? "red" : pct >= 70 ? "amber" : "default";
      progress = { percent: Math.round(pct), used: tokens ?? 0, max: win ?? 0, tint };
    }
  }

  if (flat.length === 0 && !progress && cost.value === NO_COST) {
    // No recognised SessionStats fields — fall back to generic
    return genericFallback(data);
  }

  return { rows: flat, sections, progress, usage: { cost, groups } };
}

// ---------------------------------------------------------------------------
// get_state ( /context → get_state )
// Shape: RpcSessionState { messageCount, contextUsage?: {tokens,contextWindow,percent}, ... }

function formatGetState(data: unknown): FormatResult {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { rows: [], rawJson: (() => { try { return JSON.stringify(data, null, 2); } catch { return String(data); } })() };
  }
  const rec = data as Record<string, unknown>;
  const cuRaw = rec.contextUsage;
  const cu = typeof cuRaw === "object" && cuRaw !== null && !Array.isArray(cuRaw) ? (cuRaw as Record<string, unknown>) : null;
  const tokens = cu && typeof cu.tokens === "number" && Number.isFinite(cu.tokens) ? cu.tokens : null;
  const win = cu && typeof cu.contextWindow === "number" && Number.isFinite(cu.contextWindow) ? cu.contextWindow : null;
  const pct = cu && typeof cu.percent === "number" && Number.isFinite(cu.percent) ? cu.percent : null;

  if (cu && (tokens !== null || win !== null || pct !== null)) {
    const rows: FormattedRow[] = [];
    if (tokens !== null && win !== null) {
      rows.push({ label: "Used", value: `${fmtNum(tokens)} / ${fmtNum(win)} tokens` });
    } else if (tokens !== null) {
      rows.push({ label: "Used tokens", value: fmtNum(tokens) });
    } else if (win !== null) {
      rows.push({ label: "Context window", value: fmtNum(win) });
    }
    if (pct !== null) rows.push({ label: "Usage", value: `${Math.round(pct)}%` });

    if (typeof rec.messageCount === "number" && Number.isFinite(rec.messageCount)) {
      rows.push({ label: "Messages", value: fmtNum(rec.messageCount) });
    }

    let progress: FormatResult["progress"] | undefined;
    if (pct !== null) {
      const tint = pct > 90 ? "red" : pct >= 70 ? "amber" : "default";
      progress = { percent: Math.round(pct), used: tokens ?? 0, max: win ?? 0, tint };
    }

    return { rows, progress };
  }

  const rows: FormattedRow[] = [];
  if (typeof rec.messageCount === "number" && Number.isFinite(rec.messageCount)) {
    rows.push({ label: "Messages", value: fmtNum(rec.messageCount) });
  }
  if (typeof rec.queuedMessageCount === "number" && Number.isFinite(rec.queuedMessageCount)) {
    rows.push({ label: "Queued", value: fmtNum(rec.queuedMessageCount) });
  }
  if (typeof rec.sessionId === "string" && rec.sessionId) {
    rows.push({ label: "Session", value: String(rec.sessionId).slice(0, 12) });
  }
  if (rows.length) return { rows };
  return genericFallback(data);
}

// ---------------------------------------------------------------------------
// generic — flat object as key/value list else fenced JSON via Markdown

function genericFallback(data: unknown): FormatResult {
  if (data === null || data === undefined) return { rows: [] };
  if (typeof data === "string" || typeof data === "number" || typeof data === "boolean") {
    return { rows: [{ label: "Value", value: String(data) }] };
  }
  if (Array.isArray(data)) {
    try {
      return { rows: [], rawJson: JSON.stringify(data, null, 2) };
    } catch {
      return { rows: [], rawJson: String(data) };
    }
  }
  if (typeof data === "object" && data !== null) {
    const rec = data as Record<string, unknown>;
    const vals = Object.values(rec);
    const flatPrimitive = vals.every(
      (x) => x === null || typeof x === "string" || typeof x === "number" || typeof x === "boolean",
    );
    if (flatPrimitive) {
      const rows: FormattedRow[] = Object.entries(rec).map(([k, v]) => {
        const spaced = k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ");
        const label = spaced.charAt(0).toUpperCase() + spaced.slice(1);
        let value: string;
        if (typeof v === "number" && Number.isFinite(v)) value = fmtNum(v);
        else if (v === null) value = "—";
        else value = String(v);
        return { label, value };
      });
      if (rows.length) return { rows };
    }
    try {
      return { rows: [], rawJson: JSON.stringify(data, null, 2) };
    } catch {
      return { rows: [], rawJson: String(data) };
    }
  }
  return { rows: [{ label: "Value", value: String(data) }] };
}

// ---------------------------------------------------------------------------
// public
// ---------------------------------------------------------------------------
export function formatCommandResult(
  command: string,
  data: unknown,
): FormatResult {
  // Explicit Pulse envelope keeps file spend separate from native context
  // statistics and the partial loaded-message fallback.
  let sessionSpend: number | undefined;
  if (data && typeof data === "object" && !Array.isArray(data) && "kind" in data && data.kind === "pulse-session-usage") {
    const report = data as { stats?: unknown; sessionSpend?: unknown };
    if (typeof report.sessionSpend === "number" && Number.isFinite(report.sessionSpend) && report.sessionSpend >= 0) sessionSpend = report.sessionSpend;
    data = report.stats;
  }
  if (isDerivedStats(data)) return formatDerivedStats(data, sessionSpend);
  const norm = command.replace(/^\/+/, "").trim().toLowerCase();
  if (norm === "get_session_stats" || norm === "usage" || norm === "stats") {
    return formatSessionStats(data, sessionSpend);
  }
  if (norm === "get_state" || norm === "context") {
    return formatGetState(data);
  }
  return genericFallback(data) as FormatResult;
}
