import { CheckIcon, CopyIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Copy → check as a 100ms cross-fade: the outgoing icon fades and shrinks to
 * 0.8 while the incoming one grows from 0.8 (DeepSeek's timing). Both stay
 * mounted in one grid cell so the swap never shifts the button.
 */
export function CopyFeedbackIcon({ copied }: { copied: boolean }) {
  const swap = "col-start-1 row-start-1 size-4 transition-[opacity,scale] duration-100 motion-reduce:transition-none";
  return (
    <span aria-hidden className="inline-grid size-4 place-items-center">
      <CopyIcon className={cn(swap, copied && "scale-80 opacity-0")} />
      <CheckIcon className={cn(swap, "text-success", !copied && "scale-80 opacity-0")} />
    </span>
  );
}
