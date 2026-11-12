"use client";

import { WrapTextIcon } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { ReviewLineAnchor } from "@/domain/review-notes";
import type { WorkspaceChangedFile } from "@/runtime/api-types";
import { getAppearance } from "@/platform/appearance";

import { CopyButton } from "./CopyButton";

/** Lines shown before "Show all": a 5000-line `git diff` must not mount at once. */
const COLLAPSED_LINES = 200;
/** Lines per content-visibility chunk, so an expanded long diff paints only what is on screen. */
const CHUNK_LINES = 200;

export function looksLikeDiff(text: string): boolean {
  if (!text || text.length < 10) return false;
  if (text.includes("\n@@ ") || text.startsWith("@@ ")) return true;
  if (/^diff --git/m.test(text)) return true;
  if (/^---\s/m.test(text) && /^\+\+\+\s/m.test(text)) return true;
  const lines = text.split("\n");
  let add = 0;
  let del = 0;
  let hunk = 0;
  for (const line of lines) {
    if (line.startsWith("@@")) hunk++;
    else if (line.startsWith("+") && !line.startsWith("+++")) add++;
    else if (line.startsWith("-") && !line.startsWith("---")) del++;
  }
  if (hunk > 0) return true;
  return add > 0 && del > 0;
}

type LineKind = "add" | "del" | "hunk" | "context";

interface DiffLine {
  kind: LineKind;
  /** The line without its unified-diff sign. */
  text: string;
  /** The changed span inside a paired add/delete line, [start, end). */
  word?: [number, number];
  anchor?: ReviewLineAnchor;
}

