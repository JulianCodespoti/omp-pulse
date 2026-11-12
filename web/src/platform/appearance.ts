/**
 * Appearance: every per-device look-and-feel choice from Settings → Appearance,
 * one stored object, one apply step, one hook.
 *
 * Visual choices (text size, density, accent, motion) land on <html> before the
 * first paint: the root font-size and `data-*` attributes that styles.css keys
 * off. Behaviour choices (streaming, tool calls, thinking, long replies, wrap)
 * are read by the leaf components through `useAppearance()`; reading them in
 * ChatScreen instead would re-render the whole transcript on every change.
 *
 * Text size multiplies the phone's system font scale. The Android shell pins
 * WebView textZoom to 100 (OmpShellActivity) and reports the system scale
 * through `OmpNative.fontScale()`: textZoom grows only text, so px-sized
 * controls clipped it. Ignoring the system scale made the app look zoomed in
 * beside native apps on a phone set to a smaller font (0.9 on the owner's).
 */
import { useSyncExternalStore } from "react";

export type TextSize = "small" | "default" | "large" | "larger";
export type Density = "comfortable" | "compact";
/** Hues clear of the status family (success 155, warning 75, danger 27, running 250). */
export type Accent = "chatgpt" | "violet" | "magenta" | "cyan" | "mono" | "custom";
/** The page and its three surfaces. Black is OLED; Dim and Grey lift the page like ChatGPT's web and DeepSeek's app. */
export type Background = "black" | "dim" | "grey";
/** "high" lifts secondary text and dividers for low vision or bright sun. */
export type Contrast = "standard" | "high";
/** Scales every named radius; pills (rounded-full) stay round. */
export type Corners = "square" | "default" | "round";
export type Font = "system" | "serif" | "mono";
export type LineSpacing = "tight" | "default" | "relaxed";
/** "neutral": your messages stay grey whatever the accent. */
export type UserBubble = "tinted" | "neutral";
/** How assistant text arrives while streaming. "fade" is ChatGPT's word-by-word arrival. */
export type Streaming = "instant" | "fade" | "caret";
/** "summary": a settled turn's work folds into one "Worked for 42s ›" line that opens it in a sheet. "grouped": settled runs fold into one summary row each. "expanded": runs stay open, every live step shown. */
export type ToolCalls = "summary" | "grouped" | "expanded";
/** "latest": the newest turn's thinking stays open after it settles. */
export type Thinking = "hidden" | "collapsed" | "latest";
export type LongReplies = "preview" | "full";
/** "stay": a streaming reply grows below the view instead of pulling it down. */
export type AutoScroll = "follow" | "stay";
/** "newline": Enter adds a line; Ctrl/Cmd+Enter or the send button sends. */
export type EnterKey = "send" | "newline";
/** "compact": a finished turn's footer keeps Copy and ⋯ but drops its duration and speed. */
export type TurnFooterStyle = "full" | "compact";
/** When each session was last active, at the end of its row's second line. */
export type SessionTime = "hidden" | "relative" | "clock";
/** Size of code, diffs and command output, independent of the text size. */
export type CodeSize = "small" | "default" | "large";
/** "bubbles": the agent's text sits in chat bubbles, its work threads beneath them. */
export type MessageStyle = "plain" | "bubbles";
/** "reduce" forces reduced motion regardless of the system setting. */
export type MotionPreference = "system" | "reduce";

export interface Appearance {
  readonly textSize: TextSize;
  readonly density: Density;
  readonly accent: Accent;
  /** Hue (0-359) for the "custom" accent. */
  readonly accentHue: number;
  readonly background: Background;
  readonly contrast: Contrast;
  readonly corners: Corners;
  readonly font: Font;
  readonly lineSpacing: LineSpacing;
  readonly userBubble: UserBubble;
  readonly streaming: Streaming;
  readonly toolCalls: ToolCalls;
  readonly thinking: Thinking;
  readonly longReplies: LongReplies;
  readonly wrapCode: boolean;
  /** The omp terminal's markdown palette: H1 magenta, H2 yellow, H3-H6 blue, bold and italic magenta, inline code green, table headers yellow. Rendered markdown only. */
  readonly colourMarkdown: boolean;
  readonly motion: MotionPreference;
  readonly haptics: boolean;
  readonly autoScroll: AutoScroll;
  readonly enterKey: EnterKey;
  readonly turnFooter: TurnFooterStyle;
  readonly sessionTime: SessionTime;
  readonly codeSize: CodeSize;
  readonly messageStyle: MessageStyle;
}

export interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
}

export const TEXT_SIZES: readonly (Choice<TextSize> & { readonly percent: number })[] = [
  { value: "small", label: "Small", percent: 93.75 },
  { value: "default", label: "Default", percent: 100 },
  { value: "large", label: "Large", percent: 112.5 },
  { value: "larger", label: "Larger", percent: 125 },
];
export const DENSITIES: readonly Choice<Density>[] = [
  { value: "comfortable", label: "Comfortable" },
  { value: "compact", label: "Compact" },
];
export const ACCENTS: readonly Choice<Accent>[] = [
  { value: "chatgpt", label: "ChatGPT" },
  { value: "violet", label: "Violet" },
  { value: "magenta", label: "Magenta" },
  { value: "cyan", label: "Cyan" },
  { value: "mono", label: "Mono" },
  { value: "custom", label: "Custom" },
];
export const BACKGROUNDS: readonly Choice<Background>[] = [
  { value: "black", label: "Black" },
  { value: "dim", label: "Dim" },
  { value: "grey", label: "Grey" },
];
export const CONTRASTS: readonly Choice<Contrast>[] = [
  { value: "standard", label: "Standard" },
  { value: "high", label: "High" },
];
export const CORNERS: readonly (Choice<Corners> & { readonly scale: number })[] = [
  { value: "square", label: "Square", scale: 0.4 },
  { value: "default", label: "Default", scale: 1 },
  { value: "round", label: "Round", scale: 1.35 },
];
export const FONTS: readonly Choice<Font>[] = [
  { value: "system", label: "System" },
  { value: "serif", label: "Serif" },
  { value: "mono", label: "Mono" },
];
export const LINE_SPACING: readonly (Choice<LineSpacing> & { readonly scale: number })[] = [
  { value: "tight", label: "Tight", scale: 0.88 },
  { value: "default", label: "Default", scale: 1 },
  { value: "relaxed", label: "Relaxed", scale: 1.15 },
];
export const USER_BUBBLES: readonly Choice<UserBubble>[] = [
  { value: "tinted", label: "Accent" },
  { value: "neutral", label: "Grey" },
];
export const STREAMING: readonly Choice<Streaming>[] = [
  { value: "instant", label: "Instant" },
  { value: "fade", label: "Fade in" },
  { value: "caret", label: "Caret" },
];
export const TOOL_CALLS: readonly Choice<ToolCalls>[] = [
  { value: "summary", label: "Summary" },
  { value: "grouped", label: "Grouped" },
  { value: "expanded", label: "Expanded" },
];
export const THINKING: readonly Choice<Thinking>[] = [
  { value: "hidden", label: "Hidden" },
  { value: "collapsed", label: "Collapsed" },
  { value: "latest", label: "Latest" },
];
export const LONG_REPLIES: readonly Choice<LongReplies>[] = [
  { value: "preview", label: "Preview" },
  { value: "full", label: "Full" },
];
export const AUTO_SCROLL: readonly Choice<AutoScroll>[] = [
  { value: "follow", label: "Follow" },
  { value: "stay", label: "Stay put" },
];
export const ENTER_KEY: readonly Choice<EnterKey>[] = [
  { value: "send", label: "Sends" },
  { value: "newline", label: "New line" },
];
export const TURN_FOOTER: readonly Choice<TurnFooterStyle>[] = [
  { value: "full", label: "Full" },
  { value: "compact", label: "Compact" },
];
export const SESSION_TIME: readonly Choice<SessionTime>[] = [
  { value: "hidden", label: "Hidden" },
  { value: "relative", label: "Relative" },
  { value: "clock", label: "Clock" },
];
/** Scale on --text-code (12px). Small stays at 11px, the smallest size the UI uses. */
export const CODE_SIZES: readonly (Choice<CodeSize> & { readonly scale: number })[] = [
  { value: "small", label: "Small", scale: 0.92 },
  { value: "default", label: "Default", scale: 1 },
  { value: "large", label: "Large", scale: 1.17 },
];
export const MESSAGE_STYLES: readonly Choice<MessageStyle>[] = [
  { value: "plain", label: "Plain" },
  { value: "bubbles", label: "Bubbles" },
];
export const MOTION: readonly Choice<MotionPreference>[] = [
  { value: "system", label: "System" },
  { value: "reduce", label: "Always" },
];

