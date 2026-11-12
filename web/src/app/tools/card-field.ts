// The composer's card idiom for the workspace pages' one-line command fields
// (Tasks "Add a task", Terminal command): a rounded-xl surface-1 card with the
// input flush inside and its circle action button at the end.
export const CARD_FORM =
  "flex min-w-0 items-center gap-1 rounded-xl border border-hairline bg-surface-1 py-1.5 pl-4 pr-1.5 shadow-[var(--shadow-composer)] transition-colors duration-[var(--dur-fast)] focus-within:border-control motion-reduce:transition-none";

export const CARD_INPUT =
  "h-11 min-w-0 flex-1 rounded-none border-0 bg-transparent px-0 text-ui shadow-none placeholder:text-muted-foreground focus-visible:border-0 dark:bg-transparent";

// A workspace-page list row: the session row's airy, divider-free rounded press
// fill. The group's hairlines sit on the row body, so they go transparent (`!`).
export const LIST_ROW =
  "pressable mx-1 w-[calc(100%-0.5rem)] rounded-xl pl-3 transition-colors duration-[var(--dur-fast)] [&>[data-slot=row-body]]:border-transparent! [&>[data-slot=row-body]]:pr-3";
