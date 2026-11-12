import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { bundleDomFixture, createDomFixture, root } from "./support/react-dom.mjs";

const code = await bundleDomFixture(`
  import { consumeNewChatLink, readNewChatLink } from ${JSON.stringify(resolve(root, "web/src/app/deep-link.ts"))};
  window.fixture = { consumeNewChatLink, readNewChatLink };
`);

test("the widget's #new=1 link is taken once and leaves no fragment behind", () => {
  const dom = createDomFixture(code);
  try {
    const w = dom.window;
    w.history.replaceState({ ompChat: true }, "", "/app/?x=1#new=1");
    assert.equal(w.fixture.readNewChatLink(), true);
    assert.equal(w.fixture.consumeNewChatLink(), true);
    assert.equal(w.location.hash, "");
    assert.equal(w.location.search, "?x=1");
    assert.equal(w.history.state.ompChat, true);
    // A second tap must be a fresh change, not a stale link.
    assert.equal(w.fixture.consumeNewChatLink(), false);
    w.history.replaceState(null, "", "/app/#s=%2Fa");
    assert.equal(w.fixture.consumeNewChatLink(), false);
    assert.equal(w.location.hash, "#s=%2Fa");
  } finally { dom.close(); }
});
