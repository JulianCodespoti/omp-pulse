/**
 * Fires each time the session socket opens: the daemon answers again, maybe
 * as a restarted instance. One-shot reads that failed while it was away
 * (images) retry on it instead of waiting for a tap. After Android killed
 * the app, the cached shell painted before the daemon was up and every image
 * stayed "could not be loaded" after the daemon came back.
 */
const listeners = new Set<() => void>();

export function noteDaemonReachable(): void {
  for (const listener of [...listeners]) listener();
}

export function onDaemonReachable(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
