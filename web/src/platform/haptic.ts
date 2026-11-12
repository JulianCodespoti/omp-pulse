/**
 * The one haptic entry point. Haptics mark moments, not taps: long-press,
 * drag drop, send, stop, destructive confirm, error. A buzz on every plain
 * tap teaches the hand to ignore all of them. The one exception copies
 * ChatGPT: a tap on something inside a reply plays "selection"
 * (press-feedback.ts).
 */
import { getAppearance } from "./appearance";

export type HapticKind = "selection" | "light" | "medium" | "success" | "warning" | "error";

// The native bridge (NotifyBridgePlugin.haptic) speaks Android's
// HapticFeedbackConstants vocabulary. It plays the device's tuned effects and
// honours the system "touch feedback" setting, which a raw vibrator pulse
// does not.
type NativeKind = "tap" | "longpress" | "confirm" | "reject";
const NATIVE_KIND: Record<HapticKind, NativeKind> = {
  selection: "tap",
  light: "tap",
  medium: "longpress",
  success: "confirm",
  warning: "reject",
  error: "reject",
};

// Browser fallback (PWA in Chrome). Inside the APK `navigator.vibrate` is a
// silent no-op: the WebView needs the VIBRATE permission, which is never
// declared, so the native path above must win there.
const VIBRATE: Record<HapticKind, number | number[]> = {
  selection: 5,
  light: 8,
  medium: 14,
  success: 10,
  warning: 18,
  error: [18, 60, 18],
};

type HapticPlugin = { haptic?: (options: { kind: NativeKind }) => Promise<unknown> };
type CapacitorWindow = Window & { Capacitor?: { Plugins?: { OmpNotify?: HapticPlugin } } };

function nativeHaptic(): HapticPlugin["haptic"] | undefined {
  if (typeof window === "undefined") return undefined;
  const plugin = (window as CapacitorWindow).Capacitor?.Plugins?.OmpNotify;
  return typeof plugin?.haptic === "function" ? plugin.haptic.bind(plugin) : undefined;
}

/** Best-effort feedback; actions never depend on it succeeding. */
let lastAt = -Infinity;

/** Lets a generic tap haptic stand down when the tap's handler played one. */
export function msSinceHaptic(): number {
  return performance.now() - lastAt;
}

export function haptic(kind: HapticKind): void {
  if (!getAppearance().haptics) return;
  lastAt = performance.now();
  const native = nativeHaptic();
  if (native) {
    // A rejected bridge call (activity gone mid-exit) is not worth surfacing.
    void native({ kind: NATIVE_KIND[kind] }).catch(() => {});
    return;
  }
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      navigator.vibrate(VIBRATE[kind]);
    }
  } catch {
    // Some browser policies deny vibration even when the API exists.
  }
}
