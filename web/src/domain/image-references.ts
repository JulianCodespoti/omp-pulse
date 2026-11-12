// Larger numbers can refer to earlier conversation images. Only references
// recorded while recovering a message belong to the editable attachment tray.
const IMAGE_REFERENCE = /\[(Image|Video) #([1-9]\d*)((?:,[^\]\n]*)?)\](?: attachment:\/\/(\2))?/g;
export interface DraftImageReference { start: number; end: number; imageId: string }

export function recoverImageReferences(text: string, imageNumbers: readonly (number | null)[], imageIds: readonly string[]) {
  const references: DraftImageReference[] = [];
  let offset = 0;
  const mapped = text.replace(IMAGE_REFERENCE, (match, kind: string, index: string, detail: string, link: string | undefined, start: number) => {
    const number = imageNumbers[Number(index) - 1];
    if (number === undefined) return match;
    const label = number === null ? `[${kind} removed]` : `[${kind} #${number}${detail}]`;
    const value = link === undefined || number === null ? label : `${label} attachment://${number}`;
    const imageId = imageIds[Number(index) - 1];
    if (number !== null && imageId) references.push({ start: start + offset, end: start + offset + value.length, imageId });
    offset += value.length - match.length;
    return value;
  });
  return { text: mapped, references };
}


/** Keep ownership only for spans untouched by an editor replacement. Manually
 * replaced labels become ordinary text, never guesses about conversation photos. */
export function editedImageReferences(previous: string, next: string, references: readonly DraftImageReference[]): DraftImageReference[] {
  if (previous === next) return [...references];
  const retained = previous ? next.indexOf(previous) : -1;
  if (retained >= 0 && next.indexOf(previous, retained + 1) < 0)
    return references.map(reference => ({ ...reference, start: reference.start + retained, end: reference.end + retained }));
  let start = 0, end = previous.length, nextEnd = next.length;
  while (start < end && start < nextEnd && previous[start] === next[start]) start++;
  while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
  const delta = nextEnd - end;
  return references.flatMap(reference => reference.end <= start ? [reference]
    : reference.start >= end ? [{ ...reference, start: reference.start + delta, end: reference.end + delta }] : []);
}

export function updateDraftImageReferences(text: string, references: readonly DraftImageReference[], imageIds: readonly (string | undefined)[]) {
  let value = "", cursor = 0;
  const kept: DraftImageReference[] = [];
  for (const reference of references) {
    value += text.slice(cursor, reference.start);
    const original = text.slice(reference.start, reference.end);
    const index = imageIds.indexOf(reference.imageId);
    // The displayed number is already remapped, so map its single owned span
    // directly rather than interpreting it as a new message-local index.
    const mapped = original.replace(IMAGE_REFERENCE, (_match, kind: string, _number: string, detail: string, link?: string) =>
      index < 0 ? `[${kind} removed]` : `[${kind} #${index + 1}${detail}]${link === undefined ? "" : ` attachment://${index + 1}`}`);
    if (index >= 0) kept.push({ ...reference, start: value.length, end: value.length + mapped.length });
    value += mapped;
    cursor = reference.end;
  }
  return { text: value + text.slice(cursor), references: kept };
}
