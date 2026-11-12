import { InfoIcon } from "lucide-react";
import type { JSX } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import type { PluginNode, PluginTone } from "../../domain/plugins";
import { Chip, type ChipTone } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";

type OnAction = (action: string, item?: string) => void;
type Props = Record<string, unknown>;

const TEXT_TONE: Record<PluginTone, string> = {
  neutral: "text-foreground",
  accent: "text-primary-text",
  success: "text-success",
  warning: "text-warning",
  error: "text-danger",
  muted: "text-muted-foreground",
};

const BAR_TONE: Record<PluginTone, string> = {
  neutral: "bg-foreground",
  accent: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-danger",
  muted: "bg-muted-foreground",
};

const CHIP_TONE: Record<PluginTone, ChipTone> = {
  neutral: "neutral",
  accent: "accent",
  success: "success",
  warning: "warning",
  error: "danger",
  muted: "neutral",
};

const TONES = new Set<string>(Object.keys(TEXT_TONE));

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function tone(value: unknown): PluginTone | undefined {
  return typeof value === "string" && TONES.has(value) ? (value as PluginTone) : undefined;
}

function click(props: Props): string | undefined {
  const actions = props.actions;
  if (typeof actions !== "object" || actions === null) return undefined;
  return str((actions as Props).click);
}

function records(value: unknown): Props[] {
  return Array.isArray(value) ? value.filter((item): item is Props => typeof item === "object" && item !== null) : [];
}

function gap(props: Props): string {
  return props.gap === "md" ? "gap-3" : "gap-1.5";
}

/** Renders one validated plugin node tree with the app's own components. Text is always text. */
export function PluginNodeView({ node, onAction }: { node: PluginNode; onAction: OnAction }): JSX.Element | null {
  const p: Props = node.p ?? {};
  const children = (node.c ?? []).map((child, index) => <PluginNodeView key={index} node={child} onAction={onAction} />);
  switch (node.k) {
    case "text":
      return (
        <p
          className={cn(
            "min-w-0 whitespace-pre-wrap break-words text-ui",
            TEXT_TONE[tone(p.tone) ?? "neutral"],
            p.strong === true && "font-semibold",
            p.mono === true && "font-mono",
          )}
        >
          {str(p.text) ?? ""}
        </p>
      );
    case "chip": {
      const action = click(p);
      return (
        <Chip
          testId="plugin-chip"
          tone={CHIP_TONE[tone(p.tone) ?? "neutral"]}
          onClick={action ? () => onAction(action) : undefined}
        >
          {str(p.text) ?? ""}
        </Chip>
      );
    }
    case "row":
      return <div className={cn("flex min-w-0 flex-wrap items-center", gap(p))}>{children}</div>;
    case "col":
      return <div className={cn("flex min-w-0 flex-col", gap(p))}>{children}</div>;
    case "card": {
      const title = str(p.title);
      return (
        <section className="flex min-w-0 flex-col gap-2 rounded-lg bg-surface-1 p-3">
          {title ? <h4 className={cn("m-0 break-words text-ui font-semibold", TEXT_TONE[tone(p.tone) ?? "neutral"])}>{title}</h4> : null}
          {children}
        </section>
      );
    }
    case "kv":
      return (
        <dl className="m-0 grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-x-3 gap-y-1.5 text-meta">
          {records(p.items).map((item, index) => (
            <div key={index} className="contents">
              <dt className="min-w-0 break-words text-muted-foreground">{str(item.key) ?? ""}</dt>
              <dd className={cn("m-0 min-w-0 break-words [overflow-wrap:anywhere]", TEXT_TONE[tone(item.tone) ?? "neutral"])}>{str(item.value) ?? ""}</dd>
            </div>
          ))}
        </dl>
      );
    case "list": {
      const action = click(p);
      return (
        <ul className="m-0 flex min-w-0 list-none flex-col p-0">
          {records(p.items).map((item, index) => {
            const id = str(item.id);
            const detail = str(item.detail);
            const value = str(item.value);
            const body = (
              <>
                <span className="flex min-w-0 flex-1 flex-col text-left">
                  <span className="break-words text-ui text-foreground">{str(item.label) ?? ""}</span>
                  {detail ? <span className="break-words text-meta text-muted-foreground">{detail}</span> : null}
                </span>
                {value ? (
                  <span className={cn("max-w-[50%] shrink-0 break-words text-right text-meta [overflow-wrap:anywhere]", TEXT_TONE[tone(item.tone) ?? "muted"])}>{value}</span>
                ) : null}
              </>
            );
            return (
              <li key={index} className="min-w-0">
                {action ? (
                  <button
                    type="button"
                    className="press-bounce flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-2 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring hover:bg-surface-2"
                    onClick={() => onAction(action, id)}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex min-h-11 w-full min-w-0 items-center gap-3 px-2 py-1.5">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      );
    }
    case "progress": {
      const raw = typeof p.value === "number" && Number.isFinite(p.value) ? p.value : 0;
      const value = Math.min(1, Math.max(0, raw));
      const percent = Math.round(value * 100);
      const label = str(p.label);
      return (
        <div className="flex min-w-0 flex-col gap-1">
          {label ? <span className="break-words text-meta text-muted-foreground">{label}</span> : null}
          <div
            role="progressbar"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3"
          >
            <div className={cn("h-full rounded-full", BAR_TONE[tone(p.tone) ?? "accent"])} style={{ width: `${percent}%` }} />
          </div>
        </div>
      );
    }
    case "button": {
      const action = click(p);
      const variant = p.variant === "primary" ? "primary" : p.variant === "danger" ? "danger" : "secondary";
      return (
        <Button
          type="button"
          data-testid="plugin-button"
          variant={variant}
          className="min-h-11 max-w-full"
          disabled={!action}
          onClick={action ? () => onAction(action) : undefined}
        >
          <span className="min-w-0 truncate">{str(p.text) ?? ""}</span>
        </Button>
      );
    }
    case "empty":
      return <EmptyState icon={<InfoIcon />} title={str(p.title) ?? ""} description={str(p.description)} />;
    default:
      return null;
  }
}
