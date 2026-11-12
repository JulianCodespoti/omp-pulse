import { useMemo, type JSX } from "react";
import { encode } from "uqr";

import { cn } from "@/lib/utils";

/**
 * A QR code drawn as one SVG path, dark modules on a light tile. Scanners
 * need a dark-on-light code with a quiet zone, so the tile is the foreground
 * colour with padding rather than the page's dark surface.
 */
export function QrCode({
  value,
  label,
  className,
  testId,
}: {
  value: string;
  label: string;
  className?: string;
  testId?: string;
}): JSX.Element {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: "M", border: 0 });
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { size: qr.size, path: d };
  }, [value]);
  return (
    <div className={cn("rounded-lg bg-foreground p-3 text-background", className)} data-testid={testId}>
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${size} ${size}`}
        shapeRendering="crispEdges"
        className="block size-full"
      >
        <path d={path} fill="currentColor" />
      </svg>
    </div>
  );
}
