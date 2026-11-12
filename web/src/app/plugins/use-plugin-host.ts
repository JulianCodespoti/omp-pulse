import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import { boundContext, type KeyedSlotId, type PluginRenderContext, type UnkeyedSlotId } from "../../domain/plugins";
import { pluginHost, type PluginHostState, type PluginSlotView } from "../../runtime/plugin-host";

// One shared identity for "no views", so a surface without a key never sees a change.
const NO_VIEWS = Object.freeze([]) as unknown as PluginSlotView[];

export function usePluginHost(): PluginHostState {
  return useSyncExternalStore(pluginHost.subscribe, pluginHost.getState, pluginHost.getState);
}

/**
 * Views for one slot. While `active`, the slot is retained so its plugins run
 * and poll; the slot's current views are returned either way, because the host
 * keeps a released plugin's views through a short grace period.
 */
export function usePluginSlot(
  slot: UnkeyedSlotId,
  active = true,
  pluginId?: string,
): { views: PluginSlotView[]; onAction(pluginId: string, action: string, item?: string): void } {
  const state = usePluginHost();
  useEffect(() => (active ? pluginHost.retainSlot(slot, pluginId) : undefined), [slot, active, pluginId]);
  const onAction = useCallback(
    (id: string, action: string, item?: string) => pluginHost.dispatchAction(id, slot, action, item),
    [slot],
  );
  return { views: state.views[slot], onAction };
}

/**
 * Views for one key of a keyed slot (a row, an open menu, a card). The key is
 * retained while both `key` and `context` are non-null; a context whose bounded
 * JSON changed is handed over again, an equal one on a later render is not.
 *
 * Subscribes to this key's views only (the host keeps their array identity
 * while unchanged), so a surface with a null key, or a row whose views did not
 * change, does not re-render on every host publish.
 */
export function usePluginKey(
  slot: KeyedSlotId,
  key: string | null,
  context: PluginRenderContext | null,
): { views: PluginSlotView[]; onAction(pluginId: string, action: string, item?: string): void } {
  // Bound before serialising: a tool call's args and output are unbounded.
  const bounded = useMemo(() => (context === null ? null : boundContext(context)), [context]);
  const boundedJson = bounded === null ? null : JSON.stringify(bounded);
  // The effect reads the newest context through the ref so that only a change
  // of its JSON (not of its identity) re-retains.
  const latest = useRef(bounded);
  latest.current = bounded;
  const held = useRef<(() => void) | null>(null);
  useEffect(() => {
    const current = latest.current;
    const previous = held.current;
    if (key === null || boundedJson === null || current === null) {
      held.current = null;
      previous?.();
      return;
    }
    // Retain the new context BEFORE releasing the old handle: a release that
    // reaches zero makes the host drop the key's views, which would flicker a
    // card back to its stock row on every change.
    held.current = pluginHost.retainKey(slot, key, current);
    previous?.();
  }, [slot, key, boundedJson]);
  useEffect(
    () => () => {
      const previous = held.current;
      held.current = null;
      previous?.();
    },
    [],
  );
  const onAction = useCallback(
    (id: string, action: string, item?: string) => {
      if (key !== null) pluginHost.dispatchAction(id, slot, action, item, key);
    },
    [slot, key],
  );
  const getViews = useCallback(
    () => (key === null ? NO_VIEWS : (pluginHost.getState().keyed[slot][key] ?? NO_VIEWS)),
    [slot, key],
  );
  const views = useSyncExternalStore(pluginHost.subscribe, getViews, getViews);
  return { views, onAction };
}
