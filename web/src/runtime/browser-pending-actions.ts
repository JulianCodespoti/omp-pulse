import type { UiMessage } from "../domain/messages";
import { isCurrentLocalSend } from "../domain/local-send-provenance";
import { readPairingToken } from "../platform/browser-storage";
import { captureQueueScope, getOfflineQueueNamespace, getSnapshot, offlineQueueNamespaceForCredential,
  editSavedPrompt, removeIntent, retryNativeIntent, sameQueuedIntent, type QueuedPrompt } from "./offline-queue";
import { sendPromptDurably } from "./rpc-client";
import type { CommandReceipt } from "./api-types";
import type { WithdrawnQueue } from "./withdrawn-queue";
import { usesNativeOutbox } from "./native-outbox";

export interface PendingIntentActions {
  /** Resolves true when this exact intent was removed, false when it had moved on. */
  cancel: () => Promise<boolean>;
  retry: () => Promise<CommandReceipt | null>;
  edit: (restore: (withdrawn: WithdrawnQueue, namespace: string, recoveryId: string) => Promise<void>) => Promise<boolean>;
}

/** Captured actions never transfer their authority to another scope or
 * delivery state before they start. `owned` adds the caller's own fence (the
 * transcript row's local incarnation); the composer's queue stack has none. */
function fencedActions(intent: QueuedPrompt, owned: () => boolean): PendingIntentActions {
  const namespace = getOfflineQueueNamespace();
  const scopeCurrent = captureQueueScope(namespace);
  const stillOwned = () => scopeCurrent() && owned() &&
    getSnapshot(namespace).some(current => sameQueuedIntent(current, intent) &&
      current.state === intent.state && current.updatedAt === intent.updatedAt && current.editToken === intent.editToken);
  return {
    async cancel() {
      if (!stillOwned()) return false;
      return removeIntent(intent, namespace, stillOwned);
    },
    async edit(restore) {
      if (!stillOwned() || intent.state !== "saved") return false;
      return editSavedPrompt(intent, namespace, stillOwned, async (entry, images, recoveryId) => {
        await restore({ messages: [{ text: entry.text, images }], imagesDropped: false, truncated: false }, namespace, recoveryId);
      });
    },
    async retry() {
      if (!stillOwned() || intent.editToken) return null;
      const token = readPairingToken() ?? "";
      if (offlineQueueNamespaceForCredential(token) !== namespace) return null;
      if (usesNativeOutbox()) return retryNativeIntent(intent, namespace, stillOwned);
      return sendPromptDurably(intent.sessionPath, intent.text, [], { commandId: intent.id, token });
    },
  };
}

/** Inline actions under a transcript bubble that owns this local send. */
export function localPendingActions(message: UiMessage, intent: QueuedPrompt): PendingIntentActions {
  return fencedActions(intent, () => isCurrentLocalSend(message, intent));
}

/** Actions for a durable send with no transcript bubble (the composer's queue stack). */
export function pendingIntentActions(intent: QueuedPrompt): PendingIntentActions {
  return fencedActions(intent, () => true);
}
