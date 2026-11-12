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
        "peer group/switch relative inline-flex shrink-0 items-center rounded-full border border-transparent transition-[background-color,border-color,box-shadow] duration-[var(--dur-control)] ease-[var(--ease-control)] outline-none group-has-[:focus-visible]/field-label:border-transparent group-has-[:focus-visible]/field-label:ring-0 after:absolute after:-inset-x-3 after:-inset-y-[13px] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-danger aria-invalid:ring-3 aria-invalid:ring-danger/20 data-[size=default]:h-[18.4px] data-[size=default]:w-[32px] data-[size=sm]:h-[14px] data-[size=sm]:w-[24px] dark:aria-invalid:border-danger/50 dark:aria-invalid:ring-danger/40 data-checked:bg-[var(--switch-on)] data-unchecked:bg-control dark:data-unchecked:bg-control/80 data-disabled:cursor-not-allowed data-disabled:opacity-50",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        // One 24px box in both states: the thumb slides 16px and shrinks to
        // two thirds by transform, so the Material growth reads the same without
        // animating margin and box size (layout) on every toggle.
        className="pointer-events-none block size-[24px] shrink-0 rounded-full transition-[translate,scale,background-color] duration-[var(--dur-control)] ease-[var(--ease-position)] ms-[6px] scale-[0.667] data-unchecked:bg-muted-foreground data-checked:translate-x-[16px] data-checked:scale-100 data-checked:bg-[var(--switch-thumb-on)] motion-reduce:transition-none"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
