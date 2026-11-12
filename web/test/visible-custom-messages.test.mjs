import test from "node:test";
import assert from "node:assert/strict";
import { bundleDomFixture, createDomFixture } from "./support/react-dom.mjs";
import { visibleCustomMessagesSource } from "./fixtures/visible-custom-messages.mjs";

const code = await bundleDomFixture(visibleCustomMessagesSource);
const timestamp = 1792749600000;
const custom = (id, overrides = {}) => ({
  type: "custom_message", id, timestamp: new Date(timestamp).toISOString(),
  customType: "extension-note", display: true, content: "Visible extension result.", ...overrides,
});
const live = (id, overrides = {}) => ({
  role: "custom", id, timestamp, customType: "extension-note", display: true,
  content: "Visible extension result.", ...overrides,
});
const plain = value => JSON.parse(JSON.stringify(value));

async function fixture(t) {
  const dom = createDomFixture(code), { window: w } = dom, api = w.fixture;
  let mounted;
  await api.act(async () => { mounted = api.mount(); });
  t.after(async () => {
    try { await api.act(async () => mounted.unmount()); assert.deepEqual(dom.blocked, []); }
    finally { dom.close(); }
  });
  return { w, api, async history(entries, method) { await api.act(async () => api.history(entries, method)); } };
}

test("only deliberately displayed custom and legacy hook messages enter the conversation", async t => {
  const { api, w, history } = await fixture(t);
  await history([
    custom("visible"),
    custom("hidden", { display: false, content: "PRIVATE SYSTEM INSTRUCTIONS" }),
    custom("absent", { display: undefined, content: "INTERNAL BOOKKEEPING" }),
    { type: "message", id: "legacy", message: live(undefined, { role: "hookMessage", content: "Legacy visible message." }) },
    { type: "message", id: "hidden-hook", message: live(undefined, { role: "hookMessage", display: false, content: "PRIVATE HOOK" }) },
    { type: "custom", id: "bookkeeping", customType: "extension-note", display: true, data: "NOT A CONVERSATION MESSAGE" },
  ]);
  assert.deepEqual(Array.from(api.store.getState().messages, row => row.id), ["visible", "legacy"]);
  assert.match(w.document.body.textContent, /Visible extension result/);
  assert.match(w.document.body.textContent, /Legacy visible message/);
  assert.doesNotMatch(w.document.body.textContent, /PRIVATE|INTERNAL|NOT A CONVERSATION/);
});

for (const [customType, content, details] of [
  ["irc:incoming", "<irc>PRIVATE COORDINATION: reply via write agent://Worker</irc>", { from: "Worker" }],
  ["async-result", "<system-notice>PRIVATE DELIVERY: Background job bg_4 has completed. Resume your work using the result below.</system-notice>", { jobs: [{ jobId: "bg_4", type: "bash", label: "plan smoke" }] }],
  ["launch-completion", "<system-notice>PRIVATE DELIVERY: The background service finished.</system-notice>", { daemons: [{ id: "service", name: "preview", state: "exited", exitCode: 0 }] }],
  ["local-image-labels", "[[Image #1]](file:///home/PRIVATE/blobs/a.webp)", [{ label: "[Image #1]", url: "file:///home/PRIVATE/blobs/a.webp" }]],
]) test(`${customType} stays activity-only in history, pagination, live delivery and file tails`, async t => {
  const { api, w, history } = await fixture(t);
  await history([custom("visible")]);
  for (const display of [true, false, undefined]) {
    for (const body of [content, [{ type: "text", text: content }]]) {
      const fields = { customType, display, content: body, details };
      const entries = [
        custom("internal-history", fields),
        ...["custom", "hookMessage"].map(role => ({
          type: "message", id: `internal-${role}`, message: live(`internal-${role}`, { ...fields, role }),
        })),
      ];
      for (const method of ["setHistory", "mergeMessages", "prependMessages"]) {
        await history([custom("visible"), ...entries], method);
        assert.deepEqual(Array.from(api.store.getState().messages, row => row.id), ["visible"]);
        assert.doesNotMatch(w.document.body.textContent, /PRIVATE|agent:\/\/Worker|<irc>|<system-notice>/);
      }
      for (const role of ["custom", "hookMessage"]) {
        await api.act(async () => api.anchoredLive(live(`internal-live-${role}`, { ...fields, role })));
        assert.deepEqual(Array.from(api.store.getState().messages, row => row.id), ["visible"]);
        assert.doesNotMatch(w.document.body.textContent, /PRIVATE|agent:\/\/Worker|<irc>|<system-notice>/);
      }
      for (const entry of entries) assert.equal(api.provisionalTextFromPartial(JSON.stringify(entry)), null);
    }
  }
});

test("ordinary conversation and deliberate extensions may quote internal XML without disappearing", async t => {
  const { api, w, history } = await fixture(t);
  const content = "Explain literal <irc>example</irc> and <system-notice>example</system-notice>.";
  await history([
    { type: "message", id: "user", message: { role: "user", content } },
    { type: "message", id: "assistant", message: { role: "assistant", content } },
    custom("extension", { content }),
  ]);
  assert.deepEqual(Array.from(api.store.getState().messages, row => row.text), [content, content, content]);
  assert.equal(w.document.querySelectorAll("[data-message-id]").length, 3);
});

