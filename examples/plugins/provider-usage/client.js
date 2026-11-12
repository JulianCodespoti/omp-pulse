// provider-usage: shows how much of each model provider's usage limits you have
// used, from `omp usage --json --redact`.
//
// This file runs inside a sandboxed worker; its only global is `pulse`. Every
// field of the report is treated as optional, and any problem yields "no data"
// rather than an exception.

// ---- Reading and parsing ---------------------------------------------------

// The report as an array of { provider, fetchedAt, limits: [...] }, or null.
async function readReports() {
  try {
    const reading = await pulse.source("usage");
    if (!reading || !reading.ok || typeof reading.text !== "string") return null;
    const data = JSON.parse(reading.text);
    if (!data || !Array.isArray(data.reports)) return null;
    const reports = [];
    for (const report of data.reports) {
      if (!report || typeof report.provider !== "string") continue;
      const limits = (Array.isArray(report.limits) ? report.limits : []).map(parseLimit).filter(Boolean);
      reports.push({
        provider: report.provider,
        fetchedAt: typeof report.fetchedAt === "number" ? report.fetchedAt : null,
        limits,
      });
    }
    return reports;
  } catch (_) {
    return null;
  }
}

// One limit as { label, short, used (0..1), resetsAt (ms or null) }, or null.
function parseLimit(limit) {
  if (!limit || typeof limit !== "object") return null;
  const amount = limit.amount || {};
  const window = limit.window || {};
  const scope = limit.scope || {};
  let used = null;
  if (typeof amount.usedFraction === "number") used = amount.usedFraction;
  else if (typeof amount.remainingFraction === "number") used = 1 - amount.remainingFraction;
  else if (typeof amount.used === "number" && typeof amount.limit === "number" && amount.limit > 0) {
    used = amount.used / amount.limit;
  }
  if (used === null || !Number.isFinite(used)) return null;
  const label = String(limit.label || window.label || limit.id || "limit");
  return {
    label,
    short: String(window.id || scope.windowId || label),
    used: Math.min(1, Math.max(0, used)),
    resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : null,
  };
}

// The most used limit of a report, or null when it has none.
function tightest(report) {
  let best = null;
  for (const limit of report.limits) if (!best || limit.used > best.used) best = limit;
  return best;
}

// ---- Presentation ----------------------------------------------------------

const percent = (fraction) => Math.round(fraction * 100);

// `warn_at` is a string choice such as "80"; 95 and over is always an error.
function tone(fraction) {
  const warnAt = Number((pulse.options && pulse.options.warn_at) || 80);
  const p = percent(fraction);
  return p >= 95 ? "error" : p >= warnAt ? "warning" : "muted";
}

// "3 min", "2 h 5 min", "4 d 3 h".
function span(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return minutes + " min";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + " h " + (minutes % 60) + " min";
  return Math.floor(hours / 24) + " d " + (hours % 24) + " h";
}

const chip = (text, limit) =>
  pulse.ui.chip(text, { tone: tone(limit.used), actions: { click: "open" } });

// ---- Slots -----------------------------------------------------------------

// Beside the composer: the open conversation's provider, else the tightest
// limit anywhere. `ctx.session.model` looks like "anthropic/claude-...".
pulse.slot("composer.status", async (ctx) => {
  if (pulse.options && pulse.options.composer_chip === false) return null;
  const reports = await readReports();
  if (!reports) return null;
  const model = ctx && ctx.session && typeof ctx.session.model === "string" ? ctx.session.model : "";
  const provider = model.includes("/") ? model.split("/")[0] : "";
  const match = reports.find((r) => r.provider === provider && tightest(r));
  let limit = match ? tightest(match) : null;
  if (!limit) {
    for (const report of reports) {
      const t = tightest(report);
      if (t && (!limit || t.used > limit.used)) limit = t;
    }
  }
  return limit ? chip(limit.short + " " + percent(limit.used) + "%", limit) : null;
});

// The drawer: one chip per provider with its tightest window.
pulse.slot("drawer", async () => {
  const reports = await readReports();
  const chips = [];
  for (const report of reports || []) {
    const limit = tightest(report);
    if (limit) chips.push(chip(report.provider + " " + limit.short + " " + percent(limit.used) + "%", limit));
  }
  if (!chips.length) return pulse.ui.chip("usage unavailable", { tone: "muted" });
  return pulse.ui.row(chips);
});

// The page: a card per provider with a progress bar per limit.
pulse.slot("page", async () => {
  const reports = await readReports();
  const cards = [];
  for (const report of reports || []) {
    if (!report.limits.length) continue;
    const body = report.limits.map((limit) => {
      const resets = limit.resetsAt === null ? "" : " · resets in " + span(limit.resetsAt - Date.now());
      return pulse.ui.progress(limit.used, limit.label + resets, { tone: tone(limit.used) });
    });
    if (report.fetchedAt !== null) {
      body.push(pulse.ui.text("Fetched " + span(Date.now() - report.fetchedAt) + " ago", { tone: "muted" }));
    }
    cards.push(pulse.ui.card(report.provider, body));
  }
  if (!cards.length) {
    return pulse.ui.empty("No usage data", "omp usage reported no limits, or could not be run.");
  }
  return pulse.ui.col(cards);
});

// A tap on a chip arrives here as the name given in `actions.click`.
pulse.on("action", (event) => {
  if (event.act === "open") pulse.openPage();
});
