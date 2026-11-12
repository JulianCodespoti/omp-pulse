import test from "node:test";
import assert from "node:assert/strict";
import { mergeStreamText } from "../src/domain/stream-text.ts";

const text = (value) => ({ kind: "text", text: value });
const visible = (parts) => parts.filter((p) => p.kind === "text").map((p) => p.text).join("");
const thinking = Object.freeze({ kind: "thinking", text: "Checking" });

test("append does not repeat earlier paragraphs", () => {
  const parts = [text("First paragraph. "), thinking, text("Second")];
  const next = mergeStreamText(parts, "First paragraph. Second paragraph.");
  assert.equal(visible(next), "First paragraph. Second paragraph.");
  assert.equal(next[0], parts[0]);
  assert.equal(next[1], thinking);
  assert.equal(next[2].text, "Second paragraph.");
});

test("single text block retains its existing behaviour", () => {
  assert.deepEqual(mergeStreamText([text("Hello")], "Hello there"), [text("Hello there")]);
});

test("replacement inside an earlier block cannot leave a stale suffix", () => {
  const next = mergeStreamText([text("Earlier. "), thinking, text("Later.")], "Revised reply.");
  assert.deepEqual(next, [text("Revised reply."), thinking, text("")]);
});

test("truncation to a boundary and inside a block matches the aggregate", () => {
  const parts = [text("First. "), thinking, text("Second.")];
  for (const wire of ["First. ", "First", "", "First. S"]) {
    assert.equal(visible(mergeStreamText(parts, wire)), wire);
  }
});

test("Unicode, emoji and combining characters are not split by guessed widths", () => {
  const parts = [text("A"), thinking, text("B")];
  const wire = "👩🏽‍💻 e\u0301 漢字";
  assert.deepEqual(mergeStreamText(parts, wire), [text(wire), thinking, text("")]);
});

test("empty text blocks and repeated snapshots remain idempotent", () => {
  const parts = [text(""), text("Hello"), thinking, text("")];
  const once = mergeStreamText(parts, "Hello world");
  assert.equal(visible(once), "Hello world");
  assert.deepEqual(mergeStreamText(once, "Hello world"), once);
});

test("non-text content is retained and a text block is added only when needed", () => {
  const tool = Object.freeze({ kind: "tool", callId: "t", name: "bash", state: "ok", args: {} });
  const image = Object.freeze({ kind: "image", src: null, mimeType: "image/png" });
  const parts = [thinking, tool, image];
  assert.deepEqual(mergeStreamText(parts, ""), parts);
  const next = mergeStreamText(parts, "Done");
  assert.deepEqual(next, [...parts, text("Done")]);
  parts.forEach((part, i) => assert.equal(next[i], part));
});

test("input arrays and parts are never mutated", () => {
  const parts = Object.freeze([Object.freeze(text("Old")), thinking, Object.freeze(text(" reply"))]);
  assert.equal(visible(mergeStreamText(parts, "New reply")), "New reply");
  assert.equal(visible(parts), "Old reply");
});

test("successive append and replacement frames always render exactly once", () => {
  let parts = [text("One"), thinking, text("Two"), text("Three")];
  for (const wire of ["OneTwoThree!", "OneTwo?", "One", "", "新しい", "新しい reply", "OneTwoThree!"]) {
    parts = mergeStreamText(parts, wire);
    assert.equal(visible(parts), wire);
    assert.equal(parts[1], thinking);
  }
});
