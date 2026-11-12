// systemd-timers: lists your systemd user timers and lets you run the service a
// timer starts, right now, with one tap.
//
// This file runs inside a sandboxed worker; its only global is `pulse`. The
// two sources print JSON from `systemctl --user`; every field is treated as
// optional, and any problem yields "no data" rather than an exception.

// ---- Reading and parsing ---------------------------------------------------

// A source's JSON array, or null when it failed or did not parse.
async function readJson(id) {
  try {
    const reading = await pulse.source(id);
    if (!reading || !reading.ok || typeof reading.text !== "string") return null;
    const data = JSON.parse(reading.text);
    return Array.isArray(data) ? data : null;
  } catch (_) {
    return null;
  }
}

// Microseconds since the epoch -> milliseconds, or null for 0, null or junk.
const micros = (value) => (typeof value === "number" && value > 0 ? value / 1000 : null);

// Timers joined with the state of the service each one runs, or null.
async function readTimers() {
  const [timers, units] = await Promise.all([readJson("timers"), readJson("units")]);
  if (!timers) return null;
  const states = new Map();
  for (const unit of units || []) {
    if (unit && typeof unit.unit === "string") states.set(unit.unit, unit);
  }
  const result = [];
  for (const timer of timers) {
    if (!timer || typeof timer.unit !== "string") continue;
    const service = typeof timer.activates === "string" ? timer.activates : "";
    const state = states.get(service);
    const active = state && typeof state.active === "string" ? state.active : "";
    const sub = state && typeof state.sub === "string" ? state.sub : "";
    result.push({
      name: timer.unit.replace(/\.timer$/, ""),
      service,
      next: micros(timer.next),
      last: micros(timer.last),
      // "inactive" reads better than the sub-state "dead" for a service between runs.
      state: active || sub || "unknown",
      failed: active === "failed" || sub === "failed",
    });
  }
  return result;
}

// ---- Presentation ----------------------------------------------------------

// "15 min", "2 h 5 min", "3 d 1 h".
function span(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + " h " + (minutes % 60) + " min";
  return Math.floor(hours / 24) + " d " + (hours % 24) + " h";
}

function detail(timer) {
  const now = Date.now();
  const next = timer.next === null ? "no next run" : "next in " + span(timer.next - now);
  const last = timer.last === null ? "never run" : "last " + span(now - timer.last) + " ago";
  return next + " · " + last;
}

// ---- Slots -----------------------------------------------------------------

// The drawer: a count of timers, or how many services have failed.
pulse.slot("drawer", async () => {
  const timers = await readTimers();
  if (!timers) return pulse.ui.chip("timers unavailable", { tone: "muted" });
  const failed = timers.filter((t) => t.failed).length;
  if (failed > 0) return pulse.ui.chip(failed + " failed", { tone: "error", actions: { click: "open" } });
  const shown = timers.filter((t) => pulse.options.show_inactive || t.next !== null).length;
  return pulse.ui.chip(shown + (shown === 1 ? " timer" : " timers"), { tone: "muted", actions: { click: "open" } });
});

// The page: a list of timers. Tapping one runs its service now; the item id is
// the service name, which the "start" action only accepts if it matches the
// pattern in the manifest.
pulse.slot("page", async () => {
  const timers = await readTimers();
  if (!timers) return pulse.ui.empty("Timers unavailable", "systemctl --user could not be run.");
  // A list item id is cut at 64 characters, and a cut name would no longer
  // match the action's pattern, so longer service names are left out.
  const items = timers
    .filter((t) => t.service && t.service.length <= 64 && (pulse.options.show_inactive || t.next !== null))
    .slice(0, 100)
    .map((t) => ({
      id: t.service,
      label: t.name,
      detail: detail(t),
      value: t.state,
      tone: t.failed ? "error" : undefined,
    }));
  if (!items.length) return pulse.ui.empty("No timers", "There are no user timers with a next run.");
  return pulse.ui.col([
    pulse.ui.text("Tap a timer to run its service now.", { tone: "muted" }),
    pulse.ui.list(items, { actions: { click: "run" } }),
  ]);
});

// ---- Actions ---------------------------------------------------------------
pulse.on("action", async (event) => {
  if (event.act === "open") {
    pulse.openPage();
  } else if (event.act === "run" && event.item) {
    // The host runs the manifest's "start" action with this one argument.
    const result = await pulse.host.run("start", event.item);
    pulse.toast(result.ok ? "Started " + event.item : String(result.error || result.text || "Could not start " + event.item).slice(0, 200));
    pulse.refresh();
  }
});
