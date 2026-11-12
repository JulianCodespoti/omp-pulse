import type { UiMessage } from "./messages";

export interface DerivedStats {
  turns: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost?: { total?: number; input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
  context?: { promptTokens: number; nonMessageTokens?: number; compactionEpoch?: number };
  /** true when the newest turn in view supplied the context snapshot */
  fromNewestTurn: boolean;
}

export function deriveStats(messages: readonly UiMessage[]): DerivedStats {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let total = 0;
  let costTotal = 0;
  let costInput: number | undefined;
  let costOutput: number | undefined;
  let costCacheRead: number | undefined;
  let costCacheWrite: number | undefined;
  let hasCost = false;
  let hasCostTotal = false;

  for (const m of messages) {
    if (m.role === "user") userMessages++;
    else if (m.role === "assistant") assistantMessages++;
    for (const p of m.parts) {
      if (p.kind === "tool") toolCalls++;
    }
    const u = m.usage;
    if (u) {
      if (typeof u.input === "number" && Number.isFinite(u.input)) input += u.input;
      if (typeof u.output === "number" && Number.isFinite(u.output)) output += u.output;
      if (typeof u.cacheRead === "number" && Number.isFinite(u.cacheRead)) cacheRead += u.cacheRead;
      if (typeof u.cacheWrite === "number" && Number.isFinite(u.cacheWrite)) cacheWrite += u.cacheWrite;
      // total may be under totalTokens or total
      const t = typeof u.totalTokens === "number" && Number.isFinite(u.totalTokens)
        ? u.totalTokens
        : typeof u.total === "number" && Number.isFinite(u.total)
          ? u.total
          : undefined;
      if (typeof t === "number") total += t;
      else {
        // fall back to summing components if no total supplied for this turn
        // Do not double count when total already present; otherwise synthesize total from components
        const comp = (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        // Only synthesize if at least one component present and no explicit total
        if (comp > 0) {
          // We don't add comp to total if t was missing because total is separate accumulator;
          // Instead, leave total as sum of explicit totals; components still contribute to total via input/output counts.
          // To keep total meaningful, add comp only when no mixture of explicit totals across messages would double count.
          // Simple: if no explicit total for this turn but components exist, add comp.
          total += comp;
        }
      }
      if (u.cost) {
        if (typeof u.cost.total === "number" && Number.isFinite(u.cost.total)) {
          costTotal += u.cost.total;
          hasCost = true;
          hasCostTotal = true;
        }
        if (typeof u.cost.input === "number" && Number.isFinite(u.cost.input)) {
          costInput = (costInput ?? 0) + u.cost.input;
          hasCost = true;
        }
        if (typeof u.cost.output === "number" && Number.isFinite(u.cost.output)) {
          costOutput = (costOutput ?? 0) + u.cost.output;
          hasCost = true;
        }
        if (typeof u.cost.cacheRead === "number" && Number.isFinite(u.cost.cacheRead)) {
          costCacheRead = (costCacheRead ?? 0) + u.cost.cacheRead;
          hasCost = true;
        }
        if (typeof u.cost.cacheWrite === "number" && Number.isFinite(u.cost.cacheWrite)) {
          costCacheWrite = (costCacheWrite ?? 0) + u.cost.cacheWrite;
          hasCost = true;
        }
      }
    }
  }

  // Context: snapshot from the newest assistant turn only — not a sum.
  // Scan from the end to find the newest assistant message.
  let context: DerivedStats["context"];
  let fromNewestTurn = false;
  let newestAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      newestAssistantIdx = i;
      break;
    }
  }
  if (newestAssistantIdx >= 0) {
    const newest = messages[newestAssistantIdx]!;
    const snap = newest.contextSnapshot;
    if (snap && typeof snap.promptTokens === "number" && Number.isFinite(snap.promptTokens)) {
      context = {
        promptTokens: snap.promptTokens,
        ...(typeof snap.nonMessageTokens === "number" && Number.isFinite(snap.nonMessageTokens)
          ? { nonMessageTokens: snap.nonMessageTokens }
          : {}),
        ...(typeof snap.compactionEpoch === "number" && Number.isFinite(snap.compactionEpoch)
          ? { compactionEpoch: snap.compactionEpoch }
          : {}),
      };
      fromNewestTurn = true;
    } else {
      // Newest assistant had no snapshot — do not fall back to older snapshots;
      // report no context and mark fromNewestTurn false (snapshot not from newest turn).
      fromNewestTurn = false;
    }
  }

  const cost = hasCost
    ? {
        ...(hasCostTotal ? { total: costTotal } : {}),
        ...(costInput !== undefined ? { input: costInput } : {}),
        ...(costOutput !== undefined ? { output: costOutput } : {}),
        ...(costCacheRead !== undefined ? { cacheRead: costCacheRead } : {}),
        ...(costCacheWrite !== undefined ? { cacheWrite: costCacheWrite } : {}),
      }
    : undefined;

  return {
    turns: messages.length,
    userMessages,
    assistantMessages,
    toolCalls,
    tokens: { input, output, cacheRead, cacheWrite, total },
    ...(cost ? { cost } : {}),
    ...(context ? { context } : {}),
    fromNewestTurn,
  };
}

/**
 * Pulse presentation envelope, not an OMP RPC shape. Native statistics cover
 * the active context; derived statistics cover only loaded messages. Neither
 * may be relabelled as the file's whole-session spend.
 */
export interface SessionUsageReport {
  kind: "pulse-session-usage";
  stats: unknown;
  sessionSpend?: number;
}

export function sessionUsageReport(stats: unknown, sessionSpend: number | undefined): SessionUsageReport {
  return {
    kind: "pulse-session-usage",
    stats,
    ...(typeof sessionSpend === "number" && Number.isFinite(sessionSpend) && sessionSpend >= 0 ? { sessionSpend } : {}),
  };
}
