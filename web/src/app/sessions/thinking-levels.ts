import { shortModel } from "../session-format";
import type { ModelInfo } from "../../runtime/api-types";

/** omp's effort ladder, weakest to strongest (packages/catalog/src/effort.ts). */
const LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/**
 * Match OMP 18.10.4 ModelControls.getAvailableEffortSelectors: Auto is a
 * selector, not a concrete effort. Unverified models require an explicit
 * concrete pick, so never offer Auto for them.
 */
export function thinkingChoices(model: ModelInfo | undefined): string[] {
  if (!model || model.reasoning === false) return [];
  const efforts = model.thinking?.efforts?.filter((effort) => typeof effort === "string") ?? [];
  const auto = model.reasoning === true && model.thinking?.unverified !== true;
  return efforts.length > 0 || auto ? ["off", ...(auto ? ["auto"] : []), ...efforts] : [];
}

const bare = (id: string): string => id.split("/").at(-1)!.toLowerCase().replace(/[-_]?20\d{6}$/, "").replace(/[-_](latest|preview|stable)$/, "").replace(/[^a-z0-9]/g, "");

/** The catalogue entry for the session's model (provider wins when known), so the composer can offer its thinking levels. */
export function findSessionModel(models: ModelInfo[], model: string | undefined, provider?: string): ModelInfo | undefined {
  if (!model) return undefined;
  const want = bare(model);
  const hits = models.filter((m) => (!provider || m.provider === provider) && (bare(m.id) === want || (!!m.name && bare(m.name) === want)));
  return hits.find((m) => m.id.toLowerCase() === model.slice(model.lastIndexOf("/") + 1).toLowerCase()) ?? hits[0];
}

/**
 * The level omp lands on after a model switch, so the header can say so before
 * the (possibly idle, therefore unanswerable) session confirms it. Mirrors
 * `ModelControls.setModel`: the new model's own `defaultLevel` wins, otherwise
 * the current level is kept and clamped DOWN to the nearest supported effort
 * (or up to the weakest when it is below all of them). `off` survives. A model
 * without a thinking control has no level: `""`.
 */
export function levelAfterModelSwitch(model: ModelInfo, current: string | undefined): string {
  // Native model changes retain the selector, even if the new model cannot
  // expose a reasoning control. A provisional/turn effort must not pin Auto.
  if (current === "auto") return "auto";
  const efforts = thinkingChoices(model).filter((level) => level !== "off" && level !== "auto");
  if (efforts.length === 0) return "";
  const fallback = model.thinking?.defaultLevel;
  if (fallback && efforts.includes(fallback)) return fallback;
  if (current === "off") return "off";
  if (!current || efforts.includes(current)) return current ?? "";
  const requested = LADDER.indexOf(current as (typeof LADDER)[number]);
  if (requested < 0) return current;
  let clamped: string | undefined;
  for (const effort of LADDER) {
    if (!efforts.includes(effort)) continue;
    if (LADDER.indexOf(effort) > requested) break;
    clamped = effort;
  }
  return clamped ?? efforts[0];
}

/** Segment text: short enough for six segments on a phone. */
export function thinkingButtonLabel(level: string): string {
  switch (level) {
    case "off": return "Off";
    case "auto": return "Auto";
    case "minimal": return "Minimal";
    case "low": return "Low";
    case "medium": return "Medium";
    case "high": return "High";
    case "xhigh": return "X-High";
    case "max": return "Max";
    default: return level;
  }
}

/**
 * The model·thinking chip text ("Opus 4.5 · High"), shared by the composer
 * chip and the new-session screen. Lives here, not in ModelPicker, so the
 * chip does not pull the lazily loaded picker into the main bundle. An empty
 * or inherited level shows the model alone.
 */
export function modelChipLabel(model?: string | null, thinkingLevel?: string | null): string {
  const name = shortModel(model);
  const level = thinkingLevel && thinkingLevel !== "inherit" ? thinkingButtonLabel(thinkingLevel) : "";
  return name && level ? `${name} · ${level}` : name || level;
}
