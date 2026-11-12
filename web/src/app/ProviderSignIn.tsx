import { useEffect, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { CheckIcon, KeyRoundIcon, PlusIcon, SearchIcon } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { parseProviders, type OmpLocalBridge } from "../platform/local-mode";
import type { DaemonApi, ProviderLoginState } from "../runtime/rpc-client";
import { startVisibleInterval } from "../runtime/visible-interval";
import { CopyButton } from "./parts/CopyButton";
import { providerLabel } from "./sessions/ModelPicker";
import { EmptyState } from "./ui/EmptyState";
import { Notice } from "./ui/Notice";
import { humanizeDaemonError } from "./ui/OwnedBySession";
import { ProviderLogo } from "./ui/ProviderLogo";
import { Row, RowGroup, RowSkeleton } from "./ui/Row";
import { BottomSheet, SheetSearch } from "./ui/Sheet";

/** How often a running sign-in is asked for its output. */
export const SIGN_IN_POLL_MS = 700;

export interface SignInProvider {
  id: string;
  label: string;
  signedIn: boolean;
}

export type SignInState = ProviderLoginState;

/**
 * Where `omp login` runs. On the phone it is the Android shell's `OmpLocal`
 * bridge; on a computer it is the daemon's Admin-only HTTP routes. The flow
 * below is the same for both, so it only ever talks to this.
 */
export interface SignInTransport {
  list(): Promise<{ providers: SignInProvider[]; error: string | null }>;
  start(id: string): Promise<void>;
  state(): Promise<SignInState>;
  /** A pasted code, redirect URL or API key. */
  send(text: string): Promise<void>;
  cancel(): Promise<void>;
}

function parseLoginState(raw: string): SignInState {
  let next: Partial<SignInState>;
  try {
    next = JSON.parse(raw) as Partial<SignInState>;
  } catch {
    next = {};
  }
  return {
    running: next.running === true,
    exitCode: typeof next.exitCode === "number" ? next.exitCode : null,
    output: typeof next.output === "string" ? next.output : "",
  };
}

/** Credentials stay on this phone: the web layer only relays the choice and pasted text. */
export function bridgeSignInTransport(bridge: OmpLocalBridge): SignInTransport {
  return {
    // providers() spawns omp on the bridge thread; let the surface paint first.
    list: () =>
      new Promise((resolve) =>
        window.setTimeout(() => {
          const listed = parseProviders(bridge.providers());
          resolve({
            providers: listed.providers.map((p) => ({ id: p.id, label: p.label, signedIn: p.signedIn === true })),
            error: listed.error ?? (listed.providers.length === 0 ? "omp didn’t list any providers." : null),
          });
        }, 150),
      ),
    start: async (id) => bridge.loginStart(id),
    state: async () => parseLoginState(bridge.loginState()),
    send: async (text) => bridge.loginInput(text),
    cancel: async () => bridge.loginCancel(),
  };
}

type SignInApi = Pick<
  DaemonApi,
  "listProviders" | "startProviderLogin" | "providerLoginState" | "sendProviderLoginInput" | "cancelProviderLogin"
>;

/** A computer's omp, reached through its daemon (the device must be an administrator). */
export function daemonSignInTransport(api: SignInApi): SignInTransport {
  return {
    list: async () => {
      try {
        return { providers: await api.listProviders(), error: null };
      } catch (cause) {
        return { providers: [], error: humanizeDaemonError(cause) };
      }
    },
    start: (id) => api.startProviderLogin(id),
    state: () => api.providerLoginState(),
    send: (text) => api.sendProviderLoginInput(text),
    cancel: () => api.cancelProviderLogin(),
  };
}

// The providers most people already pay for, in plain names. Ids are omp's
// `auth-broker list` ids; one missing from this omp build is simply not shown.
const FEATURED: readonly { id: string; label: string; detail: string }[] = [
  { id: "anthropic", label: "Claude", detail: "Pro or Max plan" },
  { id: "openai-codex", label: "ChatGPT", detail: "Plus or Pro plan" },
  { id: "github-copilot", label: "GitHub Copilot", detail: "Any Copilot plan" },
  { id: "google-gemini-cli", label: "Gemini", detail: "Google account" },
  { id: "openrouter", label: "OpenRouter", detail: "API key" },
];

/**
 * The page a sign-in needs from the user, read out of omp's output: the link
 * to open and, for device-code providers (Copilot), the code to type there.
 */
export function parseSignInPrompt(output: string): { url: string | null; code: string | null } {
  let url: string | null = null;
  const text = output.replace(/https?:\/\/[^\s<>"')\]]+/gi, (match) => {
    // Sentence punctuation after a link belongs to the sentence.
    const clean = match.replace(/[.,;:!?]+$/, "");
    try {
      const parsed = new URL(clean);
      if (url === null && !parsed.username && !parsed.password) url = parsed.href;
    } catch {
      /* not a link */
    }
    return " ";
  });
  const code = /\b([A-Z0-9]{4,}-[A-Z0-9]{4,})\b/.exec(text)?.[1] ?? null;
  return { url, code };
}

interface Login {
  id: string;
  state: SignInState;
}

/**
 * The sign-in outlives the surface showing it. The login keeps running
 * natively after Settings closes, but state held in a component made reopening
 * show "Add a provider" while the first login still ran, and a second tap
 * started a second login. Module scope lasts as long as the page. `reported`
 * keeps a remount from announcing the same success twice.
 */
let sharedLogin: Login | null = null;
const loginListeners = new Set<() => void>();
const reported = new WeakSet<Login>();
function setSharedLogin(next: Login | null | ((current: Login | null) => Login | null)): void {
  sharedLogin = typeof next === "function" ? next(sharedLogin) : next;
  for (const listener of loginListeners) listener();
}
function subscribeLogin(listener: () => void): () => void {
  loginListeners.add(listener);
  return () => loginListeners.delete(listener);
}
function getSharedLogin(): Login | null {
  return sharedLogin;
}

const NO_IDS: readonly string[] = [];

/**
 * Signs in to a model provider through omp's own login flow: signed-in
 * providers first, "Add a provider" for the rest, and while a login runs its
 * link, device code and a paste field, all in the page. Shared by Settings
 * (phone and computer) and first-run onboarding.
 */
export function ProviderSignIn({
  transport,
  active,
  canManage = true,
  catalogueProviders = NO_IDS,
  title,
  onSignedIn,
  onStatus,
  onChooseModel,
}: {
  /** Must be referentially stable: a new one lists providers again. */
  transport: SignInTransport;
  /** Listing and polling run only while the surface is visible. */
  active: boolean;
  /** False on a device that may not change the computer's accounts: read-only. */
  canManage?: boolean;
  /**
   * Providers that already serve models. The credential store can be one the
   * list cannot read, so a provider with models counts as signed in.
   */
  catalogueProviders?: readonly string[];
  title?: string;
  /** A sign-in just finished. Must be stable: a new identity re-reports it. */
  onSignedIn?: (id: string) => void;
  /** Whether any provider is signed in, as soon as that is known. Must be stable. */
  onStatus?: (signedIn: boolean) => void;
  /** Offers "Choose a model" in the success notice. */
  onChooseModel?: () => void;
}): JSX.Element {
  const [listed, setListed] = useState<{ providers: SignInProvider[]; error: string | null } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const login = useSyncExternalStore(subscribeLogin, getSharedLogin, getSharedLogin);
  const [adding, setAdding] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void transport.list().then((result) => {
      if (!cancelled) setListed(result);
    });
    return () => {
      cancelled = true;
    };
  }, [transport, active, attempt]);

  // A reloaded page forgets the module state while the login runs on; adopt it
  // once so the page still shows that login instead of "Add a provider".
  useEffect(() => {
    if (!active || getSharedLogin()) return;
    let cancelled = false;
    void transport.state().then(
      (state) => {
        if (!cancelled && state.running && !getSharedLogin()) setSharedLogin({ id: state.provider ?? "", state });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [transport, active]);

  // Only a finished login is stale once the page is left; a running one is
  // exactly what the next visit must find again.
  useEffect(
    () => () => {
      if (sharedLogin && !sharedLogin.state.running) setSharedLogin(null);
    },
    [],
  );

  const running = login?.state.running === true;
  useEffect(() => {
    if (!active || !running) return;
    let last: string | null = null;
    let inFlight = false;
    return startVisibleInterval(
      () => {
        if (inFlight) return;
        inFlight = true;
        transport
          .state()
          .then(
            (state) => {
              const key = JSON.stringify(state);
              if (key === last) return;
              last = key;
              setSharedLogin((current) => (current ? { ...current, state } : current));
            },
            () => undefined, // a missed poll is simply asked again on the next tick
          )
          .finally(() => {
            inFlight = false;
          });
      },
      SIGN_IN_POLL_MS,
      { tickOnShow: true },
    );
  }, [transport, active, running]);

  // Finished with no exit code: the sign-in was cancelled from elsewhere.
  const vanished = login !== null && !login.state.running && login.state.exitCode === null;
  useEffect(() => {
    if (vanished) setSharedLogin(null);
  }, [vanished]);

  const succeeded = login && !login.state.running && login.state.exitCode === 0 ? login : null;
  useEffect(() => {
    if (!succeeded || reported.has(succeeded)) return;
    reported.add(succeeded);
    // The credential now exists: list again so the tick comes from the source.
    setAttempt((n) => n + 1);
    onSignedIn?.(succeeded.id);
  }, [succeeded, onSignedIn]);

  const known = listed?.providers ?? [];
  const labelOf = (id: string): string =>
    id === ""
      ? "your provider"
      : (known.find((p) => p.id === id)?.label ?? FEATURED.find((p) => p.id === id)?.label ?? providerLabel(id));
  const signedIds = new Set<string>([
    ...known.filter((p) => p.signedIn).map((p) => p.id),
    ...catalogueProviders,
    ...(succeeded?.id ? [succeeded.id] : []),
  ]);
  const signed = [...signedIds].map((id) => ({ id, label: labelOf(id) })).sort((a, b) => a.label.localeCompare(b.label));
  const anySigned = signed.length > 0;
  useEffect(() => {
    if (listed) onStatus?.(anySigned);
  }, [listed, anySigned, onStatus]);

  const begin = async (id: string) => {
    setError(null);
    setInput("");
    setStarting(id);
    try {
      await transport.start(id);
      setSharedLogin({ id, state: { running: true, exitCode: null, output: "" } });
    } catch (cause) {
      setError(humanizeDaemonError(cause));
    } finally {
      setStarting(null);
    }
  };

  const cancel = async () => {
    setSharedLogin(null);
    try {
      await transport.cancel();
    } catch (cause) {
      setError(humanizeDaemonError(cause));
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    try {
      await transport.send(text);
    } catch (cause) {
      setError(humanizeDaemonError(cause));
      setInput(text);
    }
  };

  if (login && login.state.running) {
    const output = login.state.output.trim();
    const { url, code } = parseSignInPrompt(output);
    const label = labelOf(login.id);
    return (
      <div className="flex min-w-0 flex-col gap-6" data-testid="provider-sign-in">
        <RowGroup inset title={title} footer="Finish in your browser, then paste the code here if it asks.">
          <Row
            leading={login.id ? <ProviderLogo provider={login.id} className="size-5" /> : <KeyRoundIcon aria-hidden />}
            title={label}
            subtitle="Signing in…"
            trailing={
              <Button variant="secondary" className="pressable h-11 rounded-lg px-4" onClick={() => void cancel()} data-testid="provider-cancel">
                Cancel
              </Button>
            }
          />
        </RowGroup>
        {error ? <Notice tone="danger" onDismiss={() => setError(null)}>{error}</Notice> : null}
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn(buttonVariants({ variant: "primary" }), "pressable h-12 w-full rounded-lg")}
            data-testid="provider-auth-link"
          >
            Open sign-in page
          </a>
        ) : null}
        {code ? (
          <div className="flex min-w-0 flex-col items-center gap-1 rounded-lg bg-surface-1 px-4 py-4" data-testid="provider-device-code">
            <p className="text-meta text-muted-foreground">Type this code on the sign-in page</p>
            <p className="select-all break-all font-mono text-large-title font-semibold tracking-widest">{code}</p>
            <CopyButton text={code} label="Copy code" showLabel />
          </div>
        ) : null}
        <form
          className="flex min-w-0 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label htmlFor="provider-paste" className="text-meta font-medium text-muted-foreground">
            Paste a code, link or key
          </label>
          <div className="flex gap-2">
            <Input
              id="provider-paste"
              aria-label="Code, redirect link or API key"
              placeholder="Paste here"
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="h-12 min-w-0 flex-1 rounded-lg border border-border bg-card px-4 text-body md:text-body"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
            <Button type="submit" variant="primary" className="pressable h-12 shrink-0 rounded-lg px-5" disabled={!input.trim()}>
              Send
            </Button>
          </div>
        </form>
        {output ? (
          <pre
            className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-code text-muted-foreground [overflow-wrap:anywhere]"
            data-testid="provider-output"
          >
            {output}
          </pre>
        ) : null}
      </div>
    );
  }

  const failed = login && login.state.exitCode !== null && login.state.exitCode !== 0 ? login : null;
  const addRow = (
    <RowGroup inset>
      <Row
        leading={<PlusIcon aria-hidden />}
        title="Add a provider"
        chevron
        disabled={starting !== null || !listed || listed.providers.length === 0}
        onClick={() => setAdding(true)}
        testId="provider-add"
      />
    </RowGroup>
  );

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="provider-sign-in">
      {succeeded ? (
        <Notice
          tone="success"
          action={onChooseModel ? { label: "Choose a model", onClick: onChooseModel } : undefined}
          onDismiss={() => setSharedLogin(null)}
          testId="provider-signed-in"
        >
          Signed in to {labelOf(succeeded.id)}.
        </Notice>
      ) : null}
      {failed ? (
        <div className="flex min-w-0 flex-col gap-2">
          <Notice
            tone="danger"
            action={failed.id ? { label: "Try again", onClick: () => void begin(failed.id) } : undefined}
            onDismiss={() => setSharedLogin(null)}
            testId="provider-failed"
          >
            Couldn’t sign in to {labelOf(failed.id)}.
          </Notice>
          {failed.state.output.trim() ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-code text-muted-foreground [overflow-wrap:anywhere]">
              {failed.state.output.trim()}
            </pre>
          ) : null}
        </div>
      ) : null}
      {error ? <Notice tone="danger" onDismiss={() => setError(null)}>{error}</Notice> : null}
      {listed === null && !anySigned ? (
        <RowGroup inset title={title}>
          <RowSkeleton leading />
          <RowSkeleton leading />
        </RowGroup>
      ) : (
        <>
          {listed?.error ? (
            <Notice tone="danger" action={{ label: "Try again", onClick: () => { setListed(null); setAttempt((n) => n + 1); } }}>
              {listed.error}
            </Notice>
          ) : null}
          {anySigned ? (
            <RowGroup inset title={title ?? "Signed in"}>
              {signed.map((p) => (
                <Row
                  key={p.id}
                  testId="provider-signed-in-row"
                  leading={<ProviderLogo provider={p.id} className="size-5" />}
                  title={p.label}
                  trailing={<CheckIcon aria-label="Signed in" className="size-5 text-foreground" />}
                />
              ))}
            </RowGroup>
          ) : !listed?.error ? (
            <EmptyState
              icon={<KeyRoundIcon />}
              title="No providers yet"
              description={canManage ? "Sign in to a provider to use its models." : "Only an admin device can add providers."}
              action={canManage ? { label: "Add a provider", onClick: () => setAdding(true) } : undefined}
              testId="provider-empty"
            />
          ) : null}
          {canManage ? (
            anySigned ? addRow : null
          ) : anySigned ? (
            <p className="px-1 text-meta text-muted-foreground" data-testid="provider-read-only">
              Only an admin device can add providers.
            </p>
          ) : null}
        </>
      )}
      {canManage ? (
        <AddProviderSheet
          open={adding}
          onOpenChange={setAdding}
          providers={known}
          signedIds={signedIds}
          onPick={(id) => {
            setAdding(false);
            void begin(id);
          }}
        />
      ) : null}
    </div>
  );
}

