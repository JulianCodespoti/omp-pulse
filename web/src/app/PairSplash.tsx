import { useEffect, useState, type JSX, type ReactNode } from "react";
import { MonitorSmartphoneIcon, RotateCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

// Lives outside the lazy PairScreen chunk so App can paint it as the Suspense
// fallback: the mark lands where the pair screen's will, so the swap to the
// real screen has no visual jump.
export function PairHeader(): JSX.Element {
  return (
    <div className="grid size-12 place-items-center rounded-xl bg-surface-2 text-foreground" aria-hidden>
      <MonitorSmartphoneIcon className="size-6" />
    </div>
  );
}

/** The column every pre-pairing screen shares, so they swap without a jump. */
export function PairColumn({ children, testId }: { children: ReactNode; testId?: string }): JSX.Element {
  return (
    <main
      data-testid={testId}
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-8 bg-background px-4 pb-[max(2rem,env(safe-area-inset-bottom))] pt-[max(5rem,calc(env(safe-area-inset-top)+4rem))]"
    >
      {children}
    </main>
  );
}

/** The mark alone: a load this short needs no words. */
export function PairSplash(): JSX.Element {
  return (
    <PairColumn>
      <div role="status" aria-label="Loading">
        <PairHeader />
      </div>
    </PairColumn>
  );
}

// Below this a hand-off is a blink, and naming it only flashes text.
const SLOW_HANDOFF_MS = 1200;

/**
 * Paired, but this phone's notification service has not taken the
 * credential yet. Usually instant, so it starts as the bare splash; words
 * appear only when it is slow or has failed.
 */
export function NativeHandoff({
  failed,
  retrying,
  onRetry,
}: {
  failed: boolean;
  retrying: boolean;
  onRetry: () => void;
}): JSX.Element {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), SLOW_HANDOFF_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <PairColumn testId="native-handoff">
      {failed || slow ? (
        <>
          <header className="flex flex-col gap-6 motion-safe:animate-fade-in">
            <PairHeader />
            <div className="flex flex-col gap-2">
              <h1 className="text-large-title font-semibold text-balance">
                {failed ? "Finishing setup" : "Waking this phone"}
              </h1>
              <p className="text-body text-muted-foreground" role={failed ? "alert" : "status"}>
                {failed
                  ? "Couldn\u2019t hand your pairing to this phone\u2019s notifications. Your pairing is saved."
                  : "Getting notifications ready\u2026"}
              </p>
            </div>
          </header>
          {failed ? (
            <Button variant="primary" className="w-full" onClick={onRetry} disabled={retrying}>
              {retrying ? <Spinner data-icon="inline-start" label={null} /> : <RotateCwIcon data-icon="inline-start" />}
              {retrying ? "Trying again\u2026" : "Try again"}
            </Button>
          ) : (
            <Spinner size={20} className="text-muted-foreground" label="Waking this phone" />
          )}
        </>
      ) : (
        <div role="status" aria-label="Loading">
          <PairHeader />
        </div>
      )}
    </PairColumn>
  );
}
