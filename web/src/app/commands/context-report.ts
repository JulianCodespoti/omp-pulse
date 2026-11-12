/**
 * omp's `/context` breakdown, parsed for display. omp prints it as text for
 * a terminal (slash-commands/helpers/context-report.ts):
 *
 *   Context window: 200000 tokens (7% used)
 *     System prompt    [░░░░░░░░░░░░░░░░░░░░░░░░] 1%  2792 tokens
 *     Free             [███████████████████░░░░░] 78%  156174 tokens
 *
 * followed by optional plain lines (snapcompact savings). The daemon has
 * already stripped the bar colours; the ASCII bars themselves are redrawn as
 * real bars here.
 */
export interface ContextCategory {
  label: string;
  percent: number;
  tokens: number;
}

export interface ContextReport {
  contextWindow: number;
  percent: number;
  categories: ContextCategory[];
  /** Lines after the table, kept verbatim. */
  notes: string[];
}

const HEADER = /^Context window: (\d+) tokens \((\d+)% used\)$/;
const ROW = /^ {2}(\S.*?)\s+\[[^\]]*\]\s*(\d+)%\s+(\d+) tokens$/;
// omp pads labels to 16 columns, which cuts this one short.
const LABELS: Record<string, string> = { "Auto-compact buf": "Auto-compact reserve" };

/** `null` when the text is not omp's breakdown (e.g. "Context usage is unavailable."). */
export function parseContextReport(text: string): ContextReport | null {
  const lines = text.replace(/\r/g, "").split("\n");
  const header = HEADER.exec(lines[0]?.trim() ?? "");
  if (!header) return null;
  const categories: ContextCategory[] = [];
  const notes: string[] = [];
  for (const line of lines.slice(1)) {
    const row = notes.length === 0 ? ROW.exec(line.trimEnd()) : null;
    if (row) {
      const label = row[1]!.trim();
      categories.push({ label: LABELS[label] ?? label, percent: Number(row[2]), tokens: Number(row[3]) });
    } else if (line.trim()) {
      notes.push(line.trim());
    }
  }
  return { contextWindow: Number(header[1]), percent: Number(header[2]), categories, notes };
}
