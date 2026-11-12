import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-control bg-transparent px-2.5 py-2 text-body transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring disabled:cursor-not-allowed disabled:bg-control/50 disabled:opacity-50 aria-invalid:border-danger md:text-body dark:bg-control/30 dark:disabled:bg-control/80",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
