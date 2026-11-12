import { createElement, lazy } from "react";
import type { ComponentProps, ComponentType, FunctionComponent } from "react";

export class LazyModuleError extends Error {
  constructor(cause: unknown) {
    super("Could not load this view", { cause });
    this.name = "LazyModuleError";
  }
}

/** Keep successful preloads; failed module downloads need draft-safe document recovery. */
export function retryableLazy<View extends ComponentType<any>>(
  load: () => Promise<{ default: View }>,
): FunctionComponent<ComponentProps<View>> & { preload: () => Promise<{ default: View }> } {
  let pending: Promise<{ default: View }> | undefined;
  const preload = () => {
    if (!pending) {
      pending = load().catch((error: unknown) => {
        pending = undefined;
        // Idle preload failures may be retried before React.lazy first renders.
        // Once mounted, keep its rejection stable so Suspense can deliver it
        // to the error boundary instead of starting another lazy attempt.
        throw new LazyModuleError(error);
      });
    }
    return pending;
  };
  const current = lazy(preload);
  return Object.assign(function RetryableLazy(props: ComponentProps<View>) {
    return createElement(current as ComponentType<ComponentProps<View>>, props);
  }, { preload });
}
