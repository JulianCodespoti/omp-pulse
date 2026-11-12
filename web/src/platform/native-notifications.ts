import { readPairingToken } from "./browser-storage";
import { usesNativeOutbox } from "../runtime/native-outbox";

type NativeNotifyPlugin = {
  setToken?: (options: { token: string }) => Promise<{ ok?: boolean }>;
  clearNotifications?: (options: { sessionPath: string }) => Promise<{ ok?: boolean }>;
  setForegroundConversation?: (options: { sessionPath: string | null }) => Promise<{ ok?: boolean }>;
  clearToken?: () => Promise<{ ok?: boolean }>;
  getNotificationPrefs?: () => Promise<NativeNotificationPrefs>;
  setNotificationPrefs?: (changes: Partial<NativeNotificationPrefs>) => Promise<NativeNotificationPrefs>;
  getNotificationStatus?: () => Promise<NativeNotificationStatus>;
  getChatNotifications?: (options: { sessionPath: string }) => Promise<NativeChatNotifications>;
  setChatNotifications?: (
    options: { sessionPath: string } & Partial<NativeChatNotifications>,
  ) => Promise<NativeChatNotifications>;
  requestPermission?: () => Promise<{ granted?: boolean }>;
  openNotificationSettings?: () => Promise<{ ok?: boolean }>;
  openBubbleSettings?: () => Promise<{ ok?: boolean }>;
  openBatterySettings?: () => Promise<{ ok?: boolean }>;
};

type CapacitorWindow = Window & {
  Capacitor?: {
    Plugins?: {
      OmpNotify?: NativeNotifyPlugin;
    };
  };
};
// Serialise replacement and revocation: an in-flight old clear must finish
// before a fresh credential is handed to native storage.
let credentialMutation: Promise<void> = Promise.resolve();

function nativeNotify(): NativeNotifyPlugin | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as CapacitorWindow).Capacitor?.Plugins?.OmpNotify;
}

/** True inside the Android shell, whose bridge owns the notification switches. */
export function hasNativeNotificationControls(): boolean {
  return typeof nativeNotify()?.getNotificationPrefs === "function";
}

/**
 * Whether this build runs inside the native shell, which owns durable delivery
 * and its own copy of the credential. The shell marker and the outbox bridge
 * are the one native/browser oracle in the app; nothing here re-derives it.
 */
export function requiresNativeNotificationSync(): boolean {
  return usesNativeOutbox();
}

/** Clear delivered notifications only for the conversation currently opened by the user. */
export async function clearNativeNotifications(sessionPath: string): Promise<void> {
  if (!sessionPath) return;
  const plugin = nativeNotify();
  if (typeof plugin?.clearNotifications === "function") {
    await plugin.clearNotifications({ sessionPath });
  }
}

/**
 * Hand the credential to the native listener, which keeps it while the WebView
 * is gone. Resolves only once the native side has persisted it and asked for
 * the service; a missing bridge or a rejection is a visible failure so callers
 * can hold back the paired UI instead of claiming readiness. Browser builds
 * have no native side to acknowledge and resolve immediately.
 */
export async function syncNativeNotificationToken(token: string): Promise<void> {
  if (!token) {
    throw new Error("No device credential to hand to the native app.");
  }
  if (!requiresNativeNotificationSync()) return;
  const plugin = nativeNotify();
  if (typeof plugin?.setToken !== "function") {
    throw new Error("This app version cannot reach its notification service.");
  }
  const operation = credentialMutation.then(async () => {
    if (readPairingToken() !== token) throw new Error("Pairing changed before the phone acknowledged it.");
    const result = await plugin.setToken!({ token });
    if (result?.ok === false) throw new Error("The app did not accept this device credential.");
  });
  credentialMutation = operation.catch(() => undefined);
  await operation;
}

/** Clear only on an explicit unpair or rejected credential, never on startup. */
export async function clearNativeNotificationToken(expectedCredential?: string): Promise<void> {
  const plugin = nativeNotify();
  const operation = credentialMutation.then(async () => {
    const current = readPairingToken();
    if (expectedCredential !== undefined && current && current !== expectedCredential) return;
    if (typeof plugin?.clearToken === "function") await plugin.clearToken();
  });
  credentialMutation = operation.catch(() => undefined);
  await operation;
}

/** Every global notification switch the Android shell stores; minutes are minutes since midnight. */
export type NativeNotificationPrefs = {
  enabled: boolean;
  agentEnd: boolean;
  needsInput: boolean;
  alerts: boolean;
  quietEnabled: boolean;
  quietStart: number;
  quietEnd: number;
  background: boolean;
};

export type NativeNotificationStatus = {
  /** `ask`: the system prompt can still be shown; `blocked`: only Android settings can allow it. */
  permission: "granted" | "ask" | "blocked";
  bubbles: "on" | "off" | "unsupported";
  paired: boolean;
  listener: "off" | "stopped" | "connecting" | "connected";
  /** Absent when the OS cannot say. */
  batteryUnrestricted?: boolean;
  lastError?: string;
};

/** One chat's effective switches; a chat with no override shows the global value. */
export type NativeChatNotifications = Pick<NativeNotificationPrefs, "enabled" | "agentEnd" | "needsInput" | "alerts">;

// A missing method (an older app build) must surface as a rejection the
// caller can catch, so every wrapper below is async.
function method<K extends keyof NativeNotifyPlugin>(name: K): NonNullable<NativeNotifyPlugin[K]> {
  const fn = nativeNotify()?.[name];
  if (typeof fn !== "function") throw new Error("This app version cannot manage notifications.");
  return fn as NonNullable<NativeNotifyPlugin[K]>;
}

export async function readNativeNotificationPrefs(): Promise<NativeNotificationPrefs> {
  return method("getNotificationPrefs")();
}

/**
 * Tell the shell which conversation the user is looking at, so it can take that
 * conversation's shade entry away by itself (a finished-turn notification used
 * to linger until the next focus event). Best effort: an older shell, a plain
 * browser or a bridge failure must never break the screen that reports it.
 */
export async function setForegroundConversation(path: string | null): Promise<void> {
  try {
    await method("setForegroundConversation")({ sessionPath: path });
  } catch {
    // Not the native shell, or an older build without the method.
  }
}

export async function writeNativeNotificationPrefs(
  changes: Partial<NativeNotificationPrefs>,
): Promise<NativeNotificationPrefs> {
  return method("setNotificationPrefs")(changes);
}

export async function readNativeNotificationStatus(): Promise<NativeNotificationStatus> {
  return method("getNotificationStatus")();
}

export async function readNativeChatNotifications(sessionPath: string): Promise<NativeChatNotifications> {
  return method("getChatNotifications")({ sessionPath });
}

export async function writeNativeChatNotifications(
  sessionPath: string,
  changes: Partial<NativeChatNotifications>,
): Promise<NativeChatNotifications> {
  return method("setChatNotifications")({ sessionPath, ...changes });
}

/** Shows the system prompt; resolves with whether it was granted. */
export async function requestNativeNotificationPermission(): Promise<boolean> {
  return (await method("requestPermission")()).granted === true;
}

/** The OS screens the page links out to. */
export async function openNativeSettings(screen: "notifications" | "bubbles" | "battery"): Promise<void> {
  const open = method(
    screen === "notifications" ? "openNotificationSettings" : screen === "bubbles" ? "openBubbleSettings" : "openBatterySettings",
  );
  if ((await open())?.ok === false) throw new Error("Could not open Android settings.");
}
