import test from "node:test";
import assert from "node:assert/strict";
import { sessionSearchPresentation } from "../src/app/sessions/search-presentation.ts";

const state = (over = {}) => sessionSearchPresentation({
  query: "payment", debouncedQuery: "payment", titleCount: 0, messageCount: 0,
  listingPending: false, moreAvailable: false, messagesPending: false, failed: false, ...over,
});

test("an empty field shows no messages group and no empty state", () => {
  for (const query of ["", "  ", "\n\t"]) {
    assert.deepEqual(state({ query, debouncedQuery: query }), { showMessages: false, titlesPending: false, empty: false });
  }
});

test("one query searches titles and messages together; one letter skips messages", () => {
  assert.equal(state().showMessages, true);
  assert.equal(state({ query: "p", debouncedQuery: "p" }).showMessages, false);
});

test("nothing is declared missing while the debounce or either search is in flight", () => {
  assert.equal(state({ query: "paymen" }).empty, false);
  assert.equal(state({ query: "paymen" }).titlesPending, true);
  assert.equal(state({ listingPending: true }).empty, false);
  assert.equal(state({ messagesPending: true }).empty, false);
  assert.equal(state({ messagesPending: true }).titlesPending, false, "titles answered; messages show their own progress");
});

test("No sessions match appears once, only when both searches came back empty", () => {
  assert.equal(state().empty, true);
  assert.equal(state({ titleCount: 1 }).empty, false);
  assert.equal(state({ messageCount: 1 }).empty, false);
  assert.equal(state({ query: "p", debouncedQuery: "p" }).empty, true, "one letter: titles alone decide");
});

test("an older page or a failure is never reported as no match", () => {
  assert.equal(state({ moreAvailable: true }).empty, false);
  assert.equal(state({ failed: true }).empty, false);
});