// Git's per-file preamble: it names the file, which the header already does.
const META = /^(?:diff --git |index |--- |\+\+\+ |new file mode |deleted file mode |old mode |new mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/;

/**
 * A changed line pair shows WHICH characters changed. A shared prefix and
 * suffix is enough for the edits agents make (a renamed identifier, a new
 * argument); when most of the line differs, the whole-line tint says it.
 */
function markWords(dels: DiffLine[], adds: DiffLine[]): void {
  const pairs = Math.min(dels.length, adds.length);
  for (let i = 0; i < pairs; i++) {
    const a = dels[i]!.text;
    const b = adds[i]!.text;
    let start = 0;
    const limit = Math.min(a.length, b.length);
    while (start < limit && a[start] === b[start]) start++;
    let end = 0;
    while (end < limit - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
    const changedA = a.length - start - end;
    const changedB = b.length - start - end;
    if (start + end === 0 || Math.max(changedA / Math.max(a.length, 1), changedB / Math.max(b.length, 1)) > 0.7) continue;
    if (changedA > 0) dels[i]!.word = [start, a.length - end];
    if (changedB > 0) adds[i]!.word = [start, b.length - end];
  }
}

function parsePatch(patch: string): DiffLine[] {
  const raw = patch.split("\n");
  // A final newline produces an empty last line that carries no content.
  if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
  const out: DiffLine[] = [];
  let header = false;
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  let hunkHeader = "";
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  const anchor = (kind: "add" | "del" | "context", text: string): ReviewLineAnchor | undefined => {
    if (!hunkHeader || (kind !== "add" && oldRemaining <= 0) || (kind !== "del" && newRemaining <= 0)) return;
    const value: ReviewLineAnchor = { hunkHeader, lineText: text };
    if (kind !== "add") { value.oldLine = oldLine++; oldRemaining--; }
    if (kind !== "del") { value.newLine = newLine++; newRemaining--; }
    return value;
  };
  const flush = () => {
    if (dels.length && adds.length) markWords(dels, adds);
    dels = [];
    adds = [];
  };
  for (const line of raw) {
    if (line.startsWith("diff --git ")) { flush(); header = true; hunkHeader = ""; continue; }
    if (line.startsWith("@@")) {
      flush();
      header = false;
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      hunkHeader = match ? line : "";
      if (match) {
        oldLine = Number(match[1]); oldRemaining = Number(match[2] ?? 1);
        newLine = Number(match[3]); newRemaining = Number(match[4] ?? 1);
      }
      out.push({ kind: "hunk", text: line });
      continue;
    }
    if (header || (out.length === 0 && META.test(line))) {
      if (META.test(line)) continue;
      header = false;
    }
    if (line.startsWith("+")) {
      const entry: DiffLine = { kind: "add", text: line.slice(1), anchor: anchor("add", line.slice(1)) };
      adds.push(entry);
      out.push(entry);
    } else if (line.startsWith("-")) {
      // A delete after adds starts a new change block.
      if (adds.length) flush();
      const entry: DiffLine = { kind: "del", text: line.slice(1), anchor: anchor("del", line.slice(1)) };
      dels.push(entry);
      out.push(entry);
    } else {
      flush();
      // Only a real unified-diff prefix is a gutter; keep the backslash of
      // "\ No newline at end of file".
      out.push({
        kind: "context",
        text: line.startsWith(" ") ? line.slice(1) : line,
        anchor: line.startsWith(" ") ? anchor("context", line.slice(1)) : undefined,
      });
    }
  }
  flush();
  return out;
}

function countChanges(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added++;
    else if (line.kind === "del") removed++;
  }
  return { added, removed };
}

const ROW: Record<LineKind, string> = {
  add: "bg-success/15",
  del: "bg-danger/10",
  hunk: "text-tertiary",
  context: "",
};
const SIGN: Record<LineKind, string> = { add: "+", del: "−", hunk: "", context: "" };

function LineText({ line }: { line: DiffLine }) {
  if (!line.word) return <>{line.text}</>;
  const [start, end] = line.word;
  return (
    <>
      {line.text.slice(0, start)}
      <span className={cn("rounded-sm", line.kind === "add" ? "bg-success/40" : "bg-danger/35")}>{line.text.slice(start, end)}</span>
      {line.text.slice(end)}
    </>
  );
}

function DiffLines({ lines, wrap }: { lines: readonly DiffLine[]; wrap: boolean }) {
  const chunks: DiffLine[][] = [];
  for (let i = 0; i < lines.length; i += CHUNK_LINES) chunks.push(lines.slice(i, i + CHUNK_LINES));
  return (
    <div data-testid="diff-lines" className={cn("py-1 font-mono text-code tabular-nums", wrap ? "w-full min-w-0" : "min-w-max")}>
      {chunks.map((chunk, index) => (
        <div key={index} style={chunks.length > 1 ? { contentVisibility: "auto", containIntrinsicSize: `auto ${chunk.length * 18}px` } : undefined}>
          {chunk.map((line, offset) => (
            <div
              key={offset}
              data-testid="diff-line"
              data-kind={line.kind}
              className={cn("flex", wrap ? "min-w-0 whitespace-pre-wrap" : "whitespace-pre", ROW[line.kind])}
            >
              <span aria-hidden className={cn("w-5 shrink-0 select-none text-center", line.kind === "add" ? "text-success" : line.kind === "del" ? "text-danger" : "text-tertiary")}>
                {SIGN[line.kind]}
              </span>
              <span data-testid="diff-line-content" className={cn("flex-1 pr-3", wrap && "min-w-0 [overflow-wrap:anywhere]")}>
                {line.kind === "add" || line.kind === "del" ? <span className="sr-only">{line.kind === "add" ? "Added: " : "Removed: "}</span> : null}
                <LineText line={line} />
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The lines of one unified diff and nothing else: no card, no header, no
 * toolbar, so a caller (a tool detail, the Changes tab) draws exactly one of
 * each around it. Git's `diff --git`/index/mode preamble is hidden; hunk
 * headers stay as quiet separators.
 */
export function DiffView({ patch, wrap = false, onAnnotate }: {
  patch: string;
  wrap?: boolean;
  /** Opt-in only: transcript diffs keep their compact, read-only behavior. */
  onAnnotate?: (line: ReviewLineAnchor) => void;
}) {
  const lines = useMemo(() => parsePatch(patch), [patch]);
  const [choice, setChoice] = useState({ patch, index: "" });
  const selection = choice.patch === patch ? choice.index : "";
  const selected = selection === "" ? undefined : lines[Number(selection)]?.anchor;
  return (
    <>
      {onAnnotate ? (
        <div className="flex min-w-0 items-center gap-2 px-4 py-2">
          <select
            aria-label="Line to annotate"
            value={selection}
            onChange={(event) => setChoice({ patch, index: event.target.value })}
            className="min-h-12 min-w-0 flex-1 rounded-md border border-control bg-background px-2 text-meta text-foreground"
          >
            <option value="">Choose a line…</option>
            {lines.map((line, index) => line.anchor ? (
              <option key={index} value={index}>
                {line.anchor.oldLine === undefined ? "Added" : line.anchor.newLine === undefined ? "Removed" : "Context"}
                {` · old ${line.anchor.oldLine ?? "—"} / new ${line.anchor.newLine ?? "—"} · ${line.text}`}
              </option>
            ) : null)}
          </select>
          <Button type="button" variant="secondary" className="min-h-12" disabled={selection === "" || !selected} onClick={() => { if (selected) onAnnotate(selected); }}>
            Add line note
          </Button>
        </div>
      ) : null}
      <div role="region" aria-label="Code diff" tabIndex={0} className={cn("min-w-0 max-w-full outline-none focus-visible:ring-2 focus-visible:ring-ring", !wrap && "edge-fade-x overflow-x-auto [overscroll-behavior-x:contain]")}>
        <DiffLines lines={lines} wrap={wrap} />
      </div>
    </>
  );
}

export function ChangeCounts({ added, removed, className }: { added: number; removed: number; className?: string }) {
  return (
    <span className={cn("shrink-0 whitespace-nowrap tabular-nums", className)}>
      <span aria-hidden className="text-success">+{added}</span> <span aria-hidden className="text-danger">−{removed}</span>
      <span className="sr-only">{`${added} added, ${removed} removed`}</span>
    </span>
  );
}

/**
 * One diff as one surface: the file header `path +a −r`, one toolbar (Wrap,
 * Copy) for the whole diff, and its lines. Used by tool details for edits and
 * diff-shaped command output.
 */
export function DiffPart({ text, path, added, removed, note }: {
  text: string;
  /** The file; omitted for a multi-file diff from a command. */
  path?: string;
  /** Exact counts when the caller knows them (a capped edit diff undercounts). */
  added?: number;
  removed?: number;
  /** One quiet line under the lines, e.g. a truncation notice. */
  note?: string;
}) {
  const [wrap, setWrap] = useState(() => getAppearance().wrapCode);
  const [showAll, setShowAll] = useState(false);
  const lines = useMemo(() => parsePatch(text), [text]);
  const counts = useMemo(() => countChanges(lines), [lines]);
  const visible = showAll ? lines : lines.slice(0, COLLAPSED_LINES);
  const hidden = lines.length - visible.length;
  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-lg bg-surface-1" data-testid="diff-part">
      <div className="flex min-h-8 min-w-0 items-center gap-2 pl-3 pr-1 text-meta">
        <span className="min-w-0 flex-1 truncate text-foreground" title={path}>{path ?? "Changes"}</span>
        <ChangeCounts added={added ?? counts.added} removed={removed ?? counts.removed} />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Wrap lines"
          aria-pressed={wrap}
          onClick={() => setWrap((value) => !value)}
          className={cn("text-muted-foreground", wrap && "bg-surface-3 text-foreground")}
        >
          <WrapTextIcon aria-hidden className="size-4" />
        </Button>
        <CopyButton text={text} label="Copy diff" size="icon-sm" className="text-muted-foreground" />
      </div>
      <div role="region" aria-label="Code diff" tabIndex={0} className={cn("min-w-0 max-w-full outline-none focus-visible:ring-2 focus-visible:ring-ring", !wrap && "edge-fade-x overflow-x-auto [overscroll-behavior-x:contain]")}>
        <DiffLines lines={visible} wrap={wrap} />
      </div>
      {hidden > 0 || note ? (
        <div className="flex min-h-8 items-center gap-2 px-3 pb-1 text-meta text-muted-foreground">
          {note ? <span className="min-w-0 flex-1">{note}</span> : null}
          {hidden > 0 ? (
            <button type="button" className="relative ml-auto shrink-0 tabular-nums text-primary-text outline-none after:absolute after:-inset-y-3 after:inset-x-0 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setShowAll(true)} data-testid="show-all">
              Show all ({hidden.toLocaleString()} more {hidden === 1 ? "line" : "lines"})
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const STATUS_NOTE: Record<WorkspaceChangedFile["status"], string | null> = {
  modified: null,
  added: "New file",
  deleted: "Deleted",
  renamed: null,
  untracked: "Not tracked yet",
  conflicted: "Unresolved conflict",
};

/** One changed file from `/api/changes`: header `path +a −r`, then its diff or why there is none. */
export function FileDiff({ file }: { file: WorkspaceChangedFile }) {
  const note = file.status === "renamed" && file.oldPath ? `Renamed from ${file.oldPath}` : STATUS_NOTE[file.status];
  const body = file.binary
    ? "Binary file, no text diff."
    : !file.patch.trim()
      ? file.patchTruncated ? "Diff too large to show." : "No text changes."
      : null;
  return (
    <section className="min-w-0" data-testid="file-diff" aria-label={file.path}>
      <div className="flex min-h-8 min-w-0 items-center gap-2 text-meta">
        <span className="min-w-0 flex-1 truncate text-foreground" title={file.path}>{file.path}</span>
        {file.binary ? null : <ChangeCounts added={file.additions} removed={file.deletions} />}
      </div>
      {note ? <p className="pb-1 text-meta text-muted-foreground">{note}</p> : null}
      {body ? (
        <p className="py-2 text-meta text-muted-foreground">{body}</p>
      ) : (
        <Fragment>
          <div className="overflow-hidden rounded-lg bg-surface-1">
            <DiffView patch={file.patch} />
          </div>
          {file.patchTruncated ? <p className="pt-1 text-meta text-muted-foreground">Diff too large to show in full.</p> : null}
        </Fragment>
      )}
    </section>
  );
}
