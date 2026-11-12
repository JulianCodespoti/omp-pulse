import { XIcon } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";

import type { DraftAttachment } from "../../runtime/offline-queue";

export interface AttachmentStripProps {
  images: DraftAttachment[];
  onRemove: (index: number) => void;
  max?: number;
  /** Photos still being decoded: one neutral tile each, so a batch shows at once. */
  pendingFiles?: readonly { id: number; name: string }[];
  onCancelPending?: (id: number) => void;
}

export function AttachmentStrip({ images, pendingFiles = [], onCancelPending, onRemove, max = 8 }: AttachmentStripProps) {
  if (images.length === 0 && pendingFiles.length === 0) return null;

  // The count only matters near the limit; below that it is noise.
  const nearLimit = images.length >= max - 2;
  return (
    <div className="no-scrollbar flex items-center gap-2 overflow-x-auto" data-testid="attachment-strip">
      {images.map((img, idx) => (
        <div key={`${img.name}-${idx}`} className="relative size-14 shrink-0">
          <img
            alt={img.name}
            className="size-14 rounded-md bg-surface-2 object-cover"
            src={img.previewUrl}
          />
          {/* The 44px target covers the tile's top-right corner and stays
              inside the tile: the strip scrolls and would clip anything that
              hung outside it. The visible badge is 24px in that corner. */}
          <button
            aria-label={`Remove ${img.name}`}
            className="absolute right-0 top-0 flex size-11 items-start justify-end p-1 outline-none [-webkit-tap-highlight-color:transparent] focus-visible:[&>span]:ring-2 focus-visible:[&>span]:ring-ring"
            data-testid="attachment-remove"
            onClick={() => onRemove(idx)}
            type="button"
          >
            <span className="grid size-6 place-items-center rounded-full bg-scrim text-foreground transition-opacity duration-[var(--dur-fast)] active:opacity-85">
              <XIcon className="size-3.5" aria-hidden />
            </span>
          </button>
        </div>
      ))}
      {pendingFiles.map((file) => (
        <div
          key={`pending-${file.id}`}
          data-testid="attachment-pending"
          role="status"
          aria-label="Adding photo"
          className="relative grid size-14 shrink-0 place-items-center rounded-md bg-surface-3"
        >
          <Spinner size={16} label={null} />
          <button
            type="button"
            aria-label={`Cancel ${file.name}`}
            data-testid="attachment-cancel"
            onClick={() => onCancelPending?.(file.id)}
            className="absolute right-0 top-0 flex size-11 items-start justify-end p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="grid size-6 place-items-center rounded-full bg-scrim text-foreground">
              <XIcon className="size-3.5" aria-hidden />
            </span>
          </button>
        </div>
      ))}
      {nearLimit ? (
        <span className="shrink-0 pl-1 text-meta tabular-nums text-muted-foreground">
          {images.length}/{max}
        </span>
      ) : null}
    </div>
  );
}
