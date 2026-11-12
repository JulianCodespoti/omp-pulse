import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// Real hook callbacks, no React effects or browser. Media, timers and the
// transcribe API are fakes; no device, audio, daemon or network is involved.
const root = fileURLToPath(new URL("../../", import.meta.url));
const require = createRequire(resolve(root, "web/package.json"));
const directory = await mkdtemp(resolve(tmpdir(), "pulse-voice-retry-"));
after(() => rm(directory, { recursive: true, force: true }));
const source = `
  import { createElement } from ${JSON.stringify(require.resolve("react"))};
  import { renderToStaticMarkup } from ${JSON.stringify(require.resolve("react-dom/server"))};
  import { useDictation, transcribeDeadlineMs } from ${JSON.stringify(resolve(root, "web/src/app/composer/use-dictation.ts"))};
  export { transcribeDeadlineMs };
  export function capture(options) {
    let result;
    function Harness() { result = useDictation(options); return null; }
    renderToStaticMarkup(createElement(Harness));
    return result;
  }
`;
const bundle = await rolldown({ input: "voice-retry-entry", platform: "node",
  resolve: { alias: { "@": resolve(root, "web/src") } },
  transform: { define: { "import.meta.env": JSON.stringify({ VITE_PROTOCOL_VERSION: 1, VITE_RELEASE_ID: "unit" }) } },
  plugins: [{ name: "voice-retry-entry", resolveId: (id) => id === "voice-retry-entry" ? "\0voice-retry-entry" : null,
    load: (id) => id === "\0voice-retry-entry" ? source : null }],
});
await bundle.write({ file: resolve(directory, "voice.mjs"), format: "esm" });
await bundle.close();
const { capture, transcribeDeadlineMs } = await import(pathToFileURL(resolve(directory, "voice.mjs")).href);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

// Every transcribe call gets its own reply; timers are recorded, never real.
function fixture(scope = "/synthetic/a") {
  const texts = [], errors = [], calls = [], timers = [];
  let now = 1_000;
  class Recorder {
    state = "inactive"; mimeType = "audio/webm";
    constructor(stream) { this.stream = stream; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; queueMicrotask(() => { this.ondataavailable?.({ data: new Blob([this.stream.label], { type: this.mimeType }) }); this.onstop?.(new Event("stop")); }); }
  }
  globalThis.MediaRecorder = Recorder;
  let count = 0;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    mediaDevices: { getUserMedia: async () => ({ label: `recording-${++count}`, getTracks: () => [{ stop() {} }] }) },
  } });
  globalThis.window = {
    isSecureContext: true, location: { origin: "http://synthetic.invalid" },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    setInterval: () => 0, clearInterval() {}, cancelAnimationFrame() {},
  };
  const realNow = Date.now;
  Date.now = () => now;
  const hook = capture({ scope,
    daemonApi: { transcribe: (blob, signal) => { const reply = deferred(); calls.push({ blob, signal, reply }); return reply.promise; } },
    onTranscribed: (text, origin) => texts.push(`${origin}:${text}`), onError: (error) => errors.push(error) });
  const record = async (ms) => { const before = calls.length; await hook.start(); now += ms; hook.stop(); for (let i = 0; i < 5 && calls.length === before; i++) await tick(); };
  const restore = () => { Date.now = realNow; hook.cancel(); };
  return { hook, texts, errors, calls, timers, record, restore };
}

test("the transcribe deadline is 30 s plus the audio's length", () => {
  assert.equal(transcribeDeadlineMs(0), 30_000);
  assert.equal(transcribeDeadlineMs(12_000), 42_000);
  assert.equal(transcribeDeadlineMs(-5), 30_000);
});

test("cancel while transcribing aborts the request and ignores its late text", { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    await f.record(3_000);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].signal.aborted, false);
    f.hook.cancel();
    assert.equal(f.calls[0].signal.aborted, true);
    f.calls[0].reply.resolve("late words"); await tick();
    assert.deepEqual(f.texts, []);
    assert.deepEqual(f.errors, []);
  } finally { f.restore(); }
});

test("a cancelled transcription keeps its recording and Retry posts it again", { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    await f.record(3_000);
    f.hook.cancel();
    f.hook.retry(); await tick();
    assert.equal(f.calls.length, 2);
    assert.equal(await f.calls[1].blob.text(), "recording-1");
    f.calls[1].reply.resolve("kept words"); await tick();
    assert.deepEqual(f.texts, ["/synthetic/a:kept words"]);
  } finally { f.restore(); }
});

test("the deadline fires after 30 s plus the recording and keeps it for Retry", { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    await f.record(12_000);
    const deadline = f.timers.find((timer) => timer.ms === 42_000 && !timer.cleared);
    assert.equal(Boolean(deadline), true, `deadlines: ${f.timers.map((t) => t.ms).join(",")}`);
    deadline.fn(); await tick();
    assert.equal(f.calls[0].signal.aborted, true);
    assert.deepEqual(f.errors, ["Couldn't transcribe in time."]);
    f.calls[0].reply.resolve("too late"); await tick();
    assert.deepEqual(f.texts, []);
    f.hook.retry(); await tick();
    assert.equal(f.calls.length, 2);
    assert.equal(await f.calls[1].blob.text(), "recording-1");
    f.calls[1].reply.resolve("second try"); await tick();
    assert.deepEqual(f.texts, ["/synthetic/a:second try"]);
  } finally { f.restore(); }
});

test("a network failure keeps the recording; Retry re-posts it without speaking again", { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    await f.record(2_000);
    f.calls[0].reply.reject(new TypeError("Failed to fetch")); await tick();
    assert.deepEqual(f.errors, ["Couldn't reach your computer to transcribe."]);
    f.hook.retry(); await tick();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].blob, f.calls[0].blob);
    f.calls[1].reply.resolve("hello"); await tick();
    assert.deepEqual(f.texts, ["/synthetic/a:hello"]);
    f.hook.retry(); await tick();
    assert.equal(f.calls.length, 2, "a delivered recording is not kept");
  } finally { f.restore(); }
});

test("a server error keeps the recording; dismiss forgets it", { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    await f.record(2_000);
    f.calls[0].reply.reject(new Error("decoder crashed")); await tick();
    assert.equal(f.errors.length, 1);
    f.hook.discardRetry();
    f.hook.retry(); await tick();
    assert.equal(f.calls.length, 1);
  } finally { f.restore(); }
});

test("a new recording replaces the kept one", { timeout: 2000 }, async () => {
  const f = fixture();
  try {
    await f.record(2_000);
    f.calls[0].reply.reject(new TypeError("Failed to fetch")); await tick();
    await f.record(2_000);
    assert.equal(await f.calls[1].blob.text(), "recording-2");
    f.calls[1].reply.reject(new TypeError("Failed to fetch")); await tick();
    f.hook.retry(); await tick();
    assert.equal(await f.calls[2].blob.text(), "recording-2");
  } finally { f.restore(); }
});