test("live opt-in normalization retains content without borrowing model, usage, or tools", async t => {
  const { api } = await fixture(t);
  for (const role of ["custom", "hookMessage"]) {
    const transcript = api.customMessageToTranscript(live("canonical", {
      role, model: "not-a-model-reply", usage: { output: 900 }, responseId: "not-a-response",
      content: [
        { type: "text", text: "Hello " }, { type: "text", text: "world\n" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        { type: "text", text: "After the image <script>window.injected = true</script>." },
        { type: "thinking", thinking: "INTERNAL REASONING" },
        { type: "toolCall", id: "fake-tool", name: "bash", arguments: { command: "NEVER RUN" } },
        null,
      ],
    }));
    const row = transcript.messages[0];
    assert.equal(row.text, "Hello world\nAfter the image <script>window.injected = true</script>.");
    assert.deepEqual(Array.from(row.parts, part => part.kind), ["text", "image", "text"]);
    assert.equal(row.parts[1].src, "data:image/png;base64,aGVsbG8=");
    for (const key of ["model", "usage", "responseKey", "stopReason", "duration"]) assert.equal(row[key], undefined);
    assert.equal(row.id, "canonical");
    assert.equal(api.customMessageToTranscript(live("hidden", { role, display: undefined })).messages.length, 0);
  }
  assert.equal(api.customMessageToTranscript({ role: "assistant", content: "not custom" }), null);
});

test("activity-only background completions still settle agents without displaying their instructions", async t => {
  const { api, w, history } = await fixture(t);
  const details = { jobs: [{ type: "task", jobId: "Alpha" }, { type: "task", jobId: "Beta" }, { type: "bash", jobId: "not-an-agent" }] };
  const content = [{ type: "text", text: "<system-notice>PRIVATE DELIVERY\n<task-result id=\"Alpha\" " }, { type: "text", text: "status=\"failed\">Failure details.</task-result></system-notice>" }];
  for (const display of [true, false, undefined]) {
    const entry = custom("async", { customType: "async-result", display, content, details });
    const transcript = api.entriesToTranscript([entry]);
    assert.deepEqual(plain(transcript.settledAgents), [{ id: "Alpha", status: "failed" }, { id: "Beta", status: "completed" }]);
    for (const role of ["custom", "hookMessage"]) {
      const ended = api.customMessageToTranscript(live("async", { role, customType: "async-result", display, content, details }));
      assert.deepEqual(plain(ended.settledAgents), plain(transcript.settledAgents));
      assert.deepEqual(plain(ended.messages), []);
    }
    await history([custom("visible"), entry]);
    assert.deepEqual(Array.from(api.store.getState().messages, row => row.id), ["visible"]);
    assert.doesNotMatch(w.document.body.textContent, /PRIVATE DELIVERY|Failure details|system-notice/);
    assert.equal(api.store.getState().settledAgents.Alpha, "failed");
    assert.equal(api.store.getState().settledAgents.Beta, "completed");
  }
});

test("canonical live history and overlapping pagination deduplicate without collapsing equal-content entries", async t => {
  const { api, history, w } = await fixture(t);
  await api.act(async () => api.anchoredLive(live("newest")));
  await history([custom("newest")], "mergeMessages");
  await history([custom("older"), custom("newest")], "prependMessages");
  assert.deepEqual(Array.from(api.store.getState().messages, row => row.id), ["older", "newest"]);
  assert.equal(w.document.querySelectorAll("[data-message-id]").length, 2);
  await history([custom("older"), custom("newest")]);
  assert.deepEqual(Array.from(api.store.getState().messages, row => row.sourceEntryId), ["older", "newest"]);
  assert.equal(w.document.querySelectorAll("[data-message-id]").length, 2);
});

test("collab-prompt stays a user prompt even without display, while visible HTML remains inert", async t => {
  const { history, api, w } = await fixture(t);
  await history([
    custom("prompt", { customType: "collab-prompt", display: undefined, content: "Deliberate collaboration prompt." }),
    custom("html", { content: "<script>window.injected = true</script>\nA visible extension message." }),
  ]);
  assert.equal(api.store.getState().messages[0].role, "user");
  assert.match(w.document.body.textContent, /Deliberate collaboration prompt/);
  assert.match(w.document.body.textContent, /A visible extension message/);
  assert.equal(w.injected, undefined);
  assert.equal(w.document.querySelector("script"), null);
});

test("image-only extension content stays a readable message rather than a folded work step", async t => {
  const { api, w, history } = await fixture(t);
  await history([custom("photo", { content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }] })]);
  const items = api.buildTimeline(api.store.getState().messages);
  assert.equal(items.filter(item => item.kind === "message").length, 1);
  assert.equal(items.some(item => item.kind === "run"), false);
  assert.equal(w.document.querySelector("img")?.getAttribute("src"), "data:image/png;base64,aGVsbG8=");
});

test("partial file tails cannot disclose hidden or not-yet-decided extension instructions", async t => {
  const { api } = await fixture(t);
  for (const display of [false, undefined]) {
    assert.equal(api.provisionalTextFromPartial(JSON.stringify(custom("hidden", {
      display, content: [{ type: "text", text: "PRIVATE CUSTOM INSTRUCTIONS" }],
    }))), null);
    assert.equal(api.provisionalTextFromPartial(JSON.stringify({
      type: "message", message: live(undefined, { role: "hookMessage", display, content: [{ type: "text", text: "PRIVATE HOOK" }] }),
    })), null);
  }
  assert.equal(api.provisionalTextFromPartial('{"type":"custom_message","content":[{"type":"text","text":"PRIVATE BEFORE DISPLAY FLAG'), null);
  assert.equal(api.provisionalTextFromPartial('{"type":"message","message":{"role":"custom","content":[{"type":"text","text":"PRIVATE BEFORE DISPLAY FLAG'), null);
  assert.equal(api.provisionalTextFromPartial(JSON.stringify(custom("visible", { content: "Readable visible tail." }))), "Readable visible tail.");
});
