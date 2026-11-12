// Clipboard methods can fail without throwing. Success feedback must reflect
// an acknowledged write; manual text selection is not proof of copying.
export function legacyCopyText(text: string, doc: Document = document): boolean {
  const focused = doc.activeElement;
  const area = doc.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.position = "fixed";
  area.style.opacity = "0";
  try {
    doc.body.appendChild(area);
    area.select();
    return doc.execCommand("copy") === true;
  } finally {
    area.remove();
    if (focused && "focus" in focused && typeof focused.focus === "function") {
      try { focused.focus({ preventScroll: true }); } catch { /* best effort */ }
    }
  }
}

type ClipboardMethods = {
  writeText?: (text: string) => Promise<void>;
  legacyCopy: (text: string) => boolean;
};

export async function copyText(text: string, methods: ClipboardMethods = {
  writeText: value => navigator.clipboard.writeText(value),
  legacyCopy: legacyCopyText,
}, isCurrent: () => boolean = () => true): Promise<boolean> {
  if (!isCurrent()) return false;
  try {
    if (methods.writeText) {
      await methods.writeText(text);
      return true;
    }
  } catch { /* Some WebViews expose writeText but reject it. */ }
  // A denied native write can finish after a newer copy succeeded. Never
  // overwrite that clipboard with an obsolete fallback that has not started.
  if (!isCurrent()) return false;
  try { return methods.legacyCopy(text); } catch { return false; }
}

// A closing or newer sheet must not receive an older clipboard outcome.
export class ClipboardAttempt {
  private generation = 0;
  busy = false;
  private readonly copy: (text: string) => Promise<boolean>;
  constructor(copy: (text: string) => Promise<boolean> = copyText) { this.copy = copy; }
  cancel(): void { this.generation++; this.busy = false; }
  async run(text: string): Promise<boolean | null> {
    if (this.busy) return null;
    this.busy = true;
    const generation = ++this.generation;
    let copied = false;
    try {
      copied = this.copy === copyText
        ? await copyText(text, undefined, () => generation === this.generation)
        : await this.copy(text);
    } catch { /* failed outcome below */ }
    if (generation !== this.generation) return null;
    this.busy = false;
    return copied;
  }
}
