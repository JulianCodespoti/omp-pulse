"use client";

import { DownloadIcon, Share2Icon, XIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { showToast } from "@/app/Notices";
import { prefersReducedMotion } from "@/platform/appearance";
import { isNativeShell } from "@/platform/native-shell";

// Full-screen image viewer with pinch, pan, double-tap and wheel zoom.
//
// The previous viewer was a static `object-contain` <img> that closed on tap,
// so a screenshot in the chat could never be read at more than screen width.
// Page-level pinch zoom is no help: it scales the whole app shell, and inside
// the Android WebView it is off entirely. Gestures are handled here with
// pointer events rather than a gesture library, because this ships in the
// eager chat chunk (see the bundle guard in components/markdown.tsx).
//
// Transform model: the image is laid out centred at scale 1, then
// `translate(tx, ty) scale(s)` with origin at its centre. A screen point f
// (relative to the container centre) maps to image-local q = (f - t) / s, so
// zooming about f to s' keeps q fixed with t' = f - (f - t) * s' / s.

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const DOUBLE_TAP_SCALE = 3;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP_PX = 8;
// Swipe-down dismiss at scale 1: release past this distance, or flick faster
// than the speed, to close; the backdrop is fully faded by DISMISS_FADE_PX.
const DISMISS_DISTANCE_PX = 96;
const DISMISS_FLICK_PX_PER_MS = 0.5;
const DISMISS_FADE_PX = 400;

type Point = { x: number; y: number };

export function ImageViewer({
  src,
  alt,
  mimeType = "image/png",
  open,
  onOpenChange,
}: {
  src: string;
  alt?: string;
  mimeType?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const fileName = `image.${mimeType.split("/")[1]?.split("+")[0] || "png"}`;
  // Web Share with files exists on Android Chrome/WebView but not desktop
  // Firefox; offer Share only where the browser can actually do it.
  const canShareFiles =
    open &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [new File([], fileName, { type: mimeType })] });
  const [sharing, setSharing] = useState(false);
  const shareGeneration = useRef(0);
  const shareMounted = useRef(false);
  const shareOpen = useRef(false);
  const shareAttempt = useRef<{ controller: AbortController; issued: boolean } | null>(null);
  const invalidateShare = useCallback(() => {
    shareGeneration.current++;
    const attempt = shareAttempt.current;
    // Preparation belongs to this visit. An already-issued native share cannot
    // be canceled: keep its lease until the browser settles it.
    if (attempt && !attempt.issued) {
      shareAttempt.current = null;
      attempt.controller.abort();
    }
  }, []);
  useLayoutEffect(() => {
    shareMounted.current = true;
    shareOpen.current = open;
    setSharing(shareAttempt.current !== null);
    return () => {
      shareMounted.current = false;
      invalidateShare();
    };
  }, [open, src, mimeType, invalidateShare]);
  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      shareOpen.current = false;
      invalidateShare();
      setSharing(shareAttempt.current !== null);
    }
    onOpenChange(nextOpen);
  };
  const share = async () => {
    if (!shareOpen.current || !shareMounted.current || shareAttempt.current) return;
    const generation = shareGeneration.current;
    const current = () => generation === shareGeneration.current;
    const attempt = { controller: new AbortController(), issued: false };
    shareAttempt.current = attempt;
    setSharing(true);
    try {
      const response = await fetch(src, { signal: attempt.controller.signal });
      if (!current()) return;
      const blob = await response.blob();
      if (!current()) return;
      attempt.issued = true;
      await navigator.share({ files: [new File([blob], fileName, { type: blob.type || mimeType })] });
    } catch (error) {
      if (current() && !(error instanceof DOMException && error.name === "AbortError")) showToast("Could not share the image", "error");
    } finally {
      if (shareAttempt.current === attempt) {
        shareAttempt.current = null;
        if (shareMounted.current) setSharing(false);
      }
    }
  };
  const stageRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // Mutable view state: gestures write the transform straight to the DOM
  // instead of re-rendering React on every pointermove.
  const view = useRef({ s: 1, tx: 0, ty: 0 });
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{
    start: Point;
    moved: boolean;
    pinchDist: number;
    pinchMid: Point;
    lastTap: number;
    lastTapAt: Point;
    dismissing: boolean;
    /** Smoothed vertical speed of the single finger, px per ms. */
    vy: number;
    lastMoveAt: number;
  }>({
    start: { x: 0, y: 0 },
    moved: false,
    pinchDist: 0,
    pinchMid: { x: 0, y: 0 },
    lastTap: 0,
    lastTapAt: { x: 0, y: 0 },
    dismissing: false,
    vy: 0,
    lastMoveAt: 0,
  });

  const apply = useCallback((animate: boolean) => {
    const img = imgRef.current;
    if (!img) return;
    const { s, tx, ty } = view.current;
    img.style.transition = animate ? "transform 180ms ease-out" : "none";
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    if (stageRef.current) {
      stageRef.current.style.cursor = s > 1 ? "grab" : "zoom-in";
    }
  }, []);

  // Keep the image covering the viewport where it can: no panning past an
  // edge, and centred on any axis where it is smaller than the screen.
  const clamp = useCallback(() => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage) return;
    const v = view.current;
    v.s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.s));
    const maxX = Math.max(0, (img.offsetWidth * v.s - stage.clientWidth) / 2);
    const maxY = Math.max(0, (img.offsetHeight * v.s - stage.clientHeight) / 2);
    v.tx = Math.min(maxX, Math.max(-maxX, v.tx));
    v.ty = Math.min(maxY, Math.max(-maxY, v.ty));
  }, []);

  // Screen point relative to the stage centre.
  const local = useCallback((clientX: number, clientY: number): Point => {
    const r = stageRef.current!.getBoundingClientRect();
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
  }, []);

  const zoomAbout = useCallback((f: Point, next: number) => {
    const v = view.current;
    const s2 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
    v.tx = f.x - ((f.x - v.tx) * s2) / v.s;
    v.ty = f.y - ((f.y - v.ty) * s2) / v.s;
    v.s = s2;
  }, []);

  const reset = useCallback(() => {
    view.current = { s: 1, tx: 0, ty: 0 };
    pointers.current.clear();
  }, []);

  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  // The dismiss drag fades the dialog's own black; null once the popup unmounts.
  const setBackdrop = useCallback((alpha: number, animate: boolean) => {
    const popup = popupRef.current;
    if (!popup) return;
    popup.style.transition = animate ? "background-color 180ms ease-out" : "none";
    popup.style.backgroundColor = alpha >= 1 ? "" : `rgba(0, 0, 0, ${alpha})`;
  }, []);

  // Wheel must be a non-passive native listener to preventDefault; React's
  // onWheel is passive. Ctrl+wheel is how trackpad pinch arrives on desktop.
  // Attached from a callback ref, not an effect keyed on `open`: the dialog
  // mounts its popup a frame after `open` flips, so an effect sees a null
  // stage and never binds (wheel zoom was dead in the first cut).
  const bindStage = useCallback(
    (stage: HTMLDivElement | null) => {
      stageRef.current = stage;
      if (!stage) return;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002));
        zoomAbout(local(e.clientX, e.clientY), view.current.s * factor);
        clamp();
        apply(false);
      };
      stage.addEventListener("wheel", onWheel, { passive: false });
      return () => stage.removeEventListener("wheel", onWheel);
    },
    [zoomAbout, local, clamp, apply],
  );

  const pinchState = () => {
    const [a, b] = [...pointers.current.values()];
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      mid: local((a.x + b.x) / 2, (a.y + b.y) / 2),
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (pointers.current.size === 1) {
      g.start = { x: e.clientX, y: e.clientY };
      g.moved = false;
      g.dismissing = false;
      g.vy = 0;
      g.lastMoveAt = e.timeStamp;
    } else if (pointers.current.size === 2) {
      if (g.dismissing) {
        // A second finger turns the drag into a pinch: put the picture back.
        g.dismissing = false;
        view.current.tx = 0;
        view.current.ty = 0;
        setBackdrop(1, false);
      }
      const p = pinchState();
      g.pinchDist = p.dist;
      g.pinchMid = p.mid;
      g.moved = true;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    pointers.current.set(e.pointerId, cur);
    const g = gesture.current;
    const v = view.current;
    if (pointers.current.size >= 2) {
      const p = pinchState();
      if (g.pinchDist > 0) zoomAbout(p.mid, (v.s * p.dist) / g.pinchDist);
      // Two-finger drag pans while pinching.
      v.tx += p.mid.x - g.pinchMid.x;
      v.ty += p.mid.y - g.pinchMid.y;
      g.pinchDist = p.dist;
      g.pinchMid = p.mid;
    } else {
      if (Math.hypot(cur.x - g.start.x, cur.y - g.start.y) > TAP_SLOP_PX) g.moved = true;
      const dt = e.timeStamp - g.lastMoveAt;
      // Smoothed so one jittery last sample cannot decide a flick.
      if (dt > 0) g.vy = 0.5 * g.vy + 0.5 * ((cur.y - prev.y) / dt);
      g.lastMoveAt = e.timeStamp;
      if (v.s > 1) {
        v.tx += cur.x - prev.x;
        v.ty += cur.y - prev.y;
      } else if (!g.dismissing && g.moved && cur.y - g.start.y > 0 && cur.y - g.start.y > Math.abs(cur.x - g.start.x)) {
        // At scale 1 there is nothing to pan, so a mostly-downward drag is the dismiss gesture.
        g.dismissing = true;
      }
      if (g.dismissing) {
        // Follows the finger and is deliberately not clamped (clamp pins a
        // fitted picture to the centre).
        v.tx = cur.x - g.start.x;
        v.ty = Math.max(0, cur.y - g.start.y);
        apply(false);
        setBackdrop(Math.max(0.15, 1 - v.ty / DISMISS_FADE_PX), false);
        return;
      }
    }
    clamp();
    apply(false);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    if (g.dismissing) {
      // One finger dragged the picture down at scale 1: far enough, or flicked,
      // closes; anything less springs back.
      g.dismissing = false;
      const dy = view.current.ty;
      if (e.type !== "pointercancel" && (dy >= DISMISS_DISTANCE_PX || (dy > TAP_SLOP_PX && g.vy >= DISMISS_FLICK_PX_PER_MS))) {
        changeOpen(false);
        return;
      }
      view.current.tx = 0;
      view.current.ty = 0;
      apply(!prefersReducedMotion());
      setBackdrop(1, !prefersReducedMotion());
      return;
    }
    if (pointers.current.size === 1) {
      // Lifting one finger of a pinch: continue as a pan from the survivor
      // without a jump, and never treat the release as a tap.
      const [rest] = pointers.current.values();
      g.start = rest;
      return;
    }
    if (pointers.current.size > 0 || g.moved || e.type === "pointercancel") return;
    const now = e.timeStamp;
    const at = { x: e.clientX, y: e.clientY };
    // The stage owns the pointer (capture), so the event target is always the
    // stage: judge "outside the picture" from its on-screen box instead. A tap
    // on the black around it closes the viewer, as in the platform photo viewer.
    const box = imgRef.current?.getBoundingClientRect();
    if (box && (at.x < box.left || at.x > box.right || at.y < box.top || at.y > box.bottom)) {
      changeOpen(false);
      return;
    }
    const isDouble =
      now - g.lastTap < DOUBLE_TAP_MS &&
      Math.hypot(at.x - g.lastTapAt.x, at.y - g.lastTapAt.y) < TAP_SLOP_PX * 4;
    if (isDouble) {
      g.lastTap = 0;
      if (view.current.s > 1) view.current = { s: 1, tx: 0, ty: 0 };
      else zoomAbout(local(at.x, at.y), DOUBLE_TAP_SCALE);
      clamp();
      apply(true);
      return;
    }
    g.lastTap = now;
    g.lastTapAt = at;
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent
        ref={popupRef}
        showCloseButton={false}
        // Focus the stage, not the first button: auto-focusing Close drew a
        // focus ring on it every time the viewer opened from a tap.
        initialFocus={stageRef}
        // Full-bleed black, like the platform photo viewer: no translucent
        // chat showing through, no frame around the picture. The drag-down
        // dismiss fades this background inline.
        className="h-dvh w-screen max-w-none rounded-none bg-black p-0 ring-0 shadow-none sm:max-w-none"
      >
        <DialogTitle className="sr-only">{alt || "Image"}</DialogTitle>
        <div
          ref={bindStage}
          data-testid="image-viewer-stage"
          tabIndex={-1}
          className="relative flex h-full w-full touch-none items-center justify-center overflow-hidden outline-none select-none"
          style={{ cursor: "zoom-in" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <img
            ref={imgRef}
            src={src}
            alt={alt ?? ""}
            draggable={false}
            onLoad={() => apply(false)}
            className="max-h-full max-w-full object-contain will-change-transform"
          />
        </div>
        {/* One top bar on a soft scrim: Close leads (the Android back/close
            position), Share/Download trail. Bare white glyphs, no circle boxes;
            each keeps a 44px target. */}
        <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between bg-linear-to-b from-black/60 to-transparent px-1 pb-6 pt-[max(0.25rem,env(safe-area-inset-top))]">
          <button
            type="button"
            aria-label="Close image"
            onClick={() => changeOpen(false)}
            className="pressable pointer-events-auto flex size-11 items-center justify-center rounded-full text-white outline-none focus-visible:ring-2 focus-visible:ring-white/70"
          >
            <XIcon aria-hidden className="size-6" />
          </button>
          <div className="pointer-events-auto flex">
            {canShareFiles ? (
              <button
                type="button"
                aria-label="Share image"
                disabled={sharing}
                aria-busy={sharing}
                onClick={() => void share()}
                className="pressable flex size-11 items-center justify-center rounded-full text-white outline-none focus-visible:ring-2 focus-visible:ring-white/70 disabled:opacity-50"
              >
                <Share2Icon aria-hidden className="size-5" />
              </button>
            ) : null}
            {/* The Android shell cannot save from an anchor download; Share above
                is the only save path there. */}
            {!isNativeShell() ? (
              <a
                href={src}
                download={fileName}
                aria-label="Download image"
                className="pressable flex size-11 items-center justify-center rounded-full text-white outline-none focus-visible:ring-2 focus-visible:ring-white/70"
              >
                <DownloadIcon aria-hidden className="size-5" />
              </a>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
