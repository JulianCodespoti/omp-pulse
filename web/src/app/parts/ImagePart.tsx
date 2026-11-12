"use client";

import { ImageOffIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { ImageViewer } from "@/app/parts/ImageViewer";
import { prefersReducedMotion } from "@/platform/appearance";
import { readPairingToken } from "@/platform/browser-storage";
import { onDaemonReachable } from "@/runtime/daemon-reachability";
import { fetchWithDeadline } from "@/runtime/request";
import { useResourceSession } from "./SessionResources";

/**
 * A picture the agent embedded by its path on the computer
 * (`![After](/tmp/x.webp)`, `file:///…`, `C:\…`). The page cannot load that
 * path from the phone; the daemon serves it for the conversation embedding it.
 */
function computerPath(src: string): string | null {
  if (src.startsWith("file://")) {
    try { return decodeURIComponent(new URL(src).pathname).replace(/^\/([A-Za-z]:)/, "$1"); } catch { return null; }
  }
  if (/^[A-Za-z]:[\\/]/.test(src)) return src;
  // Site paths this app serves itself are not computer files.
  if (src.startsWith("/") && !src.startsWith("//") && !/^\/(?:api|app|assets)\//.test(src)) return src;
  return null;
}

type ImagePartProps = {
  src: string | null;
  alt?: string;
  mimeType: string;
};

/** Waits before each automatic retry of an unreachable image; the last repeats. */
const IMAGE_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
/** Start reading a screen and a half before the image scrolls in. */
const NEAR_VIEWPORT = "150% 0px";

/** `missing`: the daemon has no such blob. `waiting`: it could not be reached. */
type Failure = "missing" | "waiting" | "decode";

/**
 * INVARIANT: a daemon image is read only once it is near the viewport. A run
 * stacked 19 screenshots (4.5 MB decoded each) and fetched them all on mount,
 * with the phone already out of swap. Without IntersectionObserver it reads
 * at once.
 */
export function ImagePart(props: ImagePartProps) {
  const [attempt, setAttempt] = useState(0);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (near || !anchor) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      // The chat scrolls inside its own container, which would clip a margin on the viewport.
      { root: anchor.closest(".chat-scroll"), rootMargin: NEAR_VIEWPORT },
    );
    observer.observe(anchor);
    return () => observer.disconnect();
  }, [anchor, near]);
  // Stable: the automatic retry timer must survive parent re-renders.
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // A different source or retry must not inherit the old image, error or viewer.
  return (
    <ImageResource
      key={JSON.stringify([props.src, attempt])}
      {...props}
      near={near}
      anchorRef={setAnchor}
      attempt={attempt}
      onRetry={retry}
    />
  );
}

