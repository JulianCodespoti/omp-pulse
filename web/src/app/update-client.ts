import { applyClientUpdate } from "../platform/service-worker";
import type { OmpSessionController } from "../runtime/omp-session-controller";
import { showToast } from "./Notices";
import { openSettingsPage } from "./nav/panels";
import { humanizeDaemonError } from "./ui/OwnedBySession";

/**
 * The one "update this app now": Settings › About and the version banner both
 * call it. The banner used to open Settings, where a second Update had to be
 * found and tapped (three steps to take one update).
 *
 * A turn runs in omp on the computer, so reloading cannot interrupt it (the
 * app resyncs on load). Blocking on a live turn left Update unusable through
 * any long run. Only a send this device has not delivered yet lives here.
 *
 * Resolves after requesting a reload, or after reporting pending work or a
 * failure to the user.
 */
export async function updateClientNow(
  controller: OmpSessionController,
  options: { onViewPending?: () => void } = {},
): Promise<void> {
  if (controller.getUpdateSafety().pendingWork) {
    showToast("A message hasn't been sent yet. Update once it's delivered.", "error", {
      label: options.onViewPending ? "View pending work" : "Open settings",
      onClick: options.onViewPending ?? (() => openSettingsPage("about")),
    });
    return;
  }
  try {
    await controller.prepareForUpdate();
    await applyClientUpdate();
    window.location.reload();
  } catch (cause) {
    showToast(humanizeDaemonError(cause), "error");
  }
}
