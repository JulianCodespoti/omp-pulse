import type { UiPart } from "./messages";

/** Reconcile the wire's aggregate text without repeating earlier text blocks. */
export function mergeStreamText(parts: readonly UiPart[], text: string): UiPart[] {
  let lastText = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].kind === "text") {
      lastText = i;
      break;
    }
  }
  if (lastText < 0) return text ? [...parts, { kind: "text", text }] : [...parts];

  let offset = 0;
  let replaced = false;
  return parts.map((part, index) => {
    if (part.kind !== "text") return part;
    if (!replaced && index !== lastText && text.startsWith(part.text, offset)) {
      offset += part.text.length;
      return part;
    }
    // Deltas do not encode block boundaries. Keep unchanged leading blocks,
    // then use one suffix rather than guess boundaries inside replaced text.
    const next = replaced ? "" : text.slice(offset);
    replaced = true;
    return part.text === next ? part : { ...part, text: next };
  });
}
