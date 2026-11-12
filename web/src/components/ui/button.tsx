import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// The one button. Height and radius belong to `size`, never to a call site:
// per-call `h-11`/`rounded-full` overrides were how the app ended up with six
// button heights. Every button is a pill or a circle (the owner found square
// corners off next to ChatGPT) and answers a press with the spring squeeze
// (`press-bounce`) plus a slight fade.
const buttonVariants = cva(
  "group/button press-bounce relative inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding text-ui font-medium whitespace-nowrap outline-none select-none [-webkit-tap-highlight-color:transparent] focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 aria-invalid:border-danger [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground",
        secondary: "bg-surface-3 text-foreground",
        ghost: "text-foreground hover:bg-surface-2 aria-expanded:bg-surface-2",
        outline: "border-control bg-transparent text-foreground hover:bg-surface-2 aria-expanded:bg-surface-2",
        danger: "bg-danger text-danger-foreground",
      },
      size: {
        // Rect sizes are pills; icon sizes are circles. The 32px sizes keep
        // a 44px hit area through an invisible inset.
        sm: "h-8 gap-1.5 rounded-full px-3.5 text-meta after:absolute after:-inset-1.5 after:content-['']",
        md: "h-11 gap-2 rounded-full px-5",
        "icon-sm": "size-8 rounded-full after:absolute after:-inset-1.5 after:content-['']",
        icon: "size-11 rounded-full [&_svg:not([class*='size-'])]:size-5",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "md",
    },
  }
)

type ButtonProps = ButtonPrimitive.Props & VariantProps<typeof buttonVariants>

function Button({
  className,
  variant = "secondary",
  size = "md",
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { Button, buttonVariants, type ButtonProps }
