// What a recipe knows about the seeded corpus, and the stubs every recipe
// gets unless it overrides them.

/** Everything a recipe needs to know about the seeded corpus. */
export function makeEnv({ base, token, appUrl, listing }) {
  const byTitle = (needle) => {
    const row = listing.find((s) => (s.title ?? "").includes(needle));
    if (!row) throw new Error(`fixture session "${needle}" not in listing`);
    return row;
  };
  return {
    base,
    token,
    appUrl,
    listing,
    row: byTitle,
    path: (needle) => byTitle(needle).path,
    /** `#s=` deep link: boots straight into that conversation. */
    chatHash: (needle) => `#s=${encodeURIComponent(byTitle(needle).path)}`,
    /** The real listing with some rows patched (`patch` may be null), as a GET /api/sessions stub. */
    listingStub: (patch, projects = []) => ({
      method: "GET",
      path: "/api/sessions",
      body: { sessions: listing.map((row) => ({ ...row, ...(patch?.(row) ?? {}) })), projects },
    }),
    /**
     * Patch for a row whose turn is running. The listing's `sessionState` is
     * the authority (domain/protocol.ts sessionTurn), so the legacy
     * running/streaming/status fields alone no longer make a row Working.
     */
    runningState: (row, observedAt, activity) => runningState(row.sessionState, observedAt, activity),
    defaultStubs: DEFAULT_STUBS,
  };
}

/**
 * The daemon's authority for a turn in progress, derived from the row's real
 * (idle) `sessionState`. The revision jumps ahead so it outranks the idle
 * authority the history page and the sockets keep delivering; a child owns a
 * running turn, and that owner can stop, steer and queue.
 */
export function runningState(base, observedAt, { kind = "writing", label } = {}) {
  if (!base) throw new Error("listing row has no sessionState: the daemon predates the sessionState listing field");
  return {
    ...base,
    revision: base.revision + 100,
    turn: "running",
    owner: { ...base.owner, kind: "child" },
    observedAt,
    activity: { source: "child", kind, ...(label ? { label } : {}), observedAt, stale: false },
    capabilities: { ...base.capabilities, read: true, stream: true, control: true, send: true, stop: true, answer: true, queue: true, interrupt: true },
  };
}

// Reads that are either nondeterministic, read the owner's real data, or
// would spawn a child. Recipe stubs are consulted first and override these.
const MODELS = [
  { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1", reasoning: true, thinking: { efforts: ["low", "medium", "high"], defaultLevel: "medium" } },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", reasoning: true, thinking: { efforts: ["low", "medium", "high"] } },
  { provider: "openai", id: "gpt-5", name: "GPT-5", reasoning: true, thinking: { efforts: ["minimal", "low", "medium", "high"] } },
  { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: false },
];
const COMMANDS = [
  { name: "compact", description: "Summarise the conversation to free context" },
  { name: "model", description: "Switch the model" },
  { name: "usage", description: "Show token usage for this session" },
  { name: "context", description: "Show context window usage" },
  { name: "rename", description: "Rename this session" },
  { name: "fork", description: "Branch from a previous message" },
  { name: "plan", description: "Enter plan mode" },
  { name: "review", description: "Review the working tree" },
];
const DEFAULT_STUBS = [
  { method: "GET", path: "/api/model-usage", body: { ok: true, models: ["anthropic/claude-opus-4-1", "openai/gpt-5"] } },
  { method: "GET", path: "/api/commands", body: { ok: true, commands: COMMANDS } },
  { method: "POST", path: "/api/rpc", rpc: "get_available_models", body: { ok: true, data: { models: MODELS } } },
  { method: "POST", path: "/api/rpc", rpc: "get_available_commands", body: { ok: true, data: { commands: COMMANDS } } },
  {
    method: "POST", path: "/api/rpc", rpc: "get_state",
    body: { ok: true, data: { model: { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" }, thinkingLevel: "medium", isStreaming: false, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", interruptMode: "immediate", autoCompactionEnabled: true, fastModeEnabled: false, contextUsage: { percent: 34, tokens: 68_000, contextWindow: 200_000 }, messageCount: 84, queuedMessageCount: 0 } },
  },
  { method: "POST", path: "/api/rpc", rpc: "get_session_stats", body: { ok: true, data: { tokens: { input: 412_000, output: 38_200, cacheRead: 1_900_000, cacheWrite: 96_000, total: 2_446_200 }, cost: 4.82, userMessages: 34, assistantMessages: 51, toolCalls: 12 } } },
];
