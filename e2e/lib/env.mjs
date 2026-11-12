// Machine-specific inputs for the browser and model-backed suites, resolved in
// one place so the same suite runs on any machine.
//
// Every knob has an environment override; without one the suites resolve what
// this repo ships (web/node_modules) and fall back to sensible defaults.
//
//   OMP_PULSE_PUPPETEER    puppeteer module file      $OMP_PULSE_OMP_MODULES → web/node_modules
//   OMP_PULSE_WS           ws module file             $OMP_PULSE_OMP_MODULES → web/node_modules
//   OMP_PULSE_OMP_MODULES  node_modules dir of an omp checkout to borrow puppeteer-core/ws from (optional)
//   OMP_PULSE_CHROMIUM     browser executable         puppeteer default → /usr/bin/chromium
//   OMP_PULSE_E2E_APP      embedded | vite            vite when mise is on PATH, else embedded /app/
//   OMP_PULSE_TEST_MODEL   provider/id                Muse Contributor when offered, else a cheap one

import { existsSync } from "fs";
import { createRequire } from "module";
import { delimiter, join } from "path";
import { fileURLToPath } from "url";
import { spawn, execFileSync } from "child_process";

const env = process.env;
const WEB = fileURLToPath(new URL("../../web/", import.meta.url));
const webRequire = createRequire(join(WEB, "package.json"));

const ompModule = (file) => (env.OMP_PULSE_OMP_MODULES ? join(env.OMP_PULSE_OMP_MODULES, file) : null);

function resolveModule(override, ompFile, names) {
  if (override) return override;
  if (ompFile && existsSync(ompFile)) return ompFile;
  for (const name of names) {
    try {
      return webRequire.resolve(name);
    } catch {}
  }
  throw new Error(`none of ${names.join(", ")} is installed in web/ (run npm ci there) and no override is set`);
}

let puppeteerModule;
let bundledChromium;
/** The puppeteer API; puppeteer-core and full puppeteer are interchangeable here. */
export async function loadPuppeteer() {
  if (puppeteerModule) return puppeteerModule;
  puppeteerModule = await import(
    resolveModule(
      env.OMP_PULSE_PUPPETEER,
      ompModule("puppeteer-core/lib/puppeteer/puppeteer-core.js"),
      ["puppeteer-core", "puppeteer"],
    )
  ).then((m) => m.default || m);
  try {
    // Sync in older releases, async since; puppeteer-core has no browser of
    // its own and throws, full puppeteer names the one it downloaded.
    const path = await puppeteerModule.executablePath();
    if (path && existsSync(path)) bundledChromium = path;
  } catch {}
  return puppeteerModule;
}

/** The `ws` WebSocket class (Node's built-in WebSocket has no `.on`). */
export async function loadWs() {
  return import(resolveModule(env.OMP_PULSE_WS, ompModule("ws/index.js"), ["ws"])).then(
    (m) => m.default || m,
  );
}

/** Browser executable for `puppeteer.launch`; call after `loadPuppeteer()`. */
export function chromium() {
  return env.OMP_PULSE_CHROMIUM || bundledChromium || "/usr/bin/chromium";
}

