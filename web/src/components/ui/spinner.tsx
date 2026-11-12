import { LoaderCircleIcon } from "lucide-react"

import { cn } from "@/lib/utils"

const SIZE = { 14: "size-3.5", 16: "size-4", 20: "size-5", 24: "size-6" } as const

type SpinnerProps = Omit<React.ComponentProps<"svg">, "children"> & {
  /** Icon grid sizes only (14/16/20/24). */
  size?: keyof typeof SIZE
  /**
   * Announced name. Pass `null` when the spinner decorates a control that
   * already names its busy state (a "Saving…" button), so screen readers do
   * not hear "Loading" on top of it.
   */
  label?: string | null
}

/**
 * The only spinner. Every busy indicator that is not a running label
 * (`parts/ShimmerText`) renders this, so loading looks and announces the
 * same everywhere.
 */
function Spinner({ className, size = 16, label = "Loading", ...props }: SpinnerProps) {
  const a11y = label === null
    ? { "aria-hidden": true as const }
    : { role: "status", "aria-label": label }
  return (
    <LoaderCircleIcon
      data-slot="spinner"
      {...a11y}
      className={cn(SIZE[size], "shrink-0 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner, type SpinnerProps }
