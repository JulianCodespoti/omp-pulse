import { useState, type JSX, type ReactNode } from "react";
import { ArrowUpIcon, CheckIcon, ChevronRightIcon, RotateCcwIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";

import {
  ACCENTS,
  AUTO_SCROLL,
  BACKGROUNDS,
  CODE_SIZES,
  CONTRASTS,
  CORNERS,
  DEFAULT_APPEARANCE,
  DENSITIES,
  ENTER_KEY,
  FONTS,
  LINE_SPACING,
  LONG_REPLIES,
  MESSAGE_STYLES,
  MOTION,
  PRESETS,
  SESSION_TIME,
  STREAMING,
  TEXT_SIZES,
  THINKING,
  TOOL_CALLS,
  TURN_FOOTER,
  USER_BUBBLES,
  customAccentTokens,
  matchingPreset,
  resetAppearance,
  setAppearance,
  useAppearance,
  type Accent,
  type Appearance,
  type Choice,
} from "../platform/appearance";
import { AgentAvatar } from "./parts/Bubble";
import { AGENT_BUBBLE, AGENT_THREAD } from "./parts/prose";
import { Row, RowGroup } from "./ui/Row";
import { Segmented } from "./ui/Segmented";
import { ConfirmSheet } from "./ui/Sheet";

type Tab = "look" | "text" | "chat" | "controls";
const TABS: readonly Choice<Tab>[] = [
  { value: "look", label: "Look" },
  { value: "text", label: "Text" },
  { value: "chat", label: "Chat" },
  { value: "controls", label: "Controls" },
];

/**
 * Settings → Appearance. Every control writes through setAppearance, which
 * applies it at once; the pinned preview is built from the same type roles,
 * tokens and spacing variable as the transcript, so it changes with them.
 * Tabs instead of one long page: with ~25 choices the preview scrolled away
 * from most of the controls it was there to preview.
 */
export function AppearanceSettings(): JSX.Element {
  const appearance = useAppearance();
  const [tab, setTab] = useState<Tab>("look");
  const [confirmReset, setConfirmReset] = useState(false);
  const isDefault = (Object.keys(DEFAULT_APPEARANCE) as (keyof Appearance)[]).every(
    (key) => appearance[key] === DEFAULT_APPEARANCE[key],
  );
  // One segmented control per enum choice, all written the same way.
  const choose = <K extends keyof Appearance>(key: K, label: string, options: readonly Choice<Appearance[K] & string>[], help?: string) => (
    <Field label={label} help={help}>
      <Segmented
        aria-label={label}
        testId={`appearance-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`}
        className="bg-background"
        options={options}
        value={appearance[key] as Appearance[K] & string}
        onChange={(value) => setAppearance({ [key]: value } as Partial<Appearance>)}
      />
    </Field>
  );
  const toggle = (key: "wrapCode" | "haptics" | "colourMarkdown", title: string, subtitle?: string) => (
    <Row
      title={title}
      subtitle={subtitle}
      testId={key === "wrapCode" ? "appearance-wrap" : key === "colourMarkdown" ? "appearance-colour-markdown" : "appearance-haptics"}
      trailing={
        <span className="-mr-1 flex size-12 shrink-0 items-center justify-center">
          <Switch checked={appearance[key]} onCheckedChange={(checked) => setAppearance({ [key]: checked })} aria-label={title} />
        </span>
      }
    />
  );
  return (
    <div className="flex flex-col gap-6">
      <div className="sticky top-0 z-10 -mx-4 -mt-2 flex flex-col gap-3 bg-background px-4 pb-3 pt-2">
        <AppearancePreview appearance={appearance} />
        <Segmented aria-label="Appearance section" testId="appearance-tabs" options={TABS} value={tab} onChange={setTab} />
      </div>

      {tab === "look" ? (
        <>
          <PresetPicker appearance={appearance} />
          <RowGroup title="Colour" inset>
            <Field label="Accent">
              <AccentPicker value={appearance.accent} hue={appearance.accentHue} onChange={(accent) => setAppearance({ accent })} />
            </Field>
            {appearance.accent === "custom" ? (
              <Field label="Hue">
                <HueSlider value={appearance.accentHue} onChange={(accentHue) => setAppearance({ accentHue })} />
              </Field>
            ) : null}
            {choose("background", "Background", BACKGROUNDS, "Black is darkest on OLED screens.")}
            {choose("contrast", "Contrast", CONTRASTS, "High brightens secondary text and dividers.")}
            {toggle("colourMarkdown", "Coloured markdown", "Headings, bold, inline code and table headers in the terminal\u2019s colours.")}
          </RowGroup>
          <RowGroup title="Shape" inset>
            {choose("corners", "Corners", CORNERS)}
            {choose("messageStyle", "Message style", MESSAGE_STYLES, "Bubbles: your messages in the accent, the agent\u2019s beside its avatar, its work threaded beneath. Tap a message for its time.")}
            {choose("userBubble", "Your messages", USER_BUBBLES, "Accent tints your messages with the accent colour.")}
          </RowGroup>
        </>
      ) : null}

      {tab === "text" ? (
        <RowGroup title="Text" inset>
          {choose("textSize", "Text size", TEXT_SIZES)}
          {choose("font", "Font", FONTS)}
          {choose("lineSpacing", "Line spacing", LINE_SPACING, "Space between lines of a message.")}
          {choose("density", "Density", DENSITIES, "Compact tightens lists and the space between messages.")}
          {choose("codeSize", "Code size", CODE_SIZES, "Code, diffs and command output, separately from text.")}
          {toggle("wrapCode", "Wrap code and diffs")}
        </RowGroup>
      ) : null}

      {tab === "chat" ? (
        <RowGroup title="Conversation" inset>
          {choose("streaming", "Streaming", STREAMING, "How replies appear while the agent is writing.")}
          {choose("autoScroll", "Auto-scroll", AUTO_SCROLL, "Stay put lets a reply grow below the screen while you read.")}
          {choose("toolCalls", "Tool calls", TOOL_CALLS, "Summary folds a finished turn's work into one \u201cWorked for\u2026\u201d line that opens it. Grouped folds each run of calls into a row in place.")}
          {choose("thinking", "Thinking", THINKING, "Latest keeps only the newest thinking open; earlier thinking folds away.")}
          {choose("longReplies", "Long replies", LONG_REPLIES, "Preview shortens earlier long replies; the newest is always in full.")}
          {choose("turnFooter", "Turn footer", TURN_FOOTER, "Compact keeps Copy and more actions, without duration and speed.")}
        </RowGroup>
      ) : null}

      {tab === "controls" ? (
        <>
          <RowGroup title="Composer" inset>
            {choose("enterKey", "Enter key", ENTER_KEY, "With New line, Ctrl+Enter or the send button sends.")}
          </RowGroup>
          <RowGroup title="Sessions" inset>
            {choose("sessionTime", "Last active", SESSION_TIME, "Shown at the end of each session\u2019s second line.")}
          </RowGroup>
          <RowGroup title="Motion & feel" inset>
            {choose("motion", "Reduce motion", MOTION, "Always turns animations off even when the phone allows them.")}
            {toggle("haptics", "Haptics")}
          </RowGroup>
        </>
      ) : null}

      <RowGroup inset>
        <Row
          leading={<RotateCcwIcon />}
          title="Reset everything to defaults"
          disabled={isDefault}
          onClick={() => setConfirmReset(true)}
          testId="appearance-reset"
        />
      </RowGroup>
      <ConfirmSheet
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset appearance?"
        description="Every choice on this page goes back to its default. Your conversations are untouched."
        confirmLabel="Reset"
        onConfirm={() => {
          resetAppearance();
          setConfirmReset(false);
        }}
        testId="appearance-reset-confirm"
      />
    </div>
  );
}

/** Presets set the look in one tap; the tick follows whichever one is exactly current. */
function PresetPicker({ appearance }: { appearance: Appearance }): JSX.Element {
  const current = matchingPreset(appearance);
  return (
    <RowGroup title="Presets" inset>
      <div role="radiogroup" aria-label="Preset" data-testid="appearance-presets" className="grid grid-cols-2 gap-2 p-3">
        {PRESETS.map((preset) => {
          const checked = preset.value === current;
          return (
            <button
              key={preset.value}
              type="button"
              role="radio"
              aria-checked={checked}
              data-value={preset.value}
              onClick={() => setAppearance(preset.patch)}
              className={cn(
                "flex min-h-12 items-center justify-between gap-2 rounded-lg bg-background px-3 py-2 text-left text-ui outline-none [-webkit-tap-highlight-color:transparent]",
                "focus-visible:ring-2 focus-visible:ring-ring",
                checked ? "ring-2 ring-foreground" : "ring-1 ring-hairline",
              )}
            >
              <span className="min-w-0 truncate">{preset.label}</span>
              {checked ? <CheckIcon aria-hidden className="size-4 shrink-0" /> : null}
            </button>
          );
        })}
      </div>
    </RowGroup>
  );
}

/** A native range input: keyboard, TalkBack and drag all come with it. */
function HueSlider({ value, onChange }: { value: number; onChange: (hue: number) => void }): JSX.Element {
  return (
    <input
      type="range"
      min={0}
      max={359}
      step={1}
      value={value}
      aria-label="Accent hue"
      aria-valuetext={`${value} degrees`}
      data-testid="appearance-accent-hue"
      onChange={(event) => onChange(Number(event.currentTarget.value))}
      className="h-11 w-full cursor-pointer appearance-none bg-transparent outline-none focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-ring [&::-webkit-slider-runnable-track]:h-3 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[image:var(--hue-track)] [&::-webkit-slider-thumb]:-mt-2 [&::-webkit-slider-thumb]:size-7 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-foreground [&::-webkit-slider-thumb]:bg-primary"
      style={{ ["--hue-track" as string]: HUE_TRACK }}
    />
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2 px-4 py-3">
      <span className="text-ui text-foreground">{label}</span>
      {children}
      {help ? <span className="text-meta text-muted-foreground">{help}</span> : null}
    </div>
  );
}

// The track is the custom accent's own fill at each hue, so it shows what you get.
const HUE_TRACK = `linear-gradient(to right, ${Array.from({ length: 13 }, (_, i) => customAccentTokens(i * 30).primary).join(", ")})`;

/** Swatches paint from the same tokens the accent sets on <html> (styles.css). */
const SWATCH: Record<Accent, string> = {
  // White buttons, blue links.
  chatgpt: "linear-gradient(135deg, oklch(1 0 0) 50%, oklch(0.718 0.154 248) 50%)",
  violet: "oklch(0.56 0.21 285)",
  magenta: "oklch(0.56 0.2 330)",
  cyan: "oklch(0.52 0.085 205)",
  mono: "oklch(0.9 0.01 285)",
  // Replaced by the chosen hue once picked; a wheel until then.
  custom: "conic-gradient(oklch(0.6 0.17 0), oklch(0.6 0.17 90), oklch(0.6 0.17 180), oklch(0.6 0.17 270), oklch(0.6 0.17 360))",
};

function AccentPicker({ value, hue, onChange }: { value: Accent; hue: number; onChange: (accent: Accent) => void }): JSX.Element {
  return (
    <div role="radiogroup" aria-label="Accent" data-testid="appearance-accent" className="flex flex-wrap gap-2">
      {ACCENTS.map((accent) => {
        const checked = accent.value === value;
        return (
          <button
            key={accent.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={accent.label}
            data-value={accent.value}
            onClick={() => onChange(accent.value)}
            className={cn(
              "flex size-11 items-center justify-center rounded-full outline-none [-webkit-tap-highlight-color:transparent]",
              "focus-visible:ring-2 focus-visible:ring-ring",
              checked ? "ring-2 ring-foreground" : "ring-1 ring-hairline",
            )}
          >
            <span aria-hidden className="size-8 rounded-full" style={{ background: accent.value === "custom" && value === "custom" ? customAccentTokens(hue).primary : SWATCH[accent.value] }} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * A static mini conversation that obeys the current choices: the real
 * transcript's bubble, type roles, accent tokens and --gap-scale spacing.
 */
function AppearancePreview({ appearance }: { appearance: Appearance }): JSX.Element {
  const gap = { gap: "calc(12px * var(--gap-scale))" };
  const bubbles = appearance.messageStyle === "bubbles";
  return (
    // Pinned (by its parent) so each change shows while its control is on
    // screen; capped so Larger text cannot crowd out the controls it previews.
    <div aria-hidden data-testid="appearance-preview">
      <div className="flex max-h-[40vh] flex-col overflow-hidden rounded-lg bg-background p-4 ring-1 ring-hairline" style={gap}>
        <p className={cn("ml-auto max-w-[85%] px-4 py-2.5 text-body", bubbles ? "rounded-[calc(1.125rem*var(--radius-scale,1))] rounded-br-md bg-user-bubble" : "rounded-xl bg-user-bubble")}>Can you check the failing test?</p>
        {bubbles ? (
          <span className="-mb-2 pl-8 text-caption text-muted-foreground">omp · Opus 4.5</span>
        ) : null}
        <div className={cn("flex flex-col", bubbles && AGENT_THREAD)} style={gap}>
        {appearance.thinking === "hidden" ? null : (
          <div className="flex flex-col gap-1 text-meta text-muted-foreground">
            <span className="flex items-center gap-1">
              Thought for 12s
              <ChevronRightIcon className={cn("size-3.5", appearance.thinking === "latest" && "rotate-90")} />
            </span>
            {appearance.thinking === "latest" ? (
              <span className="border-l-2 border-hairline pl-2">The timer is never advanced, so the retry never fires.</span>
            ) : null}
          </div>
        )}
        {appearance.toolCalls === "expanded" ? (
          <ul className="flex flex-col gap-1 font-mono text-code text-muted-foreground">
            <li>read retry.test.ts</li>
            <li>bash npm test -- retry</li>
          </ul>
        ) : (
          <span className="flex items-center gap-1 text-meta text-muted-foreground">
            {appearance.toolCalls === "summary" ? "Worked for 12s" : "Read 1 file, ran 1 command"}
            <ChevronRightIcon className="size-3.5" />
          </span>
        )}
        </div>
        {bubbles ? (
          <div className="flex items-end gap-2">
            <AgentAvatar />
            <p className={cn("text-body", AGENT_BUBBLE)}>
          The timer in <code className="rounded-sm bg-surface-2 px-1 font-mono text-code">retry.ts</code> <strong data-streamdown="strong" className="font-medium">never fires</strong>. I’ll fake the clock and{" "}
          <StreamingTail streaming={appearance.streaming}>run it again.</StreamingTail>
        </p>
          </div>
        ) : (
          <p className="text-body">
          The timer in <code className="rounded-sm bg-surface-2 px-1 font-mono text-code">retry.ts</code> <strong data-streamdown="strong" className="font-medium">never fires</strong>. I’ll fake the clock and{" "}
          <StreamingTail streaming={appearance.streaming}>run it again.</StreamingTail>
        </p>
        )}
        {appearance.turnFooter === "full" ? (
          <span className="-mt-1 text-meta text-muted-foreground">Worked for 12s · 48 tok/s</span>
        ) : null}
        <div className="flex items-center gap-2 rounded-full bg-surface-2 py-1 pl-4 pr-1">
          <span className="min-w-0 flex-1 text-meta text-muted-foreground">Message</span>
          <span className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <ArrowUpIcon className="size-4" />
          </span>
        </div>
      </div>
    </div>
  );
}

function StreamingTail({ streaming, children }: { streaming: Appearance["streaming"]; children: string }): JSX.Element {
  if (streaming === "fade") return <span className="opacity-40">{children}</span>;
  if (streaming === "caret") {
    return (
      <>
        {children}
        <span className="ml-0.5 inline-block h-[1em] w-[0.5em] translate-y-[0.15em] bg-foreground/70" />
      </>
    );
  }
  return <>{children}</>;
}
