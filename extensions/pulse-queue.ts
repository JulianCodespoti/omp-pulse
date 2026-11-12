// OMP 18.10.4 session/queued-messages.ts and agent-core's public replaceQueue.
// Object identity, not chip text or array position, identifies held input.
type Message = Record<string, unknown>;
type QueueName = "steering" | "followUp";
export type QueueOwner = {
  promoteQueuedMessage?: (text: string) => boolean;
  agent?: {
    peekSteeringQueue(): readonly Message[];
    peekFollowUpQueue(): readonly Message[];
    peekLiveSteeredMessages(): readonly Message[];
    replaceQueue(queue: QueueName, messages: readonly Message[]): void;
  };
};
const userMessage = (message: Message): boolean => message.attribution !== "agent" &&
  (message.role === "user" || (message.role === "custom" && message.attribution === "user" && message.display !== false));
const companionTypes: Record<string, true> = { "ultrathink-notice": true, "orchestrate-notice": true, "workflow-notice": true, "jevify-notice": true, "image-attachment-description": true, "video-attachment": true, "image-attachment": true };
function chip(message: Message): string {
  const details = message.details;
  if (message.role === "custom" && details && typeof details === "object" && typeof (details as Message).__queueChipText === "string") {
    return (details as Message).__queueChipText as string;
  }
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  const text = message.content.find(part => part?.type === "text");
  if (message.role === "custom") return typeof text?.text === "string" ? text.text : "";
  if (typeof text?.text === "string" && text.text) return text.text;
  return message.content.some(part => part?.type === "image") ? "[Image]" : "";
}

/** One instance per extension owner. Weak keys cannot retain finished queues. */
export class OwnerQueueAccess {
  private readonly ids = new WeakMap<object, string>();
  private sequence = 0;
  private readonly prefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

  snapshot(owner: QueueOwner) {
    const agent = owner.agent;
    if (!agent || typeof agent.peekSteeringQueue !== "function" || typeof agent.peekFollowUpQueue !== "function" ||
        typeof agent.peekLiveSteeredMessages !== "function" || typeof agent.replaceQueue !== "function") return null;
    const identify = (message: Message) => {
      let id = this.ids.get(message);
      if (!id) { id = `${this.prefix}-${++this.sequence}`; this.ids.set(message, id); }
      return id;
    };
    const live = agent.peekLiveSteeredMessages().filter(userMessage);
    const steering = [...live, ...agent.peekSteeringQueue().filter(userMessage)];
    const followUp = agent.peekFollowUpQueue().filter(userMessage);
    return {
      steering: steering.map(chip), followUp: followUp.map(chip), liveSteered: live.length,
      // Taken rows have no removal authority, even when an owner reuses the
      // same raw object in its still-held queue.
      steeringIds: steering.map((message, index) => index < live.length ? `taken-${index}-${identify(message)}` : identify(message)),
      followUpIds: followUp.map(identify),
    };
  }

  take(owner: QueueOwner, queue: QueueName, itemId: string) {
    const agent = owner.agent;
    if (!this.snapshot(owner) || !agent) throw new Error("Exact queue actions are unavailable in this OMP version.");
    const messages = queue === "steering" ? agent.peekSteeringQueue() : agent.peekFollowUpQueue();
    const index = messages.findIndex(message => userMessage(message) && this.ids.get(message) === itemId);
    if (index < 0) return undefined;
    const selected = messages[index];
    if (messages.some((message, position) => position !== index && message === selected)) return undefined;
    let start = index;
    while (start > 0) {
      const previous = messages[start - 1];
      if (previous.role !== "custom" || previous.attribution !== "user" || previous.display !== false ||
          !Object.hasOwn(companionTypes, String(previous.customType))) break;
      start--;
    }
    const images = Array.isArray(selected.content) ? selected.content.filter(part => part?.type === "image" &&
      typeof part.data === "string" && typeof part.mimeType === "string") : [];
    const restored = { text: chip(selected), ...(images.length ? { images } : {}) };
    // One synchronous native mutation: no text lookup, prompt reprocessing,
    // intermediate queue state or companion from another duplicate is touched.
    agent.replaceQueue(queue, [...messages.slice(0, start), ...messages.slice(index + 1)]);
    return restored;
  }

  promote(owner: QueueOwner, itemId: string): boolean {
    const agent = owner.agent;
    const promote = owner.promoteQueuedMessage;
    if (!this.snapshot(owner) || !agent || typeof promote !== "function") {
      throw new Error("Exact queue promotion is unavailable in this OMP version.");
    }
    const messages = agent.peekFollowUpQueue();
    const index = messages.findIndex(message => userMessage(message) && this.ids.get(message) === itemId);
    if (index < 0) return false;
    if (messages.some((message, position) => position !== index && message === messages[index])) return false;
    const text = chip(messages[index]);
    // Native 18.10.4 promotion owns the drain retry latch and idle scheduling,
    // not just the queue move. Narrow its two-pass raw/chip matcher to this
    // exact occurrence without changing text, order, or intermediate queues.
    const snapshot = messages.slice();
    Object.defineProperty(snapshot, "findIndex", {
      value(predicate: (message: Message, index: number, queue: Message[]) => unknown, thisArg?: unknown) {
        return predicate.call(thisArg, snapshot[index], index, snapshot) ? index : -1;
      },
    });
    Object.freeze(snapshot);
    const descriptor = Object.getOwnPropertyDescriptor(agent, "peekFollowUpQueue");
    let installed = false;
    const restore = () => {
      if (!installed) return;
      if (descriptor) Object.defineProperty(agent, "peekFollowUpQueue", descriptor);
      else Reflect.deleteProperty(agent, "peekFollowUpQueue");
      installed = false;
    };
    Object.defineProperty(agent, "peekFollowUpQueue", {
      configurable: true,
      enumerable: descriptor?.enumerable ?? false,
      value: () => {
        // Restore before native matching/mutation: queue observers and the
        // drain scheduler must see the real queue, never our selector view.
        restore();
        return snapshot;
      },
    });
    installed = true;
    try {
      return promote.call(owner, text);
    } finally {
      restore();
    }
  }
}
