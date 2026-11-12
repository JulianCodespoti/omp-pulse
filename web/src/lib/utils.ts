import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

// tailwind-merge only knows Tailwind's built-in scales. Without this, a
// custom size from styles.css (`text-meta`) is classified as a text COLOUR,
// so `cn("text-meta text-foreground")` drops the size and renders 16px, and a
// named layer (`z-sheet`) never replaces a caller's `z-overlay`.
// Every entry here must match a `--text-*` / `--z-index-*` token in styles.css.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["meta", "ui", "body", "title", "large-title", "code"] }],
      z: [{ z: ["base", "raised", "sticky", "overlay", "sheet", "toast"] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