function ImageResource({ src, alt, mimeType, near, anchorRef, attempt, onRetry }: ImagePartProps & {
  near: boolean;
  anchorRef: (element: HTMLElement | null) => void;
  attempt: number;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [settled, setSettled] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const fromHeight = useRef(0);
  const session = useResourceSession();
  // `src` is a `data:` URL (inline), a `blob:sha256:<hash>` reference fetched
  // from omp's blob dir (`paths::omp_blob_dirs`), a computer path fetched for
  // this conversation, or null. `hash` is the daemon URL to read, if any.
  const [isBlobRef, hash, srcOrBlob] = (() => {
    if (src == null) return [false, "", null] as const;
    if (src.startsWith("blob:")) {
      const h = src.slice(5).replace(/^sha256:/, "");
      if (/^[a-fA-F0-9]{8,128}$/.test(h)) return [true, `/api/blob/${h}`, null] as const;
    }
    const local = computerPath(src);
    if (local && session) return [true, `/api/image?${new URLSearchParams({ session, path: local })}`, null] as const;
    return [false, "", src] as const;
  })();
  useEffect(() => {
    if (!isBlobRef || !hash || !near) return;
    let cancelled = false;
    const controller = new AbortController();
    let objectUrl: string | null = null;
    const token = readPairingToken();
    // Deadline, not a bare fetch: on a stalled link the "Loading image…" tile
    // spun forever. A timeout lands in the catch below, i.e. "waiting" + retry.
    fetchWithDeadline(hash, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) {
          // The daemon answered that it has no such image: retrying on a
          // timer cannot help. Any other answer (a proxy error) is the link.
          if (!cancelled) setFailure(res.status === 400 || res.status === 403 || res.status === 404 || res.status === 410 ? "missing" : "waiting");
          return;
        }
        const blob = await res.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setBlobUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailure("waiting");
      });
    return () => {
      cancelled = true;
      // This resource owns its read, including a still-streaming response body.
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [isBlobRef, hash, near]);
  useEffect(() => {
    if (failure !== "missing" && failure !== "waiting") return;
    // The daemon is back, possibly restarted with the blob it lacked before.
    const stopReachable = onDaemonReachable(onRetry);
    if (failure === "missing") return stopReachable;
    const timer = window.setTimeout(onRetry, IMAGE_RETRY_DELAYS_MS[Math.min(attempt, IMAGE_RETRY_DELAYS_MS.length - 1)]);
    window.addEventListener("online", onRetry);
    return () => {
      stopReachable();
      window.clearTimeout(timer);
      window.removeEventListener("online", onRetry);
    };
  }, [attempt, failure, onRetry]);
  // The picture arrives in the tile's box (invisible) and glides to its natural
  // height in one transition. Without it a screenshot replaced a 160x120 tile
  // in a single frame and the transcript jumped under the reader's thumb. No
  // dimensions travel with an image part, so the natural height is measured.
  useLayoutEffect(() => {
    const img = imgRef.current;
    const from = fromHeight.current;
    if (!settled || !img || from <= 0 || prefersReducedMotion()) return;
    const to = img.offsetHeight;
    if (to === from) return;
    img.style.height = `${from}px`;
    img.style.opacity = "0";
    void img.offsetHeight;
    img.style.transition = "height 200ms var(--ease-smooth), opacity 200ms var(--ease-smooth)";
    img.style.height = `${to}px`;
    img.style.opacity = "1";
    const clear = () => {
      img.style.transition = "";
      img.style.height = "";
      img.style.opacity = "";
    };
    img.addEventListener("transitionend", clear, { once: true });
    return () => {
      img.removeEventListener("transitionend", clear);
      clear();
    };
  }, [settled]);
  if (src == null) {
    // Accurate in both modes: on the phone runtime omp's host IS this device,
    // so "on your computer" would be wrong there.
    return <ImageTile icon={<ImageOffIcon aria-hidden className="size-5" />}>Image not on this device</ImageTile>;
  }
  if (failure === "missing") {
    return <ImageTile icon={<ImageOffIcon aria-hidden className="size-5" />} role="status" onRetry={onRetry}>Image is no longer available</ImageTile>;
  }
  if (failure === "waiting") {
    return <ImageTile icon={<Spinner size={20} label={null} />} role="status" onRetry={onRetry}>Waiting for the connection…</ImageTile>;
  }
  if (failure === "decode") {
    return <ImageTile icon={<ImageOffIcon aria-hidden className="size-5" />} role="alert" onRetry={onRetry}>Couldn't load image</ImageTile>;
  }
  if (isBlobRef && !blobUrl) {
    return <ImageTile anchorRef={anchorRef} icon={<Spinner size={20} label={null} />} role="status">Loading image…</ImageTile>;
  }
  const imageSrc = isBlobRef ? blobUrl! : srcOrBlob!;
  return (
    <>
      <button
        type="button"
        aria-label={alt ? `Open image: ${alt}` : "Open image"}
        onClick={() => setOpen(true)}
        className={cn(
          "not-prose my-2 block cursor-zoom-in rounded-lg focus-visible:outline-2 focus-visible:outline-ring",
          // Same box as ImageTile until the bytes are decoded.
          settled ? "min-h-11 min-w-11 max-w-full" : "w-full max-w-[20rem] bg-surface-1",
        )}
      >
        {/* The picture itself, rounded, with no frame (no boxes). A tall
            screenshot is bounded by the viewport; the viewer shows it whole.
            Until it has loaded it fills the tile's box, so the transcript does
            not jump when the bytes arrive; the layout effect then glides it to
            its natural height. */}
        <img
          ref={imgRef}
          src={imageSrc}
          alt={alt ?? ""}
          loading="lazy"
          onLoad={(event) => {
            if (settled) return;
            fromHeight.current = event.currentTarget.offsetHeight;
            setSettled(true);
          }}
          onError={() => setFailure("decode")}
          className={cn(
            "rounded-lg border border-hairline",
            settled ? "max-h-[60dvh] max-w-full" : "aspect-[4/3] w-full object-contain opacity-0",
          )}
        />
      </button>
      <ImageViewer src={imageSrc} alt={alt} mimeType={mimeType} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * The image's place when there is no picture to show: a thumbnail-shaped
 * tile, one short line, nothing that looks like an error card. Retry stays
 * for the impatient; the automatic retry runs regardless.
 */
function ImageTile({ icon, children, role, onRetry, anchorRef }: {
  icon: ReactNode;
  children: ReactNode;
  role?: "status" | "alert";
  onRetry?: () => void;
  /** The near-viewport observer's target while the read is deferred. */
  anchorRef?: (element: HTMLElement | null) => void;
}) {
  return (
    <div
      ref={anchorRef}
      role={role}
      data-testid="image-tile"
      className="not-prose my-2 flex aspect-[4/3] w-full max-w-[20rem] flex-col items-center justify-center gap-2 rounded-lg bg-surface-1 px-3 text-center text-meta text-muted-foreground"
    >
      {icon}
      {children}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="relative font-medium text-primary-text outline-none after:absolute after:-inset-x-3 after:-inset-y-3 after:content-[''] focus-visible:ring-2 focus-visible:ring-ring"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
