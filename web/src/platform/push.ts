import { readPairingToken } from "./browser-storage";
import { DaemonApi } from "../runtime/rpc-client";

export type PushPermissionState = "unsupported" | "denied" | "granted" | "default";

export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    window.isSecureContext
  );
}

export function pushStatus(): PushPermissionState {
  if (!isPushSupported()) return "unsupported";
  const perm = Notification.permission;
  if (perm === "denied") return "denied";
  if (perm === "granted") return "granted";
  return "default";
}

function base64UrlToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let idx = 0; idx < raw.length; idx += 1) {
    out[idx] = raw.charCodeAt(idx);
  }
  return out;
}

export async function subscribePush(_sessionPath?: string): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  if (Notification.permission === "denied") return null;

  if (Notification.permission !== "granted") {
    const result = await Notification.requestPermission();
    if (result !== "granted") return null;
  }

  const registration = await navigator.serviceWorker.ready;
  const api = new DaemonApi(readPairingToken());
  const vapidKey = await api.vapidPublicKey();
  if (!vapidKey) return null;

  const applicationServerKey = base64UrlToUint8Array(vapidKey);

  // Reuse existing subscription if already present.
  const existing = await registration.pushManager.getSubscription();
  let subscription: PushSubscription | null = existing;
  if (!subscription) {
    // Uint8Array.buffer is ArrayBufferLike but Push API needs ArrayBuffer — safe to view as ArrayBuffer.
    const keyBuffer = applicationServerKey.buffer as unknown as ArrayBuffer;
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBuffer,
    });
  }

  // Serialise subscription for the daemon — the same shape the daemon's
  // push_subscribe handler expects: { endpoint, keys:{p256dh,auth} }.
  const subJson: unknown = subscription.toJSON();
  let endpointFromJson: string | undefined;
  let keysFromJson: { p256dh?: string; auth?: string } | undefined;
  if (subJson !== null && typeof subJson === "object") {
    if ("endpoint" in subJson && typeof subJson.endpoint === "string") {
      endpointFromJson = subJson.endpoint;
    }
    if ("keys" in subJson && subJson.keys !== null && typeof subJson.keys === "object") {
      const k: unknown = subJson.keys;
      if (
        k !== null &&
        typeof k === "object" &&
        "p256dh" in k &&
        "auth" in k
      ) {
        const p256dhVal: unknown = k.p256dh;
        const authVal: unknown = k.auth;
        keysFromJson = {
          p256dh: typeof p256dhVal === "string" ? p256dhVal : undefined,
          auth: typeof authVal === "string" ? authVal : undefined,
        };
      }
    }
  }
  const payload = {
    endpoint: endpointFromJson ?? subscription.endpoint,
    keys: keysFromJson,
  };

  // The endpoint is device-scoped. Keep accepting the old optional argument
  // so older callers can roll forward without changing their call signature,
  // but never send a session path as a storage selector.
  await api.pushSubscribe(payload);
  return subscription;
}

/**
 * Ask the daemon whether this device has a registered endpoint. Browser
 * permission and `PushManager.getSubscription()` only describe local state;
 * a provider 404/410 can prune the server copy while both still look enabled.
 */
export async function pushSubscriptionStatus(): Promise<boolean | null> {
  if (!isPushSupported()) return null;
  try {
    const token = readPairingToken();
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch("/api/push/status", { headers });
    if (!response.ok) return null;
    const value: unknown = await response.json();
    if (value === null || typeof value !== "object" || !("subscribed" in value)) return null;
    return (value as { subscribed?: unknown }).subscribed === true;
  } catch {
    return null;
  }
}

/**
 * The daemon stores one device-wide subscription list. The optional argument
 * remains accepted for older callers, but it no longer affects the request.
 */
export async function unsubscribePush(_sessionPath?: string): Promise<void> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  // A fresh or development client may have no worker at all. `ready` never
  // settles in that case, which would leave forgetting a pairing stuck.
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = await registration?.pushManager?.getSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  try {
    const api = new DaemonApi(readPairingToken());
    await api.pushUnsubscribe(endpoint);
  } catch {
    // Daemon unreachable — still unsubscribe locally so the toggle reflects reality.
  }
  await subscription.unsubscribe();
}
