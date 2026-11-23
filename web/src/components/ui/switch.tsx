"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

/**
 * Material 3 switch: a 52×32dp track whose thumb grows from 16dp (off) to
 * 24dp (on). Like a native Android switch it keeps that size at any text
 * scale: at 150% text a rem switch grew to 78×48 and squeezed its label into
 * hyphenated fragments. Track and thumb are both px, so they stay in step
 * (the old shadcn switch mixed a px track with a rem thumb). The
 * `after:` box widens the hit area to a 48dp target without changing the
 * drawn size.
 */
function Switch({
  className,
  ...props
}: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer group/switch relative inline-flex h-[32px] w-[52px] shrink-0 items-center rounded-full border-2 border-transparent transition-[background-color,border-color,box-shadow] duration-[var(--dur-control)] ease-[var(--ease-control)] outline-none group-has-[:focus-visible]/field-label:border-transparent group-has-[:focus-visible]/field-label:ring-0 after:absolute after:-inset-x-1 after:-inset-y-[8px] focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20 dark:aria-invalid:border-danger/50 dark:aria-invalid:ring-danger/40 data-checked:bg-[var(--switch-on)] data-unchecked:border-control data-unchecked:bg-surface-1 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        // One 24px box in both states inside the 52×32px (48×28 inner) track:
        // off sits 8px inset at 16px (scale 0.667), on slides 20px to 4px inset at 24px.
        className="pointer-events-none block size-[24px] shrink-0 rounded-full transition-[translate,scale,background-color] duration-[var(--dur-control)] ease-[var(--ease-position)] ms-[2px] scale-[0.667] data-unchecked:bg-muted-foreground data-checked:translate-x-[20px] data-checked:scale-100 data-checked:bg-[var(--switch-thumb-on)] motion-reduce:transition-none"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
