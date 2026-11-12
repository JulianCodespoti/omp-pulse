"use client";

import { FilePenLineIcon, WrapTextIcon } from "lucide-react";
import { memo, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { getAppearance } from "@/platform/appearance";
import type { UiMessage } from "@/domain/messages";
import { cn } from "@/lib/utils";
import { BottomSheet } from "@/app/ui/Sheet";

import { CopyButton } from "./CopyButton";
import { ChangeCounts, DiffView } from "./DiffPart";
import { summarizeEdits, type EditedFile } from "./run-summary";
import { countLines } from "./tool-summary";
import { SHOW_ALL } from "./tools/OutputBlock";

const plural = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;
/** Lines of each diff shown in the transcript; the sheet reads them whole. */
const INLINE_LINES = 20;

function EditedFileDiffs({ file, wrap, preview }: { file: EditedFile; wrap: boolean; preview: boolean }) {
  return (
    <section className="min-w-0" data-testid="edited-file" aria-label={file.path}>
      <div className="flex min-h-8 min-w-0 items-center gap-2 text-meta">
        <span className="min-w-0 flex-1 truncate text-foreground" title={file.path}>{file.path}</span>
        <ChangeCounts added={file.added} removed={file.removed} />
      </div>
      <div className="flex min-w-0 flex-col gap-2" data-testid="edited-file-diff">
        {file.changes.map((change, index) => change.diff ? (
          <div key={index} className="min-w-0">
            <div
              className={cn(
                "overflow-hidden rounded-lg bg-surface-1",
                // 20 lines of 18px plus the list padding; the fade says there is more.
                preview && countLines(change.diff) > INLINE_LINES && "max-h-[23rem] [mask-image:linear-gradient(to_bottom,black_calc(100%-24px),transparent)]",
              )}
            >
              <DiffView patch={change.diff} wrap={wrap} />
            </div>
            {change.truncated ? <p className="pt-1 text-meta text-muted-foreground">Diff shortened; the counts cover the whole change.</p> : null}
          </div>
        ) : (
          <p key={index} className="text-meta text-muted-foreground">No diff was recorded for this change.</p>
        ))}
      </div>
    </section>
  );
}

/** Every edited file's diffs under one toolbar, with the totals at the foot. */
function EditedFiles({ files, preview, onShowAll }: { files: EditedFile[]; preview: boolean; onShowAll?: () => void }) {
  const [wrap, setWrap] = useState(() => getAppearance().wrapCode);
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  const allDiffs = useMemo(() => files.flatMap((file) => file.changes.map((change) => change.diff).filter(Boolean)).join("\n"), [files]);
  const capped = preview && files.some((file) => file.changes.some((change) => countLines(change.diff) > INLINE_LINES));
  return (
    <div className="flex min-w-0 flex-col gap-4 pb-2" data-testid="edit-summary-files">
      <div className="-mt-1 flex min-h-8 items-center justify-end gap-1">
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
        {allDiffs ? <CopyButton text={allDiffs} label="Copy all diffs" size="icon-sm" className="text-muted-foreground" /> : null}
      </div>
      {files.map((file) => <EditedFileDiffs key={file.path} file={file} wrap={wrap} preview={preview} />)}
      <div className="flex min-w-0 items-center gap-3">
        <p className="min-w-0 flex-1 text-meta text-muted-foreground" data-testid="edit-summary-total">
          {plural(files.length)} · <ChangeCounts added={added} removed={removed} />
        </p>
        {capped && onShowAll ? (
          <button type="button" className={SHOW_ALL} onClick={onShowAll} data-testid="show-all">Show all</button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Successful edits belong to their final reply, not every intermediate tool
 * run: one row "Edited 2 files +18 −4". A tap opens every diff in place, each
 * cut to its first lines; "Show all" reads them whole in a sheet.
 */
export const EditSummary = memo(function EditSummary({ messages }: { messages: readonly UiMessage[] }) {
  const [expanded, setExpanded] = useState(false);
  // null until first opened: the reader sheet costs nothing until asked for.
  const [reader, setReader] = useState<boolean | null>(null);
  const files = useMemo(() => summarizeEdits(messages), [messages]);
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  if (!files.length) return null;
  return (
    <div className="min-w-0" data-testid="edit-summary">
      <button
        type="button"
        className="relative flex h-8 w-full min-w-0 items-center gap-2 rounded-md text-left text-ui text-muted-foreground outline-none after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] press-bounce focus-visible:ring-2 focus-visible:ring-ring"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} edits: ${plural(files.length)}, ${added} added, ${removed} removed`}
        onClick={() => setExpanded((value) => !value)}
        data-testid="edit-summary-toggle"
      >
        <FilePenLineIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 truncate">Edited {plural(files.length)}</span>
        <ChangeCounts added={added} removed={removed} className="text-meta" />
      </button>
      {expanded ? (
        <div className="disclosure min-w-0 pl-6 pt-1">
          <EditedFiles files={files} preview onShowAll={() => setReader(true)} />
        </div>
      ) : null}
      {reader !== null ? (
        <BottomSheet open={reader} onOpenChange={setReader} title={`Edited ${plural(files.length)}`} testId="edit-summary-sheet">
          <EditedFiles files={files} preview={false} />
        </BottomSheet>
      ) : null}
    </div>
  );
});