function onPath(command) {
  return (env.PATH || "").split(delimiter).some((dir) => dir && existsSync(join(dir, command)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort(from) {
  for (let port = from; port < from + 10; port++) {
    try {
      await Promise.any([fetch(`http://127.0.0.1:${port}/`), fetch(`http://[::1]:${port}/`)]);
    } catch {
      return port;
    }
  }
  throw new Error(`no free port for vite in ${from}-${from + 9}`);
}

/**
 * Serve the web app against the test daemon at `base`.
 *
 * vite serves web/src (through mise when it is on PATH, web/node_modules otherwise)
 * with OMP_PULSE_WEB_TARGET proxying to `base`; embedded is the daemon's own
 * `/app/`, i.e. whatever web build the binary was compiled with. Suites that
 * import `/src/...` modules in the page pass `vite: true`.
 *
 * @param {{ base: string, port: number, vite?: boolean }} options
 *   `port` is the first port tried for vite; the next nine are fallbacks.
 * @returns {Promise<{ url: string, mode: "vite" | "embedded", stop: () => void }>}
 */
export async function startWebApp({ base, port, vite: needsVite = false }) {
  const forced = env.OMP_PULSE_E2E_APP;
  if (forced && forced !== "vite" && forced !== "embedded") {
    throw new Error(`OMP_PULSE_E2E_APP must be "vite" or "embedded", not ${JSON.stringify(forced)}`);
  }
  if (needsVite && forced === "embedded") {
    throw new Error("this suite imports web/src modules through vite; OMP_PULSE_E2E_APP=embedded cannot serve them");
  }
  const mise = onPath("mise");
  const mode = needsVite ? "vite" : forced ?? (mise ? "vite" : "embedded");

  if (mode === "embedded") {
    const url = new URL("/app/", base).href;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`embedded app at ${url} answered ${r.status}`);
    return { url, mode, stop() {} };
  }

  const vitePort = await freePort(port);
  const viteArgs = ["--host", "127.0.0.1", "--port", String(vitePort)];
  const child = mise
    ? spawn("mise", ["exec", "node@22.23.2", "--", "npx", "vite", ...viteArgs], {
        cwd: WEB,
        env: { ...env, OMP_PULSE_WEB_TARGET: base },
        stdio: "ignore",
      })
    : spawn(process.execPath, [join(WEB, "node_modules/vite/bin/vite.js"), ...viteArgs], {
        cwd: WEB,
        env: { ...env, OMP_PULSE_WEB_TARGET: base },
        stdio: "ignore",
      });
  const url = `http://127.0.0.1:${vitePort}/`;
  const stop = () => child.kill("SIGTERM");
  // 20 s matched the laptop; a cold vite on slower hosts needs longer.
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null) break;
    try {
      if ((await fetch(url)).ok) return { url, mode, stop };
    } catch {}
    await sleep(100);
  }
  stop();
  throw new Error(`vite did not come up on ${url}${child.exitCode !== null ? ` (exited ${child.exitCode})` : ""}`);
}

/** The model the model-backed suites were written against. */
export const LAPTOP_MODEL = { provider: "opencode-go", id: "muse-spark-1.3-contributor" };
const CHEAP_MODELS = ["anthropic/claude-haiku-4-5", "anthropic/claude-haiku-4-5-20251001", "openai/gpt-5-mini"];

function parseModel(spec) {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) throw new Error(`OMP_PULSE_TEST_MODEL must be provider/id, not ${JSON.stringify(spec)}`);
  return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

async function catalogue({ base, token, sessionPath }) {
  if (base && sessionPath) {
    const body = await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionPath, command: "get_available_models" }),
    }).then((r) => r.json());
    const data = body.data;
    return Array.isArray(data) ? data : data?.models ?? [];
  }
  const out = execFileSync(env.OMP_BIN || "omp", ["models", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(out).models ?? [];
}

let chosenModel;
/**
 * The model for suites that make real model calls: OMP_PULSE_TEST_MODEL, else
 * Muse Contributor when the child's catalogue offers it, else a cheap model the
 * catalogue does offer. The catalogue is read from the session's child when
 * `sessionPath` is given, otherwise from `omp models`.
 *
 * @param {{ base?: string, token?: string, sessionPath?: string }} [where]
 * @returns {Promise<{ provider: string, id: string }>}
 */
export async function testModel(where = {}) {
  if (chosenModel) return chosenModel;
  if (env.OMP_PULSE_TEST_MODEL) return (chosenModel = parseModel(env.OMP_PULSE_TEST_MODEL));
  const models = await catalogue(where);
  const offered = (spec) => models.find((m) => `${m.provider}/${m.id}` === spec);
  const pick =
    offered(`${LAPTOP_MODEL.provider}/${LAPTOP_MODEL.id}`) ??
    CHEAP_MODELS.map(offered).find(Boolean) ??
    [...models].filter((m) => typeof m.cost?.input === "number").sort((a, b) => a.cost.input - b.cost.input)[0] ??
    models[0];
  if (!pick) throw new Error("the model catalogue is empty; set OMP_PULSE_TEST_MODEL=provider/id");
  return (chosenModel = { provider: pick.provider, id: pick.id });
}