/**
 * Every default is the house look, the OMP Pulse preset: brand violet on black, the look the
 * icon, website and screenshots show. It was ChatGPT's white and blue until the brand settled.
 */
export const DEFAULT_APPEARANCE: Appearance = {
  textSize: "default",
  density: "comfortable",
  accent: "violet",
  accentHue: 265,
  background: "black",
  contrast: "standard",
  corners: "default",
  font: "system",
  lineSpacing: "default",
  userBubble: "tinted",
  streaming: "fade",
  toolCalls: "summary",
  thinking: "collapsed",
  longReplies: "preview",
  wrapCode: false,
  colourMarkdown: false,
  motion: "system",
  haptics: true,
  autoScroll: "follow",
  enterKey: "send",
  turnFooter: "full",
  sessionTime: "hidden",
  codeSize: "default",
  messageStyle: "plain",
};

export const APPEARANCE_KEY = "omp-appearance";
/** Text size's key before Appearance; read once as a fallback, removed on write. */
export const LEGACY_TEXT_SIZE_KEY = "omp-text-size";

function pick<T extends string>(choices: readonly Choice<T>[], value: unknown, fallback: T): T {
  return choices.find((choice) => choice.value === value)?.value ?? fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function hue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? ((Math.round(value) % 360) + 360) % 360 : fallback;
}

/**
 * Parse stored JSON into a complete Appearance. Never throws: unknown,
 * missing or invalid fields fall back to their defaults one by one, so a
 * newer build's extra field or an older build's missing one costs nothing.
 * `legacyTextSize` (the pre-Appearance key) applies only when the stored
 * object carries no valid text size of its own.
 */
export function parseAppearance(raw: string | null, legacyTextSize: string | null): Appearance {
  let stored: Record<string, unknown> = {};
  try {
    const value: unknown = raw === null ? null : JSON.parse(raw);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) stored = value as Record<string, unknown>;
  } catch {
    // Corrupt storage reads as defaults; the next write replaces it.
  }
  const d = DEFAULT_APPEARANCE;
  return {
    textSize: pick(TEXT_SIZES, stored.textSize, pick(TEXT_SIZES, legacyTextSize, d.textSize)),
    density: pick(DENSITIES, stored.density, d.density),
    accent: pick(ACCENTS, stored.accent, d.accent),
    accentHue: hue(stored.accentHue, d.accentHue),
    background: pick(BACKGROUNDS, stored.background, d.background),
    contrast: pick(CONTRASTS, stored.contrast, d.contrast),
    corners: pick(CORNERS, stored.corners, d.corners),
    font: pick(FONTS, stored.font, d.font),
    lineSpacing: pick(LINE_SPACING, stored.lineSpacing, d.lineSpacing),
    userBubble: pick(USER_BUBBLES, stored.userBubble, d.userBubble),
    streaming: pick(STREAMING, stored.streaming, d.streaming),
    toolCalls: pick(TOOL_CALLS, stored.toolCalls, d.toolCalls),
    thinking: pick(THINKING, stored.thinking, d.thinking),
    longReplies: pick(LONG_REPLIES, stored.longReplies, d.longReplies),
    wrapCode: flag(stored.wrapCode, d.wrapCode),
    colourMarkdown: flag(stored.colourMarkdown, d.colourMarkdown),
    motion: pick(MOTION, stored.motion, d.motion),
    haptics: flag(stored.haptics, d.haptics),
    autoScroll: pick(AUTO_SCROLL, stored.autoScroll, d.autoScroll),
    enterKey: pick(ENTER_KEY, stored.enterKey, d.enterKey),
    turnFooter: pick(TURN_FOOTER, stored.turnFooter, d.turnFooter),
    sessionTime: pick(SESSION_TIME, stored.sessionTime, d.sessionTime),
    codeSize: pick(CODE_SIZES, stored.codeSize, d.codeSize),
    messageStyle: pick(MESSAGE_STYLES, stored.messageStyle, d.messageStyle),
  };
}