function AddProviderSheet({
  open,
  onOpenChange,
  providers,
  signedIds,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providers: readonly SignInProvider[];
  signedIds: ReadonlySet<string>;
  onPick: (id: string) => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (open) setQuery("");
  }, [open]);
  const needle = query.trim().toLowerCase();
  const matches = (id: string, label: string) => !needle || label.toLowerCase().includes(needle) || id.toLowerCase().includes(needle);
  const featured = FEATURED.filter((f) => providers.some((p) => p.id === f.id) && matches(f.id, f.label));
  const others = providers
    .filter((p) => !FEATURED.some((f) => f.id === p.id) && matches(p.id, p.label))
    .sort((a, b) => a.label.localeCompare(b.label));
  const row = (id: string, label: string, detail?: string) => (
    <Row
      key={id}
      testId={`provider-${id}`}
      leading={<ProviderLogo provider={id} className="size-5" />}
      title={label}
      subtitle={detail}
      trailing={signedIds.has(id) ? <CheckIcon aria-label="Signed in" className="size-5 text-foreground" /> : undefined}
      onClick={() => onPick(id)}
    />
  );
  return (
    <BottomSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Add a provider"
      testId="provider-add-sheet"
      subHeader={
        <div className="px-4 pb-3">
          <SheetSearch value={query} onChange={setQuery} placeholder="Search providers" testId="provider-search" />
        </div>
      }
    >
      <div className="space-y-4">
        {featured.length > 0 ? <RowGroup title="Popular">{featured.map((f) => row(f.id, f.label, f.detail))}</RowGroup> : null}
        {others.length > 0 ? (
          <RowGroup title={featured.length > 0 ? "More providers" : undefined}>{others.map((p) => row(p.id, p.label))}</RowGroup>
        ) : null}
        {featured.length === 0 && others.length === 0 ? (
          <Notice tone="info" icon={SearchIcon} action={{ label: "Clear search", onClick: () => setQuery("") }}>
            No matching providers.
          </Notice>
        ) : null}
      </div>
    </BottomSheet>
  );
}
