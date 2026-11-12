import { JSDOM } from "../../node_modules/jsdom/lib/api.js";
import { rolldown } from "../../node_modules/rolldown/dist/index.mjs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import vm from "node:vm";

export const root = fileURLToPath(new URL("../../../", import.meta.url));

// Real React state/effects/events, synthetic DOM. No layout/rendering evidence.
export async function bundleDomFixture(source, plugins = []) {
  const build = await rolldown({
    input: "dom-fixture", platform: "browser",
    resolve: { alias: { "@": resolve(root, "web/src") } },
    transform: { jsx: { runtime: "automatic" }, define: {
      "process.env.NODE_ENV": JSON.stringify("development"),
      "import.meta.env": JSON.stringify({ VITE_PROTOCOL_VERSION: 1, VITE_RELEASE_ID: "unit" }),
    } },
    plugins: [{ name: "dom-fixture-entry",
      resolveId: (id) => id === "dom-fixture" ? "\0dom-fixture" : null,
      load: (id) => id === "\0dom-fixture" ? source : null,
    }, ...plugins],
  });
  try {
    return (await build.generate({ format: "iife", codeSplitting: false })).output[0].code;
  } finally { await build.close(); }
}

// Assert on strings and booleans, never on rendered DOM nodes: a failing
// assert renders its operands without custom inspectors, and a node's React
// fiber keys reach the whole tree. One such failure grew past 6 GB and got
// the phone app killed (2026-10-14).
export function createDomFixture(code) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "http://synthetic.invalid/", runScripts: "outside-only", pretendToBeVisual: true,
  });
  const w = dom.window;
  // Scheduling adapter only; jsdom does not implement browser MessageChannel.
  w.MessageChannel = class {
    constructor() {
      this.port1 = { onmessage: null };
      this.port2 = { postMessage: () => w.setTimeout(() => this.port1.onmessage?.(), 0) };
    }
  };
  w.IS_REACT_ACT_ENVIRONMENT = true;
  const blocked = [];
  const deny = (kind) => { blocked.push(kind); throw new Error(`Network prohibited: ${kind}`); };
  w.fetch = () => deny("fetch");
  w.WebSocket = class { constructor() { deny("WebSocket"); } };
  w.XMLHttpRequest = class { constructor() { deny("XMLHttpRequest"); } };
  w.navigator.sendBeacon = () => deny("sendBeacon");
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.ResizeObserver = w.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.scrollTo = () => {};
  try { compiled(code).runInContext(dom.getInternalVMContext()); } catch (error) { w.close(); throw error; }
  return { window: w, blocked, close: () => w.close() };
}

// A test file mounts one bundle into many fresh windows. `window.eval` made V8
// parse and compile the whole bundle (often several MB) again for each one;
// a compiled script runs in any context, so compile each bundle once.
const scripts = new Map();
function compiled(code) {
  let script = scripts.get(code);
  if (!script) scripts.set(code, (script = new vm.Script(code, { filename: "dom-fixture.js" })));
  return script;
}
