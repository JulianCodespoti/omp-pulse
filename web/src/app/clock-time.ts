/** Clock form of a time: "14:32" today, "Tue" this week, else "4 Nov". */
export function clockTime(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }
  if (now - at < 6 * 86_400_000 && at < now) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** A message's full time, as a messenger shows it on tap: "2:03 PM", "Yesterday 2:03 PM", "Tue 4 Nov, 2:03 PM". */
export function messageTime(at: number, now = Date.now()): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return time;
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
  const sameYear = date.getFullYear() === today.getFullYear();
  const day = date.toLocaleDateString(undefined, sameYear ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
  return `${day}, ${time}`;
}
