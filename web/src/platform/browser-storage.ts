const TOKEN_KEY = "omp-remote-token";

export function readPairingToken(): string {
  // Pairing links carry single-use codes, never the desktop owner credential.
  // Credentials are stored only after the daemon redeems a code successfully.
  try {
    return localStorage.getItem(TOKEN_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

export function writePairingToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  if (localStorage.getItem(TOKEN_KEY) !== token) {
    throw new Error("This browser could not save the device credential. Enable local storage before pairing.");
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event("app:pairing-stored"));
}

export function clearPairingToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing persisted; the in-memory token is dropped by the caller anyway.
  }
}

/** Reading is pure: React may invoke initializers twice in development. */
export function readPairingCode(): string {
  return new URLSearchParams(window.location.hash.slice(1)).get("pair")?.trim() ?? "";
}

/**
 * `#pair=CODE&connect=1`: the phone app scanned the code itself (Settings ›
 * Run on › Computer), so the code is redeemed without a second tap. A plain
 * pairing link still lands on the filled form.
 */
export function readPairingAutoConnect(): boolean {
  return new URLSearchParams(window.location.hash.slice(1)).get("connect") === "1";
}

/** Remove enrollment secrets without discarding a notification's target. */
export function clearPairingCode(): void {
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.has("pair")) return;
  params.delete("pair");
  params.delete("connect");
  const hash = params.toString();
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + window.location.search + (hash ? `#${hash}` : ""),
  );
}

/** Non-critical browser navigation preferences, never draft content. */
export function readBrowserPreference(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
export function writeBrowserPreference(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* Losing a navigation default does not discard user input. */ }
}
