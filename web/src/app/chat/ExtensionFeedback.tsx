import { InfoIcon } from "lucide-react";

import type { ExtensionFeedback as FeedbackState } from "../../runtime/extension-feedback";
import { Notice } from "../ui/Notice";
import { PluginNodeView } from "../plugins/NodeView";
import { usePluginSlot } from "../plugins/use-plugin-host";

/**
 * Text-only extension surfaces, separate from turn activity and reply
 * requests. Routine output stays quiet: an informational notice and the
 * extensions' status texts share one small pill above the composer (they
 * used to be a full card plus a line each, three rows of chrome for "loaded").
 * The pill has its own surface because the composer floats over the reply:
 * bare text needed a black fade behind it to stay readable.
 * A warning or an error keeps its tinted card, because it may need you.
 */
export function ExtensionFeedback({ feedback, placement }: { feedback: FeedbackState; placement: "aboveEditor" | "belowEditor" }) {
  const widgets = feedback.widgets.filter(widget => widget.placement === placement);
  const latest = placement === "aboveEditor" ? feedback.notices.at(-1) : undefined;
  const older = placement === "aboveEditor" ? feedback.notices.slice(0, -1) : [];
  const statuses = placement === "aboveEditor" ? feedback.statuses : [];
  // The hook returns the slot's views whether or not it retains the slot; only
  // the pill above the composer shows them, or the chip would be drawn twice.
  const slot = usePluginSlot("composer.status", placement === "aboveEditor");
  const plugin = placement === "aboveEditor" ? slot : { ...slot, views: [] };
  if (!latest && !older.length && !statuses.length && !widgets.length && !plugin.views.length) return null;
  const loud = latest && latest.severity !== "info" ? latest : undefined;
  const quiet = latest && latest.severity === "info" ? latest : undefined;
  return <section aria-label="Extension feedback" className="mx-4 mb-1.5 max-h-48 space-y-1.5 overflow-y-auto text-meta" data-testid={`extension-feedback-${placement}`}>
    {loud ? <Notice tone={loud.severity === "error" ? "danger" : loud.severity}><span className="whitespace-pre-wrap">{loud.message}</span></Notice> : null}
    {quiet || statuses.length || plugin.views.length ? (
      <div data-testid="extension-status" className="flex w-fit min-w-0 max-w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded-full bg-surface-2 px-3 py-1 text-muted-foreground shadow-[var(--shadow-float)] ring-1 ring-inset ring-white/10">
        {quiet ? (
          <p role="status" className="flex min-w-0 items-center gap-1.5">
            <InfoIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{quiet.message}</span>
          </p>
        ) : null}
        {statuses.map(status => <p key={status.key} role="status" className="min-w-0 truncate">{status.text}</p>)}
        {plugin.views.length ? (
          <span data-testid="plugin-slot-composer.status" className="flex min-w-0 flex-wrap items-center gap-1.5">
            {plugin.views.map(entry => (
              <span key={entry.pluginId} data-testid="plugin-view" data-plugin={entry.pluginId} className="min-w-0">
                <PluginNodeView node={entry.view} onAction={(action, item) => plugin.onAction(entry.pluginId, action, item)} />
              </span>
            ))}
          </span>
        ) : null}
      </div>
    ) : null}
    {older.length ? <details className="text-muted-foreground"><summary className="flex min-h-11 w-fit cursor-pointer items-center rounded-full bg-surface-2 px-3 leading-6 ring-1 ring-inset ring-white/10">Earlier extension notices ({older.length})</summary>
      <div className="space-y-1">{older.map(notice => <Notice key={notice.id} tone={notice.severity === "error" ? "danger" : notice.severity}><span className="whitespace-pre-wrap">{notice.message}</span></Notice>)}</div>
    </details> : null}
    {widgets.map(widget => <details key={widget.key} className="rounded-lg bg-surface-1 px-3 text-muted-foreground">
      <summary className="min-h-11 cursor-pointer break-words py-2.5 leading-6">{widget.key}</summary>
      <pre className="mb-2 mt-1 whitespace-pre-wrap break-words font-sans text-foreground">{widget.lines.join("\n")}</pre>
    </details>)}
  </section>;
}
