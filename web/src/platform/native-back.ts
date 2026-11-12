/**
 * The one ordered stack of things Back should close, shared with the Android
 * shell.
 *
 * WHY THE SHELL MUST BE TOLD IN ADVANCE. The shell used to override
 * `onBackPressed`, then ask the page afterwards what to do by sniffing the DOM
 * for an open dialog and synthesising Escape. Predictive back cannot work like
 * that: Android decides at the START of a swipe whether the app consumes it
 * (and therefore whether to preview the app or the home screen), so the shell
 * must already know. Every layer registers here while it is open, and the
 * stack pushes "is there anything to go back to" to the shell whenever that
 * answer changes. `onBackPressed`/`KEYCODE_BACK` also stop being dispatched
 * once the app targets Android 16, so the old path had an expiry date.
 *
 * The shell reports the gesture through `window.__ompNativeBack`. The target
 * is fixed when the swipe starts, so a layer opening mid-gesture cannot steal
 * a commit meant for the one being previewed.
 */

export type BackEdge = "left" | "right" | "none";

export type BackLayer = {
  /** Screen-level layer: always below every sheet, whatever mounted first. */
  base?: boolean;
  /** Commit: close this layer. */
  onBack: () => void;
  /** Gesture progress, 0..1. Called with 0 when a swipe starts. */
  onProgress?: (progress: number, edge: BackEdge) => void;
  /** The swipe was abandoned: return to rest without navigating. */
  onCancel?: () => void;
};

type Entry = { layer: BackLayer; seq: number };

type NativeBackPlugin = {
  setEnabled?: (options: { enabled: boolean }) => Promise<unknown>;
};

type NativeBackWindow = Window & {
  Capacitor?: { Plugins?: { OmpBack?: NativeBackPlugin } };
  __ompNativeBack?: (phase: string, progress?: number, edge?: number) => boolean;
};

const entries: Entry[] = [];
let nextSeq = 0;
let gesture: Entry | null = null;
let gestureStarted = false;
let reported: boolean | null = null;
let syncQueued = false;

function above(a: Entry, b: Entry): boolean {
  const ra = a.layer.base ? 0 : 1;
  const rb = b.layer.base ? 0 : 1;
  return ra !== rb ? ra > rb : a.seq > b.seq;
}

function top(): Entry | null {
  let best: Entry | null = null;
  for (const entry of entries) if (!best || above(entry, best)) best = entry;
  return best;
}

function plugin(): NativeBackPlugin | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as NativeBackWindow).Capacitor?.Plugins?.OmpBack;
}

// Batched so a sheet that closes as another opens reports once, not twice.
function scheduleSync(): void {
  if (syncQueued) return;
  syncQueued = true;
  queueMicrotask(() => {
    syncQueued = false;
    const enabled = entries.length > 0;
    if (enabled === reported) return;
    const setEnabled = plugin()?.setEnabled;
    if (typeof setEnabled !== "function") return;
    reported = enabled;
    void setEnabled({ enabled }).catch(() => {
      // Retry on the next change rather than trusting a failed report.
      reported = null;
    });
  });
}

/** Register an open layer; the returned function removes it. */
export function pushBackLayer(layer: BackLayer): () => void {
  const entry: Entry = { layer, seq: nextSeq++ };
  entries.push(entry);
  scheduleSync();
  return () => {
    const index = entries.indexOf(entry);
    if (index < 0) return;
    entries.splice(index, 1);
    if (gesture === entry) gesture = null;
    scheduleSync();
  };
}

function edgeName(edge: number | undefined): BackEdge {
  // BackEventCompat.EDGE_LEFT = 0, EDGE_RIGHT = 1, EDGE_NONE = 2.
  return edge === 0 ? "left" : edge === 1 ? "right" : "none";
}

/**
 * The shell's entry point. Returns whether the page handled the phase; a
 * commit that returns false makes the shell background the app itself, so a
 * page that lost its layers (a reload, a crash) can never swallow Back.
 */
export function handleNativeBack(phase: string, progress = 0, edge?: number): boolean {
  switch (phase) {
    case "start":
      gestureStarted = true;
      gesture = top();
      gesture?.layer.onProgress?.(0, edgeName(edge));
      return gesture !== null;
    case "progress":
      gesture?.layer.onProgress?.(Math.min(1, Math.max(0, progress)), edgeName(edge));
      return gesture !== null;
    case "cancel":
      gesture?.layer.onCancel?.();
      gesture = null;
      gestureStarted = false;
      return true;
    case "commit": {
      // A sheet can close while the finger is still down. That gesture has
      // already lost its target; never redirect it to the chat underneath.
      const started = gestureStarted;
      const target = started ? gesture : top();
      gesture = null;
      gestureStarted = false;
      if (!target) return started;
      target.layer.onBack();
      return true;
    }
    default:
      return false;
  }
}

if (typeof window !== "undefined") {
  (window as NativeBackWindow).__ompNativeBack = handleNativeBack;
}
