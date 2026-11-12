/**
 * The conversation on screen, registered by App. Deleting it from any surface
 * (drawer menu, list sheet, chat menu) must leave it first and bring it back on
 * Undo; keeping that here means no entry point can forget the guard.
 */
interface OpenConversation {
  path: string;
  leave: () => void;
  reopen: (path: string) => void;
}

let open: OpenConversation | null = null;

export function setOpenConversation(value: OpenConversation | null): void {
  open = value;
}

export function getOpenConversation(): OpenConversation | null {
  return open;
}
