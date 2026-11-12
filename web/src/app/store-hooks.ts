import { useSyncExternalStore } from "react";

import type { OmpStore, OmpStoreApi } from "../runtime/omp-store";

export function useStoreValue<T>(store: OmpStoreApi, selector: (state: OmpStore) => T): T {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}
