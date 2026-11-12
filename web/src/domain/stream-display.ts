interface PendingBoundary {
  offset: number;
  started: boolean;
  /** At most two fence markers; inspected whitespace is never retained/rescanned. */
  opener: string;
}

/** Known display-only newline positions, always measured in raw UTF-16 units. */
export interface StreamDisplay {
  raw: string;
  text: string;
  anchors: readonly number[];
  active: readonly number[];
  pending: readonly PendingBoundary[];
}

/** Only a full normalizer snapshot may seed anchors; never infer them from md. */
export function streamDisplaySnapshot(raw: string, text: string, anchors: readonly number[]): StreamDisplay {
  return { raw, text, anchors, active: anchors, pending: [] };
}

// The normalizer's predicate is intentionally narrow/asymmetric: trimStart for
// the opener, but only a literal leading LF or previous trailing LF vetoes it.
// Consume only this suffix/chunk; appends never index the growing raw rope.
function inspect(add: string, boundary: PendingBoundary): { active: boolean; pending?: PendingBoundary } {
  let { started, opener } = boundary;
  for (const char of add) {
    if (!started && char === "\n") return { active: false };
    started = true;
    if (!opener && char.trimStart() === "") continue;
    if (!opener ? char !== "`" && char !== "~" : char !== opener[0]) return { active: false };
    opener += char;
    if (opener.length === 3) return { active: true };
  }
  return { active: false, pending: { offset: boundary.offset, started, opener } };
}

function render(raw: string, active: readonly number[]): string {
  if (active.length === 0) return raw;
  const chunks: string[] = [];
  let from = 0;
  for (const offset of active) {
    chunks.push(raw.slice(from, offset), "\n");
    from = offset;
  }
  chunks.push(raw.slice(from));
  return chunks.join("");
}

export function appendStreamDisplay(state: StreamDisplay, add: string): StreamDisplay {
  if (!add) return state;
  const raw = state.raw + add;
  const text = state.raw === state.text ? raw : state.text + add;
  // Common token path: no anchor iteration, prefix slicing or normalization.
  if (state.pending.length === 0) return { ...state, raw, text };
  const pending: StreamDisplay["pending"][number][] = [];
  const activated: number[] = [];
  for (const boundary of state.pending) {
    const next = inspect(add, boundary);
    if (next.active) activated.push(boundary.offset);
    else if (next.pending) pending.push(next.pending);
  }
  const active = activated.length ? [...state.active, ...activated].sort((a, b) => a - b) : state.active;
  // Completion of a previously truncated opener is exceptional, not per-token
  // normalization. Ordinary/active openers cannot change under append.
  return { raw, text: activated.length ? render(raw, active) : text, anchors: state.anchors, active, pending };
}

export function replaceStreamDisplay(state: StreamDisplay, keep: number, add: string): StreamDisplay {
  const cut = Math.min(state.raw.length, Math.max(0, Math.trunc(keep)));
  const raw = state.raw.slice(0, cut) + add;
  // Keep at-cut anchors as last-known segmentation. md cannot establish new
  // producer part boundaries; the next full snapshot replaces this provenance.
  const anchors = state.anchors.filter(offset => offset <= cut);
  const active: number[] = [];
  const pending: StreamDisplay["pending"][number][] = [];
  for (const offset of anchors) {
    if (offset === 0 || raw[offset - 1] === "\n") continue;
    const next = inspect(raw.slice(offset), { offset, started: false, opener: "" });
    if (next.active) active.push(offset);
    else if (next.pending) pending.push(next.pending);
  }
  const retainedActive = state.active.filter(offset => offset <= cut);
  // Translate the raw cut by exactly the retained synthetic newline count.
  const displayCut = cut + retainedActive.length;
  const unchanged = retainedActive.length === active.length && retainedActive.every((offset, i) => offset === active[i]);
  const text = unchanged ? state.text.slice(0, displayCut) + add : render(raw, active);
  return { raw, text, anchors, active, pending };
}