/** Only fields that differ from the default are stored, so defaults can improve later. */
export function serializeAppearance(appearance: Appearance): string | null {
  const changed = Object.fromEntries(
    Object.entries(appearance).filter(([key, value]) => DEFAULT_APPEARANCE[key as keyof Appearance] !== value),
  );
  return Object.keys(changed).length === 0 ? null : JSON.stringify(changed);
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

let current: Appearance | null = null;
const listeners = new Set<() => void>();

/** The current appearance. Safe outside React (haptics, navigation, main.tsx). */
export function getAppearance(): Appearance {
  current ??= parseAppearance(readStorage(APPEARANCE_KEY), readStorage(LEGACY_TEXT_SIZE_KEY));
  return current;
}

function systemFontScale(): number {
  try {
    const scale = (window as Window & { OmpNative?: { fontScale?: () => number } }).OmpNative?.fontScale?.();
    return typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1;
  } catch {
    return 1;
  }
}

/** sRGB hex of each Background's page colour (--background in styles.css), for the browser chrome. Black matches index.html and the manifest. */
const BACKGROUND_THEME_COLOR: Record<Background, string> = { black: "#000000", dim: "#0f0f0f", grey: "#212121" };

/** Put the visual choices on <html>. Call before the first render and after every change. */
export function applyAppearance(appearance: Appearance = getAppearance()): void {
  const root = document.documentElement;
  const percent = (TEXT_SIZES.find((size) => size.value === appearance.textSize)?.percent ?? 100) * systemFontScale();
  // 100% clears the override so the platform's 16px root stays in charge.
  root.style.fontSize = Math.abs(percent - 100) < 0.01 ? "" : `${percent}%`;
  root.dataset.density = appearance.density;
  root.dataset.mdColour = appearance.colourMarkdown ? "on" : "off";
  root.dataset.accent = appearance.accent;
  root.dataset.background = appearance.background;
  // PWA and WebView chrome painted black above a Dim or Grey page until this followed the choice.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BACKGROUND_THEME_COLOR[appearance.background]);
  root.dataset.contrast = appearance.contrast;
  root.dataset.font = appearance.font;
  root.dataset.bubble = appearance.userBubble;
  scaleVar(root, "--code-scale", CODE_SIZES.find((size) => size.value === appearance.codeSize)?.scale ?? 1);
  scaleVar(root, "--radius-scale", CORNERS.find((corner) => corner.value === appearance.corners)?.scale ?? 1);
  scaleVar(root, "--leading-scale", LINE_SPACING.find((step) => step.value === appearance.lineSpacing)?.scale ?? 1);
  applyCustomAccent(appearance.accent === "custom" ? appearance.accentHue : null);
  if (appearance.motion === "reduce") root.dataset.motion = "reduce";
  else delete root.dataset.motion;
}

function scaleVar(root: HTMLElement, name: string, scale: number): void {
  if (scale === 1) root.style.removeProperty(name);
  else root.style.setProperty(name, String(scale));
}

// A stylesheet, not inline vars on <html>: `.dark` on #root redeclares the
// accent tokens, so only a rule with the accent selectors' reach wins there.
const CUSTOM_ACCENT_ID = "omp-custom-accent";
function applyCustomAccent(hueValue: number | null): void {
  const existing = document.getElementById(CUSTOM_ACCENT_ID);
  if (hueValue === null) { existing?.remove(); return; }
  const style = existing ?? Object.assign(document.createElement("style"), { id: CUSTOM_ACCENT_ID });
  const t = customAccentTokens(hueValue);
  style.textContent = `html[data-accent="custom"],html[data-accent="custom"] .dark{${Object.entries(t).map(([k, v]) => `--${k}:${v}`).join(";")}}`;
  if (!existing) document.head.append(style);
}

/** sRGB channels of an OKLCH colour (unclamped; outside 0..1 means out of gamut). */
export function oklchToSrgb(l: number, c: number, h: number): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180), b = c * Math.sin((h * Math.PI) / 180);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
  return linear.map((x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.sign(x) * Math.abs(x) ** (1 / 2.4) - 0.055)) as [number, number, number];
}

// Rounded down: rounding up can put a fitted chroma just outside the gamut.
const floor3 = (x: number) => (Math.floor(x * 1000) / 1000).toString();

/** The most chroma, up to `cap`, that keeps lightness `l` at hue `h` inside sRGB. */
function fitChroma(l: number, h: number, cap: number): number {
  let lo = 0, hi = cap;
  if (oklchToSrgb(l, hi, h).every((x) => x >= 0 && x <= 1)) return cap;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (oklchToSrgb(l, mid, h).every((x) => x >= 0 && x <= 1)) lo = mid; else hi = mid;
  }
  return lo;
}

