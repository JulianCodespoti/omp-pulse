import type { PluginSessionInfo } from "../../domain/plugins";
import type { OmpSessionSummary } from "../../domain/protocol";
import { activeTime, sessionTitle } from "../session-format";
import { sessionStatus } from "../session-status";

/** What a plugin may know about a conversation: title, folder, model, a coarse status and when it last moved. */
export function toPluginSession(summary: OmpSessionSummary): PluginSessionInfo {
  const state = sessionStatus(summary);
  const at = activeTime(summary);
  return {
    id: summary.path,
    title: sessionTitle(summary),
    cwd: typeof summary.cwd === "string" ? summary.cwd : "",
    model: typeof summary.model === "string" ? summary.model : "",
    status: state === "needs-you" || state === "working" ? state : "idle",
    activeAt: at > 0 ? at : null,
  };
}
