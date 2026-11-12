import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { DownloadIcon, FileIcon, PencilIcon, SaveIcon, Share2Icon, XIcon } from "lucide-react";

import { showToast } from "@/app/Notices";
import { CopyButton } from "@/app/parts/CopyButton";
import { Notice } from "@/app/ui/Notice";
import { EmptyState } from "@/app/ui/EmptyState";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { readPairingToken } from "@/platform/browser-storage";
import { fileSaveMode, saveBlob } from "@/platform/native-shell";
import { useFileDraft } from "@/runtime/file-draft";
import { DaemonApi, FileConflictError } from "@/runtime/rpc-client";
import type { FileContent } from "@/runtime/api-types";
import { fetchWithDeadline } from "@/runtime/request";
import type { BundledLanguage, TokensResult } from "shiki";
import { BottomSheet, SheetLoading } from "@/app/ui/Sheet";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import { isSessionResource } from "@/app/parts/SessionResources";

import { formatBytes } from "./format";

type FileViewerProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  path: string | null;
  sessionPath?: string | null;
};

function extLanguage(p: string): string {
  const base = p.split("/").pop() ?? p;
  const dot = base.lastIndexOf(".");
  if (dot === -1 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

const LANGUAGE_NAME: Record<string, string> = {
  md: "Markdown",
  markdown: "Markdown",
  ts: "TypeScript",
  tsx: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  json: "JSON",
  rs: "Rust",
  py: "Python",
  go: "Go",
  sh: "Shell",
  toml: "TOML",
  yaml: "YAML",
  yml: "YAML",
  css: "CSS",
  html: "HTML",
  kt: "Kotlin",
  java: "Java",
  txt: "Text",
};

// Highlighting tokenizes on the main thread; past this many characters the
// pass would stall the sheet, so a larger file stays plain text.
const HIGHLIGHT_MAX_CHARS = 100_000;

// Grammars the build ships (allowedShikiLangs in vite.config.ts); an extension
// outside this map is shown as plain text. A Map: an extension called
// `constructor` must not hit the prototype.
const EXTENSION_GRAMMAR = new Map<string, BundledLanguage>([
  ["ts", "typescript"], ["mts", "typescript"], ["cts", "typescript"],
  ["tsx", "tsx"],
  ["js", "javascript"], ["mjs", "javascript"], ["cjs", "javascript"],
  ["jsx", "jsx"],
  ["json", "json"], ["jsonc", "jsonc"],
  ["rs", "rust"],
  ["py", "python"],
  ["sh", "bash"], ["bash", "bash"], ["zsh", "bash"],
  ["toml", "toml"],
  ["yaml", "yaml"], ["yml", "yaml"],
  ["css", "css"],
  ["html", "html"], ["htm", "html"],
  ["md", "markdown"], ["markdown", "markdown"],
  ["diff", "diff"], ["patch", "diff"],
]);

// Shiki's own line split, so token lines and text lines stay index-aligned.
const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Colours for a file, arriving after its plain text is already on screen. The
 * highlighter is a lazy chunk (the code-plugin the markdown fences use), so a
 * file never waits for it; any failure leaves the plain text.
 */
function useHighlightedTokens(content: string, language: BundledLanguage | null): TokensResult["tokens"] | null {
  const [result, setResult] = useState<{ content: string; language: string; tokens: TokensResult["tokens"] } | null>(null);
  useEffect(() => {
    if (!language || content.length > HIGHLIGHT_MAX_CHARS) return;
    let live = true;
    const apply = (tokens: TokensResult) => {
      if (live) setResult({ content, language, tokens: tokens.tokens });
    };
    import("@/components/code-plugin")
      .then(({ code }) => {
        if (!live) return;
        const hit = code.highlight({ code: content, language, themes: code.getThemes() }, apply);
        if (hit) apply(hit);
      })
      .catch(() => {
        // Plain text is the designed fallback; nothing to report to the reader.
      });
    return () => { live = false; };
  }, [content, language]);
  return result && result.content === content && result.language === language ? result.tokens : null;
}

// One block per line so a soft-wrapped line keeps a hanging indent under its
// number. The number is a CSS counter on ::before: generated content is not
// selectable, not copied and not in textContent, so selecting or copying the
// file never picks up the gutter.
const LINE_CLASS =
  "block pl-[var(--gutter)] [text-indent:calc(var(--gutter)*-1)] [counter-increment:line] before:mr-[2ch] before:inline-block before:w-[calc(var(--gutter)-2ch)] before:select-none before:text-right before:text-tertiary before:tabular-nums before:[text-indent:0] before:content-[counter(line)]";
// Streamdown's token colouring: the light colour in --sdm-c, the dark one in --shiki-dark.
const TOKEN_CLASS = "text-[var(--sdm-c,inherit)] dark:text-[var(--shiki-dark,var(--sdm-c,inherit))]";

function FileCode({ content, language }: { content: string; language: BundledLanguage | null }) {
  const tokens = useHighlightedTokens(content, language);
  const lines = useMemo(() => content.split(LINE_BREAK), [content]);
  // A final newline ends the last line; it does not open another numbered one.
  const trailingBreak = lines.length > 1 && lines[lines.length - 1] === "";
  const count = trailingBreak ? lines.length - 1 : lines.length;
  const coloured = tokens && tokens.length === lines.length ? tokens : null;
  return (
    <pre
      data-testid="file-content"
      style={{ "--gutter": `${String(count).length + 2}ch` } as CSSProperties}
      className="-mx-4 whitespace-pre-wrap break-words bg-surface-2 px-4 py-3 font-mono text-code text-foreground [counter-reset:line] [overflow-wrap:anywhere]"
    >
      <code>
        {Array.from({ length: count }, (_, index) => (
          <span key={index} className={LINE_CLASS}>
            {coloured
              ? coloured[index].map((token, at) => {
                  const style: Record<string, string> = {};
                  const color = token.htmlStyle?.color ?? token.color;
                  if (color) style["--sdm-c"] = color;
                  const dark = token.htmlStyle?.["--shiki-dark"];
                  if (dark) style["--shiki-dark"] = dark;
                  return <span key={at} className={TOKEN_CLASS} style={style}>{token.content}</span>;
                })
              : lines[index]}
            {index < count - 1 || trailingBreak ? "\n" : ""}
          </span>
        ))}
      </code>
    </pre>
  );
}

export function FileViewer({ open, onOpenChange, path, sessionPath }: FileViewerProps) {
  const resolvedSession = sessionPath ?? null;
  const filePath = path ?? "";
  const readOnly = isSessionResource(filePath);
  const { draft: retainedDraft, update: retainDraft, discard: discardDraft, acknowledge: acknowledgeDraft, acknowledged, acknowledgementKey, beginRead, storageError } = useFileDraft(readOnly ? null : resolvedSession, readOnly ? "" : filePath);
  const retainedDraftRef = useRef(retainedDraft);
  retainedDraftRef.current = retainedDraft;
  const lastAcknowledgement = useRef(acknowledgementKey);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [data, setData] = useState<FileContent | null>(null);
  const [downloading, setDownloading] = useState(false);
  const downloadGeneration = useRef(0);
  const downloadPending = useRef(false);
  useLayoutEffect(() => {
    downloadGeneration.current++;
    downloadPending.current = false;
    setDownloading(false);
    return () => { downloadGeneration.current++; downloadPending.current = false; };
  }, [open, filePath, resolvedSession]);

  // The retained baseline travels with the draft and is enforced by POST.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saveConflict, setSaveConflict] = useState(false);
  const [saved, setSaved] = useState(false);
  const baselineRef = useRef<string>("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const readGeneration = useRef(0);
  const saveGeneration = useRef(0);
  const savePending = useRef(false);
  const savedTimer = useRef<number | null>(null);
  const draftRef = useRef(draft);
  const viewRef = useRef({ open, filePath, resolvedSession });
  viewRef.current = { open, filePath, resolvedSession };
  draftRef.current = draft;
  const updateDraft = useCallback((value: string) => {
    draftRef.current = value;
    setDraft(value);
  }, []);
  const cancelSave = useCallback(() => {
    saveGeneration.current++;
    savePending.current = false;
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    savedTimer.current = null;
    setSaving(false);
  }, []);
  useLayoutEffect(() => {
    readGeneration.current++;
    cancelSave();
    setData(null);
    setEditing(false);
    setSaved(false);
    setSaveError(null);
    setSaveConflict(false);
    setError(null);
    setLoading(Boolean(open && filePath && resolvedSession));
    return () => { readGeneration.current++; cancelSave(); };
  }, [open, filePath, resolvedSession, cancelSave]);

  const load = useCallback(async () => {
    if (!open || !filePath || !resolvedSession) return;
    const generation = ++readGeneration.current;
    const finishRead = beginRead();
    const current = () => generation === readGeneration.current && viewRef.current.open && viewRef.current.filePath === filePath && viewRef.current.resolvedSession === resolvedSession;
    cancelSave();
    setLoading(true);
    setError(null);
    setData(null);
    setEditing(false);
    setSaveError(null);
    setSaveConflict(false);
    setSaved(false);
    try {
      const api = new DaemonApi(readPairingToken());
      const res = await api.readFile(resolvedSession, filePath);
      if (!current()) return;
      if (readOnly) {
        setData(res);
      } else {
        const restored = finishRead(res.content ?? "");
        setData({ ...res, content: restored.content });
        // A retained edit owns its original baseline, not the latest disk fetch.
        baselineRef.current = restored.draft?.baseline ?? restored.content;
        updateDraft(restored.draft?.content ?? restored.content);
        setEditing(Boolean(restored.draft && !res.binary && !res.truncated));
        if (restored.draft && restored.draft.baseline !== restored.content) {
          setSaveConflict(true);
          setSaveError(humanizeDaemonError(new FileConflictError()));
        }
      }
    } catch (e) {
      if (current()) setError(e);
    } finally {
      if (current()) setLoading(false);
    }
  }, [open, filePath, resolvedSession, readOnly, cancelSave, updateDraft, beginRead]);

  useEffect(() => {
    if (!open) {
      setError(null);
      setData(null);
      setEditing(false);
      setSaveError(null);
      setSaved(false);
      return;
    }
    void load();
  }, [open, load]);

  useEffect(() => {
    if (retainedDraft && editing) {
      baselineRef.current = retainedDraft.baseline;
      updateDraft(retainedDraft.content);
    }
    if (lastAcknowledgement.current === acknowledgementKey) return;
    lastAcknowledgement.current = acknowledgementKey;
    if (!acknowledged || !open || loading || !data) return;
    baselineRef.current = retainedDraft?.baseline ?? acknowledged.content;
    setData((previous) => previous ? { ...previous, content: acknowledged.content, size: new Blob([acknowledged.content]).size } : previous);
    if (!retainedDraft) {
      updateDraft(acknowledged.content);
      setEditing(false);
    }
  }, [retainedDraft, acknowledgementKey, acknowledged, open, loading, data, editing, updateDraft]);

  // focus textarea when entering edit, without stealing focus on open
  useEffect(() => {
    if (!editing) return;
    const t = window.setTimeout(() => {
      textareaRef.current?.focus();
      // place cursor at end for one-thumbed continuation
      const el = textareaRef.current;
      if (el) {
        const len = el.value.length;
        try {
          el.setSelectionRange(len, len);
        } catch {
          // ignore
        }
      }
    }, 60);
    return () => window.clearTimeout(t);
  }, [editing]);

  const isEditable = Boolean(!readOnly && data && !data.binary && !data.truncated);

  const handleStartEdit = useCallback(() => {
    if (!data || !isEditable) return;
    cancelSave();
    const retained = retainedDraftRef.current;
    baselineRef.current = retained?.baseline ?? data.content ?? "";
    updateDraft(retained?.content ?? data.content ?? "");
    setSaveError(null);
    setSaveConflict(false);
    setSaved(false);
    setEditing(true);
  }, [data, isEditable, cancelSave, updateDraft]);

  const handleCancel = useCallback(() => {
    cancelSave();
    discardDraft();
    setEditing(false);
    updateDraft(baselineRef.current);
    setSaveError(null);
    setSaveConflict(false);
    setSaved(false);
    setSaving(false);
  }, [cancelSave, updateDraft, discardDraft]);

  const handleSave = useCallback(async () => {
    if (!open || !resolvedSession || !filePath || savePending.current) return;
    // binary/truncated must stay read-only — viewer already badges them
    if (!isEditable) {
      setSaveError("This file can’t be edited (binary or truncated).");
      return;
    }
    if (draft.length > 1_048_576) {
      setSaveError("File is too large — 1 MB maximum.");
      return;
    }
    const submitted = draftRef.current;
    const baseline = baselineRef.current;
    const submittedDraft = retainedDraftRef.current;
    const generation = ++saveGeneration.current;
    savePending.current = true;
    const current = () => generation === saveGeneration.current && viewRef.current.open && viewRef.current.filePath === filePath && viewRef.current.resolvedSession === resolvedSession;
    if (savedTimer.current !== null) window.clearTimeout(savedTimer.current);
    savedTimer.current = null;
    setSaving(true);
    setSaveError(null);
    setSaveConflict(false);
    setSaved(false);
    try {
      const api = new DaemonApi(readPairingToken());
      // Early feedback avoids submitting a known conflict, but only the
      // server-side precondition protects the gap between this GET and POST.
      await api.verifyFileBaseline(resolvedSession, filePath, baseline);
      if (!current()) return;
      await api.writeFile(resolvedSession, filePath, submitted, baseline);
      // Acknowledge even after dismissal: cleanup belongs to the submitted
      // draft, not whichever view is mounted when the server replies.
      acknowledgeDraft(submittedDraft ? { ...submittedDraft, content: submitted, baseline } : null);
      if (!current()) return;
      baselineRef.current = submitted;
      setData((prev) => (prev ? { ...prev, content: submitted, size: new Blob([submitted]).size } : prev));
      // The acknowledged snapshot is saved; typing since that snapshot is not.
      if (draftRef.current === submitted) {
        setEditing(false);
        setSaved(true);
        savedTimer.current = window.setTimeout(() => {
          savedTimer.current = null;
          if (current()) setSaved(false);
        }, 2200);
      }
    } catch (e) {
      if (current()) {
        setSaveError(e);
        setSaveConflict(e instanceof FileConflictError);
      }
    } finally {
      if (current()) { savePending.current = false; setSaving(false); }
    }
  }, [open, resolvedSession, filePath, draft, isEditable, acknowledgeDraft]);

  const handleReload = useCallback(() => {
    discardDraft();
    setEditing(false);
    setSaveError(null);
    setSaveConflict(false);
    setSaved(false);
    void load();
  }, [load, discardDraft]);

  const fileName = (readOnly ? data?.name : undefined) ?? filePath.split("/").pop() ?? filePath;
  // The Android shell cannot save blob: anchors; there the only working save
  // path is the share sheet, and with no file share we offer nothing.
  const saveMode = fileSaveMode(fileName || "download");

  const handleDownload = useCallback(async () => {
    if (!open || !filePath || !resolvedSession || downloadPending.current) return;
    const generation = ++downloadGeneration.current;
    const current = () => generation === downloadGeneration.current;
    downloadPending.current = true;
    setDownloading(true);
    try {
      const token = readPairingToken();
      const qs = new URLSearchParams({ session: resolvedSession, path: filePath });
      // Deadline: a stalled link left the Download/Share spinner running forever.
      const res = await fetchWithDeadline(`/api/raw?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!current()) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if (!current()) return;
      await saveBlob(blob, fileName || "download");
    } catch {
      if (current()) {
        showToast(
          saveMode === "share"
            ? "Couldn't share this file. Check the connection and try again."
            : "Couldn't download this file. Check the connection and try again.",
          "warn",
        );
      }
    } finally {
      if (current()) {
        downloadPending.current = false;
        setDownloading(false);
      }
    }
  }, [open, filePath, resolvedSession, fileName, saveMode]);

  // Size and kind live in the sheet description, so nothing stacks above the code.
  const ext = extLanguage(fileName);
  const kind = ext ? (LANGUAGE_NAME[ext] ?? ext.toUpperCase()) : "";
  const description = data
    ? [formatBytes(data.size), readOnly ? "Read-only session file" : "", data.binary ? "Binary" : kind].filter(Boolean).join(" · ")
    : undefined;
  // The header's Download, offered again where the reader is looking: under a
  // truncated preview and in place of a binary file's body.
  const downloadAction = filePath && resolvedSession && saveMode
    ? { label: saveMode === "share" ? "Share" : "Download", onClick: () => void handleDownload() }
    : undefined;

  const canEdit = Boolean(isEditable && data?.content !== undefined);

  let body: React.ReactNode;
  if (loading) body = <SheetLoading label="Loading…" />;
  else if (error) body = <Notice tone="danger" action={errorRecoveryAction(error) ?? { label: "Retry", onClick: () => void load() }}>{humanizeDaemonError(error)}</Notice>;
  else if (!data) body = <EmptyState icon={<FileIcon />} title="No file selected." />;
  else if (data.binary)
    body = (
      <EmptyState
        icon={<FileIcon />}
        title="Binary file, not shown."
        description={downloadAction ? (saveMode === "share" ? "Share it to open it in another app." : "Download it to open it in another app.") : undefined}
        action={downloadAction}
      />
    );
  else if (editing)
    body = (
      <div className="space-y-3">
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => {
            updateDraft(e.target.value);
            retainDraft(e.target.value, baselineRef.current);
            if (saveError && !saveConflict) setSaveError(null);
            if (saved) setSaved(false);
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) {
              // IME Escape belongs to the candidate UI, not this edit or its sheet.
              if (e.key === "Escape") e.stopPropagation();
              return;
            }
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (!e.repeat && !saving) void handleSave();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              if (e.repeat) {
                e.stopPropagation();
                return;
              }
              // Escape dismisses the sheet; only the explicit Cancel action discards.
              cancelSave();
              setEditing(false);
            }
          }}
          // The bounded editor owns text-scroll gestures. Do not arm the sheet's
          // outer drag-to-dismiss while its viewport remains at scrollTop zero.
          onTouchStart={(event) => event.stopPropagation()}
          rows={14}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          wrap="soft"
          enterKeyHint="enter"
          data-testid="file-editor"
          className="field-sizing-fixed h-[min(45dvh,24rem)] min-h-0 w-full resize-none overflow-y-auto rounded-md border border-control bg-background font-mono text-code md:text-code tabular-nums shadow-none"
          placeholder="Edit file…"
          aria-label="File editor"
        />
        {saveError ? (
          <Notice tone="danger" action={errorRecoveryAction(saveError)}>{humanizeDaemonError(saveError)}</Notice>
        ) : null}
        {saveConflict ? (
          <Button variant="secondary" className="w-full tabular-nums" onClick={handleReload} aria-label="Discard draft and reload">
            Discard draft and reload
          </Button>
        ) : null}
      </div>
    );
  else
    body = (
      <div className="space-y-3">
        {saved || saveError ? (
          <p role={saveError ? "alert" : "status"} className={saveError ? "text-meta text-danger" : "text-meta text-success"}>
            {saveError ? humanizeDaemonError(saveError) : "Saved"}
          </p>
        ) : null}
        {/* The file as text, never through markdown: a file that contains a
            ``` fence would otherwise break out and render as prose. Soft-wrapped
            so nothing is cut off at the right edge of a phone. */}
        <FileCode content={data.content ?? ""} language={EXTENSION_GRAMMAR.get(ext) ?? null} />
        {data.truncated ? (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-meta text-muted-foreground">
            <span>Showing the first 1 MB</span>
            {downloadAction ? (
              <Button variant="secondary" className="min-h-11" onClick={downloadAction.onClick} disabled={downloading}>
                {downloadAction.label}
              </Button>
            ) : null}
          </div>
        ) : null}
        {canEdit ? (
          <Button
            variant="secondary"
            className="w-full tabular-nums"
            onClick={handleStartEdit}
            aria-label="Edit file"
            data-testid="file-edit"
          >
            <PencilIcon className="size-4" />
            Edit
          </Button>
        ) : null}
      </div>
    );

  // Keep actions outside the scrolling body so long files cannot push them
  // off-screen. Match the editor body guards; never keep edit actions in a stale view.
  const editorFooter = open && !loading && !error && data && !data.binary && editing ? (
    <div className="flex gap-2">
      <Button variant="secondary" className="flex-1 tabular-nums" onClick={handleCancel} disabled={saving} aria-label="Cancel edit" title="Discard changes">
        <XIcon className="size-4" />
        Cancel
      </Button>
      <Button
        variant="primary"
        className="flex-1 tabular-nums"
        onClick={() => void handleSave()}
        disabled={saving}
        aria-label={saving ? "Saving file" : "Save file"}
        data-testid="file-save" title="Save file (⌘/Ctrl+Enter)"
      >
        <SaveIcon className="size-4" />
        {saving ? "Saving…" : "Save"}
      </Button>
    </div>
  ) : undefined;

  // Save lives only in the editor footer next to Cancel (sheets-2); Copy and
  // Download (Share in the Android shell, which cannot save blob: anchors; with
  // no file share there is nothing) are icon buttons, once, in the header.
  // Draft copy never changes save state.
  const headerActions =
    open && !loading && data ? (
      <span className="flex items-center gap-1">
        {!data.binary ? (
          <CopyButton
            key={JSON.stringify([resolvedSession, filePath, editing])}
            text={editing ? draft : data.content}
            label={editing ? "Copy draft" : data.truncated ? "Copy file preview" : "Copy file content"}
            className="text-muted-foreground [&_svg]:size-5"
          />
        ) : null}
        {!editing && filePath && resolvedSession && saveMode ? (
          <Button
            variant="ghost"
            size="icon"
            className="relative text-muted-foreground"
            onClick={handleDownload}
            disabled={downloading}
            aria-label={saveMode === "share"
              ? downloading ? "Sharing file" : "Share file"
              : downloading ? "Downloading file" : "Download file"}
            aria-busy={downloading}
          >
            {downloading
              ? <Spinner size={20} label={null} />
              : saveMode === "share"
                ? <Share2Icon aria-hidden className="size-5" />
                : <DownloadIcon aria-hidden className="size-5" />}
          </Button>
        ) : null}
      </span>
    ) : undefined;

  return (
    <BottomSheet open={open} onOpenChange={(value) => {
      if (!value) {
        readGeneration.current++;
        downloadGeneration.current++;
        downloadPending.current = false;
        cancelSave();
      }
      onOpenChange(value);
    }} title={fileName || "File"} description={description} headerActions={headerActions} footer={editorFooter}>
      {storageError ? <Notice tone="warning">{storageError}</Notice> : null}
      {body}
    </BottomSheet>
  );
}
