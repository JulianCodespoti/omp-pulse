import type { UiMessage } from "./messages";

/** Immutable local intent only: this is neither a receipt nor canonical identity. */
interface LocalIntent {
  commandId: string;
  intentToken?: string;
  sessionPath: string;
  createdAt: number;
  text: string;
  imageCount: number;
  imageBytes: number;
  droppedImages: boolean;
}

// Like other live presentation provenance, spreads preserve this symbol while
// JSON/structured clone cannot. Cache boundaries strip it explicitly as well.
const localSendOwner = Symbol("current local send owner");
type OwnedMessage = UiMessage & {
  [localSendOwner]?: { intent: LocalIntent; scope: string; controller: object; isCurrent: () => boolean };
};

export function withLocalSendOwner(
  message: UiMessage, intent: LocalIntent, scope: string, controller: object, isCurrent: () => boolean,
): UiMessage {
  if (!scope || !isCurrent() || message.role !== "user" || message.sourceEntryId ||
    message.id !== `local:${intent.commandId}` || message.text !== intent.text) return message;
  const { commandId, intentToken, sessionPath, createdAt, text, imageCount, imageBytes, droppedImages } = intent;
  return { ...message, [localSendOwner]: {
    intent: { commandId, intentToken, sessionPath, createdAt, text, imageCount, imageBytes, droppedImages },
    scope, controller, isCurrent,
  } } as OwnedMessage;
}

export function ownsLocalSend(
  message: UiMessage, intent: LocalIntent, scope: string, controller: object,
): boolean {
  const proof = (message as OwnedMessage)[localSendOwner];
  if (!scope || !proof || proof.scope !== scope || proof.controller !== controller || !proof.isCurrent() ||
    message.role !== "user" || message.sourceEntryId || message.id !== `local:${intent.commandId}` ||
    message.text !== intent.text) return false;
  const owned = proof.intent;
  // Absent tokens stay absent. Legacy intents saved without a token keep the
  // weaker same-field match; presentation must never invent a stronger ID.
  return owned.commandId === intent.commandId && owned.intentToken === intent.intentToken &&
    owned.sessionPath === intent.sessionPath && owned.createdAt === intent.createdAt &&
    owned.text === intent.text && owned.imageCount === intent.imageCount &&
    owned.imageBytes === intent.imageBytes && owned.droppedImages === intent.droppedImages;
}

/** Recheck a captured inline action after a lifecycle or queue change. */
export function isCurrentLocalSend(message: UiMessage, intent: LocalIntent): boolean {
  const proof = (message as OwnedMessage)[localSendOwner];
  return !!proof && ownsLocalSend(message, intent, proof.scope, proof.controller);
}

export function withoutLocalSendOwner(message: UiMessage): UiMessage {
  const { [localSendOwner]: _owner, ...rest } = message as OwnedMessage;
  return rest;
}
