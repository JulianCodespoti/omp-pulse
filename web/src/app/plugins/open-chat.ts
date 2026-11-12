// The chat screen registers the composer's own send path for the conversation
// it shows, so a plugin's prompt takes the identical route as pressing Send
// (slash commands, receipts and outbox included). One entry per conversation.

type Sender = (text: string) => Promise<void>;

const senders = new Map<string, Sender>();

/** Register `send` for `sessionId`. The returned function removes only this registration. */
export function setOpenChatSender(sessionId: string, send: Sender): () => void {
  senders.set(sessionId, send);
  return () => {
    if (senders.get(sessionId) === send) senders.delete(sessionId);
  };
}

/** The send path of an open conversation, or null when it is not open. */
export function openChatSender(sessionId: string): Sender | null {
  return senders.get(sessionId) ?? null;
}
