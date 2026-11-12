import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from "react";
import { ArrowLeftIcon, ChevronRightIcon, FileIcon, FolderIcon } from "lucide-react";

import { fetchWithDeadline } from "@/runtime/request";
import { useBackLayer } from "@/app/back-layer";
import { relativeTime } from "@/app/session-format";
import { EmptyState } from "@/app/ui/EmptyState";
import { Notice } from "@/app/ui/Notice";
import { humanizeDaemonError } from "@/app/ui/OwnedBySession";
import { errorRecoveryAction } from "@/app/ui/error-recovery";
import { Row, RowGroup, RowSkeleton } from "@/app/ui/Row";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { readPairingToken } from "@/platform/browser-storage";
import type { BrowseDirEntry, FileEntry } from "@/runtime/api-types";
import { DaemonApi } from "@/runtime/rpc-client";

import { FileViewer } from "./FileViewer";
import { formatBytes } from "./format";
import { LIST_ROW } from "./card-field";

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i === -1 ? "" : rel.slice(0, i);
}

/**
 * The session folder as a list. `sessionPath` is the SESSION file, not a
 * working directory: `/api/files` takes `?session=` and derives the cwd
 * itself. (It used to be passed `summary.cwd`, which the daemon could not
 * resolve, so every request came back "invalid session path".)
 */
