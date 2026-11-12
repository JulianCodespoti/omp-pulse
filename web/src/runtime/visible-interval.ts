/**
 * Run an interval only while the page is visible. Clearing it on hide avoids
 * waking a background WebView just to skip a poll or a clock render.
 *
 * Polls with their own resume listener leave tickOnShow off; clocks and polls
 * without one opt in so restoring the page immediately catches up. Neither
 * option calls fn during setup. The returned disposer permanently stops both
 * the timer and its visibility listener.
 */
export function startVisibleInterval(
  fn: () => void,
  ms: number,
  options: { tickOnShow?: boolean } = {},
): () => void {
  let timer: number | null = null;
  let stopped = false;
  let generation = 0;
  const sync = (shown: boolean) => {
    const visible = !stopped && document.visibilityState !== "hidden";
    if (visible && timer === null) {
      // clearInterval need not retract an already queued task. A previous
      // visible visit must not tick into a newly restored one.
      const current = ++generation;
      timer = window.setInterval(() => {
        if (!stopped && current === generation && document.visibilityState !== "hidden") fn();
      }, ms);
      if (shown && options.tickOnShow) fn();
    } else if (!visible && timer !== null) {
      window.clearInterval(timer);
      timer = null;
      generation++;
    }
  };
  const onVisibility = () => sync(true);
  document.addEventListener("visibilitychange", onVisibility);
  sync(false);
  return () => {
    stopped = true;
    document.removeEventListener("visibilitychange", onVisibility);
    sync(false);
  };
}
