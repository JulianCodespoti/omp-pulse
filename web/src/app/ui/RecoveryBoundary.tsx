import { Component, Suspense, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { prepareForReload } from "../../runtime/prepare-for-reload";
import { LazyModuleError } from "./retryable-lazy";

export class RecoveryBoundary extends Component<{
  children: ReactNode;
  fallback: (retry: () => void, error: unknown) => ReactNode;
}, { failed: boolean; error: unknown }> {
  state: { failed: boolean; error: unknown } = { failed: false, error: null };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, error };
  }

  private retry = () => this.setState({ failed: false, error: null });

  render() {
    return this.state.failed ? this.props.fallback(this.retry, this.state.error) : this.props.children;
  }
}

export function RecoveryMessage({ onRetry, error, visible = true }: { onRetry: () => void; error: unknown; visible?: boolean }) {
  const reloadRequired = error instanceof LazyModuleError;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const active = useRef(true);
  const busy = useRef(false);
  useLayoutEffect(() => {
    active.current = visible;
    return () => { active.current = false; };
  }, [visible]);
  const recover = async () => {
    if (!reloadRequired) { onRetry(); return; }
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setSaveError(false);
    try {
      await prepareForReload();
      // Back can dismiss this surface while photo persistence is pending.
      if (active.current) window.location.reload();
    } catch {
      if (active.current) setSaveError(true);
    } finally {
      busy.current = false;
      if (active.current) setSaving(false);
    }
  };
  return (
    <div role="alert" className="flex flex-col items-start gap-4 p-4">
      <p className="text-sm text-muted-foreground">{reloadRequired
        ? "Couldn’t load this view. Check your connection, then reload the app. Your drafts will be saved first."
        : "Couldn’t open this view. Try again or go back."}</p>
      {saveError ? <p className="text-sm text-destructive">Couldn’t save your drafts. The app was not reloaded. Keep this window open and try again.</p> : null}
      <Button disabled={saving} onClick={() => { void recover(); }}>{saving ? "Saving drafts…" : reloadRequired ? "Reload app" : "Retry"}</Button>
    </div>
  );
}

function ScreenFallback({ title, onBack, onRetry, error }: {
  title: string;
  onBack?: () => void;
  onRetry?: () => void;
  error?: unknown;
}) {
  return (
    <main className="flex h-dvh flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-hairline px-2 pt-[env(safe-area-inset-top)] box-content">
        {onBack ? <Button aria-label="Back" size="icon" variant="ghost" onClick={onBack}><ChevronLeftIcon className="size-6" /></Button> : null}
        <h1 className="text-base font-medium">{title}</h1>
      </header>
      {onRetry ? <RecoveryMessage onRetry={onRetry} error={error} /> : <p role="status" aria-busy="true" className="p-4 text-sm text-muted-foreground">Loading…</p>}
    </main>
  );
}

/** Only the failed surface unmounts; sibling screens keep their drafts and navigation. */
export function ScreenBoundary({ title, onBack, loading, children }: {
  title: string;
  onBack?: () => void;
  loading?: ReactNode;
  children: ReactNode;
}) {
  return (
    <RecoveryBoundary fallback={(retry, error) => <ScreenFallback title={title} onBack={onBack} onRetry={retry} error={error} />}>
      <Suspense fallback={loading === undefined ? <ScreenFallback title={title} onBack={onBack} /> : loading}>
        {children}
      </Suspense>
    </RecoveryBoundary>
  );
}
