export type LatestNavigationResult = "arrived" | "cancelled" | "failed";

export async function reachLatest({
  isCurrent,
  needsTailReload,
  reloadTail,
  waitForRender,
  scrollToBottom,
  isAtBottom,
}: {
  isCurrent: () => boolean;
  needsTailReload: () => boolean;
  reloadTail: () => Promise<boolean>;
  waitForRender: () => Promise<boolean>;
  scrollToBottom: () => boolean | Promise<boolean>;
  isAtBottom: () => boolean;
}): Promise<LatestNavigationResult> {
  if (!isCurrent()) return "cancelled";
  try {
    if (needsTailReload()) {
      const restored = await reloadTail();
      if (!isCurrent()) return "cancelled";
      // Another update may have restored the tail while this request waited.
      if (!restored && needsTailReload()) return "failed";
    }
    if (!isCurrent()) return "cancelled";
    if (!(await waitForRender())) return isCurrent() ? "failed" : "cancelled";
    if (!isCurrent()) return "cancelled";
    const arrived = await scrollToBottom();
    if (!isCurrent() || !arrived) return "cancelled";
    return isAtBottom() ? "arrived" : "failed";
  } catch {
    return isCurrent() ? "failed" : "cancelled";
  }
}

/** Wait for the store snapshot to reach React, not an arbitrary fixed delay. */
export async function waitForLatestRender({
  isCurrent, isRendered, nextFrame, now, timeoutMs = 1500,
}: {
  isCurrent: () => boolean;
  isRendered: () => boolean;
  nextFrame: () => Promise<void>;
  now: () => number;
  timeoutMs?: number;
}): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (isCurrent()) {
    if (isRendered()) return true;
    if (now() >= deadline) return false;
    await nextFrame();
  }
  return false;
}
