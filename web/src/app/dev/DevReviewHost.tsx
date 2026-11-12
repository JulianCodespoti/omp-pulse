import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";

import { Dialog, DialogPortal } from "@/components/ui/dialog";
import { OPEN_REVIEW_EVENT } from "../ui/LinkedText";

// Temporary dev review screen: loaded only when a review link opens it, so it
// never weighs on a normal launch.
const ReviewOverlay = lazy(() => import("./LiveTurnPreview"));

/**
 * Opens without touching history: a fragment change fires popstate, which the
 * app reads as Back out of the chat (it cleared the fragment and left the
 * question behind). A cold start from a `…/app/#dev=…` link is read once.
 * It is a dialog of its own because the question sheet it opens from is
 * modal: anything outside that sheet is blocked, a later dialog is not.
 */
export function DevReviewHost() {
  const [spec, setSpec] = useState<string | null>(() => {
    const hash = window.location.hash;
    if (!hash.startsWith("#dev=")) return null;
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    return hash;
  });
  useEffect(() => {
    const onOpen = (event: Event) => {
      const hash = (event as CustomEvent<unknown>).detail;
      if (typeof hash === "string" && hash.startsWith("#dev=")) setSpec(hash);
    };
    window.addEventListener(OPEN_REVIEW_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_REVIEW_EVENT, onOpen);
  }, []);
  const close = useCallback(() => setSpec(null), []);
  return (
    <Dialog open={spec !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogPortal>
        <DialogPrimitive.Popup aria-label="Design review" className="fixed inset-0 z-[1000] outline-none">
          {spec ? <Suspense fallback={null}><ReviewOverlay hash={spec} onClose={close} /></Suspense> : null}
        </DialogPrimitive.Popup>
      </DialogPortal>
    </Dialog>
  );
}
