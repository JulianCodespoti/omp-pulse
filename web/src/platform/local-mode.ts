// Bridge to the Android app's `OmpLocal` JavascriptInterface. It exists only
// inside the native shell, and the shell answers only pages it trusts (the
// bundled app, the on-phone daemon, the configured laptop); everything else
// gets "{}"/"[]". Every caller must treat its absence as "laptop mode,
// nothing to do".

/** "unset" has no active runtime: first run, or phone mode explicitly stopped. */
export type LocalMode = "unset" | "phone" | "laptop";
export type LocalPhase = "idle" | "installing" | "starting" | "ready" | "error";
export type LocalAccessKind =
  | "storage"
  | "install"
  | "accessibility"
  | "battery"
  | "notifications";

export interface LocalState {
  /** False when this device cannot run omp locally; the UI then hides the choice. */
  supported: boolean;
  mode: LocalMode;
  phase: LocalPhase;
  /** Whether the on-phone runtime has already been downloaded. */
  installed: boolean;
  message?: string | null;
  /** Percent, or a negative number when the phase has no measurable progress. */
  progress: number;
  error?: string | null;
  /** The on-phone daemon's app URL. */
  appUrl: string | null;
  /** The active computer's app URL, baked into the build or entered by the user. */
  laptopUrl: string | null;
  /** Every saved computer's app URL, most recent first. Absent on older shells. */
  computers?: string[];
  /** Bytes still to download before omp can run here; 0 once installed. */
  downloadBytes: number;
  ompVersion: string;
  /**
   * "Phone tools for the agent": the `android` command, the `phone` MCP
   * server and phone-mode instructions. Off for new installs. Absent on
   * older shells, which always had them.
   */
  phoneTools?: boolean;
}

export type LocalAccess = Partial<Record<LocalAccessKind, boolean>>;

export interface LocalProvider {
  id: string;
  label: string;
  /** A usable credential is stored for it; absent on older shells. */
  signedIn?: boolean;
}

export interface LocalLoginState {
  running: boolean;
  exitCode: number | null;
  output: string;
}

export interface OmpLocalBridge {
  /** JSON-encoded {@link LocalState}. */
  state(): string;
  /** Persists the mode and restarts into its URL ("unset" returns to the run-location chooser). */
  setMode(mode: LocalMode): void;
  /**
   * From a pairing link (`https://host/app/#pair=CODE`): saves the address,
   * switches to computer mode and restarts onto it with the code, which that
   * page redeems at once. JSON `{"ok":true}` or `{"ok":false,"error":"…"}`.
   * The only way a computer is added: a typed address is never accepted.
   */
  connectLaptop(link: string): string;
  /** Switch to a saved computer (restarts onto it). JSON `{"ok":…}`. */
  useComputer(url: string): string;
  /** Forget a saved computer. */
  forgetComputer(url: string): void;
  /**
   * Reachability of every saved computer, for the stopped-phone chooser: JSON
   * `{url: "checking"|"online"|"offline"}` (see {@link parseComputerStatuses}).
   * `true` starts or refreshes a bounded background check and returns what is
   * known so far; `false` cancels it and forgets the answers. Read-only: it
   * sends no credential and never changes the active computer or mode.
   */
  computerStatus(active: boolean): string;
  /** Starts installing/starting the on-phone runtime; progress is reported through `state()`. */
  prepare(): void;
  /** Saves "Phone tools for the agent"; `state().phoneTools` reads it back. Absent on older shells. */
  setPhoneTools?(on: boolean): void;
  /** JSON-encoded {@link LocalAccess}. Absent on older shells. */
  access?(): string;
  grant(kind: LocalAccessKind): void;
  /** Opens this app's Android details page; grants remain user-controlled. */
  openAppSettings?(): void;
  /** Opens connectivity settings without changing the network or VPN. */
  openNetworkSettings?(): void;
  /** JSON-encoded {@link LocalProvider}[], or `{"error":"…"}` when omp listed none (older shells: `[]`). */
  providers(): string;
  loginStart(providerId: string): void;
  loginInput(input: string): void;
  /** JSON-encoded {@link LocalLoginState}. */
  loginState(): string;
  loginCancel(): void;
}

