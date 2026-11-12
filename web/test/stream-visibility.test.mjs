import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

// Bundle production imports like the controller suites; no source copies.
const build = await rolldown({
  input: fileURLToPath(new URL("../src/domain/stream-visibility.ts", import.meta.url)),
  platform: "node",
});
let actual;
try {
  const generated = await build.generate({ format: "esm", codeSplitting: false });
  actual = await import(`data:text/javascript;base64,${Buffer.from(generated.output[0].code).toString("base64")}`);
} finally { await build.close(); }
const { visibleStreamingMessage } = actual;

const reply = (id, responseKey, text = "One reply") => ({
  id, responseKey, role: "assistant", text, parts: [{ kind: "text", text }],
});

test("history arriving before stream end hides the duplicate response", () => {
  const live = reply("live:r1", "response:r1");
  assert.equal(visibleStreamingMessage([], live), live);
  assert.equal(visibleStreamingMessage([reply("entry:1", "response:r1")], live), null);
});

test("the same message id also suppresses an echo without a response key", () => {
  assert.equal(visibleStreamingMessage([reply("m1")], reply("m1")), null);
});

test("identical text in distinct responses is never deduplicated", () => {
  const live = reply("live:r2", "response:r2");
  assert.equal(visibleStreamingMessage([reply("entry:1", "response:r1")], live), live);
});

test("missing and empty response keys do not create false matches", () => {
  for (const key of [undefined, ""]) {
    const live = reply("live:2", key);
    assert.equal(visibleStreamingMessage([reply("entry:1", key)], live), live);
  }
});

test("fallback positional ids and empty ids are not reliable response identities", () => {
  for (const id of ["entry:0", "entry:12", ""]) {
    const live = reply(id);
    assert.equal(visibleStreamingMessage([reply(id)], live), live);
  }
});

test("a real response key can identify a reply whose message id is positional", () => {
  assert.equal(visibleStreamingMessage([reply("entry:3", "response:r1")], reply("entry:0", "response:r1")), null);
});

test("user messages cannot hide an assistant response", () => {
  const live = reply("live:r1", "response:r1");
  assert.equal(visibleStreamingMessage([{ ...live, role: "user" }], live), live);
});

test("stream-first completion and the next response remain distinct", () => {
  const done = reply("live:r1", "response:r1");
  assert.equal(visibleStreamingMessage([done], null), null);
  assert.equal(visibleStreamingMessage([done], done), null);
  const next = reply("live:r2", "response:r2", "Next response");
  assert.equal(visibleStreamingMessage([done], next), next);
});

test("hiding an echo does not mutate or discard live transport state", () => {
  const live = Object.freeze(reply("live:r1", "response:r1"));
  const history = Object.freeze([Object.freeze(reply("entry:1", "response:r1"))]);
  assert.equal(visibleStreamingMessage(history, live), null);
  assert.equal(live.text, "One reply");
  assert.equal(visibleStreamingMessage([], live), live);
});

test("an earlier persisted row cannot hide newer or revised streamed text", () => {
  const history = [reply("entry:1", "response:r1", "Partial")];
  for (const content of ["Partial reply", "Revised reply"]) {
    const live = reply("live:r1", "response:r1", content);
    assert.equal(visibleStreamingMessage(history, live), live);
  }
});

test("a persisted full reply can cover a late partial stream of that response", () => {
  assert.equal(visibleStreamingMessage([reply("entry:1", "response:r1", "Full reply")], reply("live:r1", "response:r1", "Full")), null);
});

test("new thinking, image or tool details remain visible until reconciled", () => {
  const history = [reply("entry:1", "response:r1")];
  for (const part of [
    { kind: "thinking", text: "New reasoning" },
    { kind: "image", src: "data:image/png;base64,fixture", mimeType: "image/png" },
    { kind: "tool", callId: "t1", name: "bash", state: "running", args: {} },
  ]) {
    const live = reply("live:r1", "response:r1");
    live.parts.push(part);
    assert.deepEqual(visibleStreamingMessage(history, live).parts, [part]);
    assert.equal(visibleStreamingMessage(history, live).text, "");
    const covered = [{ ...history[0], parts: [...history[0].parts, part] }];
    assert.equal(visibleStreamingMessage(covered, live), null);
  }
});

test("a new stream error cannot be hidden by an earlier successful history row", () => {
  const live = { ...reply("live:r1", "response:r1"), errorMessage: "Connection interrupted" };
  assert.equal(visibleStreamingMessage([reply("entry:1", "response:r1")], live).errorMessage, "Connection interrupted");
  assert.equal(visibleStreamingMessage([{ ...live, id: "entry:1" }], live), null);
});

test("covered text is not repeated when the same response gains a tool", () => {
  const old = reply("entry:1", "response:r1", "The answer.");
  const tool = { kind: "tool", callId: "t1", name: "bash", state: "running", args: {} };
  const live = {...reply("live:r1", "response:r1", "The answer."),parts:[{kind:"text",text:"The answer."},tool]};
  const visible = visibleStreamingMessage([old], live);
  assert.equal(visible.text, "");
  assert.deepEqual(visible.parts,[tool]);
  assert.equal(old.text + visible.text, "The answer.");
  assert.equal(live.text,"The answer.");
});
test("covered prefix and old non-text details are omitted while new details survive",()=>{
 const thinking={kind:"thinking",text:"Earlier thought"},image={kind:"image",src:"synthetic:image",mimeType:"image/png"};
 const old={...reply("entry:1","response:r1","Full reply"),parts:[thinking,{kind:"text",text:"Full reply"}]};
 const live={...reply("live:r1","response:r1","Full"),parts:[thinking,{kind:"text",text:"Full"},image]};
 assert.deepEqual(visibleStreamingMessage([old],live).parts,[image]);
});
test("fresh error detail survives without replaying successful text",()=>{
 const live={...reply("live:r1","response:r1"),errorMessage:"Connection interrupted"};
 const shown=visibleStreamingMessage([reply("entry:1","response:r1")],live);
 assert.equal(shown.text,"");assert.deepEqual(shown.parts,[]);assert.equal(shown.errorMessage,"Connection interrupted");
});

test("projected snapshots are referentially stable for React subscriptions",()=>{
 const history=[reply("entry:1","response:r1")],live={...reply("live:r1","response:r1"),errorMessage:"New error"};
 const first=visibleStreamingMessage(history,live);
 assert.equal(visibleStreamingMessage(history,live),first);
 visibleStreamingMessage([reply("other","response:r2")],reply("live:r2","response:r2"));
 assert.equal(visibleStreamingMessage(history,live),first);
});
