import type { CatalogueCommand } from "./composer-route";

/** Catalogue skill names are already namespaced (`skill:plugin/name`). */
export function availableSkills<T extends CatalogueCommand>(commands: readonly T[] | undefined): T[] {
  return commands?.filter(command => command.source === "skill" || command.source === "skills") ?? [];
}

/** Insert at the remembered UTF-16 caret without replacing any draft text. */
export function insertSkill(text: string, caret: number, name: string): { text: string; caret: number } {
  const at = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  const token = `/${name.replace(/^\/+/, "")}`;
  const inserted = `${before && !/\s$/.test(before) ? " " : ""}${token}${/^\s/.test(after) ? "" : " "}`;
  return { text: before + inserted + after, caret: at + inserted.length };
}
