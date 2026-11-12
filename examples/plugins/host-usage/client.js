// host-usage: shows the load and memory of the computer running the daemon.
//
// This file runs inside a sandboxed worker. The only global it gets is `pulse`.
// It has no network, storage or page access; it asks for data through
// pulse.source(id) (the sources declared in pulse-plugin.toml) and answers with
// small node trees built by pulse.ui.*.

// ---- Reading and parsing sources -------------------------------------------
// Every helper returns null when the data is unavailable, and never throws.
// /proc does not exist on macOS or Windows, and not inside Android phone mode.

// Fetch one source; null when the source failed or produced no text.
async function read(id) {
  try {
    const reading = await pulse.source(id);
    if (!reading || !reading.ok || typeof reading.text !== "string") return null;
    return reading.text;
  } catch (_) {
    return null;
  }
}

// "/proc/loadavg" looks like "0.52 0.58 0.59 1/467 12345".
async function readLoad() {
  const text = await read("load");
  if (text === null) return null;
  const parts = text.trim().split(/\s+/).slice(0, 3).map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return { one: parts[0], five: parts[1], fifteen: parts[2] };
}

// "/proc/meminfo" has lines like "MemTotal:       16318412 kB".
async function readMemory() {
  const text = await read("mem");
  if (text === null) return null;
  const field = (name) => {
    const match = text.match(new RegExp("^" + name + ":\\s+(\\d+)\\s*kB", "m"));
    return match ? Number(match[1]) : NaN;
  };
  const total = field("MemTotal");
  const available = field("MemAvailable");
  if (!(total > 0) || !Number.isFinite(available)) return null;
  return {
    used: Math.min(1, Math.max(0, 1 - available / total)),
    totalGiB: total / 1024 / 1024,
    usedGiB: (total - available) / 1024 / 1024,
  };
}

// "uname -sn" prints "Linux hostname".
async function readHost() {
  const text = await read("host");
  if (text === null) return null;
  const [system, ...rest] = text.trim().split(/\s+/);
  if (!system) return null;
  return { system, name: rest.join(" ") || "unknown" };
}

// ---- Tones -----------------------------------------------------------------

function loadTone(one) {
  return one >= 8 ? "error" : one >= 4 ? "warning" : "muted";
}

function memTone(percent) {
  return percent >= 95 ? "error" : percent >= 85 ? "warning" : "muted";
}

const loadChip = (load) =>
  pulse.ui.chip("load " + load.one.toFixed(2), { tone: loadTone(load.one), actions: { click: "open" } });

const memChip = (mem) => {
  const percent = Math.round(mem.used * 100);
  return pulse.ui.chip("mem " + percent + "%", { tone: memTone(percent), actions: { click: "open" } });
};

// ---- Sandbox probes --------------------------------------------------------
// Each probe runs inside this worker, needs no network, and reports whether the
// capability is "blocked" (what we want) or "reachable". They run once and the
// result is cached; a probe can never break rendering.

const BLOCKED = { value: "blocked", tone: "success" };
const REACHABLE = { value: "reachable", tone: "error" };

async function probe(fn) {
  try {
    return (await fn()) ? REACHABLE : BLOCKED;
  } catch (_) {
    return BLOCKED;
  }
}

function probeIndexedDb() {
  if (typeof indexedDB === "undefined" || !indexedDB) return Promise.resolve(false);
  return new Promise((resolve) => {
    // A request that never settles counts as blocked.
    const timer = setTimeout(() => resolve(false), 1000);
    try {
      const request = indexedDB.open("pulse-sandbox-probe");
      request.onsuccess = () => {
        clearTimeout(timer);
        try {
          request.result.close();
          indexedDB.deleteDatabase("pulse-sandbox-probe");
        } catch (_) {
          // Cleanup only; the probe result is already known.
        }
        resolve(true);
      };
      request.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
    } catch (_) {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

async function runProbes() {
  const items = [];
  const add = (key, result) => items.push({ key, value: result.value, tone: result.tone });

  add("fetch", await probe(async () => {
    await fetch("data:text/plain,x");
    return true; // resolving means the network API works
  }));
  add("importScripts", await probe(() => {
    importScripts("data:text/javascript,0");
    return true;
  }));
  add("eval", await probe(() => {
    new Function("return 1");
    return true;
  }));
  add("IndexedDB", await probe(probeIndexedDb));

  let origin = "unknown";
  try {
    origin = String(self.origin);
  } catch (_) {
    // Leave "unknown".
  }
  items.push({ key: "origin", value: origin, tone: origin === "null" ? "success" : "error" });

  const present = ["OmpLocal", "OmpNative", "OmpOutbox", "androidBridge", "Capacitor"].filter((name) => {
    try {
      return name in self;
    } catch (_) {
      return false;
    }
  });
  items.push({
    key: "native bridge",
    value: present.length ? present.join(", ") : "none",
    tone: present.length ? "error" : "success",
  });
  return items;
}

// Started once; every render awaits the same promise.
let probesPromise = null;
function probes() {
  if (!probesPromise) probesPromise = runProbes().catch(() => []);
  return probesPromise;
}

// ---- Slots -----------------------------------------------------------------

// The drawer: a row of chips, or one muted chip when nothing is available.
pulse.slot("drawer", async () => {
  const [load, mem] = await Promise.all([readLoad(), readMemory()]);
  const chips = [];
  if (load) chips.push(loadChip(load));
  if (mem) chips.push(memChip(mem));
  if (!chips.length) return pulse.ui.chip("host usage unavailable", { tone: "muted" });
  return pulse.ui.row(chips);
});

// Next to the composer: just the load, or nothing at all.
pulse.slot("composer.status", async () => {
  const load = await readLoad();
  return load ? loadChip(load) : null;
});

// The full page: host facts, then the sandbox check.
pulse.slot("page", async () => {
  const [host, load, mem, checks] = await Promise.all([readHost(), readLoad(), readMemory(), probes()]);
  const unavailable = "unavailable";
  const gib = (n) => n.toFixed(1) + " GiB";
  const hostItems = [
    { key: "system", value: host ? host.system : unavailable },
    { key: "name", value: host ? host.name : unavailable },
    { key: "load 1 min", value: load ? load.one.toFixed(2) : unavailable },
    { key: "load 5 min", value: load ? load.five.toFixed(2) : unavailable },
    { key: "load 15 min", value: load ? load.fifteen.toFixed(2) : unavailable },
    { key: "memory used", value: mem ? gib(mem.usedGiB) : unavailable },
    { key: "memory total", value: mem ? gib(mem.totalGiB) : unavailable },
  ];
  const hostBody = [pulse.ui.kv(hostItems)];
  if (mem) {
    const percent = Math.round(mem.used * 100);
    hostBody.push(pulse.ui.progress(mem.used, "memory " + percent + "%", { tone: memTone(percent) }));
  }
  return pulse.ui.col([
    pulse.ui.card("Host", hostBody),
    pulse.ui.card("Sandbox check", [pulse.ui.kv(checks)]),
    pulse.ui.button("Refresh", "refresh"),
  ]);
});

// ---- Actions ---------------------------------------------------------------
// A tap on a chip or button arrives here as the name given in `actions.click`.
pulse.on("action", (event) => {
  if (event.act === "open") pulse.openPage();
  else if (event.act === "refresh") pulse.refresh();
});
