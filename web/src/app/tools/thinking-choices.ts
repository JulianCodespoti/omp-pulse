// Values verified against packages/coding-agent/src/modes/rpc/rpc-types.ts
// and packages/agent/src/thinking.ts (ThinkingLevel) / packages/catalog/src/effort.ts.
// The full list is the fallback when omp cannot say what the live model takes.
export const FALLBACK_THINKING_LEVELS: readonly string[] = ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * The levels the session settings picker offers. omp's
 * `get_available_thinking_levels` answers `{levels}` for the live model (`off`
 * included, OMP-only `inherit` deliberately left out); "inherit" (Default) is
 * always first. Anything else (an error, an owner without the command, an
 * empty list) falls back to the full fixed list. The current level is always
 * kept so the picker can show it even if the model no longer lists it.
 */
export function thinkingChoices(available: unknown, current: string): string[] {
  const levels =
    typeof available === "object" && available !== null && "levels" in available && Array.isArray(available.levels)
      ? available.levels.filter((level): level is string => typeof level === "string" && level !== "" && level !== "inherit")
      : [];
  const choices = levels.length > 0 ? ["inherit", ...new Set(levels)] : [...FALLBACK_THINKING_LEVELS];
  return current && !choices.includes(current) ? [...choices, current] : choices;
}
