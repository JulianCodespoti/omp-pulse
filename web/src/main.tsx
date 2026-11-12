import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LucideProvider } from "lucide-react";

import { App } from "./app/App";
import { DevReviewHost } from "./app/dev/DevReviewHost";
import { installMotionTokens } from "./app/ui/motion";
import { retryableLazy } from "./app/ui/retryable-lazy";
import { ScreenBoundary } from "./app/ui/RecoveryBoundary";
import { applyAppearance, followSystemFontScale } from "./platform/appearance";
import { getOmpLocal, readLocalState } from "./platform/local-mode";
import { installPressFeedback } from "./platform/press-feedback";
import "./styles.css";

// Shown only while no mode is chosen (first run, or after Stop phone mode), so it stays out of the chunk every launch parses.
const Onboarding = retryableLazy(() =>
  import("./app/Onboarding").then((module) => ({ default: module.Onboarding })),
);

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
// omp-pulse is dark-only: phone client used at all hours on OLED; light tokens were
// removed from styles.css. Keep .dark as the class-based source of truth.
document.documentElement.classList.add("dark");
root.classList.add("dark");
// Text size, density, accent and motion land on <html> before the first
// paint, so a Larger or Compact setting never flashes Default first.
applyAppearance();
followSystemFontScale();
installPressFeedback();
// One sampled spring for the sheet, menu, selection and bar transitions
// (--ease-position / --ease-settle), computed once before the first paint.
installMotionTokens();

// styles.css pauses every CSS animation under html[data-hidden]: a hidden
// page still ran its infinite spinners and shimmers.
const syncHidden = () =>
  document.documentElement.toggleAttribute("data-hidden", document.visibilityState === "hidden");
document.addEventListener("visibilitychange", syncHidden);
syncHidden();

// INVARIANT: while the shell reports mode "unset", App never mounts. That page
// is the bundled app with no daemon behind it, and App starts the session
// controller, service worker and pairing the moment it renders.
const bridge = getOmpLocal();
const firstRun = bridge && readLocalState(bridge)?.mode === "unset" ? bridge : null;

// One icon weight app-wide. Lucide's default 2px stroke read heavy next to
// 400-weight text; call sites must not pass their own strokeWidth.
createRoot(root).render(
  <StrictMode>
    <LucideProvider strokeWidth={1.5}>
      <ScreenBoundary title={firstRun ? "Welcome" : "omp-pulse"}>
        {firstRun ? <Onboarding bridge={firstRun} /> : <><App /><DevReviewHost /></>}
      </ScreenBoundary>
    </LucideProvider>
  </StrictMode>,
);
