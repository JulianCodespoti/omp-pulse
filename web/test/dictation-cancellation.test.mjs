import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// Real hook callbacks, no React effects or browser. Every media/API surface is
// fake. No device permission, recorded audio, daemon or network is involved.
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(resolve(root, "web/package.json"));
const directory = await mkdtemp(resolve(tmpdir(), "pulse-voice-unit-"));
after(() => rm(directory, { recursive: true, force: true }));
const source = `
  import { createElement } from ${JSON.stringify(require.resolve("react"))};
  import { renderToStaticMarkup } from ${JSON.stringify(require.resolve("react-dom/server"))};
  import { useDictation } from ${JSON.stringify(resolve(root, "web/src/app/composer/use-dictation.ts"))};
  export function capture(options) {
    let result;
    function Harness() { result = useDictation(options); return null; }
    renderToStaticMarkup(createElement(Harness));
    return result;
  }
`;
const bundle = await rolldown({ input: "voice-test-entry", platform: "node",
  resolve: { alias: { "@": resolve(root, "web/src") } },
  transform: { define: { "import.meta.env": JSON.stringify({ VITE_PROTOCOL_VERSION: 1, VITE_RELEASE_ID: "unit" }) } },
  plugins: [{ name: "voice-test-entry", resolveId: (id) => id === "voice-test-entry" ? "\0voice-test-entry" : null,
    load: (id) => id === "\0voice-test-entry" ? source : null }],
});
await bundle.write({ file: resolve(directory, "voice.mjs"), format: "esm" });
await bundle.close();
const { capture } = await import(pathToFileURL(resolve(directory, "voice.mjs")).href);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(autoStop = true) {
  const texts = [], errors = [], blobs = [], recorders = [], streams = [];
  const reply = deferred(), called = deferred();
  const permission = { pending: null };
  class Recorder {
    state = "inactive";
    mimeType = "audio/webm";
    constructor(stream) { this.stream = stream; recorders.push(this); }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; if (autoStop) queueMicrotask(() => this.finish()); }
    finish() { this.ondataavailable?.({ data: new Blob([this.stream.label], { type: this.mimeType }) }); this.onstop?.(new Event("stop")); }
  }
  globalThis.MediaRecorder = Recorder;
  const makeStream = () => {
    const stream = { label: `recording-${streams.length + 1}`, stops: 0,
      getTracks: () => [{ stop: () => { stream.stops++; } }] };
    streams.push(stream); return stream;
  };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    mediaDevices: { getUserMedia: () => permission.pending?.promise ?? Promise.resolve(makeStream()) },
  } });
  globalThis.window = {
    isSecureContext: true, location: { origin: "http://synthetic.invalid" },
    setTimeout: (...args) => setTimeout(...args).unref(), clearTimeout,
    setInterval: (...args) => setInterval(...args).unref(), clearInterval,
    cancelAnimationFrame() {},
  };
  const hook = capture({ daemonApi: { transcribe: (blob) => { blobs.push(blob); called.resolve(); return reply.promise; } },
    onTranscribed: (text) => texts.push(text), onError: (error) => errors.push(error) });
  return { hook, texts, errors, blobs, recorders, streams, reply, called, permission, makeStream };
}

test("a cancelled transcription cannot insert its late text", { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    await f.hook.start(); f.hook.stop(); await f.called.promise;
    f.hook.cancel(); f.reply.resolve("cancelled words"); await tick();
    assert.deepEqual(f.texts, []);
  } finally { f.hook.cancel(); }
});

test("a cancelled transcription cannot display its late error", { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    await f.hook.start(); f.hook.stop(); await f.called.promise;
    f.hook.cancel(); f.reply.reject(new Error("network fixture failure")); await tick();
    assert.deepEqual(f.errors, []);
  } finally { f.hook.cancel(); }
});

test("a superseded recorder error cannot stop the new recording", { timeout: 2000 }, async () => {
  const f = fixture(false);
  try {
    await f.hook.start(); const old = f.recorders[0];
    f.hook.cancel(); await f.hook.start();
    old.onerror?.(new Event("error"));
    assert.equal(f.streams[1].stops, 0);
    assert.deepEqual(f.errors, []);
  } finally { f.hook.cancel(); }
});

test("cancel during final chunks keeps the next recording's audio separate", { timeout: 2000 }, async () => {
  const f = fixture(false);
  try {
    await f.hook.start(); f.hook.stop();
    f.hook.cancel();
    assert.ok(f.streams[0].stops > 0, "Cancel releases the stream while final chunks are pending");
    await f.hook.start();
    f.recorders[0].finish(); await tick();
    assert.equal(f.blobs.length, 0);
    assert.equal(f.streams[1].stops, 0);
    f.hook.stop(); f.recorders[1].finish(); await f.called.promise;
    assert.equal(await f.blobs[0].text(), "recording-2");
    f.reply.resolve("new words"); await tick();
    assert.deepEqual(f.texts, ["new words"]);
  } finally { f.hook.cancel(); }
});

test("normal stop transcribes once and releases the captured stream", { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    await f.hook.start(); f.hook.stop(); f.hook.stop(); await f.called.promise;
    f.reply.resolve("  hello  "); await tick();
    assert.deepEqual(f.texts, ["hello"]);
    assert.equal(f.blobs.length, 1);
    assert.ok(f.streams[0].stops > 0);
  } finally { f.hook.cancel(); }
});

test("cancel while permission is pending releases the late stream without recording", { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    f.permission.pending = deferred();
    const start = f.hook.start(); f.hook.cancel();
    const stream = f.makeStream(); f.permission.pending.resolve(stream); await start;
    assert.ok(stream.stops > 0);
    assert.equal(f.recorders.length, 0);
    assert.equal(f.blobs.length, 0);
  } finally { f.hook.cancel(); }
});


test("a current recorder error during stop reports once without uploading", { timeout: 2000 }, async () => {
  const f = fixture(false);
  try {
    await f.hook.start(); f.hook.stop();
    f.recorders[0].onerror?.(new Event("error")); await tick();
    assert.equal(f.blobs.length, 0);
    assert.deepEqual(f.errors, ["Recording failed. Try again."]);
    assert.ok(f.streams[0].stops > 0);
  } finally { f.hook.cancel(); }
});

test("cancel during AudioContext resume cannot restart a stale recording", { timeout: 2000 }, async () => {
  const f = fixture(false);
  const resume = deferred();
  let context;
  window.AudioContext = class {
    state = "suspended"; closed = false;
    constructor() { context = this; }
    resume() { return resume.promise; }
    close() { this.closed = true; return Promise.resolve(); }
    createAnalyser() { assert.fail("a cancelled context must not create an analyser"); }
  };
  try {
    const starting = f.hook.start(); await tick();
    assert.ok(context);
    f.hook.cancel(); resume.resolve(); await starting;
    assert.equal(context.closed, true);
    assert.ok(f.streams[0].stops > 0);
    assert.equal(f.blobs.length, 0);
  } finally { f.hook.cancel(); delete window.AudioContext; }
});
