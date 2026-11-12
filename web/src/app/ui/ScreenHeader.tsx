import type { JSX, ReactNode } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * The one header for a pushed full screen (Settings and its pages, New
 * session): a 44px back button whose 20px arrow sits on the 16px gutter, then
 * the title. 56px tall below the status bar. One icon, one padding, so every
 * pushed screen's title starts at the same x.
 */
export function ScreenHeader({
  title,
  onBack,
  backLabel = "Back",
  trailing,
}: {
  title: ReactNode;
  onBack: () => void;
  backLabel?: string;
  trailing?: ReactNode;
}): JSX.Element {
  return (
    <header className="flex min-h-14 shrink-0 items-center gap-1 px-1 pt-[env(safe-area-inset-top)]">
      <Button variant="ghost" size="icon" aria-label={backLabel} onClick={onBack}>
        <ArrowLeftIcon className="size-5" />
      </Button>
      <h1 className="min-w-0 flex-1 truncate text-title font-semibold">{title}</h1>
      {trailing}
    </header>
  );
}
