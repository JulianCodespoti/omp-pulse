import type { JSX } from "react";

import type { OmpSessionController } from "../../runtime/omp-session-controller";
import { useNeedsYouElsewhere } from "../nav/needs-you";

/**
 * The accent dot on a ≡ button while ANOTHER chat waits on the reader. Lives
 * inside the (relative) button; the button's `aria-describedby` points at
 * `hintId`, because its aria-label would otherwise hide the dot from a screen
 * reader.
 */
export function NeedsYouDot({ controller, currentPath, hintId }: { controller: OmpSessionController; currentPath: string | null; hintId: string }): JSX.Element | null {
  const count = useNeedsYouElsewhere(controller, currentPath);
  if (count === 0) return null;
  return (
    <>
      <span aria-hidden data-testid="needs-you-dot" className="absolute right-2 top-2 size-2.5 rounded-full bg-primary ring-2 ring-surface-2" />
      <span id={hintId} className="sr-only">{count === 1 ? "Another chat needs you" : `${count} other chats need you`}</span>
    </>
  );
}
