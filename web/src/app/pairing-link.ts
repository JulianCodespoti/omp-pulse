/**
 * What a scanned QR code or a pasted value means for pairing.
 *
 * `omp-pulse pair` prints, and Settings › Pair another device shows, a link
 * of the form `<origin>/app/#pair=<code>` (src/cli.rs `pairing_url`). People
 * also paste the bare code. Both yield the code; anything else is not a
 * pairing code and yields null.
 */
export function pairingCodeFrom(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  const hash = value.indexOf("#");
  if (hash >= 0 || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    const code = new URLSearchParams(hash >= 0 ? value.slice(hash + 1) : "").get("pair")?.trim();
    return code ? code : null;
  }
  // A bare code is one token; a sentence or a URL without `pair=` is not.
  return /^[A-Za-z0-9_-]{4,128}$/.test(value) ? value : null;
}

/** The pairing link another device opens or scans to redeem `code`. */
export function pairingLink(code: string): string {
  const link = new URL("./", window.location.href);
  link.hash = new URLSearchParams({ pair: code }).toString();
  return link.toString();
}

/** A link that names a computer AND carries a code: `https://host/app/#pair=CODE`. */
export function isPairingLink(text: string): boolean {
  return /^https?:\/\//i.test(text) && pairingCodeFrom(text) !== null;
}

/**
 * A name the computer's device list can tell apart: the Android model from
 * the user agent ("Pixel 9"), or "Phone"/"Browser". Chrome's reduced user
 * agent reports the model as "K", which names nothing.
 */
export function defaultDeviceName(userAgent: string): string {
  const model = userAgent.match(/Android [\d.]+; (?:[a-z]{2}[-_][a-z]{2}; )?([^;)]+?)(?: Build\/|;|\))/i)?.[1]?.trim();
  if (model && model !== "K") return model;
  if (/iPhone/.test(userAgent)) return "iPhone";
  if (/iPad/.test(userAgent)) return "iPad";
  return /Android|Mobi/i.test(userAgent) ? "Phone" : "Browser";
}
