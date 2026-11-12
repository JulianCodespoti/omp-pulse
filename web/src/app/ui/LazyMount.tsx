import { Suspense, useLayoutEffect, useState, type ReactNode } from "react";
import { BottomSheet } from "./Sheet";
import { RecoveryBoundary, RecoveryMessage } from "./RecoveryBoundary";

export function LazyMount({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const [hasOpened, setHasOpened] = useState(false);
  useLayoutEffect(() => {
    if (open && !hasOpened) setHasOpened(true);
  }, [open, hasOpened]);

  // Render on the first open immediately, then keep the sheet mounted so its
  // close animation can finish without paying for its chunk before first use.
  if (!open && !hasOpened) return null;
  const shell = (retry: () => void, error: unknown) => (
    <BottomSheet open={open} onOpenChange={(next) => { if (!next) onClose(); }} title="Open panel">
      <RecoveryMessage onRetry={retry} error={error} visible={open} />
    </BottomSheet>
  );
  return (
    <RecoveryBoundary fallback={shell}>
      <Suspense fallback={null}>{children}</Suspense>
    </RecoveryBoundary>
  );
}