/**
 * The accent tokens for any hue. Fixed lightnesses hold the bars the named
 * accents meet at every hue: white on the fill (L 0.52) is >= 5.1:1 and the
 * text colour (L 0.81) >= 4.5:1 on every surface of every background,
 * because chroma is fitted into gamut rather than clipped (clipping moves
 * lightness, which is what contrast depends on).
 */
export function customAccentTokens(h: number): Record<string, string> {
  const fill = fitChroma(0.52, h, 0.2), text = fitChroma(0.81, h, 0.12), glow = fitChroma(0.66, h, 0.2);
  const c = (l: number, chroma: number, alpha?: number) => `oklch(${l} ${floor3(chroma)} ${h}${alpha === undefined ? "" : ` / ${alpha}`})`;
  return {
    primary: c(0.52, fill),
    "primary-foreground": "oklch(1 0 0)",
    "primary-text": c(0.81, text),
    "primary-tint": c(0.81, text, 0.16),
    ring: c(0.66, glow),
    "dot-unread": c(0.72, fitChroma(0.72, h, 0.15)),
    "accent-glow": c(0.66, glow),
    "switch-on": "var(--primary)",
    "switch-thumb-on": "var(--primary-foreground)",
    "user-bubble": `oklch(from var(--surface-1) l ${floor3(fitChroma(0.25, h, 0.1))} ${h})`,
  };
}

/** One tap, many choices: each preset sets only the look, never behaviour you tuned (Enter key, haptics…). */
export const PRESETS: readonly { readonly value: string; readonly label: string; readonly patch: Partial<Appearance> }[] = [
  { value: "pulse", label: "OMP Pulse", patch: { accent: "violet", background: "black", corners: "default", font: "system", messageStyle: "plain", userBubble: "tinted", density: "comfortable", lineSpacing: "default" } },
  { value: "chatgpt", label: "ChatGPT", patch: { accent: "chatgpt", background: "black", corners: "default", font: "system", messageStyle: "plain", userBubble: "tinted", density: "comfortable", lineSpacing: "default" } },
  { value: "deepseek", label: "DeepSeek", patch: { accent: "custom", accentHue: 268, background: "grey", corners: "round", font: "system", messageStyle: "plain", userBubble: "neutral", density: "comfortable", lineSpacing: "relaxed" } },
  { value: "terminal", label: "Terminal", patch: { accent: "mono", background: "black", corners: "square", font: "mono", messageStyle: "plain", userBubble: "neutral", density: "compact", lineSpacing: "tight", streaming: "caret", toolCalls: "expanded", colourMarkdown: true } },
  { value: "messenger", label: "Messenger", patch: { accent: "violet", background: "dim", corners: "round", font: "system", messageStyle: "bubbles", userBubble: "tinted", density: "comfortable", lineSpacing: "default" } },
];

/** The preset every one of whose choices is current, if any. */
export function matchingPreset(appearance: Appearance): string | null {
  return PRESETS.find((preset) => (Object.keys(preset.patch) as (keyof Appearance)[]).every((key) => appearance[key] === preset.patch[key]))?.value ?? null;
}

/** Merge a change, persist it, apply it and notify subscribers. */
export function setAppearance(patch: Partial<Appearance>): void {
  const next: Appearance = { ...getAppearance(), ...patch };
  current = next;
  try {
    const serialized = serializeAppearance(next);
    if (serialized === null) localStorage.removeItem(APPEARANCE_KEY);
    else localStorage.setItem(APPEARANCE_KEY, serialized);
    localStorage.removeItem(LEGACY_TEXT_SIZE_KEY);
  } catch {
    // Storage refused: the choice still applies for this launch.
  }
  applyAppearance(next);
  for (const listener of listeners) listener();
}

export function resetAppearance(): void {
  setAppearance(DEFAULT_APPEARANCE);
}

/** Re-apply whenever the Android shell reports a new system font scale. */
export function followSystemFontScale(): void {
  window.addEventListener("omp-font-scale", () => applyAppearance());
}

/** Reduced motion from either the in-app choice or the system setting. */
export function prefersReducedMotion(): boolean {
  if (getAppearance().motion === "reduce") return true;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppearance(): Appearance {
  return useSyncExternalStore(subscribe, getAppearance, getAppearance);
}