export function FilesTab({ sessionPath, active, focused }: { sessionPath: string; active: boolean; focused: boolean }): JSX.Element {
  const [rel, setRel] = useState("");
  const [entries, setEntries] = useState<FileEntry[] | null>(null);
  const [cwdLabel, setCwdLabel] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The read that failed, so Retry repeats it rather than the folder on screen.
  const [failed, setFailed] = useState<{ rel: string; browse: string | null; quiet: boolean } | null>(null);
  const [missingProject, setMissingProject] = useState(false);
  const [fallbackBrowsePath, setFallbackBrowsePath] = useState<string | null>(null);
  const [viewerPath, setViewerPath] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const readGeneration = useRef(0);
  const listed = useRef(false);
  const location = useRef({ rel, fallbackBrowsePath });
  location.current = { rel, fallbackBrowsePath };

  const crumbs = useMemo(() => {
    const rootName = basename(fallbackBrowsePath ?? cwdLabel) || "Project";
    const list: { name: string; rel: string }[] = [{ name: rootName, rel: "" }];
    let acc = "";
    for (const seg of rel.split("/")) {
      if (!seg) continue;
      acc = acc ? `${acc}/${seg}` : seg;
      list.push({ name: seg, rel: acc });
    }
    return list;
  }, [cwdLabel, rel, fallbackBrowsePath]);

  const canGoUp = rel !== "" || fallbackBrowsePath !== null;

  // Browse targets are explicit, so entering HOME never retriggers the reset effect.
  const load = useCallback(
    async (nextRel: string, browsePath: string | null = null, quiet = false) => {
      const generation = ++readGeneration.current;
      const current = () => generation === readGeneration.current;
      if (!quiet) setLoading(true);
      setError(null);
      setFailed(null);
      setMissingProject(false);
      try {
        if (browsePath !== null) {
          const res = await new DaemonApi(readPairingToken()).browse(browsePath || undefined);
          if (!current()) return;
          setCwdLabel(res.path);
          setFallbackBrowsePath(res.path);
          // Browse returns absolute paths; they are not session-relative breadcrumbs.
          setRel("");
          setEntries(
            res.dirs.map((d: BrowseDirEntry) => ({ name: d.name, path: d.path, type: "dir" as const, size: 0, mtime: 0 })),
          );
        } else {
          const qs = new URLSearchParams({ session: sessionPath });
          if (nextRel) qs.set("path", nextRel);
          const res = await fetchWithDeadline(`/api/files?${qs}`, {
            headers: { Authorization: `Bearer ${readPairingToken()}` },
          });
          if (res.status === 401 || res.status === 403) throw new Error("Authentication failed");
          const body = (await res.json()) as { ok: boolean; cwd?: string; entries?: FileEntry[]; code?: string; error?: string };
          if (!current()) return;
          if (body.code === "project_folder_unavailable") setMissingProject(true);
          if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
          if (typeof body.cwd === "string" && body.cwd) setCwdLabel(body.cwd);
          setEntries(Array.isArray(body.entries) ? body.entries : []);
          setRel(nextRel);
        }
      } catch (e) {
        if (current()) {
          setError(e);
          setFailed({ rel: nextRel, browse: browsePath, quiet });
        }
      } finally {
        if (current()) setLoading(false);
      }
    },
    [sessionPath],
  );

  const navigate = (nextRel: string) =>
    load(nextRel, fallbackBrowsePath === null ? null : nextRel || fallbackBrowsePath);

  // A different chat starts at its own folder root.
  useEffect(() => {
    readGeneration.current++;
    location.current = { rel: "", fallbackBrowsePath: null };
    listed.current = false;
    setRel("");
    setEntries(null);
    setError(null);
    setFailed(null);
    setMissingProject(false);
    setCwdLabel("");
    setFallbackBrowsePath(null);
    setViewerOpen(false);
    setViewerPath(null);
    setLoading(false);
    return () => {
      readGeneration.current++;
    };
  }, [sessionPath]);

  // Each visit re-reads where the user left off, without blanking the list:
  // the agent may have added files since.
  listed.current = entries !== null;
  useEffect(() => {
    if (!active) return;
    const { rel: here, fallbackBrowsePath: browse } = location.current;
    void load(here, browse === null ? null : here || browse, listed.current);
  }, [active, load]);

  const goUp = () => {
    if (fallbackBrowsePath !== null && rel === "") {
      void navigate(fallbackBrowsePath.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/");
    } else {
      void navigate(parentOf(rel));
    }
  };
  // Back inside a subfolder climbs one level, like the leading arrow.
  useBackLayer(focused && canGoUp && !viewerOpen, { onBack: goUp });

  let body: JSX.Element;
  const listLoading = loading || (entries === null && !error);
  // A quiet re-read that failed leaves the rows it was refreshing on screen:
  // the error branch used to replace a good list with a bare error notice.
  const refreshFailed = Boolean(error && failed?.quiet && entries && entries.length > 0);
  // Retry the read that failed, not the folder on screen: after a failed tap
  // into a subfolder `rel` is still the old folder.
  const retryAction = errorRecoveryAction(error) ?? { label: "Retry", onClick: () => void (failed ? load(failed.rel, failed.browse, failed.quiet) : navigate(rel)) };
  if (listLoading) {
    body = (
      <div aria-busy className="-mx-4 flex flex-col" data-testid="files-loading">
        <RowSkeleton leading subtitle />
        <RowSkeleton leading subtitle />
        <RowSkeleton leading subtitle />
      </div>
    );
  } else if (!refreshFailed && (missingProject || (error instanceof Error ? error.message : error) === "invalid session path")) {
    body = (
      <EmptyState
        title={missingProject ? "Project folder unavailable" : "No folder for this session"}
        description={missingProject ? error ? humanizeDaemonError(error) : undefined : "This session has no folder on your computer. Browse your home folder instead."}
        icon={<FolderIcon />}
        action={{ label: "Browse home", onClick: () => void load("", "") }}
      />
    );
  } else if (!refreshFailed && error) {
    // A failed tap into a folder: say which one, since the list on screen is still the old one.
    const target = failed && failed.rel !== rel ? basename(failed.rel) : "";
    body = (
      <Notice tone="danger" action={retryAction}>
        {target ? `Couldn’t open ${target}. ` : ""}{humanizeDaemonError(error)}
      </Notice>
    );
  } else if (!entries || entries.length === 0) {
    body = <EmptyState title="Empty folder" description="This folder has no files or subfolders." icon={<FolderIcon />} />;
  } else {
    const folders = entries.filter((e) => e.type === "dir").length;
    const files = entries.length - folders;
    const counts = [folders ? `${folders} ${folders === 1 ? "folder" : "folders"}` : "", files ? `${files} ${files === 1 ? "file" : "files"}` : ""].filter(Boolean).join(" · ");
    body = (
      <>
      {refreshFailed ? (
        <Notice tone="warning" className="mb-3" testId="files-refresh-failed" action={retryAction}>
          Couldn’t refresh
        </Notice>
      ) : null}
      <p data-testid="files-summary" className="pb-1 text-meta font-medium text-muted-foreground">{counts}</p>
      <RowGroup>
        {entries.map((e) => {
          const isDir = e.type === "dir";
          // A bare "30m" under a folder name reads as a size; say it is an age.
          const ago = e.mtime ? relativeTime(e.mtime) : "";
          const age = ago && ago !== "now" ? `${ago} ago` : ago;
          const meta = isDir ? age : [formatBytes(e.size), age].filter(Boolean).join(" · ");
          return (
            <Row
              key={e.path}
              className={LIST_ROW}
              leading={isDir ? <FolderIcon /> : <FileIcon />}
              title={<span className="block min-w-0 truncate font-medium">{e.name}</span>}
              subtitle={meta ? <span className="tabular-nums">{meta}</span> : undefined}
              chevron={isDir}
              onClick={() => {
                if (isDir) {
                  void navigate(e.path);
                } else {
                  setViewerPath(e.path);
                  setViewerOpen(true);
                }
              }}
            />
          );
        })}
      </RowGroup>
      </>
    );
  }

  return (
    <div data-testid="files-tab" className="flex min-h-0 flex-1 flex-col">
      <nav aria-label="File location" className="flex shrink-0 items-center gap-2 px-4 pt-3 text-meta">
        {canGoUp ? (
          <Button variant="secondary" size="icon-sm" className="shrink-0 text-muted-foreground" aria-label="Parent folder" onClick={goUp}>
            <ArrowLeftIcon className="size-4" />
          </Button>
        ) : null}
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1">
          {crumbs.map((c, i) => (
            <span key={`${c.rel}-${i}`} className="inline-flex min-w-0 max-w-full items-center gap-1">
              {i > 0 ? <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-tertiary" /> : null}
              {i === crumbs.length - 1 ? (
                <span aria-current="location" title={c.name} className="min-w-0 max-w-full rounded-full bg-surface-3 px-3 py-1 font-medium text-foreground [overflow-wrap:anywhere]">
                  {c.name}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => void navigate(c.rel)}
                  title={c.name}
                  className="press-bounce inline-flex min-h-11 max-w-full items-center text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                >
                  <span className="min-w-0 break-words rounded-full bg-surface-2 px-3 py-1 text-muted-foreground">{c.name}</span>
                </button>
              )}
            </span>
          ))}
        </span>
      </nav>
      <ScrollArea className="min-h-0 flex-1">
        {/* Keyed on loading, so content that replaces the skeleton fades in
            while a quiet re-read of the same folder swaps rows in place. */}
        <div key={listLoading ? "loading" : "ready"} className="px-4 pb-6 pt-3 motion-safe:animate-fade-in">
          {fallbackBrowsePath !== null ? (
            <Notice tone="warning" className="mb-3" testId="files-browse-location">
              Browsing {fallbackBrowsePath}, not this conversation’s project folder.
            </Notice>
          ) : null}
          {body}
        </div>
      </ScrollArea>
      <FileViewer open={viewerOpen} onOpenChange={setViewerOpen} path={viewerPath} sessionPath={sessionPath} />
    </div>
  );
}
