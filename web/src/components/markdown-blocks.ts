/** Group only whole parser blocks; independent newline slices corrupt Markdown. */
export function groupMarkdownBlocks(
  text: string,
  parse: (text: string) => string[],
  target = 8000,
): string[] {
  // Definitions can resolve links in any other block. This intentionally
  // broad signal also falls back for code containing "]:"; it is not a second
  // Markdown parser and must never claim those documents are independent.
  if (text.includes("]:")) return [text];
  const blocks = parse(text);
  // The public splitter normalizes some newlines. Fall back to one parser
  // context whenever its blocks do not reconstruct the source exactly.
  if (blocks.length < 2 || blocks.join("") !== text) return [text];
  const groups: string[] = [];
  for (const block of blocks) {
    const last = groups.length - 1;
    if (last >= 0 && groups[last]!.length + block.length <= target) {
      groups[last] += block;
    } else {
      groups.push(block);
    }
  }
  return groups;
}
