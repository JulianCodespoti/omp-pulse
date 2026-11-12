import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { rolldown } from "../node_modules/rolldown/dist/index.mjs";

const build = await rolldown({
  input: fileURLToPath(new URL("../src/domain/model-mention.ts", import.meta.url)),
  platform: "node",
});
let domain;
try {
  const { output } = await build.generate({ format: "es", codeSplitting: false });
  domain = await import(`data:text/javascript;base64,${Buffer.from(output[0].code).toString("base64")}`);
} finally { await build.close(); }
const { modelMentionAtCaret, applyModelMention, rankModelMentionEntries, isModelMentionSelector } = domain;

// OMP 18.8.6 embedded source: tui/src/prompt/model-mention-syntax.ts
// /(^|\s)\^([^\s^]+)(?=\s|$)/g; ModelMentionRegistry.findMentionable uses ===.
const entry = (selector, name = selector, provider = selector.split("/")[0]) => ({ selector, name, provider });

test("caret completion starts only at OMP's whitespace/start boundary", () => {
  for (const prefix of ["", " ", "\t", "\n", "text\u00a0"]) {
    const text = `${prefix}^cla`;
    assert.deepEqual(modelMentionAtCaret(text, text.length), { start: prefix.length, end: text.length, query: "cla" });
  }
  for (const text of ["x^cla", "(^cla", "[^cla", '"^cla', "`^cla", "^cla done", "^cla\n", "^cla\r", "^cla ", "^^cla", "^cla^ude"]) {
    assert.equal(modelMentionAtCaret(text, text.length), null, text);
  }
  assert.deepEqual(modelMentionAtCaret("^", 1), { start: 0, end: 1, query: "" });
});

test("mid-token completion replaces its old tail and retains the rest of the prompt", () => {
  const text = "compare ^old/model@route:high and explain\nnext line";
  const caret = text.indexOf("old") + 2;
  const token = modelMentionAtCaret(text, caret);
  assert.equal(token.query, "ol");
  assert.equal(text.slice(token.start, token.end), "^old/model@route:high");
  const chosen = entry("Router/Team/Claude@EU:high");
  const result = applyModelMention(text, token, chosen);
  assert.equal(result.text, "compare ^Router/Team/Claude@EU:high and explain\nnext line");
  assert.equal(result.text.slice(result.caret), "and explain\nnext line");
});

test("selector bytes are literal: preserve case, nested routes, quotes and punctuation", () => {
  for (const selector of ["Provider/Model", "openrouter/anthropic/claude@EU:high", 'local/"quoted"', "local/'quoted'", "local/model)", "local/日本語"]) {
    const token = modelMentionAtCaret("choose ^", 8);
    const result = applyModelMention("choose ^", token, entry(selector));
    assert.equal(result.text, `choose ^${selector} `);
    assert.equal(result.caret, result.text.length);
    assert.equal(isModelMentionSelector(selector), true);
    // This is the installed grammar, not shell-style quote decoding.
    const match = /(^|\s)\^([^\s^]+)(?=\s|$)/g.exec(result.text);
    assert.equal(match[2], selector);
  }
});

test("quoted prefixes remain literal search text and cannot swallow whitespace", () => {
  assert.deepEqual(modelMentionAtCaret('^local/"quo', 11), { start: 0, end: 11, query: 'local/"quo' });
  assert.equal(modelMentionAtCaret('^"model with spaces"', 20), null);
  assert.equal(modelMentionAtCaret("^foo", -1), null);
  assert.equal(modelMentionAtCaret("^foo", 10), null);
});

test("existing whitespace is preserved, including multiple spaces and newlines", () => {
  for (const tail of ["  suffix", "\nnext", "\tend", ""]) {
    const text = `^old${tail}`;
    const result = applyModelMention(text, modelMentionAtCaret(text, 2), entry("p/new"));
    assert.equal(result.text, `^p/new${tail || " "}`);
    assert.equal(result.caret, 7);
  }
});

test("search is case-insensitive but choices and insertion retain exact identifiers", () => {
  const models = [entry("P/Claude-Sonnet", "Claude Sonnet"), entry("P/CLAUDE-Opus", "Claude Opus"), entry("Q/Gemini", "Gemini")];
  const choices = rankModelMentionEntries(models, "cLaUdE");
  assert.deepEqual(choices.map(x => x.selector), ["P/Claude-Sonnet", "P/CLAUDE-Opus"]);
  assert.equal(applyModelMention("^cla", modelMentionAtCaret("^cla", 4), choices[1]).text, "^P/CLAUDE-Opus ");
  assert.deepEqual(rankModelMentionEntries(models, "unavailable"), []);
  assert.deepEqual(rankModelMentionEntries([], "cla"), []);
});

test("only provided grammar-valid choices appear, without aliases or invented routes", () => {
  const models = [entry("p/a"), entry("p/a"), entry("p/a@route"), entry("p/A"), entry("p/has space"), entry("p/has^caret"), entry("")];
  assert.deepEqual(rankModelMentionEntries(models, "").map(x => x.selector), ["p/a", "p/a@route", "p/A"]);
  assert.deepEqual(rankModelMentionEntries(models, "", 1).map(x => x.selector), ["p/a"]);
  for (const selector of ["", "p/model name", "p/model\n", "p/model^suffix"]) {
    assert.equal(isModelMentionSelector(selector), false);
    assert.deepEqual(applyModelMention("^old suffix", modelMentionAtCaret("^old suffix", 3), entry(selector)), { text: "^old suffix", caret: 3 });
  }
});