declare global {
  interface Window {
    OmpLocal?: OmpLocalBridge;
  }
}

export function getOmpLocal(): OmpLocalBridge | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = window.OmpLocal;
  return bridge && typeof bridge.state === "function" ? bridge : undefined;
}

/**
 * Null when the shell refused the call: an untrusted origin gets "{}", which
 * has no `mode`, and must not be mistaken for a real state.
 */
/** `bridge.state()` JSON, or null when unreadable. Split out so a poll can skip unchanged JSON. */
export function parseLocalState(raw: string): LocalState | null {
  try {
    const state = JSON.parse(raw) as Partial<LocalState>;
    return typeof state.mode === "string" ? (state as LocalState) : null;
  } catch {
    return null;
  }
}

export function readLocalState(bridge: OmpLocalBridge): LocalState | null {
  return parseLocalState(bridge.state());
}

/** `bridge.access()` JSON, or null when unreadable. */
export function parseLocalAccess(raw: string): LocalAccess | null {
  try {
    return JSON.parse(raw) as LocalAccess;
  } catch {
    return null;
  }
}

export function readLocalAccess(bridge: OmpLocalBridge): LocalAccess | null {
  if (typeof bridge.access !== "function") return null;
  return parseLocalAccess(bridge.access());
}

/** What a read-only reachability check of a saved computer last found. */
export type ComputerStatus = "checking" | "online" | "offline";

const COMPUTER_STATUSES: readonly string[] = ["checking", "online", "offline"];

/** `bridge.computerStatus()` JSON as a url → status map; unknown or malformed entries are dropped. */
export function parseComputerStatuses(raw: string): Record<string, ComputerStatus> {
  const out: Record<string, ComputerStatus> = {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
    for (const [url, status] of Object.entries(parsed)) {
      if (typeof status === "string" && COMPUTER_STATUSES.includes(status)) out[url] = status as ComputerStatus;
    }
  } catch {
    // Unreadable means nothing is known; every row stays "checking".
  }
  return out;
}

/** `bridge.providers()` JSON: the list, or the shell's reason it is empty. */
export function parseProviders(raw: string): { providers: LocalProvider[]; error: string | null } {
  try {
    const parsed = JSON.parse(raw) as LocalProvider[] | { error?: string };
    if (Array.isArray(parsed)) return { providers: parsed, error: null };
    return { providers: [], error: typeof parsed.error === "string" ? parsed.error : null };
  } catch {
    return { providers: [], error: null };
  }
}

/** The shell's `{"ok":…,"error":…}` answer as the refusal wording, else null. */
function refusalOf(raw: string, fallback: string): string | null {
  try {
    const result = JSON.parse(raw) as { ok?: boolean; error?: string };
    return result.ok ? null : result.error || fallback;
  } catch {
    return fallback;
  }
}

/** Connects to the computer a pairing link names, in one step. Returns the refusal wording, else null. */
export function connectLaptop(bridge: OmpLocalBridge, link: string): string | null {
  return refusalOf(bridge.connectLaptop(link), "Couldn\u2019t connect to that computer.");
}

/** Switches to a saved computer. Returns the refusal wording, else null. */
export function switchComputer(bridge: OmpLocalBridge, url: string): string | null {
  return refusalOf(bridge.useComputer(url), "Couldn\u2019t switch to that computer.");
}

/**
 * Leave a computer the phone is not paired with (or cannot reach): back to
 * omp on this phone when it is installed, else to the first-run choice.
 */
export function leaveComputer(bridge: OmpLocalBridge): void {
  const state = readLocalState(bridge);
  bridge.setMode(state?.supported && state.installed ? "phone" : "unset");
}

/** True only when the native shell reports omp running on this phone. */
export function isPhoneMode(): boolean {
  const bridge = getOmpLocal();
  return bridge ? readLocalState(bridge)?.mode === "phone" : false;
}

/** "230 MB" / "1.2 GB": decimal units, as Android's storage screens use. */
export function formatDownloadSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
